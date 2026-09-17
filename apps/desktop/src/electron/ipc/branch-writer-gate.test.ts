// @vitest-environment node

// T5 — every writer (user autosave, agent persist, scene-HTML disk loop) must
// queue behind a destructive branch op (fork / restore) and never interleave.
// These tests exercise the real lock + writer-gate primitives that the IPC
// handlers use, asserting a restore that runs concurrently with a pending write
// leaves the restored state intact in BOTH the DB and the scene HTML files.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cench-writer-gate-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.CENCH_SCENES_DIR = scenesDir

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsPromises from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, scenes } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { createSceneVersion, restoreBranchToBatch } from '@/lib/db/queries/scene-versions'
import { withBranchLock, withWriterGate, BranchWriterBlockedError } from '@/lib/db/queries/branch-locks'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

beforeAll(async () => {
  mkdirSync(scenesDir, { recursive: true })
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** Seed one branch + one scene with a committed "good" version, and its HTML. */
async function seed() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'WriterGate' })
  const branch = await createBranch({ projectId, name: 'main', isDefault: true })
  const sceneId = crypto.randomUUID()
  const goodBlob = { id: sceneId, reactCode: 'GOOD' }
  await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8, branchId: branch.id, sceneBlob: goodBlob })
  // One committed version that the restore target points at.
  const batchId = crypto.randomUUID()
  await createSceneVersion(db, {
    sceneId,
    branchId: branch.id,
    layerSnapshot: goodBlob,
    operation: 'user_edit',
    source: 'user',
    batchId,
  })
  writeFileSync(path.join(scenesDir, `${sceneId}.html`), '<html>GOOD</html>')
  return { projectId, branchId: branch.id, sceneId, batchId }
}

// ── Interleave instrumentation ────────────────────────────────────────────────
// Rather than biasing the race with an artificial delay (which can pass even when
// the gate is reverted), we record the ORDER of each write step and assert the
// restore's [db-tx → html] pair is contiguous — i.e. the writer's [db, html] pair
// never lands between the restore's DB transaction and its HTML write. That
// non-interleave invariant only holds if the writer actually queues behind the
// restore; with the gate neutered the writer's steps slip into the middle and the
// contiguity assertion fails.
type Step =
  | 'restore:db-start'
  | 'restore:db-end'
  | 'restore:html'
  | 'writer:db'
  | 'writer:html'

/** Assert the restore's critical section (db-start..restore:html) is never broken
 *  up by any writer step. Returns the slice between restore start and html. */
function assertNoInterleave(log: Step[]) {
  const start = log.indexOf('restore:db-start')
  const html = log.indexOf('restore:html')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(html).toBeGreaterThan(start)
  const between = log.slice(start, html + 1)
  // No writer step may appear inside the restore's [db-start .. html] window.
  expect(between).not.toContain('writer:db')
  expect(between).not.toContain('writer:html')
}

/** A restore that mirrors the IPC handler: under the branch lock, revert scene
 *  rows + rewrite their HTML. A real async yield (microtask + timer) sits between
 *  the DB tx and the HTML write so an UNGATED writer has a genuine window to
 *  interleave into — that's exactly what the gate must prevent. */
async function runRestore(projectId: string, branchId: string, batchId: string, log: Step[]) {
  return withBranchLock({ branchId, projectId, operation: 'restore' }, async () => {
    log.push('restore:db-start')
    const { restored } = await db.transaction(async (tx) => {
      const result = await restoreBranchToBatch(tx, branchId, batchId)
      for (const s of result.restored) {
        await tx.update(scenes).set({ sceneBlob: s.layerSnapshot }).where(eq(scenes.id, s.sceneId))
      }
      return result
    })
    log.push('restore:db-end')
    for (const s of restored) {
      // Yield the event loop so a concurrently-scheduled writer gets a real
      // chance to run between the DB tx and the HTML write if it isn't gated.
      await new Promise((r) => setTimeout(r, 25))
      await fsPromises.writeFile(path.join(scenesDir, `${s.sceneId}.html`), '<html>GOOD</html>', 'utf-8')
    }
    log.push('restore:html')
    return restored
  })
}

/** A gated writer mirroring the autosave / agent-persist / scene-HTML loop:
 *  writes "BAD" content to both the DB row and the HTML file, with a yield in
 *  between so its two steps could straddle the restore if it weren't queued. */
async function runGatedWrite(projectId: string, branchId: string, sceneId: string, log: Step[]) {
  return withWriterGate({ branchId, projectId }, async () => {
    await db.update(scenes).set({ sceneBlob: { id: sceneId, reactCode: 'BAD' } }).where(eq(scenes.id, sceneId))
    log.push('writer:db')
    await new Promise((r) => setTimeout(r, 25))
    await fsPromises.writeFile(path.join(scenesDir, `${sceneId}.html`), '<html>BAD</html>', 'utf-8')
    log.push('writer:html')
  })
}

describe('writer gate vs restore (T5)', () => {
  it('a writer started during a restore queues behind it — no interleave; consistent DB+HTML', async () => {
    const { projectId, branchId, sceneId, batchId } = await seed()
    // Move the live state forward to "BAD" first so the restore has something to revert.
    await db.update(scenes).set({ sceneBlob: { id: sceneId, reactCode: 'STALE' } }).where(eq(scenes.id, sceneId))

    const log: Step[] = []
    // Start the restore, then a microtask later kick off a writer that races to
    // slip its db/html pair into the restore's critical section. The gate must
    // force the writer to queue so its steps never land mid-restore.
    const restore = runRestore(projectId, branchId, batchId, log)
    const writer = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return runGatedWrite(projectId, branchId, sceneId, log)
    })()
    await Promise.all([restore, writer])

    // Primary assertion: the restore's [db .. html] window is contiguous — the
    // writer never interleaved. (With the gate reverted the writer's steps appear
    // inside this window and this fails, regardless of final state.)
    assertNoInterleave(log)
    // Writer queued AFTER restore: both writer steps follow the restore's html.
    expect(log).toEqual(['restore:db-start', 'restore:db-end', 'restore:html', 'writer:db', 'writer:html'])

    // And the final state is consistent across DB + HTML (writer ran last → BAD).
    const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
    const html = readFileSync(path.join(scenesDir, `${sceneId}.html`), 'utf-8')
    expect((row.sceneBlob as any).reactCode).toBe('BAD')
    expect(html).toContain('BAD')
  })

  it('a writer that STARTS before a restore completes — no interleave; restored state intact in DB AND HTML', async () => {
    const { projectId, branchId, sceneId, batchId } = await seed()
    await db.update(scenes).set({ sceneBlob: { id: sceneId, reactCode: 'STALE' } }).where(eq(scenes.id, sceneId))

    const log: Step[] = []
    // Writer first (acquires the in-process slot), THEN restore queues behind it.
    // The restore runs last → restored GOOD state must survive, and the restore's
    // critical section must still be contiguous (writer fully drained before it).
    const writer = runGatedWrite(projectId, branchId, sceneId, log)
    const restore = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return runRestore(projectId, branchId, batchId, log)
    })()
    await Promise.all([writer, restore])

    assertNoInterleave(log)
    // Writer fully completed BEFORE the restore started its DB tx.
    expect(log).toEqual(['writer:db', 'writer:html', 'restore:db-start', 'restore:db-end', 'restore:html'])

    const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
    const html = readFileSync(path.join(scenesDir, `${sceneId}.html`), 'utf-8')
    // Restore ran last → GOOD wins, consistently in DB and on disk.
    expect((row.sceneBlob as any).reactCode).toBe('GOOD')
    expect(html).toContain('GOOD')
  })

  it('a writer fails loud when a cross-process destructive lock is held past the bound', async () => {
    const { projectId, branchId } = await seed()
    // Simulate another window holding the branch lock (a different owner token)
    // by acquiring it directly and never releasing within the writer's wait.
    const { acquireBranchLock, releaseBranchLock } = await import('@/lib/db/queries/branch-locks')
    const held = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'other-window' })
    expect(held.acquired).toBe(true)

    // The writer can't take the in-process mutex from another "process", so use a
    // short bound to keep the test fast — it must fail loud, not silently write.
    await expect(
      withWriterGate({ branchId, projectId, waitMs: 200 }, async () => 'should-not-run'),
    ).rejects.toBeInstanceOf(BranchWriterBlockedError)

    await releaseBranchLock(branchId, 'other-window')
  })
})
