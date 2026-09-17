// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-branches-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects } from '../schema'
import {
  backfillProjectBranch,
  createBranch,
  deleteBranch,
  getBranch,
  getBranches,
  getDefaultBranch,
  getOrCreateDefaultBranch,
  renameBranch,
  setDefaultBranch,
} from './branches'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedProject(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `Test Project ${id.slice(0, 6)}` })
  return id
}

describe('createBranch', () => {
  it('creates a branch and returns it', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'feature-1' })
    expect(branch.name).toBe('feature-1')
    expect(branch.projectId).toBe(projectId)
    expect(branch.isDefault).toBe(false)
  })

  it('throws UNIQUE constraint error for duplicate name in same project', async () => {
    const projectId = await seedProject()
    await createBranch({ projectId, name: 'main', isDefault: true })
    await expect(createBranch({ projectId, name: 'main' })).rejects.toThrow()
  })

  it('allows same branch name in different projects', async () => {
    const p1 = await seedProject()
    const p2 = await seedProject()
    const b1 = await createBranch({ projectId: p1, name: 'feature-x' })
    const b2 = await createBranch({ projectId: p2, name: 'feature-x' })
    expect(b1.id).not.toBe(b2.id)
  })

  it('clones scenes from sourceBranchId in one transaction', async () => {
    const projectId = await seedProject()
    const src = await createBranch({ projectId, name: 'source', isDefault: true })

    const { scenes } = await import('../schema')
    const sceneId = crypto.randomUUID()
    await db.insert(scenes).values({
      id: sceneId,
      projectId,
      position: 0,
      duration: 8,
      branchId: src.id,
    })

    const dst = await createBranch({ projectId, name: 'clone', sourceBranchId: src.id })

    const { eq, and } = await import('drizzle-orm')
    const cloned = await db
      .select()
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, dst.id)))
    expect(cloned).toHaveLength(1)
    // Cloned scene has a new ID — not the original
    expect(cloned[0].id).not.toBe(sceneId)
  })

  it('rewrites the embedded sceneBlob id/branchId on clone (no scene-stealing)', async () => {
    const projectId = await seedProject()
    const src = await createBranch({ projectId, name: 'source', isDefault: true })

    const { scenes } = await import('../schema')
    const srcSceneId = crypto.randomUUID()
    // sceneBlob is authoritative on load — it carries the scene's own id/branchId.
    await db.insert(scenes).values({
      id: srcSceneId,
      projectId,
      position: 0,
      duration: 8,
      branchId: src.id,
      sceneBlob: { id: srcSceneId, branchId: src.id, type: 'react', reactCode: 'x' } as Record<string, unknown>,
    })

    const dst = await createBranch({ projectId, name: 'clone', sourceBranchId: src.id })

    const { eq, and } = await import('drizzle-orm')
    const [clone] = await db
      .select()
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, dst.id)))
    const blob = clone.sceneBlob as Record<string, unknown>
    // The cloned blob must point at the NEW row, not the source scene — otherwise
    // saving the clone branch would upsert onto the source scene and move it.
    expect(blob.id).toBe(clone.id)
    expect(blob.id).not.toBe(srcSceneId)
    expect(blob.branchId).toBe(dst.id)
  })

  it('returns an explicit old→new scene id map (createBranchWithMap)', async () => {
    const { createBranchWithMap } = await import('./branches')
    const projectId = await seedProject()
    const src = await createBranch({ projectId, name: 'source', isDefault: true })

    const { scenes } = await import('../schema')
    const srcIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await db
      .insert(scenes)
      .values(srcIds.map((id, i) => ({ id, projectId, position: i, duration: 8, branchId: src.id })))

    const { branch: dst, sceneIdMap } = await createBranchWithMap({
      projectId,
      name: 'clone',
      sourceBranchId: src.id,
    })

    // One pair per source scene; every srcId is mapped to a fresh, distinct dstId.
    expect(sceneIdMap).toHaveLength(3)
    expect(new Set(sceneIdMap.map((p) => p.srcId))).toEqual(new Set(srcIds))
    const dstIds = sceneIdMap.map((p) => p.dstId)
    expect(new Set(dstIds).size).toBe(3)
    for (const p of sceneIdMap) expect(p.dstId).not.toBe(p.srcId)

    // Every dstId actually exists on the destination branch.
    const { eq, and } = await import('drizzle-orm')
    const cloned = await db
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, dst.id)))
    expect(new Set(cloned.map((c) => c.id))).toEqual(new Set(dstIds))
  })
})

describe('deleteBranch', () => {
  it('deletes a non-default branch', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'to-delete' })
    await deleteBranch(branch.id)
    const branches = await getBranches(projectId)
    expect(branches.find((b) => b.id === branch.id)).toBeUndefined()
  })

  it('blocks deletion of default branch', async () => {
    const projectId = await seedProject()
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    await expect(deleteBranch(main.id)).rejects.toThrow('Cannot delete the default branch')
  })

  it('deletes the branch_locks row with the branch (no permanent lock leak)', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'locked-then-deleted' })

    const { branchLocks } = await import('../schema')
    const { eq } = await import('drizzle-orm')
    // Simulate the IPC delete handler holding the lock while deleteBranch runs
    // (FK cascade is inert — enforcement is off per-connection — so without
    // the explicit delete this row would outlive its branch forever).
    await db.insert(branchLocks).values({
      branchId: branch.id,
      projectId,
      ownerId: crypto.randomUUID(),
      operation: 'delete',
    })

    await deleteBranch(branch.id)

    const leftover = await db.select().from(branchLocks).where(eq(branchLocks.branchId, branch.id))
    expect(leftover).toHaveLength(0)
  })
})

describe('renameBranch', () => {
  it('renames a branch', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'old-name' })
    const renamed = await renameBranch(branch.id, 'new-name')
    expect(renamed.name).toBe('new-name')
  })

  it('throws UNIQUE constraint error when renaming to an existing name', async () => {
    const projectId = await seedProject()
    await createBranch({ projectId, name: 'main', isDefault: true })
    const other = await createBranch({ projectId, name: 'other' })
    await expect(renameBranch(other.id, 'main')).rejects.toThrow()
  })
})

describe('setDefaultBranch', () => {
  it('swaps the default atomically — exactly one default remains', async () => {
    const projectId = await seedProject()
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const feature = await createBranch({ projectId, name: 'feature' })

    const updated = await setDefaultBranch(projectId, feature.id)
    expect(updated.isDefault).toBe(true)

    const all = await getBranches(projectId)
    const defaults = all.filter((b) => b.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(feature.id)
    expect((await getBranch(main.id))!.isDefault).toBe(false)
  })

  it('is a no-op when the branch is already default', async () => {
    const projectId = await seedProject()
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const updated = await setDefaultBranch(projectId, main.id)
    expect(updated.id).toBe(main.id)
    expect(updated.isDefault).toBe(true)
  })

  it('rejects a branch from another project', async () => {
    const p1 = await seedProject()
    const p2 = await seedProject()
    const b2 = await createBranch({ projectId: p2, name: 'main', isDefault: true })
    await expect(setDefaultBranch(p1, b2.id)).rejects.toThrow()
  })
})

describe('getDefaultBranch', () => {
  it('returns the default branch for a project', async () => {
    const projectId = await seedProject()
    await createBranch({ projectId, name: 'main', isDefault: true })
    const branch = await getDefaultBranch(projectId)
    expect(branch).not.toBeNull()
    expect(branch!.isDefault).toBe(true)
  })

  it('returns null when no default branch exists', async () => {
    const projectId = await seedProject()
    await createBranch({ projectId, name: 'feature' })
    const branch = await getDefaultBranch(projectId)
    expect(branch).toBeNull()
  })
})

describe('getOrCreateDefaultBranch', () => {
  it('creates main branch on first call and returns same branch on second call', async () => {
    const projectId = await seedProject()
    const first = await getOrCreateDefaultBranch(projectId)
    const second = await getOrCreateDefaultBranch(projectId)
    expect(first.id).toBe(second.id)
    expect(first.name).toBe('main')
    expect(first.isDefault).toBe(true)
  })
})

describe('getBranch', () => {
  it('returns the branch by id', async () => {
    const projectId = await seedProject()
    const created = await createBranch({ projectId, name: 'test-branch' })
    const fetched = await getBranch(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(created.id)
    expect(fetched!.projectId).toBe(projectId)
  })

  it('returns null for a non-existent id', async () => {
    const result = await getBranch(crypto.randomUUID())
    expect(result).toBeNull()
  })
})

describe('backfillProjectBranch', () => {
  it('assigns default branchId to scenes/snapshots/conversations with null branchId', async () => {
    const { scenes, snapshots, conversations } = await import('../schema')
    const { eq, isNull } = await import('drizzle-orm')

    const projectId = await seedProject()
    const branch = await getOrCreateDefaultBranch(projectId)

    // Insert a scene, snapshot, and conversation with null branchId
    const sceneId = crypto.randomUUID()
    await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8 })

    await db.insert(snapshots).values({
      id: crypto.randomUUID(),
      projectId,
      operation: 'test',
      diff: '{}',
      stackIndex: 0,
    } as any)

    await db.insert(conversations).values({
      id: crypto.randomUUID(),
      projectId,
      title: 'Test Chat',
    } as any)

    // Verify they have null branchId before backfill
    const [sceneRow] = await db.select({ branchId: scenes.branchId }).from(scenes).where(eq(scenes.id, sceneId))
    expect(sceneRow.branchId).toBeNull()

    // Run backfill
    await backfillProjectBranch(projectId)

    // All rows should now have the default branchId
    const sceneAfter = await db.select({ branchId: scenes.branchId }).from(scenes).where(eq(scenes.id, sceneId))
    expect(sceneAfter[0].branchId).toBe(branch.id)
  })

  it('is idempotent — re-running does not change already-backfilled rows', async () => {
    const { scenes } = await import('../schema')
    const { eq } = await import('drizzle-orm')

    const projectId = await seedProject()
    const branch = await getOrCreateDefaultBranch(projectId)

    const sceneId = crypto.randomUUID()
    await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8 })
    await backfillProjectBranch(projectId)
    await backfillProjectBranch(projectId) // second call should no-op

    const [row] = await db.select({ branchId: scenes.branchId }).from(scenes).where(eq(scenes.id, sceneId))
    expect(row.branchId).toBe(branch.id)
  })

  it('does not overwrite rows that already have a branchId', async () => {
    const { scenes } = await import('../schema')
    const { eq } = await import('drizzle-orm')

    const projectId = await seedProject()
    const main = await getOrCreateDefaultBranch(projectId)
    const other = await createBranch({ projectId, name: 'other' })

    // Insert a scene already pinned to `other` branch
    const sceneId = crypto.randomUUID()
    await db.insert(scenes).values({ id: sceneId, projectId, position: 0, duration: 8, branchId: other.id })

    await backfillProjectBranch(projectId)

    const [row] = await db.select({ branchId: scenes.branchId }).from(scenes).where(eq(scenes.id, sceneId))
    // Should still point to `other`, not the default `main`
    expect(row.branchId).toBe(other.id)
  })
})
