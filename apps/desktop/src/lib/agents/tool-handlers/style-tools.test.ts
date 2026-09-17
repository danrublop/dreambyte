// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createStyleToolHandler } from './style-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, SceneStyleOverride } from '@/lib/types'

/**
 * Direct coverage for style-tools mutations:
 *   - set_camera_motion (camera/setMotion emit)
 *   - set_global_style (style/setGlobal emit)
 *   - set_all_transitions (scene/update per scene)
 *   - set_roughness_all (style/setGlobal emit)
 *   - set_scene_style (scene/update via styleOverride)
 *   - style_scene → deleted in A3 stage 1; pinned as unknown-tool error
 *
 * Assert in-memory mutation; the emit side-effect is covered by
 * `action-emitter.test.ts`.
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
    transition: 'none',
    styleOverride: {} as SceneStyleOverride,
    cameraMotion: null,
    ...overrides,
  } as Scene
}

function makeWorld(scenes: Scene[]): WorldStateMutable {
  return {
    scenes,
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    } as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scenes[0]?.id ?? null } as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createStyleToolHandler({
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('style-tools — mutation sites', () => {
  it('set_camera_motion replaces cameraMotion on the scene', async () => {
    const scene = makeScene('s1')
    const world = makeWorld([scene])
    const moves = [{ type: 'pan', params: { fromX: 0, toX: 100 } }]
    const result = await handler('set_camera_motion', { sceneId: 's1', moves }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[0].cameraMotion).toEqual(moves)
  })

  it('set_camera_motion errors on unknown scene', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler('set_camera_motion', { sceneId: 'nope', moves: [] }, world)
    expect(result.success).toBe(false)
  })

  it('set_global_style writes presetId + strokeWidth into the global', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler('set_global_style', { presetId: null, strokeWidth: 3 }, world)
    expect(result.success).toBe(true)
    expect(world.globalStyle.strokeWidth).toBe(3)
  })

  it('set_global_style clamps strokeWidth to [1, 5]', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('set_global_style', { strokeWidth: 99 }, world)
    expect(world.globalStyle.strokeWidth).toBe(5)
    await handler('set_global_style', { strokeWidth: -7 }, world)
    expect(world.globalStyle.strokeWidth).toBe(1)
  })

  it('set_global_style rejects an off-catalog font without touching state', async () => {
    const world = makeWorld([makeScene('s1')])
    const before = { ...world.globalStyle }
    const result = await handler('set_global_style', { font: 'NotAFont' }, world)
    expect(result.success).toBe(false)
    expect(world.globalStyle).toEqual(before)
  })

  it('set_global_style with scope=all_scenes resets each scene styleOverride to {}', async () => {
    const s1 = makeScene('s1', { styleOverride: { font: 'Inter' } as SceneStyleOverride })
    const s2 = makeScene('s2', { styleOverride: { bgColor: '#fff' } as SceneStyleOverride })
    const world = makeWorld([s1, s2])
    await handler('set_global_style', { strokeWidth: 2, scope: 'all_scenes' }, world)
    expect(world.scenes[0].styleOverride).toEqual({})
    expect(world.scenes[1].styleOverride).toEqual({})
  })

  it('set_global_style scope=all_scenes surfaces scenes the new style broke (does NOT report all-good)', async () => {
    // One scene errors at render after the global change; the agent must be told.
    const brokenHandler = createStyleToolHandler({
      regenerateHTML: async (_w, sceneId) =>
        sceneId === 's2'
          ? {
              htmlWritten: false,
              verifyStatus: 'errored' as const,
              verifyError: { kind: 'runtime' as const, message: 'x is not defined', line: 12 },
            }
          : { htmlWritten: true, verifyStatus: 'verified' as const, verifyError: null },
    })
    const world = makeWorld([makeScene('s1'), makeScene('s2'), makeScene('s3')])
    const result = await brokenHandler('set_global_style', { strokeWidth: 2, scope: 'all_scenes' }, world)
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('s2')
    const verify = (result.data as { _verify?: { brokenScenes?: Array<{ sceneId: string }> } })._verify
    expect(verify?.brokenScenes?.map((s) => s.sceneId)).toEqual(['s2'])
  })

  it('set_global_style scope=all_scenes reports success when every scene regenerates clean', async () => {
    const okHandler = createStyleToolHandler({
      regenerateHTML: async () => ({ htmlWritten: true, verifyStatus: 'verified' as const, verifyError: null }),
    })
    const world = makeWorld([makeScene('s1'), makeScene('s2')])
    const result = await okHandler('set_global_style', { strokeWidth: 2, scope: 'all_scenes' }, world)
    expect(result.success).toBe(true)
  })

  it('set_all_transitions writes the normalized transition to every scene', async () => {
    const world = makeWorld([makeScene('s1'), makeScene('s2'), makeScene('s3')])
    await handler('set_all_transitions', { transition: 'crossfade' }, world)
    for (const s of world.scenes) expect(s.transition).toBe('crossfade')
  })

  it('set_all_transitions falls back to "none" for unknown transition ids', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('set_all_transitions', { transition: 'spinning-cube' }, world)
    expect(world.scenes[0].transition).toBe('none')
  })

  it('set_all_transitions is a no-op when the plan varies transitions per scene (fidelity guard)', async () => {
    const world = makeWorld([
      makeScene('s1', { transition: 'crossfade' as Scene['transition'] }),
      makeScene('s2', { transition: 'wipe-left' as Scene['transition'] }),
    ])
    ;(world as unknown as { scenePlan: unknown }).scenePlan = {
      scenes: [
        { id: 's1', transition: 'crossfade' },
        { id: 's2', transition: 'wipe-left' },
      ],
    }
    const result = await handler('set_all_transitions', { transition: 'dissolve' }, world)
    expect(result.success).toBe(true)
    // planned per-scene transitions preserved, NOT flattened to dissolve
    expect(world.scenes[0].transition).toBe('crossfade')
    expect(world.scenes[1].transition).toBe('wipe-left')
  })

  it('set_all_transitions still flattens when the plan is uniform / has no per-scene transitions', async () => {
    const world = makeWorld([makeScene('s1'), makeScene('s2')])
    ;(world as unknown as { scenePlan: unknown }).scenePlan = { scenes: [{ id: 's1' }, { id: 's2' }] }
    await handler('set_all_transitions', { transition: 'crossfade' }, world)
    for (const s of world.scenes) expect(s.transition).toBe('crossfade')
  })

  it('set_style(global) clamps strokeWidth to [1, 5] and writes to globalStyle (was set_roughness_all)', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('set_style', { scope: 'global', strokeWidth: 99 }, world)
    expect(world.globalStyle.strokeWidth).toBe(5)
  })

  it('set_scene_style merges styleOverride fields on the scene', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('set_scene_style', { sceneId: 's1', bgColor: '#abcdef', roughnessLevel: 2 }, world)
    const override = world.scenes[0].styleOverride as SceneStyleOverride
    expect(override.bgColor).toBe('#abcdef')
    expect(override.roughnessLevel).toBe(2)
  })

  it('set_scene_style rejects an off-catalog font', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler('set_scene_style', { sceneId: 's1', font: 'NotAFont' }, world)
    expect(result.success).toBe(false)
  })

  it('style_scene (deleted in A3 stage 1) is no longer handled — falls to the unknown-tool error', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler('style_scene', { sceneId: 's1', bgColor: '#fefefe' }, world)
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('Unknown style tool')
    // And it must not have mutated the scene.
    expect(world.scenes[0].styleOverride?.bgColor).not.toBe('#fefefe')
  })
})
