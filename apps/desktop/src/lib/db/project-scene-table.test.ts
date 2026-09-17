// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-scene-table-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from './migrate'
import { db, closeDb } from './index'
import { projects, scenes } from './schema'
import { eq, and } from 'drizzle-orm'
import { createBranch } from './queries/branches'
import { readProjectScenesFromTables, writeProjectScenesToTables } from './project-scene-table'
import type { Scene, SceneGraph } from '@/lib/types'

const migrationsFolder = path.resolve(__dirname, './migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedProject() {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `Test Project ${id.slice(0, 6)}` })
  return id
}

function makeScene(projectId: string, branchId: string): Scene {
  return {
    id: crypto.randomUUID(),
    projectId,
    branchId,
    name: 'Test Scene',
    prompt: '',
    summary: '',
    svgContent: '',
    duration: 8,
    bgColor: '#000000',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'none',
    usage: null,
    sceneType: 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    chartLayers: [],
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {},
    cameraMotion: null,
    worldConfig: null,
  } as unknown as Scene
}

describe('writeProjectScenesToTables — branch isolation (P0 regression)', () => {
  it('saving branch A scenes does NOT delete branch B scenes', async () => {
    const projectId = await seedProject()
    const branchA = await createBranch({ projectId, name: 'main', isDefault: true })
    const branchB = await createBranch({ projectId, name: 'feature' })

    // Insert 2 scenes on branch B directly
    const bSceneId1 = crypto.randomUUID()
    const bSceneId2 = crypto.randomUUID()
    await db.insert(scenes).values([
      { id: bSceneId1, projectId, branchId: branchB.id, position: 0, duration: 8 },
      { id: bSceneId2, projectId, branchId: branchB.id, position: 1, duration: 8 },
    ])

    // Now save 1 scene to branch A
    const aScene = makeScene(projectId, branchA.id)
    await writeProjectScenesToTables(projectId, [aScene], null, branchA.id)

    // Branch B scenes must still exist
    const bRows = await db
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchB.id)))
    expect(bRows).toHaveLength(2)
    expect(bRows.map((r) => r.id)).toContain(bSceneId1)
    expect(bRows.map((r) => r.id)).toContain(bSceneId2)
  })

  it('saving branch A scenes only removes branch A scenes not in the incoming set', async () => {
    const projectId = await seedProject()
    const branchA = await createBranch({ projectId, name: 'main', isDefault: true })

    // Start with 3 scenes on branch A
    const oldIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await db
      .insert(scenes)
      .values(oldIds.map((id, i) => ({ id, projectId, branchId: branchA.id, position: i, duration: 8 })))

    // Save 1 new scene to branch A (replacing the 3 old ones)
    const newScene = makeScene(projectId, branchA.id)
    await writeProjectScenesToTables(projectId, [newScene], null, branchA.id)

    const aRows = await db
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchA.id)))

    expect(aRows).toHaveLength(1)
    expect(aRows[0].id).toBe(newScene.id)
    // Old scenes are gone
    for (const old of oldIds) {
      expect(aRows.map((r) => r.id)).not.toContain(old)
    }
  })

  it('inserted scenes have the correct branchId stamped', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    const scene = makeScene(projectId, branch.id)
    await writeProjectScenesToTables(projectId, [scene], null, branch.id)

    const [row] = await db.select({ branchId: scenes.branchId }).from(scenes).where(eq(scenes.id, scene.id))

    expect(row.branchId).toBe(branch.id)
  })

  it('calling without branchId (legacy path) still saves scenes', async () => {
    const projectId = await seedProject()
    const scene = makeScene(projectId, '')
    // No branchId — backward-compat path
    await writeProjectScenesToTables(projectId, [scene], null)

    const [row] = await db
      .select({ id: scenes.id, branchId: scenes.branchId })
      .from(scenes)
      .where(eq(scenes.id, scene.id))

    expect(row.id).toBe(scene.id)
    expect(row.branchId).toBeNull()
  })
})

describe('writeProjectScenesToTables — empty-set wipe guard (P2 regression)', () => {
  async function branchSceneIds(projectId: string, branchId: string): Promise<string[]> {
    const rows = await db
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchId)))
    return rows.map((r) => r.id)
  }

  it('an EMPTY incoming set (persist filter artifact) does NOT wipe a populated branch', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    // Two real, coded scenes already persisted on the branch.
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    await db
      .insert(scenes)
      .values(ids.map((id, i) => ({ id, projectId, branchId: branch.id, position: i, duration: 8 })))

    // Agent persist path: cleanScenesForAgentPersistence returned [] (a swept
    // never-coded shell). No intentionalClear signal → must be REFUSED.
    await writeProjectScenesToTables(projectId, [], null, branch.id)

    const remaining = await branchSceneIds(projectId, branch.id)
    expect(remaining).toHaveLength(2)
    expect(remaining.sort()).toEqual([...ids].sort())
  })

  it('an all-non-UUID incoming set (legacy slug ids filtered out) does NOT wipe a populated branch', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    const realId = crypto.randomUUID()
    await db.insert(scenes).values({ id: realId, projectId, branchId: branch.id, position: 0, duration: 8 })

    // Caller DID provide a scene, but its id is a legacy slug → filtered to [].
    // Emptiness is a filter artifact, so the wipe must be refused even though
    // intentionalClear is set (a provided-but-filtered set is never a clear).
    const slugScene = { ...makeScene(projectId, branch.id), id: 'legacy-slug-scene' } as unknown as Scene
    await writeProjectScenesToTables(projectId, [slugScene], null, branch.id, { intentionalClear: true })

    const remaining = await branchSceneIds(projectId, branch.id)
    expect(remaining).toEqual([realId])
  })

  it('a REAL clear (empty set + intentionalClear) still wipes the branch', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    await db
      .insert(scenes)
      .values(ids.map((id, i) => ({ id, projectId, branchId: branch.id, position: i, duration: 8 })))

    // User deleted every scene — store-authoritative clear.
    await writeProjectScenesToTables(projectId, [], null, branch.id, { intentionalClear: true })

    const remaining = await branchSceneIds(projectId, branch.id)
    expect(remaining).toHaveLength(0)
  })

  it('an empty set on an already-empty branch is a harmless no-op', async () => {
    const projectId = await seedProject()
    const branch = await createBranch({ projectId, name: 'main', isDefault: true })

    // No prior rows, no signal — nothing to lose, no throw.
    await writeProjectScenesToTables(projectId, [], null, branch.id)

    const remaining = await branchSceneIds(projectId, branch.id)
    expect(remaining).toHaveLength(0)
  })
})

describe('readProjectScenesFromTables — cross-branch node/edge orphan guard (P2 regression)', () => {
  it("a branch read never surfaces another branch's nodes or edges", async () => {
    const projectId = await seedProject()
    const branchA = await createBranch({ projectId, name: 'main', isDefault: true })
    const branchB = await createBranch({ projectId, name: 'feature' })

    // Branch A: two scenes + a node per scene + an edge between them.
    const a1 = makeScene(projectId, branchA.id)
    const a2 = makeScene(projectId, branchA.id)
    const graphA: SceneGraph = {
      nodes: [
        { id: a1.id, position: { x: 10, y: 10 } },
        { id: a2.id, position: { x: 20, y: 20 } },
      ],
      edges: [
        {
          id: crypto.randomUUID(),
          fromSceneId: a1.id,
          toSceneId: a2.id,
          condition: { type: 'auto', interactionId: null, variableName: null, variableValue: null },
        },
      ],
      startSceneId: a1.id,
    }
    await writeProjectScenesToTables(projectId, [a1, a2], graphA, branchA.id)

    // Branch B: a single scene + its own node, no edges.
    const b1 = makeScene(projectId, branchB.id)
    const graphB: SceneGraph = {
      nodes: [{ id: b1.id, position: { x: 99, y: 99 } }],
      edges: [],
      startSceneId: b1.id,
    }
    await writeProjectScenesToTables(projectId, [b1], graphB, branchB.id)

    // Reading branch B must NOT leak branch A's nodes/edges (they share projectId
    // because scene_nodes/scene_edges have no branch_id column).
    const readB = await readProjectScenesFromTables(projectId, branchB.id)
    expect(readB).not.toBeNull()
    expect(readB!.scenes.map((s) => s.id)).toEqual([b1.id])
    expect(readB!.sceneGraph.nodes.map((n) => n.id).sort()).toEqual([b1.id])
    expect(readB!.sceneGraph.edges).toHaveLength(0)
    expect(readB!.sceneGraph.startSceneId).toBe(b1.id)

    // Sanity: branch A still reads its own full graph.
    const readA = await readProjectScenesFromTables(projectId, branchA.id)
    expect(readA!.sceneGraph.nodes.map((n) => n.id).sort()).toEqual([a1.id, a2.id].sort())
    expect(readA!.sceneGraph.edges).toHaveLength(1)
  })
})
