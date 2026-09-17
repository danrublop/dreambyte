// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createImageVideoToolHandler } from './image-video-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, AILayer } from '@/lib/types'

// ── DB mock (place_image assetId validation, P2) ─────────────────────────────
// place_image now validates `assetId` against the project's asset library via a
// drizzle select chain. The set of asset ids that "resolve" is controlled by
// `mockResolvableAssetIds`; the where() clause is inspected only enough to honor
// it. Reset before each test.
const mockResolvableAssetIds = new Set<string>()
let lastQueriedAssetId: string | null = null

vi.mock('@/lib/db', () => {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: (cond: { __assetId?: string }) => {
      lastQueriedAssetId = cond?.__assetId ?? null
      return builder
    },
    limit: async () =>
      lastQueriedAssetId && mockResolvableAssetIds.has(lastQueriedAssetId) ? [{ id: lastQueriedAssetId }] : [],
  }
  return { db: builder }
})

vi.mock('@/lib/db/schema', () => ({
  projectAssets: { id: 'projectAssets.id', projectId: 'projectAssets.projectId' },
}))

// `and`/`eq` are reduced to a tiny shim: `eq(projectAssets.id, value)` surfaces
// the requested assetId so the mocked `where` can decide if it resolves.
vi.mock('drizzle-orm', () => ({
  and: (...conds: Array<{ __assetId?: string }>) => ({
    __assetId: conds.map((c) => c?.__assetId).find(Boolean) ?? null,
  }),
  eq: (col: string, value: string) => (col === 'projectAssets.id' ? { __assetId: value } : {}),
}))

// ── pollVideoStatus mock (get_video_status, P1#1) ────────────────────────────
const mockPollVideoStatus = vi.fn()
vi.mock('@/lib/services/generation', () => ({
  pollVideoStatus: (...args: unknown[]) => mockPollVideoStatus(...args),
}))

/**
 * Direct coverage for the mutation surface of image-video-tools:
 * `place_image` (the only path that mutates `world.scenes` without
 * needing an external API call). The other tools in this file
 * (`generate_image`, `generate_sticker`, `generate_veo3_video`,
 * `search_images`) talk to provider SDKs and are out of scope for
 * a pure mutation test.
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

const handler = createImageVideoToolHandler({
  checkMediaEnabled: () => null,
  checkApiPermission: () => null,
  enrichPermission: (r) => r,
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('image-video-tools — place_image', () => {
  beforeEach(() => {
    mockResolvableAssetIds.clear()
    lastQueriedAssetId = null
  })

  it('appends an image AI layer with the supplied URL + geometry', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      {
        sceneId: 's1',
        imageUrl: 'https://example/img.png',
        x: 100,
        y: 200,
        width: 300,
        height: 400,
      },
      world,
    )
    expect(result.success).toBe(true)
    const layers = world.scenes[0].aiLayers as AILayer[]
    expect(layers.length).toBe(1)
    expect(layers[0].type).toBe('image')
    expect((layers[0] as unknown as { imageUrl: string }).imageUrl).toBe('https://example/img.png')
    expect((layers[0] as unknown as { x: number; y: number }).x).toBe(100)
    expect((layers[0] as unknown as { y: number }).y).toBe(200)
  })

  it('applies opacity and zIndex defaults when omitted', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'https://x/u.png', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    const layer = world.scenes[0].aiLayers[0] as unknown as { opacity: number; zIndex: number }
    expect(layer.opacity).toBe(1)
    expect(layer.zIndex).toBe(1)
  })

  it('honors explicit opacity and zIndex', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'https://x/u.png', x: 0, y: 0, width: 10, height: 10, opacity: 0.4, zIndex: 7 },
      world,
    )
    const layer = world.scenes[0].aiLayers[0] as unknown as { opacity: number; zIndex: number }
    expect(layer.opacity).toBe(0.4)
    expect(layer.zIndex).toBe(7)
  })

  it('errors on unknown sceneId without touching aiLayers on existing scenes', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      { sceneId: 'unknown', imageUrl: 'u', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    expect(result.success).toBe(false)
    expect(world.scenes[0].aiLayers.length).toBe(0)
  })

  it('T7: carries assetId + provenance snapshot end-to-end when placed from a generated asset', async () => {
    mockResolvableAssetIds.add('asset-123') // asset exists in the project library
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      {
        sceneId: 's1',
        imageUrl: '/uploads/projects/p/abc.png',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        assetId: 'asset-123',
        prompt: 'a red fox',
        model: 'flux-1.1-pro',
        style: 'photorealistic',
      },
      world,
    )
    expect(result.success).toBe(true)
    const layer = world.scenes[0].aiLayers[0] as unknown as {
      assetId: string
      prompt: string
      model: string
      provenance: { prompt: string; provider: string; model: string; style: string }
    }
    expect(layer.assetId).toBe('asset-123')
    expect(layer.prompt).toBe('a red fox')
    expect(layer.model).toBe('flux-1.1-pro')
    expect(layer.provenance.prompt).toBe('a red fox')
    expect(layer.provenance.provider).toBe('imageGen')
    expect(layer.provenance.model).toBe('flux-1.1-pro')
    expect(layer.provenance.style).toBe('photorealistic')
  })

  it('T7: leaves assetId null and provenance null for a plain placed URL (no asset link)', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'https://x/y.png', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    const layer = world.scenes[0].aiLayers[0] as unknown as { assetId: string | null; provenance: unknown }
    expect(layer.assetId).toBeNull()
    expect(layer.provenance).toBeNull()
  })

  it('P2: drops a stale assetId (not in the project library) to null and omits provenance', async () => {
    // 'asset-stale' is NOT registered as resolvable → the validation query
    // returns empty → the link must be dropped rather than persisted.
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      {
        sceneId: 's1',
        imageUrl: 'https://x/y.png',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        assetId: 'asset-stale',
        prompt: 'a red fox',
        model: 'flux-1.1-pro',
      },
      world,
    )
    expect(result.success).toBe(true)
    const layer = world.scenes[0].aiLayers[0] as unknown as { assetId: string | null; provenance: unknown }
    // Image still placed, but the bogus provenance link is severed.
    expect(layer.assetId).toBeNull()
    expect(layer.provenance).toBeNull()
  })

  it('P0: rejects a garbage imageUrl (no resolvable asset) instead of placing a broken layer', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'not a url', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('imageUrl must be an http(s)/data/blob URL or a project asset id')
    expect(world.scenes[0].aiLayers.length).toBe(0)
  })

  it('P0: rejects an empty imageUrl', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      { sceneId: 's1', imageUrl: '', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    expect(result.success).toBe(false)
    expect(world.scenes[0].aiLayers.length).toBe(0)
  })

  it('P0: accepts data: and root-relative URLs', async () => {
    const world = makeWorld([makeScene('s1'), makeScene('s2')])
    const r1 = await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'data:image/png;base64,iVBORw0KGgo=', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    const r2 = await handler(
      'place_image',
      { sceneId: 's2', imageUrl: '/uploads/projects/p/abc.png', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
  })

  it('P0: a resolvable assetId still places even when imageUrl is not a URL shape', async () => {
    mockResolvableAssetIds.add('asset-ok')
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'place_image',
      { sceneId: 's1', imageUrl: 'asset-ok', x: 0, y: 0, width: 10, height: 10, assetId: 'asset-ok' },
      world,
    )
    expect(result.success).toBe(true)
    expect(world.scenes[0].aiLayers.length).toBe(1)
  })

  it('propagates a permission block from checkApiPermission', async () => {
    const blockedHandler = createImageVideoToolHandler({
      checkMediaEnabled: () => null,
      checkApiPermission: () => ({
        success: false,
        affectedSceneId: null,
        error: 'permission denied',
        changes: [],
      }),
      enrichPermission: (r) => r,
      regenerateHTML: async () => ({ htmlWritten: true }),
    })
    const world = makeWorld([makeScene('s1')])
    const result = await blockedHandler(
      'place_image',
      { sceneId: 's1', imageUrl: 'u', x: 0, y: 0, width: 10, height: 10 },
      world,
    )
    expect(result.success).toBe(false)
    expect(world.scenes[0].aiLayers.length).toBe(0)
  })
})

// ── get_video_status (P1#1) ──────────────────────────────────────────────────

/** A placed (still-generating) Veo3 layer, as generate_veo3_video would leave it. */
function makeVeo3Layer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'veo-layer-1',
    type: 'veo3' as const,
    prompt: 'a calm ocean',
    negativePrompt: null,
    aspectRatio: '16:9' as const,
    duration: 5 as const,
    loop: false,
    playbackRate: 1,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    opacity: 1,
    zIndex: 50,
    videoUrl: null,
    thumbnailUrl: null,
    status: 'generating' as const,
    operationName: 'op-abc-123',
    startAt: 0,
    label: 'Veo clip',
    assetId: null,
    provenance: { prompt: 'a calm ocean', provider: 'veo3', model: 'veo3', referenceAssetIds: null },
    ...overrides,
  }
}

describe('image-video-tools — get_video_status', () => {
  let regenCalls: string[]
  let statusHandler: ReturnType<typeof createImageVideoToolHandler>

  beforeEach(() => {
    mockPollVideoStatus.mockReset()
    regenCalls = []
    statusHandler = createImageVideoToolHandler({
      checkMediaEnabled: () => null,
      checkApiPermission: () => null,
      enrichPermission: (r) => r,
      regenerateHTML: async (_w, sceneId) => {
        regenCalls.push(sceneId)
        return { htmlWritten: true }
      },
    })
  })

  it('poll completes → layer patched to ready with videoUrl + derived dims, HTML regenerated', async () => {
    mockPollVideoStatus.mockResolvedValue({ done: true, videoUrl: '/cache/veo/out.mp4', provider: 'veo3' })
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])

    const result = await statusHandler('get_video_status', { operationName: 'op-abc-123' }, world)

    expect(result.success).toBe(true)
    const layer = world.scenes[0].aiLayers[0] as unknown as {
      status: string
      videoUrl: string
      width: number
      height: number
    }
    expect(layer.status).toBe('ready')
    expect(layer.videoUrl).toBe('/cache/veo/out.mp4')
    // 16:9 at 1080 height → 1920 width
    expect(layer.width).toBe(1920)
    expect(layer.height).toBe(1080)
    expect(regenCalls).toEqual(['s1'])
  })

  it('poll not done → layer left generating, no HTML regen, returns done:false', async () => {
    mockPollVideoStatus.mockResolvedValue({ done: false, provider: 'veo3' })
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])

    const result = await statusHandler('get_video_status', { operationName: 'op-abc-123' }, world)

    expect(result.success).toBe(true)
    expect((result.data as { done: boolean }).done).toBe(false)
    const layer = world.scenes[0].aiLayers[0] as unknown as { status: string; videoUrl: string | null }
    expect(layer.status).toBe('generating')
    expect(layer.videoUrl).toBeNull()
    expect(regenCalls).toEqual([])
  })

  it('poll fails (fail-loud) → layer marked error, other fields intact, returns error', async () => {
    mockPollVideoStatus.mockResolvedValue({ done: true, error: 'provider rejected', provider: 'veo3' })
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])

    const result = await statusHandler('get_video_status', { operationName: 'op-abc-123' }, world)

    expect(result.success).toBe(false)
    expect(result.error).toContain('failed')
    const layer = world.scenes[0].aiLayers[0] as unknown as {
      status: string
      videoUrl: string | null
      prompt: string
    }
    expect(layer.status).toBe('error')
    expect(layer.videoUrl).toBeNull()
    // Prior fields untouched.
    expect(layer.prompt).toBe('a calm ocean')
    // HTML regenerated so the error state is reflected.
    expect(regenCalls).toEqual(['s1'])
  })

  it('unknown operation → error, poll never called, no scene mutated', async () => {
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])

    const result = await statusHandler('get_video_status', { operationName: 'op-does-not-exist' }, world)

    expect(result.success).toBe(false)
    expect(result.error).toContain('No video layer found')
    expect(mockPollVideoStatus).not.toHaveBeenCalled()
    const layer = world.scenes[0].aiLayers[0] as unknown as { status: string }
    expect(layer.status).toBe('generating') // untouched
    expect(regenCalls).toEqual([])
  })

  it('missing operationName → validation error', async () => {
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])
    const result = await statusHandler('get_video_status', {}, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('operationName is required')
  })

  it('poll throws (transient) → error, layer untouched (no corruption)', async () => {
    mockPollVideoStatus.mockRejectedValue(new Error('network down'))
    const world = makeWorld([makeScene('s1', { aiLayers: [makeVeo3Layer() as unknown as AILayer] })])

    const result = await statusHandler('get_video_status', { operationName: 'op-abc-123' }, world)

    expect(result.success).toBe(false)
    expect(result.error).toContain('network down')
    const layer = world.scenes[0].aiLayers[0] as unknown as { status: string }
    expect(layer.status).toBe('generating') // not corrupted by a transient poll failure
    expect(regenCalls).toEqual([])
  })
})
