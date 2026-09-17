// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createElementToolHandler } from './element-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, TextOverlay } from '@/lib/types'

/**
 * Direct coverage for element-tools mutations (P1b-fanout-remaining for
 * text overlays). Assert in-memory mutation; the action-emitter side-
 * effect is covered by `action-emitter.test.ts`.
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
    textOverlays: [],
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

const handler = createElementToolHandler({
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('element-tools — mutation sites', () => {
  it('add_element appends a text overlay with defaults', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler('add_element', { sceneId: scene.id, content: 'Hello', x: 10, y: 20 }, world)
    expect(result.success).toBe(true)
    const overlays = world.scenes[0].textOverlays as TextOverlay[]
    expect(overlays.length).toBe(1)
    expect(overlays[0].content).toBe('Hello')
    expect(overlays[0].font).toBe('Caveat')
    expect(overlays[0].size).toBe(48)
    expect(overlays[0].animation).toBe('fade-in')
  })

  it('add_element coerces invalid animation to fade-in', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler(
      'add_element',
      { sceneId: scene.id, content: 'x', x: 0, y: 0, animation: 'spinning-fireworks' },
      world,
    )
    const overlays = world.scenes[0].textOverlays as TextOverlay[]
    expect(overlays[0].animation).toBe('fade-in')
  })

  it('edit_element patches existing overlay fields', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler('add_element', { sceneId: scene.id, content: 'before', x: 0, y: 0 }, world)
    const id = (world.scenes[0].textOverlays[0] as TextOverlay).id
    const result = await handler(
      'edit_element',
      { sceneId: scene.id, elementId: id, content: 'after', size: 72 },
      world,
    )
    expect(result.success).toBe(true)
    const ov = world.scenes[0].textOverlays[0] as TextOverlay
    expect(ov.content).toBe('after')
    expect(ov.size).toBe(72)
  })

  it('edit_element rewrites an invalid animation patch to fade-in', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler('add_element', { sceneId: scene.id, content: 'x', x: 0, y: 0 }, world)
    const id = (world.scenes[0].textOverlays[0] as TextOverlay).id
    await handler('edit_element', { sceneId: scene.id, elementId: id, animation: 'tap-dance' }, world)
    expect((world.scenes[0].textOverlays[0] as TextOverlay).animation).toBe('fade-in')
  })

  it('delete_element removes the overlay by id', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    await handler('add_element', { sceneId: scene.id, content: 'keep', x: 0, y: 0 }, world)
    await handler('add_element', { sceneId: scene.id, content: 'drop', x: 0, y: 0 }, world)
    const dropId = (world.scenes[0].textOverlays[1] as TextOverlay).id
    const result = await handler('delete_element', { sceneId: scene.id, elementId: dropId }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[0].textOverlays.length).toBe(1)
    expect((world.scenes[0].textOverlays[0] as TextOverlay).content).toBe('keep')
  })

  it('returns an error for unknown elementId on edit/delete', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    for (const tool of ['edit_element', 'delete_element']) {
      const result = await handler(
        tool,
        { sceneId: scene.id, elementId: 'nope', x: 0, y: 0, size: 1, delay: 0, duration: 1 },
        world,
      )
      expect(result.success).toBe(false)
    }
  })

  it('returns an error when sceneId does not exist', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler('add_element', { sceneId: 'unknown', content: 'x', x: 0, y: 0 }, world)
    expect(result.success).toBe(false)
  })
})
