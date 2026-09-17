// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createAvatarToolHandler } from './avatar-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, AILayer } from '@/lib/types'

/**
 * Non-blocking HeyGen avatar path. generate_avatar_narration / _scene now call
 * `startAvatarGeneration`: HeyGen submits + returns immediately (the scene gets a
 * `processing` layer carrying the heygenVideoId), every other provider stays sync
 * (`ready` layer). `get_avatar_status` polls HeyGen and fills the layer in place.
 *
 * The service layer (resolution + the resolveGuardedFace trust chokepoint) is covered
 * in src/lib/services/avatar.test.ts — here we mock it and assert the handler's layer
 * wiring + the poll state machine.
 */

const startAvatarGeneration = vi.fn()
const resolveAvatarConfig = vi.fn(async () => ({ id: 'cfg1', provider: 'heygen' }))
vi.mock('@/lib/services/avatar', () => ({
  startAvatarGeneration: (...a: unknown[]) => startAvatarGeneration(...a),
  resolveAvatarConfig: (...a: unknown[]) => resolveAvatarConfig(...(a as [])),
}))

const pollHeygenStatus = vi.fn()
vi.mock('@/lib/services/generation', () => ({
  pollHeygenStatus: (...a: unknown[]) => pollHeygenStatus(...a),
}))

const regenerateHTML = vi.fn(async () => ({ htmlWritten: true }))
vi.mock('@/lib/agents/tool-executor', () => ({
  regenerateHTML: (...a: unknown[]) => regenerateHTML(...(a as [])),
  // V7 P1-8: handlers re-check the abort signal before the paid provider call.
  // No abort in these tests → undefined signal → guard passes.
  getWorldAbortSignal: () => undefined,
}))

function makeScene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id,
    sceneType: 'react',
    duration: 8,
    durationSeconds: 8,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    ...overrides,
  } as unknown as Scene
}

function makeWorld(scenes: Scene[]): WorldStateMutable {
  return {
    scenes,
    globalStyle: {} as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    generationOverrides: {},
    mediaGenEnabled: {},
    sceneGraph: { nodes: [], edges: [], startSceneId: scenes[0]?.id ?? null } as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createAvatarToolHandler({
  checkMediaEnabled: () => null,
  checkApiPermission: () => null,
  enrichPermission: (r) => r,
})

const avatarLayerOf = (world: WorldStateMutable, sceneId: string) =>
  (world.scenes.find((s) => s.id === sceneId)?.aiLayers as AILayer[]).find((l) => (l as any).type === 'avatar') as any

beforeEach(() => {
  startAvatarGeneration.mockReset()
  resolveAvatarConfig.mockReset().mockResolvedValue({ id: 'cfg1', provider: 'heygen' })
  pollHeygenStatus.mockReset()
  regenerateHTML.mockClear()
})

describe('generate_avatar_narration', () => {
  it('heygen (async) → places a `processing` layer carrying the heygenVideoId', async () => {
    startAvatarGeneration.mockResolvedValue({
      async: true,
      provider: 'heygen',
      heygenVideoId: 'hg-1',
      avatarVideoId: 'av-1',
      estimatedSeconds: 40,
    })
    const world = makeWorld([makeScene('s1')])
    const res = await handler('generate_avatar_narration', { sceneId: 's1', text: 'hi' }, world)

    expect(res.success).toBe(true)
    expect((res.data as any).status).toBe('processing')
    expect((res.data as any).heygenVideoId).toBe('hg-1')
    expect((res.data as any).pollWith).toBe('get_avatar_status')

    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('processing')
    expect(layer.heygenVideoId).toBe('hg-1')
    expect(layer.videoUrl).toBeNull()
  })

  it('musetalk (sync) → places a `ready` layer with the videoUrl, no heygenVideoId', async () => {
    resolveAvatarConfig.mockResolvedValue({ id: 'cfg1', provider: 'musetalk' })
    startAvatarGeneration.mockResolvedValue({
      async: false,
      video: { provider: 'musetalk', videoUrl: '/uploads/a.mp4', durationSeconds: 5, costUsd: 0 },
    })
    const world = makeWorld([makeScene('s1')])
    const res = await handler('generate_avatar_narration', { sceneId: 's1', text: 'hi' }, world)

    expect(res.success).toBe(true)
    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('ready')
    expect(layer.heygenVideoId).toBeNull()
    expect(layer.videoUrl).toBe('/uploads/a.mp4')
  })
})

describe('generate_avatar_scene', () => {
  it('heygen (async) → avatar_scene layer is `processing` with the heygenVideoId', async () => {
    startAvatarGeneration.mockResolvedValue({
      async: true,
      provider: 'heygen',
      heygenVideoId: 'hg-2',
      avatarVideoId: 'av-2',
      estimatedSeconds: 50,
    })
    const world = makeWorld([makeScene('s1')])
    const res = await handler(
      'generate_avatar_scene',
      { sceneId: 's1', narration_script: { mood: 'neutral', view: 'full', lines: [{ text: 'hello' }] } },
      world,
    )

    expect(res.success).toBe(true)
    expect((res.data as any).status).toBe('processing')
    expect(world.scenes[0].sceneType).toBe('avatar_scene')
    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('processing')
    expect(layer.heygenVideoId).toBe('hg-2')
  })

  it('musetalk (sync) → avatar_scene layer is `ready`', async () => {
    resolveAvatarConfig.mockResolvedValue({ id: 'cfg1', provider: 'musetalk' })
    startAvatarGeneration.mockResolvedValue({
      async: false,
      video: { provider: 'musetalk', videoUrl: '/uploads/a.mp4', durationSeconds: 5, costUsd: 0 },
    })
    const world = makeWorld([makeScene('s1')])
    const res = await handler(
      'generate_avatar_scene',
      { sceneId: 's1', narration_script: { mood: 'neutral', view: 'full', lines: [{ text: 'hello' }] } },
      world,
    )
    expect(res.success).toBe(true)
    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('ready')
    expect(layer.heygenVideoId).toBeNull()
  })
})

describe('get_avatar_status', () => {
  // A scene already holding a processing heygen avatar layer (as the generate call left it).
  const processingWorld = () =>
    makeWorld([
      makeScene('s1', {
        aiLayers: [
          {
            id: 'L1',
            type: 'avatar',
            status: 'processing',
            heygenVideoId: 'hg-9',
            videoUrl: null,
          } as unknown as AILayer,
        ],
      }),
    ])

  it('processing → returns done:false, leaves the layer untouched', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'processing' })
    const world = processingWorld()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(true)
    expect((res.data as any).done).toBe(false)
    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('processing')
    expect(regenerateHTML).not.toHaveBeenCalled()
  })

  it('completed → fills the layer (ready + videoUrl) and regenerates HTML', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'completed', videoUrl: '/media/hg-9.mp4', thumbnailUrl: '/t.png' })
    const world = processingWorld()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(true)
    expect((res.data as any).done).toBe(true)
    const layer = avatarLayerOf(world, 's1')
    expect(layer.status).toBe('ready')
    expect(layer.videoUrl).toBe('/media/hg-9.mp4')
    expect(layer.thumbnailUrl).toBe('/t.png')
    expect(regenerateHTML).toHaveBeenCalledWith(world, 's1')
  })

  const avatarWorldWithStart = () =>
    makeWorld([
      makeScene('s1', {
        aiLayers: [
          {
            id: 'L1',
            type: 'avatar',
            status: 'processing',
            heygenVideoId: 'hg-9',
            videoUrl: null,
            startAt: 0,
          } as unknown as AILayer,
        ],
      }),
    ])

  it('completed with a longer real duration → records it and extends the scene to fit', async () => {
    pollHeygenStatus.mockResolvedValue({
      status: 'completed',
      videoUrl: '/media/hg-9.mp4',
      thumbnailUrl: '/t.png',
      durationSeconds: 25, // real avatar length vs the 8s scene
    })
    const world = avatarWorldWithStart()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(true)
    expect(avatarLayerOf(world, 's1').estimatedDuration).toBe(25) // real length recorded (export scene-fit)
    expect((world.scenes.find((s) => s.id === 's1') as any).duration).toBe(25) // scene grown so preview fits
    expect((res.data as any).sceneExtendedTo).toBe(25)
  })

  it('completed with a shorter real duration → records it but does NOT shrink the scene', async () => {
    pollHeygenStatus.mockResolvedValue({
      status: 'completed',
      videoUrl: '/media/hg-9.mp4',
      thumbnailUrl: '/t.png',
      durationSeconds: 4, // shorter than the 8s scene
    })
    const world = avatarWorldWithStart()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(avatarLayerOf(world, 's1').estimatedDuration).toBe(4)
    expect((world.scenes.find((s) => s.id === 's1') as any).duration).toBe(8) // unchanged — never shrink
    expect((res.data as any).sceneExtendedTo).toBeNull()
  })

  it('already-ready layer → returns done WITHOUT re-polling HeyGen or re-extending', async () => {
    const world = makeWorld([
      makeScene('s1', {
        duration: 25, // already grown on a prior poll
        aiLayers: [
          {
            id: 'L1',
            type: 'avatar',
            status: 'ready',
            heygenVideoId: 'hg-9',
            videoUrl: '/media/hg-9.mp4',
          } as unknown as AILayer,
        ],
      }),
    ])
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(true)
    expect((res.data as any).done).toBe(true)
    expect(pollHeygenStatus).not.toHaveBeenCalled() // no redundant re-download
    expect(regenerateHTML).not.toHaveBeenCalled()
    expect((world.scenes.find((s) => s.id === 's1') as any).duration).toBe(25) // not re-extended
  })

  it('completed with no provider duration → leaves duration + scene as-is (no regression)', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'completed', videoUrl: '/media/hg-9.mp4', thumbnailUrl: '/t.png' })
    const world = avatarWorldWithStart()
    await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)
    expect((world.scenes.find((s) => s.id === 's1') as any).duration).toBe(8) // unchanged
  })

  it('failed → marks the layer error and returns an error result', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'failed', error: 'render exploded' })
    const world = processingWorld()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/render exploded/)
    expect(avatarLayerOf(world, 's1').status).toBe('error')
  })

  it('unknown layer → error', async () => {
    const world = processingWorld()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'nope' }, world)
    expect(res.success).toBe(false)
    expect(pollHeygenStatus).not.toHaveBeenCalled()
  })

  it('transient poll throw → error WITHOUT corrupting the layer (stays processing)', async () => {
    pollHeygenStatus.mockRejectedValue(new Error('network blip'))
    const world = processingWorld()
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/transient/i)
    // Layer must NOT be flipped to error on a transient failure.
    expect(avatarLayerOf(world, 's1').status).toBe('processing')
    expect(regenerateHTML).not.toHaveBeenCalled()
  })

  // A scene holding a processing avatar layer that started rendering `ageMs` ago.
  const agedWorld = (ageMs: number) =>
    makeWorld([
      makeScene('s1', {
        aiLayers: [
          {
            id: 'L1',
            type: 'avatar',
            status: 'processing',
            heygenVideoId: 'hg-9',
            videoUrl: null,
            renderStartedAt: Date.now() - ageMs,
          } as unknown as AILayer,
        ],
      }),
    ])

  it('still processing past the 15-min deadline → marks the layer error (timeout)', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'processing' })
    const world = agedWorld(16 * 60_000) // 16 min ago — expired
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/timed out/i)
    expect(avatarLayerOf(world, 's1').status).toBe('error')
  })

  it('still processing within the deadline → done:false, layer untouched', async () => {
    pollHeygenStatus.mockResolvedValue({ status: 'processing' })
    const world = agedWorld(60_000) // 1 min ago — fresh
    const res = await handler('get_avatar_status', { sceneId: 's1', layerId: 'L1' }, world)

    expect(res.success).toBe(true)
    expect((res.data as any).done).toBe(false)
    expect(avatarLayerOf(world, 's1').status).toBe('processing')
  })
})
