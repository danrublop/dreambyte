// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createSceneToolHandler } from './scene-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

/**
 * Direct coverage for scene-tools mutations. Covers all 7 cases.
 * The action-emit side-effect is covered separately by
 * `action-emitter.test.ts`.
 */

function makeScene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id,
    sceneType: 'react',
    duration: 8,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    transition: 'none',
    ...overrides,
  } as Scene
}

function makeWorld(scenes: Scene[]): WorldStateMutable {
  return {
    scenes,
    globalStyle: {} as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scenes[0]?.id ?? null } as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createSceneToolHandler({
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('scene-tools — mutation sites', () => {
  it('create_scene appends a scene at the end by default', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B')])
    const result = await handler('create_scene', { name: 'C', prompt: 'p', duration: 10 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.length).toBe(3)
    expect(world.scenes[2].id).toBe(result.affectedSceneId)
    expect(world.scenes[2].name).toBe('C')
  })

  it('create_scene clamps duration to [6, 30]', async () => {
    const world = makeWorld([])
    await handler('create_scene', { name: 'x', prompt: 'p', duration: 100 }, world)
    expect(world.scenes[0].duration).toBe(30)
    await handler('create_scene', { name: 'y', prompt: 'p', duration: 1 }, world)
    expect(world.scenes[1].duration).toBe(6)
  })

  it('create_scene respects in-range position', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B'), makeScene('C')])
    await handler('create_scene', { name: 'X', prompt: 'p', duration: 8, position: 1 }, world)
    expect(world.scenes[1].name).toBe('X')
    expect(world.scenes[0].id).toBe('A')
    expect(world.scenes[2].id).toBe('B')
  })

  it('delete_scene removes the matching scene', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B'), makeScene('C')])
    const result = await handler('delete_scene', { sceneId: 'B' }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.map((s) => s.id)).toEqual(['A', 'C'])
  })

  it('delete_scene errors on unknown sceneId', async () => {
    const world = makeWorld([makeScene('A')])
    const result = await handler('delete_scene', { sceneId: 'nope' }, world)
    expect(result.success).toBe(false)
    expect(world.scenes.length).toBe(1)
  })

  it('duplicate_scene inserts a copy directly after the source', async () => {
    const world = makeWorld([makeScene('A', { name: 'orig' }), makeScene('B')])
    const result = await handler('duplicate_scene', { sceneId: 'A' }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.length).toBe(3)
    expect(world.scenes[0].id).toBe('A')
    expect(world.scenes[1].name).toBe('orig (copy)')
    expect(world.scenes[1].id).not.toBe('A')
    expect(world.scenes[2].id).toBe('B')
  })

  it('duplicate_scene regenerates ids for nested interactions', async () => {
    const world = makeWorld([
      makeScene('A', {
        interactions: [
          { id: 'i1', type: 'hotspot' } as Scene['interactions'][number],
          { id: 'i2', type: 'hotspot' } as Scene['interactions'][number],
        ],
      }),
    ])
    await handler('duplicate_scene', { sceneId: 'A' }, world)
    const copyInteractions = world.scenes[1].interactions
    expect(copyInteractions.length).toBe(2)
    expect(copyInteractions[0].id).not.toBe('i1')
    expect(copyInteractions[1].id).not.toBe('i2')
  })

  it('reorder_scenes swaps positions', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B'), makeScene('C')])
    const result = await handler('reorder_scenes', { fromIndex: 0, toIndex: 2 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.map((s) => s.id)).toEqual(['B', 'C', 'A'])
  })

  it('reorder_scenes errors on out-of-range indices', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B')])
    expect((await handler('reorder_scenes', { fromIndex: 99, toIndex: 0 }, world)).success).toBe(false)
    expect((await handler('reorder_scenes', { fromIndex: 0, toIndex: -1 }, world)).success).toBe(false)
  })

  it('set_scene_duration clamps to [3, 30]', async () => {
    const world = makeWorld([makeScene('A', { duration: 5 })])
    await handler('set_scene_duration', { sceneId: 'A', duration: 100 }, world)
    expect(world.scenes[0].duration).toBe(30)
    await handler('set_scene_duration', { sceneId: 'A', duration: 0 }, world)
    expect(world.scenes[0].duration).toBe(3)
  })

  it('set_scene_background updates bgColor', async () => {
    const world = makeWorld([makeScene('A')])
    await handler('set_scene_background', { sceneId: 'A', bgColor: '#abcdef' }, world)
    expect(world.scenes[0].bgColor).toBe('#abcdef')
  })

  it('set_transition normalizes the transition id', async () => {
    const world = makeWorld([makeScene('A')])
    // Real catalog id round-trips cleanly.
    await handler('set_transition', { sceneId: 'A', transition: 'crossfade' }, world)
    expect(world.scenes[0].transition).toBe('crossfade')
    // Unknown id falls back to 'none' (normalizeTransition contract).
    await handler('set_transition', { sceneId: 'A', transition: 'spinning-cube' }, world)
    expect(world.scenes[0].transition).toBe('none')
  })

  it('returns an error when sceneId does not exist on per-scene tools', async () => {
    const world = makeWorld([makeScene('A')])
    for (const tool of ['duplicate_scene', 'set_scene_duration', 'set_scene_background', 'set_transition']) {
      const result = await handler(
        tool,
        { sceneId: 'unknown', duration: 8, bgColor: '#000', transition: 'none' },
        world,
      )
      expect(result.success).toBe(false)
    }
  })
})
