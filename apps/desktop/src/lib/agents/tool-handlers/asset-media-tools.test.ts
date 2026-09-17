// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createAssetMediaToolHandler } from './asset-media-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, AudioLayer, VideoLayer } from '@/lib/types'

/**
 * Direct coverage for asset-media-tools mutations: set_audio_layer and
 * set_video_layer. The request_screen_recording honesty pin is gone with the tool:
 * it had no schema, so executeTool's gate answered "Unknown tool" long before the
 * honest refusal could run.
 * `use_asset_in_scene` / `add_watermark` DB lookups are covered in
 * asset-media-tools.use-asset.test.ts.
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
    audioLayer: {
      enabled: false,
      src: null,
      volume: 1,
      fadeIn: false,
      fadeOut: false,
      startOffset: 0,
    } as AudioLayer,
    videoLayer: {
      enabled: false,
      src: null,
      opacity: 1,
      trimStart: 0,
      trimEnd: null,
    } as VideoLayer,
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

const handler = createAssetMediaToolHandler({
  checkApiPermission: () => null, // tests bypass permission flow
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('asset-media-tools — mutation sites', () => {
  it('set_audio_layer enables the layer and writes src when provided', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler(
      'set_audio_layer',
      { sceneId: scene.id, src: 'https://example/audio.mp3', volume: 0.7 },
      world,
    )
    expect(result.success).toBe(true)
    const layer = world.scenes[0].audioLayer as AudioLayer
    expect(layer.enabled).toBe(true)
    expect(layer.src).toBe('https://example/audio.mp3')
    expect(layer.volume).toBe(0.7)
  })

  it('set_audio_layer skips the (spurious) paid gate in sandbox so a $0 run is not fail-closed', async () => {
    // A deps whose permission check ALWAYS fail-closes (as the real guard does in
    // sandbox). set_audio_layer assigns a URL and calls no provider, so it must skip
    // the check in sandbox and still succeed.
    const failClosed = createAssetMediaToolHandler({
      checkApiPermission: () => ({ success: false, error: 'blocked in Sandbox mode' }),
      regenerateHTML: async () => ({ htmlWritten: true }),
    })
    const scene = makeScene()
    const world = { ...makeWorld(scene), sandboxMode: true } as unknown as WorldStateMutable
    const result = await failClosed('set_audio_layer', { sceneId: scene.id, src: 'https://example/a.mp3' }, world)
    expect(result.success).toBe(true)
    expect((world.scenes[0].audioLayer as AudioLayer).src).toBe('https://example/a.mp3')
  })

  it('set_audio_layer with null src disables the layer', async () => {
    const scene = makeScene({
      audioLayer: {
        enabled: true,
        src: 'existing',
        volume: 0.5,
        fadeIn: true,
        fadeOut: false,
        startOffset: 0,
      } as AudioLayer,
    })
    const world = makeWorld(scene)
    await handler('set_audio_layer', { sceneId: scene.id, src: null }, world)
    const layer = world.scenes[0].audioLayer as AudioLayer
    expect(layer.enabled).toBe(false)
    expect(layer.src).toBeNull()
    // Other fields preserved when not patched.
    expect(layer.fadeIn).toBe(true)
  })

  it('set_audio_layer preserves omitted fields from the prior layer', async () => {
    const scene = makeScene({
      audioLayer: { enabled: false, src: null, volume: 0.3, fadeIn: true, fadeOut: true, startOffset: 2 } as AudioLayer,
    })
    const world = makeWorld(scene)
    await handler('set_audio_layer', { sceneId: scene.id, src: 'new.mp3' }, world)
    const layer = world.scenes[0].audioLayer as AudioLayer
    expect(layer.volume).toBe(0.3)
    expect(layer.fadeIn).toBe(true)
    expect(layer.fadeOut).toBe(true)
    expect(layer.startOffset).toBe(2)
  })

  it('set_video_layer enables the layer and writes src + opacity', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    const result = await handler(
      'set_video_layer',
      { sceneId: scene.id, src: 'https://example/video.mp4', opacity: 0.5 },
      world,
    )
    expect(result.success).toBe(true)
    const layer = world.scenes[0].videoLayer as VideoLayer
    expect(layer.enabled).toBe(true)
    expect(layer.src).toBe('https://example/video.mp4')
    expect(layer.opacity).toBe(0.5)
  })

  it('set_video_layer with explicit trimEnd:null preserves null (distinct from undefined)', async () => {
    const scene = makeScene({
      videoLayer: { enabled: true, src: 'old', opacity: 1, trimStart: 0, trimEnd: 5 } as VideoLayer,
    })
    const world = makeWorld(scene)
    await handler('set_video_layer', { sceneId: scene.id, src: 'new', trimEnd: null }, world)
    const layer = world.scenes[0].videoLayer as VideoLayer
    expect(layer.trimEnd).toBeNull()
  })

  it('set_video_layer with null src disables', async () => {
    const scene = makeScene({
      videoLayer: { enabled: true, src: 'old', opacity: 1, trimStart: 0, trimEnd: null } as VideoLayer,
    })
    const world = makeWorld(scene)
    await handler('set_video_layer', { sceneId: scene.id, src: null }, world)
    const layer = world.scenes[0].videoLayer as VideoLayer
    expect(layer.enabled).toBe(false)
    expect(layer.src).toBeNull()
  })

  it('returns an error when sceneId does not exist', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)
    for (const tool of ['set_audio_layer', 'set_video_layer']) {
      const result = await handler(tool, { sceneId: 'unknown', src: 'x' }, world)
      expect(result.success).toBe(false)
    }
  })
})
