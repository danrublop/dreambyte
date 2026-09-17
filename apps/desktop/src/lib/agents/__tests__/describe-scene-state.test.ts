/**
 * T10 — describe_scene_state: the cheap state-query primitive.
 *
 * The audit's "missing primitives" finding: the agent's only way to answer
 * "what's in this scene?" was read_scene_code (tens of KB of source) or
 * verify_scene (offscreen render). These tests pin the new tool's contract:
 * code-free structural summary, project-wide totals, helpful not-found
 * errors, read-only behavior, and the <4KB payload bound for a 20-layer
 * scene that justifies "cheap".
 */

import { describe, it, expect } from 'vitest'
import { createStateQueryToolHandler } from '../tool-handlers/state-query-tools'
import type { WorldStateMutable } from '../world-state'

const handler = createStateQueryToolHandler()

function makeScene(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scene-1',
    name: 'Intro',
    sceneType: 'react',
    duration: 8,
    bgColor: '#ffffff',
    transition: 'fade',
    reactCode: 'export default function S() { return <div>hello</div> }',
    sceneCode: '',
    svgContent: '',
    canvasCode: '',
    lottieSource: '',
    textOverlays: [
      { id: 't1', text: 'A very long headline that should be preview-truncated because it goes on and on' },
    ],
    svgObjects: [{ id: 'svg1', label: 'logo' }],
    aiLayers: [{ id: 'ai1', type: 'image', prompt: 'a sunset over mountains', imageUrl: 'https://x/img.png' }],
    chartLayers: [],
    interactions: [],
    cameraMotion: [{ kind: 'zoom' }],
    // Real layer shapes (/review PR2): VideoLayer is {enabled, src};
    // narration lives at audioLayer.tts (set by add_narration).
    videoLayer: { enabled: true, src: '/uploads/clip.mp4' },
    audioLayer: { tts: { text: 'hi' }, music: null, sfx: [{ id: 'fx1' }] },
    layerHiddenIds: ['svg1'],
    layerPanelOrder: ['t1', 'ai1', 'svg1'],
    ...overrides,
  }
}

function makeWorld(scenes: Array<Record<string, unknown>>): WorldStateMutable {
  return { projectId: 'p1', scenes, globalStyle: {} } as unknown as WorldStateMutable
}

describe('describe_scene_state', () => {
  it('returns a code-free structural summary for one scene', async () => {
    const result = await handler('describe_scene_state', { sceneId: 'scene-1' }, makeWorld([makeScene()]))
    expect(result.success).toBe(true)
    const data = result.data as { scene: Record<string, unknown>; project: Record<string, unknown> }
    const scene = data.scene
    expect(scene.id).toBe('scene-1')
    expect(scene.durationSec).toBe(8)
    // Renderer summarized as kind + size, never the source itself.
    expect(scene.renderers).toEqual([{ kind: 'react', codeChars: expect.any(Number) }])
    expect(JSON.stringify(data)).not.toContain('export default function')
    // Layer inventory with previews, hidden flags, asset presence.
    const overlays = scene.textOverlays as Array<{ text: string }>
    expect(overlays[0].text.length).toBeLessThanOrEqual(61) // 60 + ellipsis
    const svgs = scene.svgObjects as Array<{ id: string; hidden: boolean }>
    expect(svgs[0].hidden).toBe(true) // layerHiddenIds respected
    const ai = scene.aiLayers as Array<{ hasAsset: boolean }>
    expect(ai[0].hasAsset).toBe(true)
    expect((scene.audio as { narration: boolean }).narration).toBe(true)
    expect(scene.hasVideoLayer).toBe(true) // enabled+src — the real VideoLayer fields
    expect((scene.audio as { sfxCount: number }).sfxCount).toBe(1)
    expect(scene.layerPanelOrder).toEqual(['t1', 'ai1', 'svg1'])
  })

  it('project-wide call returns every scene + totalDurationSec', async () => {
    const world = makeWorld([makeScene(), makeScene({ id: 'scene-2', name: 'Outro', duration: 5.5 })])
    const result = await handler('describe_scene_state', {}, world)
    expect(result.success).toBe(true)
    const data = result.data as { scenes: unknown[]; project: { sceneCount: number; totalDurationSec: number } }
    expect(data.scenes).toHaveLength(2)
    expect(data.project.sceneCount).toBe(2)
    expect(data.project.totalDurationSec).toBeCloseTo(13.5)
  })

  it('not-found error lists the available scenes (no bare "not found")', async () => {
    const result = await handler('describe_scene_state', { sceneId: 'nope' }, makeWorld([makeScene()]))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Available scenes')
    expect(result.error).toContain('Intro')
  })

  it('is read-only: the world is untouched', async () => {
    const world = makeWorld([makeScene()])
    const before = JSON.stringify(world.scenes)
    await handler('describe_scene_state', { sceneId: 'scene-1' }, world)
    expect(JSON.stringify(world.scenes)).toBe(before)
  })

  it('payload bound: a 20-layer scene with huge code summarizes under 4KB', async () => {
    const big = makeScene({
      reactCode: 'x'.repeat(50_000), // 50KB source — must NOT appear in output
      textOverlays: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, text: `headline ${i} `.repeat(10) })),
      svgObjects: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: `obj ${i}` })),
      aiLayers: Array.from({ length: 6 }, (_, i) => ({
        id: `a${i}`,
        type: 'image',
        prompt: `prompt ${i} `.repeat(20),
        imageUrl: 'https://example.com/some/long/asset/path/image.png',
      })),
    })
    const result = await handler('describe_scene_state', { sceneId: 'scene-1' }, makeWorld([big]))
    expect(result.success).toBe(true)
    const payload = JSON.stringify(result.data)
    expect(payload.length).toBeLessThan(4096)
    expect(payload).not.toContain('xxxxx') // no code leaked
  })
})
