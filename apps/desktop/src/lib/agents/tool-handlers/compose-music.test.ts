// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAudioToolHandler } from './audio-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

// Mock the composer so the handler contract is tested WITHOUT a real render (the
// render/arrange paths have their own tests). resolveSoundfontPath is a vi.fn so a
// test can simulate the missing-soundfont case.
const resolveSoundfontPath = vi.fn<() => string | null>(() => '/fake/GeneralUser-GS.sf2')
const composeMusicToFile = vi.fn(async (p: any, out: { absPath: string; publicUrl: string }) => {
  const c = compose(p) // reuse the mocked compose() for meta + corrections
  return {
    audioUrl: out.publicUrl,
    filePath: out.absPath,
    durationSec: c.arrangement.durationSec,
    rms: 0.03,
    corrections: c.corrections,
    meta: c.meta,
    melodySource: p.melody === 'ml' ? 'ml' : 'template',
  }
})
const compose = vi.fn((p: any) => ({
  arrangement: { durationSec: p.sceneDurationSec, channels: [], events: [{}] },
  corrections: p.tempo === 999 ? ['tempo 999 clamped to 95 (range 70-95 for lofi)'] : [],
  meta: { templateId: p.templateId ?? 'lofi', key: 'C minor', tempo: 82, bars: 4, sections: ['core'] },
}))
vi.mock('@/lib/audio/composer', () => ({
  resolveSoundfontPath: () => resolveSoundfontPath(),
  composeMusicToFile: (...a: any[]) => composeMusicToFile(a[0], a[1]),
  compose: (...a: any[]) => compose(a[0]),
  COMPOSER_VERSION: 'test-version',
}))
vi.mock('@/lib/apis/cache-hash', () => ({ computeCacheHash: () => 'deadbeef' }))
vi.mock('@/lib/audio/paths', () => ({
  getAudioDir: () => '/tmp/dreambyte-test-audio',
  audioUrlFor: (f: string) => `/audio/${f}`,
}))

const checkApiPermission = vi.fn(() => null)
const handler = createAudioToolHandler({
  checkApiPermission,
  enrichPermission: (r: unknown) => r,
} as unknown as Parameters<typeof createAudioToolHandler>[0])

function makeScene(audioLayer: unknown): Scene {
  return { id: 'A', name: 'A', sceneType: 'react', duration: 6, audioLayer } as unknown as Scene
}
function makeWorld(): WorldStateMutable {
  return {
    scenes: [makeScene(null)],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectId: 'p',
    sceneGraph: { nodes: [], edges: [], startSceneId: 'A' } as unknown as SceneGraph,
  } as unknown as WorldStateMutable
}

describe('add_music wiring (agent + MCP accessibility) — compose is source:compose', () => {
  it('is exposed in the tool surface both the agent and MCP read', async () => {
    const { getToolDefinitions } = await import('@/lib/agents/mcp-adapter')
    const names = getToolDefinitions().map((t) => t.name)
    expect(names).toContain('add_music')
  })
  it('is routed to the audio handler via AUDIO_TOOL_NAMES', async () => {
    const { AUDIO_TOOL_NAMES } = await import('./audio-tools')
    expect(AUDIO_TOOL_NAMES as readonly string[]).toContain('add_music')
  })
})

describe('compose_music', () => {
  beforeEach(() => {
    checkApiPermission.mockClear()
    composeMusicToFile.mockClear()
    resolveSoundfontPath.mockReturnValue('/fake/GeneralUser-GS.sf2')
  })

  it('composes native music, tags provider native-sequencer, and is $0 (no permission gate)', async () => {
    const world = makeWorld()
    const r = await handler('compose_music', { sceneId: 'A', templateId: 'lofi' }, world)
    expect(r.success).toBe(true)
    const music = (world.scenes[0].audioLayer as any).music
    expect(music.provider).toBe('native-sequencer')
    expect(music.src).toBe('/audio/composed-deadbeef.wav')
    expect((r.changes?.[0] as any)?.description).toMatch(/\$0, no provider/)
    // The whole point: never gated, never billed.
    expect(checkApiPermission).not.toHaveBeenCalled()
  })

  it('uses the scene duration when no duration arg is given', async () => {
    const world = makeWorld()
    await handler('compose_music', { sceneId: 'A' }, world)
    expect(compose).toHaveBeenCalledWith(expect.objectContaining({ sceneDurationSec: 6 }))
  })

  it('surfaces clamp corrections in the result message', async () => {
    const world = makeWorld()
    const r = await handler('compose_music', { sceneId: 'A', tempo: 999 }, world)
    expect((r.changes?.[0] as any)?.description).toMatch(/adjusted:.*clamped/)
  })

  it('errors clearly when the soundfont is missing', async () => {
    resolveSoundfontPath.mockReturnValue(null)
    const r = await handler('compose_music', { sceneId: 'A' }, makeWorld())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/fetch-soundfont/)
    expect(composeMusicToFile).not.toHaveBeenCalled()
  })

  it('errors on an unknown scene', async () => {
    const r = await handler('compose_music', { sceneId: 'NOPE' }, makeWorld())
    expect(r.success).toBe(false)
  })
})
