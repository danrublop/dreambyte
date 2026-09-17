// @vitest-environment node

/**
 * Branch-aware `projects.get` — the renderer's
 * save-conflict retry and the 30s refresh poll must be able to fetch the
 * scenes of the branch they operate on. Before this, `get` ALWAYS returned
 * default-branch scenes, so a conflict retry on a non-default branch merged
 * against the wrong document (and refresh poisoned the per-scene baseline,
 * which is keyed by the ACTIVE branch, with main's scene hashes).
 *
 * Pins:
 *  - no branchId → default-branch scenes (the historical contract, unchanged
 *    for loadProject / agent callers);
 *  - branchId → THAT branch's scenes, with `defaultBranchId` still reporting
 *    the default;
 *  - a branchId from another project / unknown / malformed is rejected, never
 *    silently degraded to an empty scene list (an empty "remote" would make
 *    the retry merge believe every scene was deleted).
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { vi } from 'vitest'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-projects-get-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_SCENES_DIR = scenesDir
process.env.CENCH_SCENES_DIR = scenesDir

// projects.ts imports `app` for the packaged published-dir path; stub it so
// the module loads outside Electron (pattern from audio-decode.test.ts).
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpRoot,
    isPackaged: false,
  },
}))

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcMain } from 'electron'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, scenes } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { register } from './projects'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

// Capture every handler register() wires, keyed by channel. projects.get is
// a MULTI-ARG channel — (event, projectId, branchId?) — so the fake passes
// rest args through, unlike the single-args-object harnesses.
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()
const fakeIpc = {
  handle: (channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  },
} as unknown as IpcMain

const callGet = (projectId: string, branchId?: string) => {
  const h = handlers.get('dreambyte:projects.get')
  if (!h) throw new Error('no handler registered for dreambyte:projects.get')
  return h({}, projectId, branchId) as Promise<{
    scenes: Array<{ id: string }>
    defaultBranchId: string
  }>
}

const callUpdate = (projectId: string, updates: Record<string, unknown>) => {
  const h = handlers.get('dreambyte:projects.update')
  if (!h) throw new Error('no handler registered for dreambyte:projects.update')
  return h({}, { projectId, updates })
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

/** One project with a default branch (1 scene) and an alt branch (1 different scene). */
async function seed() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'GetBranch' })
  const main = await createBranch({ projectId, name: 'main', isDefault: true })
  const alt = await createBranch({ projectId, name: 'alt' })
  const mainSceneId = crypto.randomUUID()
  const altSceneId = crypto.randomUUID()
  await db.insert(scenes).values([
    { id: mainSceneId, projectId, position: 0, duration: 8, branchId: main.id, sceneBlob: { id: mainSceneId, reactCode: 'MAIN' } },
    { id: altSceneId, projectId, position: 0, duration: 8, branchId: alt.id, sceneBlob: { id: altSceneId, reactCode: 'ALT' } },
  ])
  return { projectId, mainBranchId: main.id, altBranchId: alt.id, mainSceneId, altSceneId }
}

describe('projects.get branch scoping', () => {
  it('no branchId → default-branch scenes only (historical contract)', async () => {
    const s = await seed()
    const res = await callGet(s.projectId)
    expect(res.scenes.map((x) => x.id)).toEqual([s.mainSceneId])
    expect(res.defaultBranchId).toBe(s.mainBranchId)
  })

  it('branchId → that branch\'s scenes; defaultBranchId still reports the default', async () => {
    const s = await seed()
    const res = await callGet(s.projectId, s.altBranchId)
    expect(res.scenes.map((x) => x.id)).toEqual([s.altSceneId])
    expect(res.defaultBranchId).toBe(s.mainBranchId)
  })

  it('passing the default branch explicitly matches the no-arg result', async () => {
    const s = await seed()
    const explicit = await callGet(s.projectId, s.mainBranchId)
    expect(explicit.scenes.map((x) => x.id)).toEqual([s.mainSceneId])
  })

  it('rejects a branchId that belongs to ANOTHER project (never an empty scene list)', async () => {
    const a = await seed()
    const b = await seed()
    await expect(callGet(a.projectId, b.altBranchId)).rejects.toThrow(/not found/i)
  })

  it('rejects an unknown branchId', async () => {
    const s = await seed()
    await expect(callGet(s.projectId, crypto.randomUUID())).rejects.toThrow(/not found/i)
  })

  it('rejects a malformed branchId (uuid validation, not a silent default fallback)', async () => {
    const s = await seed()
    await expect(callGet(s.projectId, 'not-a-uuid')).rejects.toThrow(/branchId/i)
  })
})

describe('projects.update branch validation (write side)', () => {
  // `baseVersion` is the caller's compare-and-swap baseline; scene writes are
  // rejected without one (see projects.save-safety.test.ts). Seeded projects
  // are freshly inserted, so their version is the column default.
  const sceneUpdate = (sceneId: string, branchId: string) => ({
    scenes: [{ id: sceneId, name: 'w', sceneType: 'react', duration: 5, reactCode: 'W0' }],
    branchId,
    baseVersion: 1,
  })

  it('accepts a branchId that belongs to the project and writes its scenes there', async () => {
    const s = await seed()
    const newSceneId = crypto.randomUUID()
    await callUpdate(s.projectId, sceneUpdate(newSceneId, s.altBranchId))
    const res = await callGet(s.projectId, s.altBranchId)
    expect(res.scenes.map((x) => x.id)).toEqual([newSceneId])
    // The default branch was untouched.
    const main = await callGet(s.projectId)
    expect(main.scenes.map((x) => x.id)).toEqual([s.mainSceneId])
  })

  it('rejects a DELETED branchId loudly instead of stamping scenes onto a dead branch', async () => {
    const s = await seed()
    const { projectBranches } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(projectBranches).where(eq(projectBranches.id, s.altBranchId))
    await expect(callUpdate(s.projectId, sceneUpdate(crypto.randomUUID(), s.altBranchId))).rejects.toThrow(/not found/i)
  })

  it('rejects a branchId from ANOTHER project on the write path too', async () => {
    const a = await seed()
    const b = await seed()
    await expect(callUpdate(a.projectId, sceneUpdate(crypto.randomUUID(), b.altBranchId))).rejects.toThrow(/not found/i)
  })

  it('rejects a malformed branchId on the write path', async () => {
    const s = await seed()
    await expect(callUpdate(s.projectId, sceneUpdate(crypto.randomUUID(), 'not-a-uuid'))).rejects.toThrow(/branchId/i)
  })
})
