// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAudioToolHandler } from './audio-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

// Mock the synth so the handler contract is tested without rendering (the synth has
// its own tests). Returns null for the "unknown" archetype to exercise the error path.
const synthesizeSfxToFile = vi.fn(async (spec: any, _abs: string) =>
  spec.archetype === 'unknownz' ? null : { durationSec: 0.2, resolvedId: spec.archetype },
)
const synthesizeLayeredSfxToFile = vi.fn(async (layers: any[], _abs: string) =>
  layers.some((l) => l.archetype === 'unknownz')
    ? null
    : { durationSec: 0.4, resolvedId: layers.map((l) => l.archetype).join('+') },
)
const generateSfxrToFile = vi.fn(async (category: string, _v: number, _abs: string) =>
  category === 'nope' ? null : { durationSec: 0.3, resolvedId: category },
)
const synthesizeNatureToFile = vi.fn(async (category: string, spec: any, _abs: string) =>
  category === 'volcano' ? null : { durationSec: spec.durationSec, resolvedId: category },
)
const synthesizeModalToFile = vi.fn(async (material: string, _spec: any, _abs: string) =>
  material === 'plasma' ? null : { durationSec: 1.2, resolvedId: material },
)
vi.mock('@/lib/audio/sfx', () => ({
  synthesizeSfxToFile: (...a: any[]) => synthesizeSfxToFile(a[0], a[1]),
  synthesizeLayeredSfxToFile: (...a: any[]) => synthesizeLayeredSfxToFile(a[0], a[1]),
  generateSfxrToFile: (...a: any[]) => generateSfxrToFile(a[0], a[1], a[2]),
  synthesizeNatureToFile: (...a: any[]) => synthesizeNatureToFile(a[0], a[1], a[2]),
  synthesizeModalToFile: (...a: any[]) => synthesizeModalToFile(a[0], a[1], a[2]),
  SFX_ARCHETYPE_NAMES: ['laser', 'coin', 'click'],
  SFXR_CATEGORY_NAMES: ['explosion', 'laser', 'coin'],
  NATURE_CATEGORIES: ['wind', 'rain', 'fire', 'ocean'],
  MODAL_MATERIALS: ['metal', 'wood', 'glass', 'ceramic', 'membrane'],
  SFX_SYNTH_VERSION: 'test',
}))
vi.mock('@/lib/apis/cache-hash', () => ({ computeCacheHash: () => 'cafef00d' }))
vi.mock('@/lib/audio/paths', () => ({
  getAudioDir: () => '/tmp/dreambyte-test-audio',
  audioUrlFor: (f: string) => `/audio/${f}`,
}))

const checkApiPermission = vi.fn(() => null)
const handler = createAudioToolHandler({
  checkApiPermission,
  enrichPermission: (r: unknown) => r,
} as unknown as Parameters<typeof createAudioToolHandler>[0])

function makeWorld(): WorldStateMutable {
  const scene = { id: 'A', name: 'A', sceneType: 'react', duration: 5, audioLayer: null } as unknown as Scene
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectId: 'p',
    sceneGraph: { nodes: [], edges: [], startSceneId: 'A' } as unknown as SceneGraph,
  } as unknown as WorldStateMutable
}

describe('add_sfx wiring (agent + MCP accessibility) — synthesize is source:synthesize', () => {
  it('is exposed in the tool surface both the agent and MCP read', async () => {
    const { getToolDefinitions } = await import('@/lib/agents/mcp-adapter')
    expect(getToolDefinitions().map((t) => t.name)).toContain('add_sfx')
  })
  it('is routed to the audio handler via AUDIO_TOOL_NAMES', async () => {
    const { AUDIO_TOOL_NAMES } = await import('./audio-tools')
    expect(AUDIO_TOOL_NAMES as readonly string[]).toContain('add_sfx')
  })
})

describe('synthesize_sfx', () => {
  beforeEach(() => {
    checkApiPermission.mockClear()
    synthesizeSfxToFile.mockClear()
    synthesizeLayeredSfxToFile.mockClear()
    generateSfxrToFile.mockClear()
    synthesizeNatureToFile.mockClear()
    synthesizeModalToFile.mockClear()
  })

  it('synthesizes a MODAL impact (provider local), labels it, and routes by material', async () => {
    const world = makeWorld()
    const r = await handler('synthesize_sfx', { sceneId: 'A', material: 'glass', pitch: 1.2, triggerAt: 1 }, world)
    expect(r.success).toBe(true)
    expect(synthesizeModalToFile).toHaveBeenCalledWith(
      'glass',
      expect.objectContaining({ pitch: 1.2 }),
      expect.any(String),
    )
    const sfx = (world.scenes[0].audioLayer as any).sfx[0]
    expect(sfx.name).toBe('glass (impact)')
    expect(sfx.provider).toBe('local')
    expect(checkApiPermission).not.toHaveBeenCalled() // $0, no gate
  })

  it('errors with a material hint for an unknown material', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A', material: 'plasma' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unknown SFX material/)
    expect(r.error).toMatch(/metal, wood, glass/)
  })

  it('synthesizes a local SFX, tags provider zzfx, and is $0 (no permission gate)', async () => {
    const world = makeWorld()
    const r = await handler('synthesize_sfx', { sceneId: 'A', archetype: 'laser', triggerAt: 1 }, world)
    expect(r.success).toBe(true)
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx).toHaveLength(1)
    expect(sfx[0].provider).toBe('zzfx')
    expect(sfx[0].src).toBe('/audio/sfx-cafef00d.wav')
    expect(sfx[0].triggerAt).toBe(1)
    expect((r.changes?.[0] as any)?.description).toMatch(/\$0, no provider/)
    expect(checkApiPermission).not.toHaveBeenCalled()
  })

  it('errors with a hint for an unknown archetype', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A', archetype: 'unknownz' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unknown SFX archetype/)
  })

  it('requires an archetype', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A' }, makeWorld())
    expect(r.success).toBe(false)
  })

  it('clamps triggerAt into the scene duration', async () => {
    const world = makeWorld()
    const r = await handler('synthesize_sfx', { sceneId: 'A', archetype: 'coin', triggerAt: 99 }, world)
    expect(r.success).toBe(true)
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx[0].triggerAt).toBeLessThanOrEqual(5)
    expect((r.changes?.[0] as any)?.description).toMatch(/clamped/)
  })

  it('errors on an unknown scene', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'NOPE', archetype: 'laser' }, makeWorld())
    expect(r.success).toBe(false)
  })

  it('synthesizes a layered compound sound and labels it by its layers', async () => {
    const world = makeWorld()
    const r = await handler(
      'synthesize_sfx',
      { sceneId: 'A', layers: [{ archetype: 'explosion' }, { archetype: 'thud', offsetMs: 10 }] },
      world,
    )
    expect(r.success).toBe(true)
    expect(synthesizeLayeredSfxToFile).toHaveBeenCalled()
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx[0].name).toBe('explosion+thud')
    expect(sfx[0].provider).toBe('zzfx')
  })

  it('requires either an archetype, layers, or generate', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A', layers: [] }, makeWorld())
    expect(r.success).toBe(false)
  })

  it('generates a jsfxr sound (provider local) and labels it as generated', async () => {
    const world = makeWorld()
    const r = await handler('synthesize_sfx', { sceneId: 'A', generate: 'explosion', variation: 0.4 }, world)
    expect(r.success).toBe(true)
    expect(generateSfxrToFile).toHaveBeenCalledWith('explosion', 0.4, expect.any(String))
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx[0].provider).toBe('local')
    expect(sfx[0].name).toBe('explosion (generated)')
    expect(synthesizeSfxToFile).not.toHaveBeenCalled()
  })

  it('errors with category hint for an unknown generate category', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A', generate: 'nope' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unknown SFX category/)
  })

  it('synthesizes a natural ambience (duration in seconds, provider local)', async () => {
    const world = makeWorld()
    const r = await handler('synthesize_sfx', { sceneId: 'A', nature: 'rain', duration: 6, intensity: 0.8 }, world)
    expect(r.success).toBe(true)
    expect(synthesizeNatureToFile).toHaveBeenCalledWith(
      'rain',
      expect.objectContaining({ durationSec: 6, intensity: 0.8 }),
      expect.any(String),
    )
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx[0].provider).toBe('local')
    expect(sfx[0].name).toBe('rain (ambience)')
    // nature beats the retro engines — neither was called
    expect(generateSfxrToFile).not.toHaveBeenCalled()
    expect(synthesizeSfxToFile).not.toHaveBeenCalled()
  })

  it('errors with nature-category hint for an unknown ambience', async () => {
    const r = await handler('synthesize_sfx', { sceneId: 'A', nature: 'volcano' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unknown SFX nature category/)
  })
})
