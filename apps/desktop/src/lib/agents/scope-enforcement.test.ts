// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { executeTool, collectTargetedSceneIds, type WorldStateMutable } from './tool-executor'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

/**
 * Execution-time enforcement for delegated sub-agents (Workstream C.2).
 *
 * Two guards, both checked inside executeTool() so they hold no matter which
 * provider path or tool the model emits:
 *  - C.2b toolset enforcement: a sub-agent may only run tools in its resolved
 *    `enforcedToolNames` set (its offered toolset), not just be *offered* them.
 *  - C.2a scene-scope (TaskPacket): a sub-agent may only mutate the scene it
 *    owns (plus scenes it creates); pre-existing scenes it doesn't own are
 *    read-only context.
 */

function twoSceneWorld(overrides?: Partial<WorldStateMutable>): WorldStateMutable {
  const owned = { ...createDefaultScene(), id: 'owned', name: 'Owned' }
  const foreign = { ...createDefaultScene(), id: 'foreign', name: 'Foreign' }
  return {
    scenes: [owned, foreign],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([owned, foreign]).sceneGraph,
    ...overrides,
  }
}

describe('execution-time toolset enforcement (C.2b)', () => {
  it('rejects a tool that is not in the sub-agent enforced set', async () => {
    const world = twoSceneWorld({
      // Sub-agent was offered only scene_props — but the model emits
      // delete_scene anyway. Enforcement must block it at execute time.
      enforcedToolNames: new Set(['scene_props']),
    })
    const result = await executeTool('delete_scene', { sceneId: 'owned' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not available for this scene/i)
    // State untouched — both scenes still present.
    expect(world.scenes).toHaveLength(2)
  })

  it('allows a tool that IS in the enforced set', async () => {
    const world = twoSceneWorld({
      enforcedToolNames: new Set(['scene_props']),
    })
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'owned', duration: 11 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.find((s) => s.id === 'owned')?.duration).toBe(11)
  })

  it('does not restrict the parent (no enforced set)', async () => {
    const world = twoSceneWorld() // no enforcedToolNames
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'owned', duration: 13 }, world)
    expect(result.success).toBe(true)
  })

  // Phase 3 — plan mode reuses this SAME primitive: the parent "wears" the Plan
  // toolset (enforcedToolNames = Plan set) so it physically cannot mutate scenes
  // before the user approves the plan. write_plan IS allowed; create_scene is not.
  it('plan-mode parent (Plan enforced set) rejects a mutating tool but allows write_plan', async () => {
    const planSet = new Set([
      'web_search',
      'fetch_url_content',
      'read_scene_code',
      'read_editor_state',
      'write_plan',
      'update_todos',
    ])
    const blocked = await executeTool(
      'create_scene',
      { name: 'x', sceneType: 'react', duration: 6 },
      twoSceneWorld({ enforcedToolNames: planSet }),
    )
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/not available for this scene/i)

    const allowed = await executeTool(
      'write_plan',
      { plan: 'Build it.' },
      twoSceneWorld({ enforcedToolNames: planSet }),
    )
    expect(allowed.success).toBe(true)
  })
})

describe('scene-scope enforcement / TaskPacket (C.2a)', () => {
  it('rejects a mutating tool targeting a scene outside the packet scope', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
    const before = world.scenes.find((s) => s.id === 'foreign')?.duration
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'foreign', duration: 99 }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/outside your assigned scope/i)
    // The foreign scene was not mutated.
    expect(world.scenes.find((s) => s.id === 'foreign')?.duration).toBe(before)
  })

  it('allows a mutating tool targeting the owned scene', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
    const result = await executeTool('scene_props', { op: 'duration', sceneId: 'owned', duration: 7 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.find((s) => s.id === 'owned')?.duration).toBe(7)
  })

  it('does not block read-only tools even on a foreign scene', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
    // read_scene_code is not tagged `mutates` → scope guard ignores it.
    const result = await executeTool('read_scene_code', { sceneId: 'foreign' }, world)
    // It may succeed or fail for unrelated reasons (empty scene), but it must
    // NOT be rejected by the scope guard.
    expect(result.error ?? '').not.toMatch(/outside your assigned scope/i)
  })

  it('allows creating a new scene (no sceneId arg) under scope restriction', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['owned', 'foreign']) })
    // A sub-agent dispatched to *create* a scene owns none of the existing ones.
    // create_scene has no sceneId arg → not blocked.
    const result = await executeTool('create_scene', { name: 'Fresh', sceneType: 'react', duration: 6 }, world)
    expect(result.error ?? '').not.toMatch(/outside your assigned scope/i)
  })
})

describe('collectTargetedSceneIds — scope check covers all scene-id args (C.2 #2)', () => {
  it('collects sceneId, fromSceneId/toSceneId, and sceneIds[] — not just sceneId', () => {
    expect(collectTargetedSceneIds({ sceneId: 'a' })).toEqual(['a'])
    expect(collectTargetedSceneIds({ fromSceneId: 'a', toSceneId: 'b' })).toEqual(['a', 'b'])
    expect(collectTargetedSceneIds({ sceneIds: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c'])
    expect(collectTargetedSceneIds({ sourceSceneId: 'a', targetSceneId: 'b' })).toEqual(['a', 'b'])
  })

  it('ignores non-string and unrelated args', () => {
    expect(collectTargetedSceneIds({ fromIndex: 0, toIndex: 1, duration: 5 })).toEqual([])
    expect(collectTargetedSceneIds({ sceneId: 42, sceneIds: ['a', 7, null] })).toEqual(['a'])
  })
})
