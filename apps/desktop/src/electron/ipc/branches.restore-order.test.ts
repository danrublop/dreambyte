// @vitest-environment node

// Regression pin for the flush-then-lock ordering fix (TODOS P1-7a): the
// whole-branch restore must flush pending autosave version timers INSIDE the
// branch lock, not before acquiring it. Flushing first leaves a gap where a
// late same-process autosave lands between flush and lock and is silently
// reverted by the restore. This test records the call order of the real
// primitives and fails if the flush ever moves back outside the lock.

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-restore-order-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_SCENES_DIR = scenesDir
process.env.CENCH_SCENES_DIR = scenesDir

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Order journal shared with the hoisted mocks below.
const order = vi.hoisted(() => [] as string[])

vi.mock('@/lib/db/queries/scene-versions', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/db/queries/scene-versions')>()
  return {
    ...actual,
    flushAllPendingVersions: async () => {
      order.push('flush')
      return actual.flushAllPendingVersions()
    },
  }
})

vi.mock('@/lib/db/queries/branch-locks', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/db/queries/branch-locks')>()
  return {
    ...actual,
    withBranchLock: (async (args: unknown, fn: (...a: unknown[]) => Promise<unknown>) =>
      actual.withBranchLock(args as never, async (...a: unknown[]) => {
        order.push('lock-acquired')
        return fn(...a)
      })) as typeof actual.withBranchLock,
  }
})

import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, scenes } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { createSceneVersion } from '@/lib/db/queries/scene-versions'
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

describe('restoreToPoint ordering', () => {
  it('flushes pending autosave versions INSIDE the branch lock, never before it', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'RestoreOrder' })
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    const sceneId = crypto.randomUUID()
    const goodBlob = { id: sceneId, reactCode: 'GOOD' }
    await db
      .insert(scenes)
      .values({ id: sceneId, projectId, position: 0, duration: 8, branchId: branch.id, sceneBlob: goodBlob })
    const batchId = crypto.randomUUID()
    await createSceneVersion(db, {
      sceneId,
      branchId: branch.id,
      layerSnapshot: goodBlob,
      operation: 'user_edit',
      source: 'user',
      batchId,
    })

    order.length = 0
    await restoreToPoint({ projectId, branchId: branch.id, key: batchId })

    // The flush must happen, and only after the lock callback has begun.
    expect(order).toContain('flush')
    expect(order).toContain('lock-acquired')
    expect(order.indexOf('lock-acquired')).toBeLessThan(order.indexOf('flush'))
  })
})
