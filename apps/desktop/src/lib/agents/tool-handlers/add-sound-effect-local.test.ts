// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createAudioToolHandler } from './audio-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'
import type { SfxLocalManifest } from '@/lib/audio/sfx-local-manifest'

// Provide a small bundled manifest; searchLocalSfx (real, pure) runs against it.
const manifest: SfxLocalManifest = {
  version: 1,
  categories: [
    {
      id: 'impacts',
      label: 'Impacts & hits',
      sounds: [
        { id: 'zzfx-impact-glass', name: 'Glass break', file: 'impacts/glass.wav', license: 'MIT', duration: 0.5 },
      ],
    },
    {
      id: 'pickups',
      label: 'Pickups',
      sounds: [{ id: 'zzfx-coin', name: 'Coin', file: 'pickups/coin.wav', license: 'MIT', duration: 0.2 }],
    },
  ],
}
vi.mock('@/lib/audio/load-local-sfx-manifest', () => ({ loadLocalSfxManifest: () => manifest }))
// searchSFX would only run for remote providers (not exercised in the local path).
vi.mock('@/lib/services/audio', () => ({
  synthesizeTTS: vi.fn(),
  searchSFX: vi.fn(async () => ({ results: [], provider: 'freesound' })),
  searchMusic: vi.fn(),
  generateMusic: vi.fn(),
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

describe('add_sound_effect — local bundled library', () => {
  const savedKeys = {
    e: process.env.ELEVENLABS_API_KEY,
    f: process.env.FREESOUND_API_KEY,
    p: process.env.PIXABAY_API_KEY,
  }
  beforeEach(() => {
    checkApiPermission.mockClear()
    // No remote keys → 'auto' falls back to the local library.
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.FREESOUND_API_KEY
    delete process.env.PIXABAY_API_KEY
  })
  // restore after the suite
  afterAll(() => {
    if (savedKeys.e) process.env.ELEVENLABS_API_KEY = savedKeys.e
    if (savedKeys.f) process.env.FREESOUND_API_KEY = savedKeys.f
    if (savedKeys.p) process.env.PIXABAY_API_KEY = savedKeys.p
  })

  it("provider 'local' attaches a bundled sound, $0 (no permission gate)", async () => {
    const world = makeWorld()
    const r = await handler('add_sound_effect', { sceneId: 'A', query: 'coin', provider: 'local', triggerAt: 1 }, world)
    expect(r.success).toBe(true)
    const sfx = (world.scenes[0].audioLayer as any).sfx
    expect(sfx[0].provider).toBe('local')
    expect(sfx[0].name).toBe('Coin')
    expect(sfx[0].src).toBe('/sfx-library/pickups/coin.wav')
    expect((r.changes?.[0] as any)?.description).toMatch(/local library/)
    expect(checkApiPermission).not.toHaveBeenCalled()
  })

  it('falls back to the local library when no provider key is configured', async () => {
    const world = makeWorld()
    const r = await handler('add_sound_effect', { sceneId: 'A', query: 'glass break' }, world)
    expect(r.success).toBe(true)
    expect((world.scenes[0].audioLayer as any).sfx[0].name).toBe('Glass break')
  })

  it("errors when 'local' is requested but nothing matches", async () => {
    const r = await handler('add_sound_effect', { sceneId: 'A', query: 'didgeridoo', provider: 'local' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No bundled sound matched/)
  })
})
