// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-scene-versions-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, scenes, sceneVersions } from '../schema'
import { createBranch } from './branches'
import {
  createSceneVersion,
  getSceneVersion,
  getSceneVersions,
  restoreSceneVersion,
  getBranchHistory,
  restoreBranchToBatch,
} from './scene-versions'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedSceneAndBranch() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Test Project' })
  const branch = await createBranch({ projectId, name: 'main', isDefault: true })
  const sceneId = crypto.randomUUID()
  await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8, branchId: branch.id })
  return { projectId, branchId: branch.id, sceneId }
}

const SNAPSHOT = { type: 'react', reactCode: 'export default () => null', aiLayers: [] }

describe('createSceneVersion', () => {
  it('creates a version with incrementing version numbers', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const v1 = await createSceneVersion(db, {
      sceneId,
      branchId,
      layerSnapshot: SNAPSHOT,
      operation: 'edit',
      source: 'autosave',
    })
    const v2 = await createSceneVersion(db, {
      sceneId,
      branchId,
      layerSnapshot: SNAPSHOT,
      operation: 'edit',
      source: 'autosave',
    })
    expect(v1.versionNumber).toBe(1)
    expect(v2.versionNumber).toBe(2)
  })

  it('stores the full layerSnapshot', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const snap = { reactCode: 'hello', aiLayers: [{ type: 'avatar', id: 'abc' }] }
    const v = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: snap, source: 'autosave' })
    expect(v.layerSnapshot).toEqual(snap)
  })

  it('trims oldest version at 201 so only newest 200 remain', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    for (let i = 0; i < 201; i++) {
      await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    }
    const versions = await getSceneVersions(sceneId, branchId, { all: true })
    expect(versions).toHaveLength(200)
    // Oldest version (number 1) was trimmed; newest (201) is present
    const numbers = versions.map((v) => v.versionNumber)
    expect(numbers).not.toContain(1)
    expect(numbers).toContain(201)
  })

  it('trim deletes oldest by version_number, never newest', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    // Insert 200 versions
    for (let i = 0; i < 200; i++) {
      await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    }
    // Insert 201st — should trim v1
    const v201 = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    expect(v201.versionNumber).toBe(201)

    const versions = await getSceneVersions(sceneId, branchId, { all: true })
    const numbers = versions.map((v) => v.versionNumber)
    expect(Math.min(...numbers)).toBe(2)
    expect(Math.max(...numbers)).toBe(201)
  })
})

describe('getSceneVersions', () => {
  it('never returns layerSnapshot column', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    const versions = await getSceneVersions(sceneId, branchId)
    expect(versions).toHaveLength(1)
    expect((versions[0] as Record<string, unknown>).layerSnapshot).toBeUndefined()
  })

  it('returns empty array when scene has 0 versions', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const versions = await getSceneVersions(sceneId, branchId)
    expect(versions).toEqual([])
  })

  it('returns versions ordered newest first', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    const versions = await getSceneVersions(sceneId, branchId)
    expect(versions[0].versionNumber).toBe(3)
    expect(versions[2].versionNumber).toBe(1)
  })
})

describe('getSceneVersion', () => {
  it('returns full layerSnapshot when found', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const created = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    const fetched = await getSceneVersion(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.layerSnapshot).toEqual(SNAPSHOT)
  })

  it('returns null when versionId not found', async () => {
    const result = await getSceneVersion(crypto.randomUUID())
    expect(result).toBeNull()
  })
})

describe('restoreSceneVersion', () => {
  it('creates a NEW version record after restore', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const v1 = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    await createSceneVersion(db, {
      sceneId,
      branchId,
      layerSnapshot: { ...SNAPSHOT, reactCode: 'v2' },
      source: 'autosave',
    })

    const { newVersionNumber } = await restoreSceneVersion(db, v1.id)
    expect(newVersionNumber).toBe(3)

    const all = await getSceneVersions(sceneId, branchId)
    expect(all).toHaveLength(3)
  })

  it('does not overwrite or truncate existing version history', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const v1 = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    await createSceneVersion(db, {
      sceneId,
      branchId,
      layerSnapshot: { ...SNAPSHOT, reactCode: 'v2' },
      source: 'autosave',
    })

    await restoreSceneVersion(db, v1.id)

    const all = await getSceneVersions(sceneId, branchId)
    const numbers = all.map((v) => v.versionNumber).sort((a, b) => a - b)
    // v1 and v2 still exist alongside the new restore version
    expect(numbers).toContain(1)
    expect(numbers).toContain(2)
    expect(numbers).toContain(3)
  })

  it('new version after restore has operation=restore', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    const v1 = await createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, source: 'autosave' })
    await restoreSceneVersion(db, v1.id)
    const all = await getSceneVersions(sceneId, branchId)
    const restoreVersion = all.find((v) => v.operation === 'restore')
    expect(restoreVersion).toBeDefined()
  })
})

describe('branch history (batchId)', () => {
  // Seed a branch with two scenes, plus a small helper to write a batch.
  async function seedBranchWithTwoScenes() {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'History Test' })
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })
    const sceneA = crypto.randomUUID()
    const sceneB = crypto.randomUUID()
    await db.insert(scenes).values([
      { id: sceneA, projectId, position: 0, duration: 8, branchId: branch.id },
      { id: sceneB, projectId, position: 1, duration: 8, branchId: branch.id },
    ])
    return { projectId, branchId: branch.id, sceneA, sceneB }
  }

  async function writeBatch(
    branchId: string,
    entries: { sceneId: string; snap: Record<string, unknown> }[],
    atSec?: number,
  ): Promise<string> {
    const batchId = crypto.randomUUID()
    const ids: string[] = []
    for (const e of entries) {
      const v = await createSceneVersion(db, {
        sceneId: e.sceneId,
        branchId,
        layerSnapshot: e.snap,
        operation: 'agent_run',
        source: 'agent',
        batchId,
      })
      ids.push(v.id)
    }
    // Pin createdAt to a controlled second so restore's as-of-T ordering is
    // deterministic (unixepoch() default is second-resolution, so two batches
    // written in the same test second would otherwise be indistinguishable).
    if (atSec !== undefined) {
      await db
        .update(sceneVersions)
        .set({ createdAt: new Date(atSec * 1000) })
        .where(inArray(sceneVersions.id, ids))
    }
    return batchId
  }

  it('collapses a multi-scene operation into one history entry with sceneCount', async () => {
    const { branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    const batch = await writeBatch(branchId, [
      { sceneId: sceneA, snap: { reactCode: 'A1' } },
      { sceneId: sceneB, snap: { reactCode: 'B1' } },
    ])
    const history = await getBranchHistory(branchId)
    expect(history).toHaveLength(1)
    expect(history[0].batchId).toBe(batch)
    expect(history[0].sceneCount).toBe(2)
    expect(history[0].operation).toBe('agent_run')
  })

  it('surfaces separate operations as separate entries', async () => {
    const { branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    const b1 = await writeBatch(branchId, [
      { sceneId: sceneA, snap: { reactCode: 'A1' } },
      { sceneId: sceneB, snap: { reactCode: 'B1' } },
    ])
    const b2 = await writeBatch(branchId, [{ sceneId: sceneA, snap: { reactCode: 'A2' } }])
    const history = await getBranchHistory(branchId)
    const keys = history.map((h) => h.batchId)
    expect(keys).toContain(b1)
    expect(keys).toContain(b2)
    expect(history.find((h) => h.batchId === b1)?.sceneCount).toBe(2)
    expect(history.find((h) => h.batchId === b2)?.sceneCount).toBe(1)
  })

  it('restores the whole branch to a point — reverts later edits, no splice', async () => {
    const { branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    // Batch 1 (t=1000): A=A1, B=B1. Batch 2 (t=2000): A=A2 only (B untouched).
    const b1 = await writeBatch(
      branchId,
      [
        { sceneId: sceneA, snap: { reactCode: 'A1' } },
        { sceneId: sceneB, snap: { reactCode: 'B1' } },
      ],
      1000,
    )
    await writeBatch(branchId, [{ sceneId: sceneA, snap: { reactCode: 'A2' } }], 2000)

    const { restored } = await restoreBranchToBatch(db, branchId, b1)
    const bySceneId = new Map(restored.map((r) => [r.sceneId, r.layerSnapshot]))
    // Whole branch as of batch 1: A reverts from its LATER A2 back to A1, B=B1.
    expect(bySceneId.get(sceneA)).toEqual({ reactCode: 'A1' })
    expect(bySceneId.get(sceneB)).toEqual({ reactCode: 'B1' })

    // The restore is itself one batch (so it's one undoable history entry).
    const restoreBatchIds = new Set(
      (await getSceneVersions(sceneA, branchId, { all: true }))
        .filter((v) => v.operation === 'restore')
        .map((v) => v.batchId),
    )
    expect(restoreBatchIds.size).toBe(1)
  })

  it('throws when restoring an unknown history key', async () => {
    const { branchId } = await seedBranchWithTwoScenes()
    await expect(restoreBranchToBatch(db, branchId, crypto.randomUUID())).rejects.toThrow()
  })

  it('uses a monotonic cursor: two batches in the SAME second do not splice', async () => {
    const { branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    // Both batches pinned to the SAME wall-clock second. With a second-resolution
    // cursor these are indistinguishable and a restore to b1 would wrongly pull
    // in b2's A2. The rowid cursor keeps them ordered by insertion.
    const b1 = await writeBatch(
      branchId,
      [
        { sceneId: sceneA, snap: { reactCode: 'A1' } },
        { sceneId: sceneB, snap: { reactCode: 'B1' } },
      ],
      1000,
    )
    await writeBatch(branchId, [{ sceneId: sceneA, snap: { reactCode: 'A2' } }], 1000)

    const { restored } = await restoreBranchToBatch(db, branchId, b1)
    const bySceneId = new Map(restored.map((r) => [r.sceneId, r.layerSnapshot]))
    // Restored to b1: A must be A1 (NOT the same-second-later A2), B must be B1.
    expect(bySceneId.get(sceneA)).toEqual({ reactCode: 'A1' })
    expect(bySceneId.get(sceneB)).toEqual({ reactCode: 'B1' })
  })

  it('removes scenes created after the restore point (scene-add across cursor)', async () => {
    const { projectId, branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    // Batch 1: A and B exist.
    const b1 = await writeBatch(branchId, [
      { sceneId: sceneA, snap: { reactCode: 'A1' } },
      { sceneId: sceneB, snap: { reactCode: 'B1' } },
    ])
    // Later, a NEW scene C is created and versioned (after the cursor).
    const sceneC = crypto.randomUUID()
    await db.insert(scenes).values({ id: sceneC, projectId, position: 2, duration: 8, branchId })
    await writeBatch(branchId, [{ sceneId: sceneC, snap: { reactCode: 'C1' } }])

    const { restored, removedSceneIds } = await restoreBranchToBatch(db, branchId, b1)
    const restoredIds = new Set(restored.map((r) => r.sceneId))
    // A and B are restored; C is removed (it didn't exist at the restore point).
    expect(restoredIds.has(sceneA)).toBe(true)
    expect(restoredIds.has(sceneB)).toBe(true)
    expect(removedSceneIds).toEqual([sceneC])
    // C's row is actually gone from the branch.
    const liveC = await db
      .select()
      .from(scenes)
      .where(inArray(scenes.id, [sceneC]))
    expect(liveC).toHaveLength(0)
  })

  it('keeps a scene untouched-after-cursor at its as-of-cursor state', async () => {
    // Scene-delete across the cursor is not separately recoverable: deleting a
    // scene row cascades its version history (FK onDelete: cascade), so there is
    // no snapshot left to re-materialize. This test instead pins the other half
    // of the add/delete story — a scene that existed at the cursor and was NOT
    // touched afterward is restored to exactly its cursor state, never spliced.
    const { branchId, sceneA, sceneB } = await seedBranchWithTwoScenes()
    const b1 = await writeBatch(branchId, [
      { sceneId: sceneA, snap: { reactCode: 'A1' } },
      { sceneId: sceneB, snap: { reactCode: 'B1' } },
    ])
    // Later: only A changes; B is left alone.
    await writeBatch(branchId, [{ sceneId: sceneA, snap: { reactCode: 'A2' } }])

    const { restored, removedSceneIds } = await restoreBranchToBatch(db, branchId, b1)
    expect(removedSceneIds).toEqual([])
    const bySceneId = new Map(restored.map((r) => [r.sceneId, r.layerSnapshot]))
    expect(bySceneId.get(sceneA)).toEqual({ reactCode: 'A1' })
    expect(bySceneId.get(sceneB)).toEqual({ reactCode: 'B1' })
  })
})

describe('createSceneVersion — concurrent collision (B9)', () => {
  it('never persists duplicate version numbers: racers either get distinct numbers or fail on the unique index', async () => {
    const { sceneId, branchId } = await seedSceneAndBranch()
    // Fire 5 creates concurrently. The implementation reads max(version) then
    // inserts — racers can compute the same next number. The contract under
    // race is: NO silent duplicate may ever persist (the
    // scene_versions_unique_idx backstop); losers surface as UNIQUE failures.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createSceneVersion(db, { sceneId, branchId, layerSnapshot: SNAPSHOT, operation: 'edit', source: 'autosave' }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    // In practice all racers read max=0 before any commit, so exactly one
    // wins — but the contract only requires ≥1 (asserting ===1 would couple
    // the test to driver scheduling).
    expect(ok.length).toBeGreaterThanOrEqual(1)
    for (const f of failed as PromiseRejectedResult[]) {
      // Only the unique-index backstop is an acceptable failure mode.
      // Depth-capped walk — same hardening rationale as isUniqueViolation.
      const chain: string[] = []
      for (let e: unknown = f.reason, depth = 0; e && depth < 16; e = (e as { cause?: unknown }).cause, depth++) {
        if (e instanceof Error) chain.push(e.message)
      }
      expect(chain.join(' | ')).toMatch(/UNIQUE/i)
    }
    // Ground truth: the persisted rows carry strictly distinct version numbers.
    const rows = await db
      .select({ versionNumber: sceneVersions.versionNumber })
      .from(sceneVersions)
      .where(and(eq(sceneVersions.sceneId, sceneId), eq(sceneVersions.branchId, branchId)))
    const numbers = rows.map((r) => r.versionNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(numbers.length).toBe(ok.length)
  })
})

describe('branch history — compound keyset pagination (hotlist item 2)', () => {
  async function seedBranchWithScene() {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'Keyset Test' })
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })
    const sceneId = crypto.randomUUID()
    await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8, branchId: branch.id })
    return { branchId: branch.id, sceneId }
  }

  async function writeStampedVersion(branchId: string, sceneId: string, batchId: string, atSec: number) {
    const v = await createSceneVersion(db, {
      sceneId,
      branchId,
      layerSnapshot: { stamp: atSec },
      operation: 'agent_run',
      source: 'agent',
      batchId,
    })
    await db
      .update(sceneVersions)
      .set({ createdAt: new Date(atSec * 1000) })
      .where(eq(sceneVersions.id, v.id))
  }

  it('pages through more-than-limit entries in ONE second without dropping or duplicating', async () => {
    const { branchId, sceneId } = await seedBranchWithScene()
    const T = 1_900_000_000
    // 5 single-version batches, all stamped to the same second — the old bare
    // `before` cursor returned ZERO of the remaining entries on page 2.
    for (let i = 0; i < 5; i++) {
      await writeStampedVersion(branchId, sceneId, crypto.randomUUID(), T)
    }
    const page1 = await getBranchHistory(branchId, { limit: 2 })
    expect(page1).toHaveLength(2)
    const page2 = await getBranchHistory(branchId, {
      limit: 2,
      before: page1[1].createdAt,
      beforeKey: page1[1].key,
    })
    expect(page2).toHaveLength(2)
    const page3 = await getBranchHistory(branchId, {
      limit: 2,
      before: page2[1].createdAt,
      beforeKey: page2[1].key,
    })
    expect(page3).toHaveLength(1)
    const keys = [...page1, ...page2, ...page3].map((e) => e.key)
    expect(new Set(keys).size).toBe(5)
  })

  it('a batch straddling the cursor second is never truncated into a partial group', async () => {
    const { branchId, sceneId } = await seedBranchWithScene()
    // Second scene so the straddling batch counts 2 distinct scenes.
    const scene2 = crypto.randomUUID()
    const [row] = await db.select({ projectId: scenes.projectId }).from(scenes).where(eq(scenes.id, sceneId))
    await db.insert(scenes).values({ id: scene2, projectId: row.projectId, position: 1, duration: 8, branchId })

    const T = 1_900_000_100
    // Batch X: rows at T-5 AND at T → the group's max is T, sceneCount 2. The
    // old ROW-level `created_at < T` cursor kept only the T-5 row, resurfacing
    // X on page 2 with an earlier timestamp and sceneCount 1.
    const xBatch = crypto.randomUUID()
    await writeStampedVersion(branchId, sceneId, xBatch, T - 5)
    await writeStampedVersion(branchId, scene2, xBatch, T)
    // Three sibling single-version entries at the same second T.
    for (let i = 0; i < 3; i++) {
      await writeStampedVersion(branchId, sceneId, crypto.randomUUID(), T)
    }

    // Walk the timeline one entry at a time with the compound cursor; when X
    // arrives it must be WHOLE: max-timestamp T and both scenes counted.
    const seen: { key: string; createdAt: Date; sceneCount: number }[] = []
    let cursor: { before: Date; beforeKey: string } | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await getBranchHistory(branchId, { limit: 1, ...(cursor ?? {}) })
      if (page.length === 0) break
      seen.push(page[0])
      cursor = { before: page[0].createdAt, beforeKey: page[0].key }
    }
    expect(seen).toHaveLength(4) // 3 singletons + X, each exactly once
    const x = seen.find((e) => e.key === xBatch)
    expect(x).toBeDefined()
    expect(x!.sceneCount).toBe(2) // never truncated
    expect(x!.createdAt.getTime()).toBe(T * 1000) // group max, not the T-5 leftover
    expect(new Set(seen.map((e) => e.key)).size).toBe(4)
  })

  it('a bare `before` (legacy callers) keeps the old strictly-older semantics', async () => {
    const { branchId, sceneId } = await seedBranchWithScene()
    await writeStampedVersion(branchId, sceneId, crypto.randomUUID(), 1_900_000_200)
    await writeStampedVersion(branchId, sceneId, crypto.randomUUID(), 1_900_000_300)
    const older = await getBranchHistory(branchId, { before: new Date(1_900_000_300 * 1000) })
    expect(older).toHaveLength(1)
    expect(older[0].createdAt.getTime()).toBe(1_900_000_200 * 1000)
  })
})
