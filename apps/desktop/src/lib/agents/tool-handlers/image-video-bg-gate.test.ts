// @vitest-environment node

// Spend-hardening: backgroundRemoval is a SEPARATE paid provider (~$0.01) that
// runs after image generation. It was previously billed with NO checkApiPermission,
// so a `removeBackground:true` generate_image (and every generate_sticker, which
// ALWAYS removes the background) under-counted the MCP cost ceiling / in-app spend
// cap by the removal spend. These tests assert the gate now fires for the removal
// provider exactly when a removal will happen — and not otherwise.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createImageVideoToolHandler } from './image-video-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene } from '@/lib/types'

// Provider SDKs + asset gateway stubbed so the handler can run past the imageGen
// gate without touching the network. resolveAsset just runs the `real` closure.
const generateImage = vi.fn(async () => ({ imageUrl: 'https://x/gen.png', width: 100, height: 100, cost: 0.04 }))
const removeImageBackground = vi.fn(async (_url: string) => ({ resultUrl: 'https://x/nobg.png' }))
vi.mock('@/lib/apis/image-gen', () => ({ generateImage: (...a: unknown[]) => generateImage(...(a as [])) }))
vi.mock('@/lib/apis/background-removal', () => ({
  removeImageBackground: (...a: unknown[]) => removeImageBackground(...(a as [string])),
}))
vi.mock('@/lib/agents/asset-gateway', () => ({
  resolveAsset: async (_w: unknown, opts: { real: () => Promise<unknown> }) => opts.real(),
  sandboxImageAsset: () => ({ imageUrl: 'https://x/sandbox.png', width: 1, height: 1, cost: 0 }),
  SANDBOX_ASSET_TAG: '__sandbox__',
}))

function makeScene(id: string): Scene {
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
  } as unknown as Scene
}
function makeWorld(): WorldStateMutable {
  // projectId null → skip the persist-to-library DB branch (not under test here).
  return { scenes: [makeScene('s1')], projectId: null, sandboxMode: false } as unknown as WorldStateMutable
}

// A checkApiPermission that RECORDS every gated api and optionally blocks one.
function recordingDeps(blockApi?: string) {
  const gatedApis: string[] = []
  const handler = createImageVideoToolHandler({
    checkMediaEnabled: () => null,
    checkApiPermission: (_w: unknown, api: string) => {
      gatedApis.push(api)
      return api === blockApi ? { success: false, affectedSceneId: null, error: `blocked:${api}`, changes: [] } : null
    },
    enrichPermission: (r: unknown) => r,
    regenerateHTML: async () => ({ htmlWritten: true }),
  } as unknown as Parameters<typeof createImageVideoToolHandler>[0])
  return { handler, gatedApis }
}

describe('backgroundRemoval spend gate', () => {
  beforeEach(() => {
    generateImage.mockClear()
    removeImageBackground.mockClear()
  })

  it('generate_image removeBackground:true gates the backgroundRemoval provider', async () => {
    const { handler, gatedApis } = recordingDeps()
    await handler('generate_image', { sceneId: 's1', prompt: 'a cat', removeBackground: true }, makeWorld())
    expect(gatedApis).toContain('imageGen')
    expect(gatedApis).toContain('backgroundRemoval')
  })

  it('generate_image removeBackground:false does NOT gate backgroundRemoval', async () => {
    const { handler, gatedApis } = recordingDeps()
    await handler('generate_image', { sceneId: 's1', prompt: 'a cat', removeBackground: false }, makeWorld())
    expect(gatedApis).toContain('imageGen')
    expect(gatedApis).not.toContain('backgroundRemoval')
  })

  it('a blocked backgroundRemoval gate stops the call BEFORE any provider spend', async () => {
    const { handler } = recordingDeps('backgroundRemoval')
    const r = await handler('generate_image', { sceneId: 's1', prompt: 'a cat', removeBackground: true }, makeWorld())
    expect((r as { error?: string }).error).toBe('blocked:backgroundRemoval')
    // The gate runs before resolveAsset → neither provider was billed.
    expect(generateImage).not.toHaveBeenCalled()
    expect(removeImageBackground).not.toHaveBeenCalled()
  })

  it('generate_sticker ALWAYS gates backgroundRemoval (it always removes the bg)', async () => {
    const { handler, gatedApis } = recordingDeps()
    await handler('generate_sticker', { sceneId: 's1', prompt: 'a cat' }, makeWorld())
    expect(gatedApis).toContain('imageGen')
    expect(gatedApis).toContain('backgroundRemoval')
  })

  it('a blocked sticker backgroundRemoval gate stops before spend', async () => {
    const { handler } = recordingDeps('backgroundRemoval')
    const r = await handler('generate_sticker', { sceneId: 's1', prompt: 'a cat' }, makeWorld())
    expect((r as { error?: string }).error).toBe('blocked:backgroundRemoval')
    expect(generateImage).not.toHaveBeenCalled()
  })
})
