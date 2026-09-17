// @vitest-environment node

/**
 * B8 — IPC-level tests for the branches handlers (previously entirely
 * untested; only fork.ts had IPC tests). Exercises the real handlers through
 * `register()` against a captured fake IpcMain, over a real migrated SQLite
 * DB — the same harness shape as fork.test.ts.
 *
 * Covers the gaps the audit called out: the default-delete guard, the
 * BranchLockedError → IpcValidationError translation, cross-project ownership
 * checks, duplicate-name friendly messages, and the restoreToPoint
 * failure path (no half-reverted live rows).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-branches-ipc-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_SCENES_DIR = scenesDir
process.env.CENCH_SCENES_DIR = scenesDir

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcMain } from 'electron'
import { and, eq } from 'drizzle-orm'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, projectBranches, scenes, branchLocks, sceneVersions } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { acquireBranchLock, releaseBranchLock } from '@/lib/db/queries/branch-locks'
import { createSceneVersion } from '@/lib/db/queries/scene-versions'
import { IpcValidationError, IpcNotFoundError } from './_helpers'
import { register, isUniqueViolation } from './branches'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

// Capture every handler register() wires, keyed by channel.
type Handler = (event: unknown, args: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
const fakeIpc = {
  handle: (channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  },
} as unknown as IpcMain

const call = (channel: string, args: unknown) => {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler registered for ${channel}`)
  return h({}, args)
}

beforeAll(async () => {
  mkdirSync(scenesDir, { recursive: true })
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  register(fakeIpc)
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function seedProject(): Promise<{ projectId: string; defaultBranchId: string }> {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Branches IPC', status: 'ready' })
  const branch = await createBranch({ projectId, name: 'main', isDefault: true })
  return { projectId, defaultBranchId: branch.id }
}

async function seedScene(projectId: string, branchId: string, blob?: Record<string, unknown>) {
  const sceneId = crypto.randomUUID()
  await db.insert(scenes).values({
    id: sceneId,
    projectId,
    branchId,
    position: 0,
    duration: 8,
    sceneBlob: blob ?? { id: sceneId, reactCode: 'LIVE' },
  })
  return sceneId
}

describe('branches.create', () => {
  it('creates a branch; duplicate name gets the friendly message, not a raw UNIQUE error', async () => {
    const { projectId } = await seedProject()
    const created = (await call('dreambyte:branches.create', { projectId, name: 'feature' })) as {
      branch: { id: string; name: string }
    }
    expect(created.branch.name).toBe('feature')
    await expect(call('dreambyte:branches.create', { projectId, name: 'feature' })).rejects.toThrow(
      'A branch named "feature" already exists in this project',
    )
  })

  it('rejects empty and over-long names, and a non-uuid projectId', async () => {
    const { projectId } = await seedProject()
    await expect(call('dreambyte:branches.create', { projectId, name: '   ' })).rejects.toBeInstanceOf(
      IpcValidationError,
    )
    await expect(call('dreambyte:branches.create', { projectId, name: 'x'.repeat(101) })).rejects.toBeInstanceOf(
      IpcValidationError,
    )
    await expect(call('dreambyte:branches.create', { projectId: 'nope', name: 'ok' })).rejects.toBeInstanceOf(
      IpcValidationError,
    )
  })

  it('cloning from a source branch copies its scenes under fresh ids', async () => {
    const { projectId, defaultBranchId } = await seedProject()
    const srcSceneId = await seedScene(projectId, defaultBranchId)
    const { branch } = (await call('dreambyte:branches.create', {
      projectId,
      name: 'clone',
      sourceBranchId: defaultBranchId,
    })) as { branch: { id: string } }
    const cloned = await db.select().from(scenes).where(eq(scenes.branchId, branch.id))
    expect(cloned).toHaveLength(1)
    expect(cloned[0].id).not.toBe(srcSceneId) // fresh id, not a shared row
  })
})

describe('branches.rename', () => {
  it('rejects a branch from ANOTHER project (ownership check)', async () => {
    const a = await seedProject()
    const b = await seedProject()
    await expect(
      call('dreambyte:branches.rename', { projectId: a.projectId, id: b.defaultBranchId, name: 'stolen' }),
    ).rejects.toThrow('Branch does not belong to this project')
  })

  it('duplicate target name gets the friendly message; unknown branch is NotFound', async () => {
    const { projectId } = await seedProject()
    const { branch } = (await call('dreambyte:branches.create', { projectId, name: 'other' })) as {
      branch: { id: string }
    }
    await expect(call('dreambyte:branches.rename', { projectId, id: branch.id, name: 'main' })).rejects.toThrow(
      'A branch named "main" already exists in this project',
    )
    await expect(
      call('dreambyte:branches.rename', { projectId, id: crypto.randomUUID(), name: 'x' }),
    ).rejects.toBeInstanceOf(IpcNotFoundError)
  })
})

describe('branches.setDefault', () => {
  it('atomically swaps: exactly ONE default remains, and it is the target', async () => {
    const { projectId, defaultBranchId } = await seedProject()
    const { branch } = (await call('dreambyte:branches.create', { projectId, name: 'next' })) as {
      branch: { id: string }
    }
    await call('dreambyte:branches.setDefault', { projectId, id: branch.id })
    const defaults = await db
      .select()
      .from(projectBranches)
      .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.isDefault, true)))
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(branch.id)
    expect(defaults[0].id).not.toBe(defaultBranchId)
  })

  it('rejects a branch from another project', async () => {
    const a = await seedProject()
    const b = await seedProject()
    await expect(
      call('dreambyte:branches.setDefault', { projectId: a.projectId, id: b.defaultBranchId }),
    ).rejects.toThrow('Branch does not belong to this project')
  })
})

describe('branches.delete', () => {
  it('never deletes the default branch (server-side guard, not just disabled UI)', async () => {
    const { projectId, defaultBranchId } = await seedProject()
    await expect(call('dreambyte:branches.delete', { projectId, id: defaultBranchId })).rejects.toThrow(
      'Cannot delete the default branch',
    )
  })

  it('translates a foreign live lock into IpcValidationError (BranchLockedError surface)', async () => {
    const { projectId } = await seedProject()
    const { branch } = (await call('dreambyte:branches.create', { projectId, name: 'locked' })) as {
      branch: { id: string }
    }
    // Another window/process holds a live lock on this branch.
    await acquireBranchLock({ branchId: branch.id, projectId, operation: 'fork', ownerId: 'other-window' })
    try {
      await expect(call('dreambyte:branches.delete', { projectId, id: branch.id })).rejects.toBeInstanceOf(
        IpcValidationError,
      )
      // The branch must still exist — the lock blocked the cascade entirely.
      const rows = await db.select().from(projectBranches).where(eq(projectBranches.id, branch.id))
      expect(rows).toHaveLength(1)
    } finally {
      await releaseBranchLock(branch.id, 'other-window')
    }
  })

  it('deletes the branch cascade: scenes, versions, the branch_locks row, and HTML files', async () => {
    const { projectId } = await seedProject()
    const { branch } = (await call('dreambyte:branches.create', { projectId, name: 'doomed' })) as {
      branch: { id: string }
    }
    const sceneId = await seedScene(projectId, branch.id)
    await createSceneVersion(db, {
      sceneId,
      branchId: branch.id,
      layerSnapshot: { id: sceneId },
      operation: 'user_edit',
      source: 'user',
      batchId: crypto.randomUUID(),
    })
    const htmlPath = path.join(scenesDir, `${sceneId}.html`)
    writeFileSync(htmlPath, '<html></html>')
    // A stale lock row owned by a crashed holder must not survive the branch.
    // HONESTY NOTE: under this test connection PRAGMA
    // foreign_keys=ON, so the lock/version rows would ALSO disappear via FK
    // ON DELETE CASCADE even without deleteBranch's explicit deletes — this
    // pins the user-visible "no survivors" invariant, NOT the explicit-delete
    // mechanism (which exists for connections where FK enforcement is off).
    await db.insert(branchLocks).values({
      branchId: branch.id,
      projectId,
      ownerId: 'crashed-holder',
      operation: 'fork',
      heartbeatAt: new Date(0),
      createdAt: new Date(0),
    })

    const res = (await call('dreambyte:branches.delete', { projectId, id: branch.id })) as {
      success: boolean
      deletedSceneCount: number
    }
    expect(res.success).toBe(true)
    expect(res.deletedSceneCount).toBe(1)
    expect(await db.select().from(scenes).where(eq(scenes.branchId, branch.id))).toHaveLength(0)
    expect(await db.select().from(sceneVersions).where(eq(sceneVersions.sceneId, sceneId))).toHaveLength(0)
    expect(await db.select().from(branchLocks).where(eq(branchLocks.branchId, branch.id))).toHaveLength(0)
    expect(existsSync(htmlPath)).toBe(false)
  })

  it('unknown branch is NotFound; cross-project is rejected', async () => {
    const a = await seedProject()
    const b = await seedProject()
    await expect(call('dreambyte:branches.delete', { projectId: a.projectId, id: crypto.randomUUID() })).rejects.toBeInstanceOf(
      IpcNotFoundError,
    )
    await expect(
      call('dreambyte:branches.delete', { projectId: a.projectId, id: b.defaultBranchId }),
    ).rejects.toThrow('Branch does not belong to this project')
  })
})

describe('branches.restoreVersion ownership', () => {
  it("rejects restoring a version that belongs to another project's scene", async () => {
    const a = await seedProject()
    const b = await seedProject()
    const bScene = await seedScene(b.projectId, b.defaultBranchId)
    const v = await createSceneVersion(db, {
      sceneId: bScene,
      branchId: b.defaultBranchId,
      layerSnapshot: { id: bScene },
      operation: 'user_edit',
      source: 'user',
      batchId: crypto.randomUUID(),
    })
    await expect(
      call('dreambyte:branches.restoreVersion', { projectId: a.projectId, versionId: v.id }),
    ).rejects.toThrow('Version does not belong to this project')
  })
})

describe('branches.restoreToPoint failure path', () => {
  // HONESTY NOTE: an unknown key throws on restoreBranchToBatch's
  // FIRST READ, before any write — so the untouched-blob assertion here pins
  // "failure happened inside the locked section and nothing was written", NOT
  // transactional rollback. The true mid-transaction rollback pin lives in
  // branches.restore-rollback.test.ts (forced failure AFTER an in-tx write).
  it('an unknown history key throws from inside the restore, writes nothing, and releases the lock', async () => {
    const { projectId, defaultBranchId } = await seedProject()
    const liveBlob = { id: 'x', reactCode: 'LIVE-CODE' }
    const sceneId = await seedScene(projectId, defaultBranchId, liveBlob)
    await createSceneVersion(db, {
      sceneId,
      branchId: defaultBranchId,
      layerSnapshot: { id: sceneId, reactCode: 'OLD-CODE' },
      operation: 'user_edit',
      source: 'user',
      batchId: crypto.randomUUID(),
    })

    await expect(
      call('dreambyte:branches.restoreToPoint', { projectId, branchId: defaultBranchId, key: crypto.randomUUID() }),
    ).rejects.toThrow(/No history entry/) // the in-restore throw, not a pre-flight validation reject

    const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
    expect(row.sceneBlob).toEqual(liveBlob) // nothing was written
    // The lock must have been released despite the throw.
    const lock = await acquireBranchLock({
      branchId: defaultBranchId,
      projectId,
      operation: 'restore',
      ownerId: 'post-failure-probe',
    })
    expect(lock.acquired).toBe(true)
    await releaseBranchLock(defaultBranchId, 'post-failure-probe')
  })
})

describe('branches.create lock translation', () => {
  it('a foreign live lock on the default branch surfaces as IpcValidationError (the most user-facing path)', async () => {
    const { projectId, defaultBranchId } = await seedProject()
    // create() anchors its project-scoped lock on the default branch.
    await acquireBranchLock({ branchId: defaultBranchId, projectId, operation: 'fork', ownerId: 'other-window' })
    try {
      await expect(call('dreambyte:branches.create', { projectId, name: 'blocked' })).rejects.toBeInstanceOf(
        IpcValidationError,
      )
    } finally {
      await releaseBranchLock(defaultBranchId, 'other-window')
    }
  })
})

describe('isUniqueViolation (unit)', () => {
  it('finds UNIQUE on the cause chain (the drizzle wrapping that broke the old check)', () => {
    const cause = new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: project_branches.name')
    const wrapped = new Error('Failed query: insert into "project_branches" …')
    ;(wrapped as Error & { cause: unknown }).cause = cause
    expect(isUniqueViolation(wrapped)).toBe(true)
    expect(isUniqueViolation(cause)).toBe(true) // top-level still works
  })

  it('does not match unrelated errors, non-Error causes, or lowercase free text', () => {
    expect(isUniqueViolation(new Error('NOT NULL constraint failed'))).toBe(false)
    expect(isUniqueViolation('plain string without the word')).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    // Lowercase 'unique' in a human-authored message must NOT trigger the
    // friendly duplicate-name lie (the match is narrowed to SQLite's
    // exact uppercase wording).
    expect(isUniqueViolation(new Error('branch names should be unique-ish'))).toBe(false)
  })

  it('terminates on a cyclic cause chain instead of hanging the main process', () => {
    const cyclic = new Error('no match here')
    ;(cyclic as Error & { cause: unknown }).cause = cyclic
    expect(isUniqueViolation(cyclic)).toBe(false)
  })
})
