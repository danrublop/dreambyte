// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createInteractionToolHandler } from './interaction-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, SceneVariable } from '@/lib/types'

/**
 * Direct coverage for interaction-tools mutations (P1b-fanout-interaction).
 * Follows the layer-tools.test.ts pattern: assert in-memory world mutation;
 * the action-emitter side-effect (disk + DB) is exercised separately by
 * `action-emitter.test.ts`.
 */

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    durationSeconds: 5,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    ...overrides,
  } as Scene
}

function makeWorld(scene: Scene): WorldStateMutable {
  return {
    scenes: [scene],
    globalStyle: {} as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scene.id } as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createInteractionToolHandler()

describe('interaction-tools — mutation sites', () => {
  it('add_interaction appends to scene.interactions and returns the new element id', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler(
      'add_interaction',
      {
        sceneId: scene.id,
        type: 'hotspot',
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        appearsAt: 1,
        config: { label: 'click me' },
      },
      world,
    )
    expect(result.success).toBe(true)
    expect(world.scenes[0].interactions.length).toBe(1)
    const created = world.scenes[0].interactions[0]
    expect(created.type).toBe('hotspot')
    expect(created.x).toBe(10)
    expect((created as unknown as { label: string }).label).toBe('click me')
    expect((result.data as { elementId: string }).elementId).toBe(created.id)
  })

  it('add_interaction auto-creates a numeric scene variable for slider', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler(
      'add_interaction',
      {
        sceneId: scene.id,
        type: 'slider',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearsAt: 0,
        config: { setsVariable: 'volume', defaultValue: 50 },
      },
      world,
    )
    const vars = world.scenes[0].variables as SceneVariable[]
    expect(vars).toEqual([{ name: 'volume', type: 'number', defaultValue: 50 }])
  })

  it('add_interaction auto-creates a boolean scene variable for toggle', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler(
      'add_interaction',
      {
        sceneId: scene.id,
        type: 'toggle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearsAt: 0,
        config: { setsVariable: 'mute', defaultValue: true },
      },
      world,
    )
    expect(world.scenes[0].variables).toEqual([{ name: 'mute', type: 'boolean', defaultValue: true }])
  })

  it('edit_interaction patches an existing interaction by id', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler(
      'add_interaction',
      {
        sceneId: scene.id,
        type: 'hotspot',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearsAt: 0,
        config: { label: 'before' },
      },
      world,
    )
    const id = world.scenes[0].interactions[0].id
    const result = await handler(
      'edit_interaction',
      { sceneId: scene.id, elementId: id, updates: { label: 'after' } },
      world,
    )
    expect(result.success).toBe(true)
    expect((world.scenes[0].interactions[0] as unknown as { label: string }).label).toBe('after')
  })

  it('edit_interaction returns an error when the element is not found', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler(
      'edit_interaction',
      { sceneId: scene.id, elementId: 'nope', updates: { label: 'x' } },
      world,
    )
    expect(result.success).toBe(false)
  })

  it('define_scene_variable inserts when missing', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler('define_scene_variable', { sceneId: scene.id, name: 'count', type: 'number', defaultValue: 0 }, world)
    expect(world.scenes[0].variables).toEqual([{ name: 'count', type: 'number', defaultValue: 0 }])
  })

  it('define_scene_variable updates type and default when the name already exists', async () => {
    const scene = makeScene({
      variables: [{ name: 'count', type: 'string', defaultValue: 'init' }] as SceneVariable[],
    })
    const world = makeWorld(scene)
    await handler('define_scene_variable', { sceneId: scene.id, name: 'count', type: 'number', defaultValue: 7 }, world)
    expect(world.scenes[0].variables).toEqual([{ name: 'count', type: 'number', defaultValue: 7 }])
  })

  it('returns an error when sceneId does not exist', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler(
      'add_interaction',
      {
        sceneId: 'unknown-scene',
        type: 'hotspot',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearsAt: 0,
        config: {},
      },
      world,
    )
    expect(result.success).toBe(false)
  })
})
