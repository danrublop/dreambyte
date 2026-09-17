// @vitest-environment node

/**
 * TRUE mid-transaction rollback pin for restoreToPoint: the
 * unknown-key test in branches.test.ts throws on the first READ, before any
 * write — it can't prove rollback. Here restoreBranchToBatch is overridden to
 * perform a REAL in-transaction write (a marker version row) and then throw,
 * so the assertion that the marker is gone pins that the handler's
 * db.transaction actually rolls back partial restore work (the data-loss
 * path B8 called out), and that the branch lock is released afterwards.
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-restore-rollback-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_SCENES_DIR = scenesDir
process.env.CENCH_SCENES_DIR = scenesDir

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/queries/scene-versions', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/db/queries/scene-versions')>()
  return {
    ...actual,
    // Write a real row THROUGH the handler's tx, then fail — the row must
    // not survive if the transaction rolls back.
    restoreBranchToBatch: async (tx: never, branchId: string) => {
      const { sceneVersions } = await import('@/lib/db/schema')
      await (tx as typeof import('@/lib/db').db).insert(sceneVersions).values({
        sceneId: (globalThis as Record<string, unknown>).__rollbackSceneId as string,
        branchId,
        versionNumber: 999,
        layerSnapshot: { marker: 'PARTIAL-RESTORE-WRITE' },
        operation: 'restore',
        source: 'restore',
        batchId: 'rollback-probe',
      })
      throw new Error('forced mid-restore failure (after in-tx write)')
    },
  }
})

import { eq, and } from 'drizzle-orm'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, scenes, sceneVersions } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { acquireBranchLock, releaseBranchLock } from '@/lib/db/queries/branch-locks'
import { restoreToPoint } from './branches'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

beforeAll(async () => {
  mkdirSync(scenesDir, { recursive: true })
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('restoreToPoint mid-transaction failure', () => {
  it('rolls back the partial in-tx write and releases the lock', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'RollbackPin' })
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })
    const sceneId = crypto.randomUUID()
    ;(globalThis as Record<string, unknown>).__rollbackSceneId = sceneId
    await db
      .insert(scenes)
      .values({ id: sceneId, projectId, branchId: branch.id, position: 0, duration: 8, sceneBlob: { id: sceneId } })

    await expect(restoreToPoint({ projectId, branchId: branch.id, key: crypto.randomUUID() })).rejects.toThrow(
      'forced mid-restore failure',
    )

    // The marker row written INSIDE the transaction must not have survived.
    const markers = await db
      .select()
      .from(sceneVersions)
      .where(and(eq(sceneVersions.sceneId, sceneId), eq(sceneVersions.versionNumber, 999)))
    expect(markers).toHaveLength(0)

    // And the branch lock was released despite the throw.
    const lock = await acquireBranchLock({
      branchId: branch.id,
      projectId,
      operation: 'restore',
      ownerId: 'rollback-probe',
    })
    expect(lock.acquired).toBe(true)
    await releaseBranchLock(branch.id, 'rollback-probe')
  })
})
