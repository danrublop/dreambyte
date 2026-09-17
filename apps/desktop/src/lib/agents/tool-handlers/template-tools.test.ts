// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createTemplateToolHandler } from './template-tools'
import { INSTANTIABLE_TEMPLATE_IDS } from '@/lib/templates/built-in'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

/**
 * Direct coverage for template-tools (`use_template` + `save_as_template`).
 * Built-in template registry is real (`@/lib/templates/built-in`); the
 * test picks `clean-title`, a small template that's guaranteed to be
 * registered.
 */

function makeScene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id,
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

const handler = createTemplateToolHandler()

// These exercise positioning, so they need a template that actually
// instantiates. They used to pass 'clean-title', which carries no layers and no
// interactions — the assertions passed while the scene inserted was blank, which
// is the bug use_template's enum + fail-honest guard now prevent.
const INSTANTIABLE_ID = INSTANTIABLE_TEMPLATE_IDS[0]

describe('template-tools — mutation sites', () => {
  it('use_template appends a new scene by default', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B')])
    const before = world.scenes.length
    const result = await handler('use_template', { templateId: INSTANTIABLE_ID, scenePrompt: 'Hello world' }, world)
    expect(result.success).toBe(true)
    expect(world.scenes.length).toBe(before + 1)
    // Appended at the end since position is omitted.
    expect(world.scenes[world.scenes.length - 1].id).toBe(result.affectedSceneId)
  })

  it('use_template respects the explicit position when in range', async () => {
    const world = makeWorld([makeScene('A'), makeScene('B'), makeScene('C')])
    const result = await handler(
      'use_template',
      { templateId: INSTANTIABLE_ID, scenePrompt: 'Insert me', position: 1 },
      world,
    )
    expect(result.success).toBe(true)
    expect(world.scenes[1].id).toBe(result.affectedSceneId)
    // Original A stays at 0; original B is pushed to 2.
    expect(world.scenes[0].id).toBe('A')
    expect(world.scenes[2].id).toBe('B')
    expect(world.scenes[3].id).toBe('C')
  })

  it('use_template falls back to append when position is out of range', async () => {
    const world = makeWorld([makeScene('A')])
    const result = await handler('use_template', { templateId: INSTANTIABLE_ID, scenePrompt: 'x', position: 99 }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[world.scenes.length - 1].id).toBe(result.affectedSceneId)
  })

  it('use_template refuses a declared-but-hollow template instead of inserting a blank scene', async () => {
    const world = makeWorld([makeScene('A')])
    const before = world.scenes.length
    // clean-title is declared in the registry but carries no layers and no
    // interactions, so instantiating it yields a scene with no content at all.
    const result = await handler('use_template', { templateId: 'clean-title', scenePrompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('carries no layers or interactions')
    expect(world.scenes.length).toBe(before)
  })

  it('use_template errors on unknown templateId', async () => {
    const world = makeWorld([makeScene('A')])
    const result = await handler('use_template', { templateId: 'does-not-exist', scenePrompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Template not found')
  })

  // pick_template + save_as_template were DELETED (dead stubs nothing wired). The
  // handler now only knows use_template.
  it('pick_template / save_as_template are unknown tools now', async () => {
    const world = makeWorld([makeScene('A')])
    for (const name of ['pick_template', 'save_as_template']) {
      const result = await handler(name, { sceneId: 'A', name: 'X', category: 'title-card' }, world)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Unknown template tool/)
    }
  })
})
