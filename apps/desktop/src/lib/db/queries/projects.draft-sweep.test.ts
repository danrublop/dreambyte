// @vitest-environment node
//
// Real-DB (libsql file) test for the draft-sweep DB glue (T2 / D7 + D17):
// candidate gathering, soft-hide + hard-purge application, and draft promotion.
// Proves a row exists at creation, the sweep hides only provably-untouched
// empties, purge respects the 7-day window, and named/scened projects are never
// swept. Runs the real migration chain + real SQL.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-draft-sweep-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, scenes, conversations, messages } from '../schema'
import { eq } from 'drizzle-orm'
import { getDraftSweepCandidates, runDraftSweep, promoteDraftToReady, applyDraftSweep } from './projects'
import { DRAFT_PURGE_AFTER_MS } from '@/lib/store/draft-sweep'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function mkProject(over: Partial<typeof projects.$inferInsert> = {}): Promise<string> {
  const id = crypto.randomUUID()
  const { id: _ignore, ...rest } = over
  void _ignore
  await db.insert(projects).values({
    name: over.name ?? `Untitled Project ${id.slice(0, 4)}`,
    status: over.status ?? 'draft',
    createdAt: over.createdAt ?? new Date(),
    lastOpenedAt: over.lastOpenedAt ?? over.createdAt ?? new Date(),
    hiddenAt: over.hiddenAt ?? null,
    ...rest,
    id,
  })
  return id
}

async function status(id: string): Promise<string | undefined> {
  const [row] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id)).limit(1)
  return row?.status
}

async function exists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1)
  return !!row
}

describe('draft sweep — DB glue (T2 / D7 + D17)', () => {
  it('a draft row exists immediately with status=draft', async () => {
    const id = await mkProject()
    expect(await status(id)).toBe('draft')
    const cands = await getDraftSweepCandidates()
    expect(cands.find((c) => c.id === id)).toBeTruthy()
  })

  it('sweep soft-hides a provably-untouched empty draft; named/scened never swept', async () => {
    const empty = await mkProject({ name: 'Untitled Project 7' })
    const named = await mkProject({ name: 'My Real Video' })
    const scened = await mkProject({ name: 'Untitled Project 8' })
    // Give the scened draft a scene row.
    await db.insert(scenes).values({
      id: crypto.randomUUID(),
      projectId: scened,
      name: 'S',
      position: 0,
      sceneType: 'react' as never,
    } as never)

    await runDraftSweep(Date.now())

    expect(await status(empty)).toBe('hidden')
    expect(await status(named)).toBe('draft') // renamed → never swept
    expect(await status(scened)).toBe('draft') // has a scene → never swept
  })

  it('a draft with a message is never swept', async () => {
    const id = await mkProject({ name: 'Untitled Project 9' })
    const [conv] = await db.insert(conversations).values({ projectId: id, title: 'c' }).returning()
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: conv.id,
      projectId: id,
      role: 'user',
      content: 'hi',
      position: 0,
    })
    await runDraftSweep(Date.now())
    expect(await status(id)).toBe('draft')
  })

  it('hard-purge respects the 7-day window', async () => {
    const now = Date.now()
    const old = await mkProject({
      name: 'Untitled Project 10',
      status: 'hidden',
      hiddenAt: new Date(now - DRAFT_PURGE_AFTER_MS - 60_000),
    })
    const fresh = await mkProject({
      name: 'Untitled Project 11',
      status: 'hidden',
      hiddenAt: new Date(now - 60_000),
    })
    await runDraftSweep(now)
    expect(await exists(old)).toBe(false) // purged
    expect(await exists(fresh)).toBe(true) // within window
    expect(await status(fresh)).toBe('hidden')
  })

  it('promoteDraftToReady flips draft/hidden to ready and clears hiddenAt; no-op on ready', async () => {
    const d = await mkProject({ name: 'Untitled Project 12' })
    await promoteDraftToReady(d)
    expect(await status(d)).toBe('ready')

    const h = await mkProject({ name: 'Untitled Project 13', status: 'hidden', hiddenAt: new Date() })
    await promoteDraftToReady(h)
    expect(await status(h)).toBe('ready')
    const [row] = await db.select({ hiddenAt: projects.hiddenAt }).from(projects).where(eq(projects.id, h)).limit(1)
    expect(row?.hiddenAt).toBeNull()
  })

  it('applyDraftSweep never hard-deletes a row that is no longer hidden (re-check guard)', async () => {
    const id = await mkProject({ name: 'Untitled Project 14', status: 'ready' })
    // Plan tries to purge it, but it's 'ready' now — the WHERE re-check protects it.
    await applyDraftSweep({ toHide: [], toPurge: [id] })
    expect(await exists(id)).toBe(true)
  })

  it('purge invokes the fs-cleanup hook per purged id BEFORE the DB delete (COMMIT 5)', async () => {
    const now = Date.now()
    const a = await mkProject({
      name: 'Untitled Project 15',
      status: 'hidden',
      hiddenAt: new Date(now - DRAFT_PURGE_AFTER_MS - 60_000),
    })
    const b = await mkProject({
      name: 'Untitled Project 16',
      status: 'hidden',
      hiddenAt: new Date(now - DRAFT_PURGE_AFTER_MS - 60_000),
    })

    const cleaned: string[] = []
    // Assert the row still EXISTS when the hook runs — cleanup precedes delete.
    const cleanupFs = async (projectId: string) => {
      cleaned.push(projectId)
      expect(await exists(projectId)).toBe(true)
    }

    await runDraftSweep(now, cleanupFs)

    expect(cleaned.sort()).toEqual([a, b].sort())
    expect(await exists(a)).toBe(false)
    expect(await exists(b)).toBe(false)
  })

  it('a cleanup-hook failure never blocks the row purge (COMMIT 5)', async () => {
    const now = Date.now()
    const id = await mkProject({
      name: 'Untitled Project 17',
      status: 'hidden',
      hiddenAt: new Date(now - DRAFT_PURGE_AFTER_MS - 60_000),
    })
    await applyDraftSweep({ toHide: [], toPurge: [id] }, async () => {
      throw new Error('fs cleanup blew up')
    })
    // Row is still purged despite the hook throwing.
    expect(await exists(id)).toBe(false)
  })
})
