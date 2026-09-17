// @vitest-environment node

/**
 * Three data-loss defects in the ONE path every renderer save funnels through
 * (`dreambyte:projects.update`). Each test fails against the pre-fix handler.
 *
 *  P0-1  The "optimistic lock" read its OWN baseline, so it always matched and
 *        the last writer won. A 30s-poll save or a visibilitychange flush
 *        (Cmd+Tab / Cmd+Q / Cmd+H) carrying a PRE-RUN scene array therefore
 *        overwrote everything an agent had written mid-run — and reported
 *        success. Fixed by CAS-ing against a caller-supplied `baseVersion`.
 *
 *  P0-2  A scene write with a null `branchId` degrades EVERY delete in
 *        `writeProjectScenesToTables` to project-wide: other branches' scenes,
 *        plus their scene_nodes / scene_edges. `intentionalClear` never gated
 *        that (it only guards the empty-input case). Fixed by resolving the
 *        default branch — the same one the READ path uses — so the UI path can
 *        never issue a project-wide delete.
 *
 *  P0-3  The scene-table mirror was a SECOND transaction whose failure was
 *        swallowed as "blob is source of truth". False: `get()` reads the
 *        mirror FIRST, so a failed mirror write left the new blob committed and
 *        the stale mirror serving every read. Fixed by making the two one
 *        transaction.
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { vi } from 'vitest'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-save-safety-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_SCENES_DIR = scenesDir
process.env.CENCH_SCENES_DIR = scenesDir

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot, isPackaged: false },
}))

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IpcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, scenes, sceneNodes, sceneEdges } from '@/lib/db/schema'
import { createBranch } from '@/lib/db/queries/branches'
import { register } from './projects'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()
const fakeIpc = {
  handle: (channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  },
} as unknown as IpcMain

const callUpdate = (projectId: string, updates: Record<string, unknown>) => {
  const h = handlers.get('dreambyte:projects.update')
  if (!h) throw new Error('no handler registered for dreambyte:projects.update')
  return h({}, { projectId, updates })
}

const sceneOf = (id: string, code: string) => ({
  id,
  name: id,
  sceneType: 'react',
  duration: 5,
  reactCode: code,
})

async function projectRow(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId))
  return row
}

async function sceneIds(projectId: string): Promise<string[]> {
  const rows = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.projectId, projectId))
  return rows.map((r) => r.id).sort()
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

describe('P0-1 — a stale renderer save cannot overwrite an agent mid-run', () => {
  it('rejects the save whose baseVersion predates the agent write, and keeps the agent scenes', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'AgentRace' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })

    // The renderer opened the project and holds one scene.
    const preRunSceneId = crypto.randomUUID()
    await db.insert(scenes).values({
      id: preRunSceneId,
      projectId,
      position: 0,
      duration: 8,
      branchId: main.id,
      sceneBlob: { id: preRunSceneId, reactCode: 'PRE' },
    })
    const observedVersion = (await projectRow(projectId)).version ?? 1

    // The agent run lands two more scenes and bumps the project version — the
    // renderer never sees this (autosave is gated off during runs).
    const agentSceneIds = [crypto.randomUUID(), crypto.randomUUID()]
    await db.insert(scenes).values(
      agentSceneIds.map((id, i) => ({
        id,
        projectId,
        position: i + 1,
        duration: 8,
        branchId: main.id,
        sceneBlob: { id, reactCode: 'AGENT' },
      })),
    )
    await db
      .update(projects)
      .set({ version: (observedVersion ?? 1) + 1 })
      .where(eq(projects.id, projectId))

    // Cmd+Tab: the visibilitychange flush ships the PRE-RUN array.
    await expect(
      callUpdate(projectId, {
        scenes: [sceneOf(preRunSceneId, 'PRE')],
        branchId: main.id,
        baseVersion: observedVersion,
      }),
    ).rejects.toThrow(/modified concurrently/i)

    expect(await sceneIds(projectId)).toEqual([preRunSceneId, ...agentSceneIds].sort())
  })

  it('accepts the same save once the caller refreshes its baseline (the retry path)', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'AgentRaceRetry' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const sceneId = crypto.randomUUID()

    const v = (await projectRow(projectId)).version ?? 1
    await callUpdate(projectId, {
      scenes: [sceneOf(sceneId, 'OK')],
      branchId: main.id,
      baseVersion: v,
    })
    expect(await sceneIds(projectId)).toEqual([sceneId])
    expect((await projectRow(projectId)).version).toBe(v + 1)
  })

  it('refuses a scene write with no baseline at all rather than defaulting to last-writer-wins', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'NoBaseline' })
    await expect(callUpdate(projectId, { scenes: [sceneOf(crypto.randomUUID(), 'X')] })).rejects.toThrow(
      /baseVersion is required/i,
    )
  })
})

describe('P0-2 — a null branchId must not wipe other branches', () => {
  it('leaves the other branch\'s scenes, nodes and edges intact', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'CrossBranch' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const alt = await createBranch({ projectId, name: 'alt' })

    const mainSceneId = crypto.randomUUID()
    const altSceneA = crypto.randomUUID()
    const altSceneB = crypto.randomUUID()
    await db.insert(scenes).values([
      { id: mainSceneId, projectId, position: 0, duration: 8, branchId: main.id, sceneBlob: { id: mainSceneId } },
      { id: altSceneA, projectId, position: 0, duration: 8, branchId: alt.id, sceneBlob: { id: altSceneA } },
      { id: altSceneB, projectId, position: 1, duration: 8, branchId: alt.id, sceneBlob: { id: altSceneB } },
    ])
    await db.insert(sceneNodes).values([
      { projectId, sceneId: altSceneA, position: { x: 0, y: 0 } },
      { projectId, sceneId: altSceneB, position: { x: 300, y: 0 } },
    ])
    await db.insert(sceneEdges).values([
      {
        id: crypto.randomUUID(),
        projectId,
        fromSceneId: altSceneA,
        toSceneId: altSceneB,
        condition: { type: 'auto', interactionId: null, variableName: null, variableValue: null },
      },
    ])

    // A save that never resolved its branch — branchId omitted entirely.
    const v = (await projectRow(projectId)).version ?? 1
    await callUpdate(projectId, { scenes: [sceneOf(mainSceneId, 'MAIN')], baseVersion: v })

    expect(await sceneIds(projectId)).toEqual([mainSceneId, altSceneA, altSceneB].sort())
    const nodes = await db.select().from(sceneNodes).where(eq(sceneNodes.projectId, projectId))
    expect(nodes).toHaveLength(2)
    const edges = await db.select().from(sceneEdges).where(eq(sceneEdges.projectId, projectId))
    expect(edges).toHaveLength(1)
  })

  it('a genuine delete-all still clears the writer\'s own branch only', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'ClearOwnBranch' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const alt = await createBranch({ projectId, name: 'alt' })
    const mainSceneId = crypto.randomUUID()
    const altSceneId = crypto.randomUUID()
    await db.insert(scenes).values([
      { id: mainSceneId, projectId, position: 0, duration: 8, branchId: main.id, sceneBlob: { id: mainSceneId } },
      { id: altSceneId, projectId, position: 0, duration: 8, branchId: alt.id, sceneBlob: { id: altSceneId } },
    ])

    const v = (await projectRow(projectId)).version ?? 1
    await callUpdate(projectId, { scenes: [], branchId: main.id, baseVersion: v })

    expect(await sceneIds(projectId)).toEqual([altSceneId])
  })
})

describe('P0-3 — the project row and the scene mirror commit together', () => {
  it('rolls the blob back when the mirror write fails, instead of swallowing it', async () => {
    // A scene id that already belongs to ANOTHER project makes
    // writeProjectScenesToTables throw ("scene id collision across projects") —
    // the real-world equivalent of the SQLITE_BUSY the old code logged away.
    const otherProjectId = crypto.randomUUID()
    await db.insert(projects).values({ id: otherProjectId, name: 'Owner' })
    const stolenSceneId = crypto.randomUUID()
    await db.insert(scenes).values({
      id: stolenSceneId,
      projectId: otherProjectId,
      position: 0,
      duration: 8,
      sceneBlob: { id: stolenSceneId },
    })

    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'Atomic' })
    const before = await projectRow(projectId)

    await expect(
      callUpdate(projectId, {
        name: 'renamed-by-the-failed-save',
        scenes: [sceneOf(stolenSceneId, 'BOOM')],
        baseVersion: before.version ?? 1,
      }),
    ).rejects.toThrow(/collision/i)

    const after = await projectRow(projectId)
    // Nothing committed: the caller sees an error AND the row is untouched, so
    // the blob can never disagree with the mirror `get()` reads first.
    expect(after.version).toBe(before.version)
    expect(after.name).toBe(before.name)
    expect(after.description).toBe(before.description)
    expect(await sceneIds(projectId)).toEqual([])
  })
})
