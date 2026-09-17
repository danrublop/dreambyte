// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Control the layer-content generator (used by the SVG / code-scene regen paths)
// without hitting the real LLM. `clearStaleCodeFields` is a passthrough.
const generateLayerContentMock = vi.fn()
vi.mock('@/lib/agents/tool-executor', () => ({
  clearStaleCodeFields: () => ({}),
  generateLayerContent: (...args: unknown[]) => generateLayerContentMock(...args),
  // A1 abort plumbing: layer-tools reads the run's signal via this getter —
  // no signal in these tests (undefined = never aborted).
  getWorldAbortSignal: () => undefined,
}))

// Control AI image regeneration (image/sticker branch).
const generateImageMock = vi.fn()
vi.mock('@/lib/apis/image-gen', () => ({
  generateImage: (...args: unknown[]) => generateImageMock(...args),
}))
const removeImageBackgroundMock = vi.fn()
vi.mock('@/lib/apis/background-removal', () => ({
  removeImageBackground: (...args: unknown[]) => removeImageBackgroundMock(...args),
}))
const persistGeneratedAssetMock = vi.fn()
vi.mock('@/lib/media/provenance', () => ({
  persistGeneratedAsset: (...args: unknown[]) => persistGeneratedAssetMock(...args),
}))

import { createLayerToolHandler } from './layer-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, AILayer, GlobalStyle, SceneGraph } from '@/lib/types'

/**
 * Lightweight coverage for the new emission sites added in P1b-fanout-layer.
 * The action-emitter writes to disk + DB asynchronously and fails gracefully
 * outside Electron — so these tests don't observe persistence directly.
 * They confirm the in-memory mutation happens and the handler returns a
 * success result; the emission side-effect is exercised via the
 * `action-emitter.test.ts` suite that already verifies the stamping logic.
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
  }
}

const handler = createLayerToolHandler({
  regenerateHTML: async () => ({ htmlWritten: true }),
})

describe('layer-tools — emission sites', () => {
  it('remove_layer drops the AI layer from the world', async () => {
    const layer: AILayer = {
      id: 'ai-1',
      type: 'svg',
      prompt: 'thing',
      generatedCode: '',
      opacity: 0.8,
    } as unknown as AILayer
    const scene = makeScene({ aiLayers: [layer] })
    const world = makeWorld(scene)

    const result = await handler('remove_layer', { sceneId: scene.id, layerId: 'ai-1' }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[0].aiLayers).toEqual([])
  })

  it('set_layer_opacity clamps to [0,1] on AI layers', async () => {
    const layer = { id: 'ai-1', opacity: 0.5 } as unknown as AILayer
    const scene = makeScene({ aiLayers: [layer] })
    const world = makeWorld(scene)

    const result = await handler('set_layer_opacity', { sceneId: scene.id, layerId: 'ai-1', opacity: 1.5 }, world)
    expect(result.success).toBe(true)
    expect((world.scenes[0].aiLayers![0] as { opacity: number }).opacity).toBe(1)
  })

  it('set_layer_visibility flips opacity to 0 / 1', async () => {
    const layer = { id: 'ai-1', opacity: 0.7 } as unknown as AILayer
    const scene = makeScene({ aiLayers: [layer] })
    const world = makeWorld(scene)

    const hidden = await handler('set_layer_visibility', { sceneId: scene.id, layerId: 'ai-1', visible: false }, world)
    expect(hidden.success).toBe(true)
    expect((world.scenes[0].aiLayers![0] as { opacity: number }).opacity).toBe(0)

    const shown = await handler('set_layer_visibility', { sceneId: scene.id, layerId: 'ai-1', visible: true }, world)
    expect(shown.success).toBe(true)
    expect((world.scenes[0].aiLayers![0] as { opacity: number }).opacity).toBe(1)
  })

  it('set_layer_timing updates startAt on the AI layer', async () => {
    const layer = { id: 'ai-1', opacity: 1 } as unknown as AILayer
    const scene = makeScene({ aiLayers: [layer] })
    const world = makeWorld(scene)

    const result = await handler('set_layer_timing', { sceneId: scene.id, layerId: 'ai-1', startAt: 2.5 }, world)
    expect(result.success).toBe(true)
    expect((world.scenes[0].aiLayers![0] as { startAt?: number }).startAt).toBe(2.5)
  })

  it('returns an error when the scene is missing', async () => {
    const world = makeWorld(makeScene())
    const result = await handler('set_layer_opacity', { sceneId: 'nope', layerId: 'ai-1', opacity: 0.5 }, world)
    expect(result.success).toBe(false)
  })

  it('returns an error when the layer is missing', async () => {
    const world = makeWorld(makeScene({ aiLayers: [] }))
    const result = await handler('set_layer_opacity', { sceneId: 'scene-1', layerId: 'missing', opacity: 0.5 }, world)
    expect(result.success).toBe(false)
  })
})

// ── A0/T1: read_scene_code fails honestly on an elided placeholder ──────────

describe('read_scene_code — placeholder honesty (A0/T1)', () => {
  const codeText = (r: { changes?: Array<{ description?: string }> }) => r.changes?.[0]?.description ?? ''

  it('fails honestly when the primary code field is a `[<n> chars]` placeholder', async () => {
    const scene = makeScene({ sceneType: 'react', reactCode: '[8243 chars]' } as Partial<Scene>)
    const world = makeWorld(scene)
    const result = await handler('read_scene_code', { sceneId: scene.id }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not available in this run/i)
    expect(result.error).toMatch(/write_scene_code/)
  })

  it('returns real code untouched (regression — non-placeholder is byte-identical)', async () => {
    const scene = makeScene({ sceneType: 'react', reactCode: 'export default () => REAL' } as Partial<Scene>)
    const world = makeWorld(scene)
    const result = await handler('read_scene_code', { sceneId: scene.id }, world)
    expect(result.success).toBe(true)
    expect(codeText(result)).toContain('export default () => REAL')
  })

  it('does NOT mistake real code containing "[12 chars]" for a placeholder', async () => {
    const scene = makeScene({ sceneType: 'react', reactCode: 'const n = "[12 chars]"' } as Partial<Scene>)
    const world = makeWorld(scene)
    const result = await handler('read_scene_code', { sceneId: scene.id }, world)
    expect(result.success).toBe(true)
    expect(codeText(result)).toContain('const n = "[12 chars]"')
  })
})

// ── T8: regenerate_layer — AI image/sticker in-place regen + guards ──────────

function makeImageLayer(overrides: Record<string, unknown> = {}): AILayer {
  return {
    id: 'img-1',
    type: 'image',
    prompt: 'a red fox',
    model: 'flux-schnell',
    style: null,
    imageUrl: '/uploads/projects/p/old.png',
    x: 100,
    y: 200,
    width: 300,
    height: 400,
    rotation: 0,
    opacity: 0.8,
    zIndex: 7,
    status: 'ready',
    label: 'Fox',
    startAt: 1.5,
    assetId: 'asset-old',
    provenance: {
      prompt: 'a red fox',
      provider: 'imageGen',
      model: 'flux-schnell',
      style: 'photorealistic',
      referenceAssetIds: null,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  } as unknown as AILayer
}

describe('regenerate_layer — AI image/sticker (T8)', () => {
  beforeEach(() => {
    generateLayerContentMock.mockReset()
    generateImageMock.mockReset()
    removeImageBackgroundMock.mockReset()
    persistGeneratedAssetMock.mockReset()
  })

  it('regenerates an image layer in place, preserving geometry/timing/z-order', async () => {
    generateImageMock.mockResolvedValue({ imageUrl: '/tmp/new.png', width: 512, height: 512, cost: 0.01 })
    persistGeneratedAssetMock.mockResolvedValue({ id: 'asset-new', publicUrl: '/uploads/projects/p/new.png' })
    const scene = makeScene({ sceneType: 'react', aiLayers: [makeImageLayer()] })
    const world = makeWorld(scene)

    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'img-1', prompt: '' }, world)
    expect(result.success).toBe(true)
    const layer = world.scenes[0].aiLayers[0] as unknown as Record<string, unknown>
    // media swapped + new asset linked
    expect(layer.imageUrl).toBe('/uploads/projects/p/new.png')
    expect(layer.assetId).toBe('asset-new')
    // geometry / timing / z-order / opacity preserved
    expect(layer.x).toBe(100)
    expect(layer.y).toBe(200)
    expect(layer.width).toBe(300)
    expect(layer.height).toBe(400)
    expect(layer.zIndex).toBe(7)
    expect(layer.opacity).toBe(0.8)
    expect(layer.startAt).toBe(1.5)
    // provenance refreshed, parentAssetId chained to the prior asset
    expect(persistGeneratedAssetMock.mock.calls[0][0].metadata.parentAssetId).toBe('asset-old')
  })

  it('uses the provided prompt + params.model override', async () => {
    generateImageMock.mockResolvedValue({ imageUrl: '/tmp/new.png', width: 512, height: 512, cost: 0 })
    persistGeneratedAssetMock.mockResolvedValue({ id: 'asset-new', publicUrl: '/u/new.png' })
    const world = makeWorld(makeScene({ aiLayers: [makeImageLayer()] }))
    await handler(
      'regenerate_layer',
      { sceneId: 'scene-1', layerId: 'img-1', prompt: 'a blue fox', params: { model: 'flux-1.1-pro' } },
      world,
    )
    const callArgs = generateImageMock.mock.calls[0][0]
    expect(callArgs.prompt).toBe('a blue fox')
    expect(callArgs.model).toBe('flux-1.1-pro')
  })

  it('runs background removal for sticker layers', async () => {
    generateImageMock.mockResolvedValue({ imageUrl: '/tmp/raw.png', width: 512, height: 512, cost: 0 })
    removeImageBackgroundMock.mockResolvedValue({ resultUrl: '/tmp/cut.png' })
    persistGeneratedAssetMock.mockResolvedValue({ id: 'asset-new', publicUrl: '/u/sticker.png' })
    const stickerLayer = {
      ...(makeImageLayer() as object),
      id: 'st-1',
      type: 'sticker',
      stickerUrl: '/old.png',
    } as unknown as AILayer
    const world = makeWorld(makeScene({ aiLayers: [stickerLayer] }))
    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'st-1', prompt: '' }, world)
    expect(result.success).toBe(true)
    expect(removeImageBackgroundMock).toHaveBeenCalledWith('/tmp/raw.png')
    const layer = world.scenes[0].aiLayers[0] as unknown as Record<string, unknown>
    expect(layer.stickerUrl).toBe('/u/sticker.png')
  })

  it('FAILURE LEAVES INTACT: generation error returns a visible error and does not mutate the prior layer', async () => {
    generateImageMock.mockRejectedValue(new Error('provider 500'))
    const original = makeImageLayer()
    const world = makeWorld(makeScene({ aiLayers: [original] }))

    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'img-1', prompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/provider 500/)
    // Prior layer fully intact — same media + asset link.
    const layer = world.scenes[0].aiLayers[0] as unknown as Record<string, unknown>
    expect(layer.imageUrl).toBe('/uploads/projects/p/old.png')
    expect(layer.assetId).toBe('asset-old')
  })

  it('NO PROVENANCE: a layer with no prompt/provenance returns a clear actionable error', async () => {
    const bare = {
      id: 'img-2',
      type: 'image',
      imageUrl: '/u/x.png',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      opacity: 1,
      zIndex: 1,
      status: 'ready',
      label: 'X',
    } as unknown as AILayer
    const world = makeWorld(makeScene({ aiLayers: [bare] }))
    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'img-2', prompt: '' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no provenance prompt/i)
    expect(generateImageMock).not.toHaveBeenCalled()
  })

  it('rejects regeneration of unsupported AI layer types (e.g. avatar)', async () => {
    const avatar = { id: 'av-1', type: 'avatar', label: 'A', opacity: 1, status: 'ready' } as unknown as AILayer
    const world = makeWorld(makeScene({ aiLayers: [avatar] }))
    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'av-1', prompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/does not yet support/i)
  })
})

describe('regenerate_layer — fallthrough guard + code-layer regression (T8)', () => {
  beforeEach(() => {
    generateLayerContentMock.mockReset()
    generateImageMock.mockReset()
  })

  it('FALLTHROUGH GUARD: an unknown layerId errors and never regenerates the whole scene', async () => {
    generateLayerContentMock.mockResolvedValue({ success: true, code: 'export default () => null' })
    const scene = makeScene({ sceneType: 'react', reactCode: 'ORIGINAL', aiLayers: [makeImageLayer()] })
    const world = makeWorld(scene)

    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'ghost-id', prompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    // Whole-scene regen never ran.
    expect(generateLayerContentMock).not.toHaveBeenCalled()
    expect((world.scenes[0] as unknown as { reactCode: string }).reactCode).toBe('ORIGINAL')
  })

  it('CODE-LAYER REGRESSION: layerId === sceneId regenerates the scene code (react path unaffected)', async () => {
    generateLayerContentMock.mockResolvedValue({ success: true, code: 'NEWCODE' })
    const scene = makeScene({ sceneType: 'react', reactCode: 'OLDCODE' })
    const world = makeWorld(scene)

    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'redo' }, world)
    expect(result.success).toBe(true)
    expect(generateLayerContentMock).toHaveBeenCalledTimes(1)
    expect((world.scenes[0] as unknown as { reactCode: string }).reactCode).toBe('NEWCODE')
  })

  it('CODE-LAYER REGRESSION: SVG object regenerate path still works', async () => {
    generateLayerContentMock.mockResolvedValue({ success: true, code: '<svg>new</svg>' })
    const scene = makeScene({
      sceneType: 'svg',
      svgObjects: [
        { id: 'svg-1', prompt: 'old', svgContent: '<svg>old</svg>', x: 0, y: 0, width: 100, opacity: 1, zIndex: 2 },
      ],
    } as Partial<Scene>)
    const world = makeWorld(scene)

    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'svg-1', prompt: 'new' }, world)
    expect(result.success).toBe(true)
    expect((world.scenes[0].svgObjects![0] as unknown as { svgContent: string }).svgContent).toBe('<svg>new</svg>')
  })

  it('whole-scene regen failure surfaces an error', async () => {
    generateLayerContentMock.mockResolvedValue({ success: false, error: 'LLM down' })
    const world = makeWorld(makeScene({ sceneType: 'react', reactCode: 'OLD' }))
    const result = await handler('regenerate_layer', { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'x' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/LLM down/)
  })
})

describe('lottie quality field (T8)', () => {
  beforeEach(() => generateLayerContentMock.mockReset())

  it('add_layer attaches a structured lottieQuality field for lottie layers', async () => {
    const lottieJson = JSON.stringify({
      v: '5.7',
      fr: 30,
      ip: 0,
      op: 60,
      w: 100,
      h: 100,
      layers: [{ ty: 4, ip: 0, op: 60 }],
    })
    generateLayerContentMock.mockResolvedValue({ success: true, code: lottieJson })
    const world = makeWorld(makeScene({ sceneType: 'lottie' }))
    const result = await handler('add_layer', { sceneId: 'scene-1', layerType: 'lottie', prompt: 'spinner' }, world)
    expect(result.success).toBe(true)
    const data = result.data as { lottieQuality?: { score: number; dimensions: Record<string, number> } }
    expect(data.lottieQuality).toBeDefined()
    expect(typeof data.lottieQuality!.score).toBe('number')
    expect(data.lottieQuality!.dimensions).toBeDefined()
  })

  it('does not attach lottieQuality for non-lottie layers', async () => {
    generateLayerContentMock.mockResolvedValue({ success: true, code: 'export default () => null' })
    const world = makeWorld(makeScene({ sceneType: 'react' }))
    const result = await handler('add_layer', { sceneId: 'scene-1', layerType: 'react', prompt: 'x' }, world)
    expect(result.success).toBe(true)
    expect((result.data as { lottieQuality?: unknown }).lottieQuality).toBeUndefined()
  })
})
