// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

/**
 * V7 Lane B — media money. Covers the five behaviors P0-2 / P1-8 / P1-10 protect:
 *  1. media-gen tools get the LONG timeout tier (not the 60s default).
 *  2. idempotency: a double-call to generate_music makes ONE provider call +
 *     ONE bill (the request-hash cache serves the retry).
 *  3. abort: an aborted run makes NO provider call (no bill).
 *  4. regenerateHTML htmlWritten:false → a DEGRADED (warned) result, not silent success.
 *  5. stale-cap: checkApiPermission re-hydrates live spend so the in-run $ cap
 *     advances across N generations (does not read a stale run-start zero).
 */

// ── shared db mock (getCachedMedia / setCachedMedia / logSpend / getProjectApiSpend) ──
const dbState = {
  cache: new Map<string, { filePath: string; config: string | null }>(),
  spendLog: [] as Array<{ projectId: string; api: string; cost: number }>,
  // live ledger the stale-cap re-hydrate reads (per api)
  liveSpend: {} as Record<string, { session: number; monthly: number }>,
}
const getCachedMedia = vi.fn(async (hash: string) => dbState.cache.get(hash) ?? null)
const setCachedMedia = vi.fn(async (hash: string, _api: string, filePath: string) => {
  dbState.cache.set(hash, { filePath, config: null })
})
const logSpend = vi.fn(async (projectId: string, api: string, cost: number) => {
  dbState.spendLog.push({ projectId, api, cost })
})
const getProjectApiSpend = vi.fn(
  async (_projectId: string, api: string) => dbState.liveSpend[api] ?? { session: 0, monthly: 0 },
)

vi.mock('@/lib/db', () => ({
  getCachedMedia: (...a: any[]) => (getCachedMedia as any)(...a),
  setCachedMedia: (...a: any[]) => (setCachedMedia as any)(...a),
  logSpend: (...a: any[]) => (logSpend as any)(...a),
  getProjectApiSpend: (...a: any[]) => (getProjectApiSpend as any)(...a),
}))

// the cached file always "exists" so a cache hit is honored
vi.mock('@/lib/media-paths', () => ({
  resolvePublicMediaPath: (url: string) => (url ? `/abs${url}` : null),
}))
vi.mock('node:fs/promises', () => ({
  default: { access: vi.fn(async () => undefined) },
  access: vi.fn(async () => undefined),
}))

// the music provider (paid). Counts calls so we can prove dedupe = one call.
const generateMusic = vi.fn<(...a: any[]) => any>(async () => ({
  result: { audioUrl: '/audio/music-123.mp3', name: 'clip', provider: 'stable-audio' },
  provider: 'stable-audio',
}))
const synthesizeTTS = vi.fn<(...a: any[]) => any>()
const searchSFX = vi.fn<(...a: any[]) => any>()
const searchMusic = vi.fn<(...a: any[]) => any>()
vi.mock('@/lib/services/audio', () => ({
  synthesizeTTS: (...a: any[]) => synthesizeTTS(...a),
  searchSFX: (...a: any[]) => searchSFX(...a),
  searchMusic: (...a: any[]) => searchMusic(...a),
  generateMusic: (...a: any[]) => generateMusic(...a),
}))

import { createAudioToolHandler } from './audio-tools'
import {
  toolTimeoutMs,
  MEDIA_GEN_TOOL_SET,
  checkApiPermission,
  setWorldAbortSignal,
  type WorldStateMutable as WSM,
} from '@/lib/agents/tool-executor'
import { degradeIfHtmlUnwritten, ok } from './_shared'
import { createDefaultAPIPermissions } from '@/lib/permissions'

function makeScene(): Scene {
  return {
    id: 'A',
    name: 'A',
    sceneType: 'react',
    duration: 5,
    durationSeconds: 5,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    transition: 'none',
    audioLayer: null,
  } as unknown as Scene
}

function makeWorld(): WorldStateMutable {
  return {
    scenes: [makeScene()],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: 'A' } as SceneGraph,
  } as unknown as WorldStateMutable
}

const audioHandler = createAudioToolHandler({
  checkApiPermission: () => null,
  enrichPermission: (r: unknown) => r,
} as unknown as Parameters<typeof createAudioToolHandler>[0])

beforeEach(() => {
  dbState.cache.clear()
  dbState.spendLog.length = 0
  dbState.liveSpend = {}
  vi.clearAllMocks()
  process.env.FAL_KEY = 'test-fal-key'
})

// ── 1. timeout tier ──────────────────────────────────────────────────────────
describe('media-gen timeout tier (P0-2)', () => {
  it('gives every paid media-gen tool a timeout LONGER than the 60s default', () => {
    const defaultMs = toolTimeoutMs('set_scene_duration') // a plain mutator
    expect(defaultMs).toBe(60_000)
    for (const tool of MEDIA_GEN_TOOL_SET) {
      expect(toolTimeoutMs(tool)).toBeGreaterThan(60_000)
      expect(toolTimeoutMs(tool)).toBeGreaterThan(120_000) // longer than the generation tier too
    }
  })

  it('covers the named media-gen tools', () => {
    for (const name of [
      'generate_image',
      'add_narration',
      'add_sfx',
      'add_music',
      'generate_avatar_narration',
      'generate_avatar_scene',
      'dub_video',
      'clone_voice',
    ]) {
      expect(MEDIA_GEN_TOOL_SET.has(name)).toBe(true)
    }
  })

  it('P1-1: generate_avatar_scene is in the long-timeout tier (twin of generate_avatar_narration)', () => {
    // Both call startAvatarGeneration and block on a real fal lipsync render on
    // sync providers — generate_avatar_scene must NOT fall back to the 60s default.
    expect(MEDIA_GEN_TOOL_SET.has('generate_avatar_scene')).toBe(true)
    expect(toolTimeoutMs('generate_avatar_scene')).toBeGreaterThan(60_000)
    expect(toolTimeoutMs('generate_avatar_scene')).toBe(toolTimeoutMs('generate_avatar_narration'))
  })
})

// ── 2 + 3. generate_music idempotency + abort ──────────────────────────────────
describe('generate_music idempotency + abort (P0-2 / P1-8)', () => {
  it('double-call → ONE provider call + ONE bill (retry reattaches the cached clip)', async () => {
    const world = makeWorld()
    const r1 = await audioHandler(
      'generate_music',
      { sceneId: 'A', prompt: 'lofi beat', provider: 'stable-audio' },
      world,
    )
    expect(r1.success).toBe(true)

    // identical second call (the "retry")
    const world2 = makeWorld()
    const r2 = await audioHandler(
      'generate_music',
      { sceneId: 'A', prompt: 'lofi beat', provider: 'stable-audio' },
      world2,
    )
    expect(r2.success).toBe(true)

    // exactly one paid provider call across both
    expect(generateMusic).toHaveBeenCalledTimes(1)
    // exactly one ledger commit — the cache hit must NOT re-bill
    expect(dbState.spendLog.length).toBe(1)
    expect(dbState.spendLog[0].api).toBe('falMusic')
    // both attached the same clip to a scene
    expect((world.scenes[0].audioLayer as any)?.music?.src).toBe('/audio/music-123.mp3')
    expect((world2.scenes[0].audioLayer as any)?.music?.src).toBe('/audio/music-123.mp3')
  })

  it('aborted run → NO provider call and NO bill', async () => {
    const world = makeWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world as unknown as WSM, controller.signal)
    controller.abort()

    const r = await audioHandler(
      'generate_music',
      { sceneId: 'A', prompt: 'lofi beat', provider: 'stable-audio' },
      world,
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/aborted/i)
    expect(generateMusic).not.toHaveBeenCalled()
    expect(dbState.spendLog.length).toBe(0)
  })
})

// ── 3b. agent TTS/SFX are billed on the agent path (P1-2) ──────────────────────
describe('agent TTS/SFX commit spend on the agent path (P1-2)', () => {
  // elevenlabs_tts was deleted (folded into add_narration provider:'elevenlabs').
  // The "→ ONE logSpend" case is covered by the add_narration test below; sandbox +
  // attach coverage is preserved here, repointed to add_narration.
  it('add_narration(elevenlabs) in sandbox uses the free local voice → NO bill', async () => {
    synthesizeTTS.mockResolvedValueOnce({ url: '/audio/native.mp3', provider: 'native-tts', duration: 1.0 })
    const world = { ...makeWorld(), sandboxMode: true } as unknown as WorldStateMutable
    const r = await audioHandler('add_narration', { sceneId: 'A', text: 'hi', provider: 'elevenlabs' }, world)
    expect(r.success).toBe(true)
    expect(dbState.spendLog.length).toBe(0)
  })

  it('add_narration(elevenlabs) ATTACHES the paid audio to the scene (P2 — bill-and-lose fix)', async () => {
    // The scene starts with no audio; the billed TTS must land on the scene's
    // audioLayer (src + tts.src = the generated url), not just be returned in the
    // result. Without the updateScene, the paid audio would go nowhere.
    synthesizeTTS.mockResolvedValueOnce({ url: '/audio/tts-attach.mp3', provider: 'elevenlabs', duration: 2.4 })
    const world = makeWorld()
    expect(world.scenes[0].audioLayer).toBeNull()
    const r = await audioHandler('add_narration', { sceneId: 'A', text: 'attach me', provider: 'elevenlabs' }, world)
    expect(r.success).toBe(true)
    const layer = world.scenes[0].audioLayer as any
    expect(layer).toBeTruthy()
    expect(layer.enabled).toBe(true)
    expect(layer.src).toBe('/audio/tts-attach.mp3')
    expect(layer.tts?.src).toBe('/audio/tts-attach.mp3')
    expect(layer.tts?.status).toBe('ready')
    expect((r.data as any)?.audioUrl).toBe('/audio/tts-attach.mp3')
  })

  it('add_narration → ONE logSpend under the resolved paid TTS apiName (explicit elevenlabs)', async () => {
    synthesizeTTS.mockResolvedValueOnce({
      url: '/audio/narr-1.mp3',
      provider: 'elevenlabs',
      duration: 3.4,
      captions: null,
    })
    const world = makeWorld()
    const r = await audioHandler(
      'add_narration',
      { sceneId: 'A', text: 'a longer narration line to read aloud', provider: 'elevenlabs' },
      world,
    )
    expect(r.success).toBe(true)
    expect(synthesizeTTS).toHaveBeenCalledTimes(1)
    expect(dbState.spendLog.length).toBe(1)
    expect(dbState.spendLog[0].api).toBe('elevenLabs')
    expect(dbState.spendLog[0].cost).toBeGreaterThan(0)
  })

  it('add_sound_effect (elevenlabs-sfx = generative/paid) → ONE logSpend under elevenLabs', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-eleven-key'
    searchSFX.mockResolvedValueOnce({
      provider: 'elevenlabs-sfx',
      results: [{ name: 'whoosh', provider: 'elevenlabs-sfx', audioUrl: '/audio/sfx-1.mp3', duration: 0.8 }],
    })
    const world = makeWorld()
    const r = await audioHandler(
      'add_sound_effect',
      { sceneId: 'A', query: 'whoosh', provider: 'elevenlabs-sfx' },
      world,
    )
    expect(r.success).toBe(true)
    expect(searchSFX).toHaveBeenCalledTimes(1)
    expect(dbState.spendLog.length).toBe(1)
    expect(dbState.spendLog[0].api).toBe('elevenLabs')
    expect(dbState.spendLog[0].cost).toBeGreaterThan(0)
  })

  it('the committed spend advances the in-run cap — re-hydrate reads it back (TTS → elevenLabs)', async () => {
    // 1) agent TTS commits a bill to the (mocked) ledger
    synthesizeTTS.mockResolvedValueOnce({ url: '/audio/tts-cap.mp3', provider: 'elevenlabs', duration: 2.0 })
    const world = makeWorld()
    await audioHandler('add_narration', { sceneId: 'A', text: 'bill me', provider: 'elevenlabs' }, world)
    expect(dbState.spendLog.length).toBe(1)
    const billed = dbState.spendLog[0].cost

    // 2) reflect that bill in the live ledger and set a cap just under it
    dbState.liveSpend.elevenLabs = { session: billed, monthly: billed }
    const perms = createDefaultAPIPermissions()
    perms.elevenLabs = {
      ...perms.elevenLabs,
      mode: 'always_allow',
      sessionSpend: 0, // STALE run-start zero
      sessionLimit: billed / 2, // cap below what's already billed
      monthlyLimit: null,
      monthlySpend: 0,
    }
    const capWorld = {
      scenes: [],
      projectId: 'project-test',
      apiPermissions: perms,
      permissionPosture: 'auto',
    } as unknown as WSM

    // re-hydrate sees the LIVE billed spend (not the stale zero) → cap fires
    const denied = await checkApiPermission(capWorld, 'elevenLabs', { details: { prompt: 'x' } })
    expect(denied?.success).toBe(false)
    expect(denied?.error).toMatch(/spend limit reached/i)
  })
})

// ── 4. htmlWritten degrade ─────────────────────────────────────────────────────
describe('regenerateHTML htmlWritten:false → degraded result (P1-10)', () => {
  it('passes the success result through untouched when htmlWritten is true', () => {
    const base = ok('A', 'Placed image')
    const out = degradeIfHtmlUnwritten({ htmlWritten: true }, base)
    expect(out).toBe(base)
    expect(out.success).toBe(true)
    expect((out.data as any)?.htmlWritten).toBeUndefined()
  })

  it('degrades (warns, flags) — NOT silent success — when htmlWritten is false', () => {
    const out = degradeIfHtmlUnwritten(
      { htmlWritten: false, error: 'Run aborted by user — HTML write skipped' },
      ok('A', 'Placed image'),
    )
    // still success (the world-state mutation is real) but loudly flagged
    expect(out.success).toBe(true)
    expect((out.data as any)?.htmlWritten).toBe(false)
    const desc = (out.changes?.[0] as any)?.description as string
    expect(desc).toMatch(/WARNING/)
    expect(desc).toMatch(/did not update on disk/i)
    expect(desc).toMatch(/aborted/i) // surfaces the underlying reason
  })

  it('merges htmlWritten:false into existing data without dropping it', () => {
    const out = degradeIfHtmlUnwritten(
      { htmlWritten: false },
      ok('A', 'Reused asset', { assetId: 'x', publicUrl: '/u' }),
    )
    expect((out.data as any).assetId).toBe('x')
    expect((out.data as any).publicUrl).toBe('/u')
    expect((out.data as any).htmlWritten).toBe(false)
  })
})

// ── 5. stale spend cap re-hydrate ──────────────────────────────────────────────
describe('stale spend cap re-hydrates live spend across N gens (P0-2 / learning agent-gate-stale-spend-cap)', () => {
  function worldWithCap(sessionLimit: number): WSM {
    const perms = createDefaultAPIPermissions()
    // start the in-memory config at a STALE zero (the run-start snapshot)
    perms.falMusic = {
      ...perms.falMusic,
      mode: 'always_allow',
      sessionSpend: 0,
      sessionLimit,
      monthlyLimit: null,
      monthlySpend: 0,
    }
    return {
      scenes: [],
      projectId: 'project-test',
      apiPermissions: perms,
      permissionPosture: 'auto',
    } as unknown as WSM
  }

  it('advances the in-run cap as the ledger grows — the stale in-memory zero is overwritten', async () => {
    const world = worldWithCap(1.0) // $1 cap

    // gen #1: ledger at $0 → under cap → allowed
    dbState.liveSpend.falMusic = { session: 0, monthly: 0 }
    expect(await checkApiPermission(world, 'falMusic', { details: { prompt: 'x' } })).toBeNull()

    // ledger climbs past the cap after a couple gens
    dbState.liveSpend.falMusic = { session: 0.9, monthly: 0.9 }
    expect(await checkApiPermission(world, 'falMusic', { details: { prompt: 'x' } })).toBeNull() // still under $1

    dbState.liveSpend.falMusic = { session: 1.2, monthly: 1.2 }
    const denied = await checkApiPermission(world, 'falMusic', { details: { prompt: 'x' } })
    // re-hydrate saw the LIVE $1.20 (not the stale $0) → cap fires
    expect(denied?.success).toBe(false)
    expect(denied?.error).toMatch(/spend limit reached/i)

    // and the re-hydrate actually queried the ledger each time
    expect(getProjectApiSpend).toHaveBeenCalled()
  })

  it('does NOT query the ledger when no cap is set (no DB read per gated call)', async () => {
    const perms = createDefaultAPIPermissions()
    perms.falMusic = { ...perms.falMusic, mode: 'always_allow', sessionLimit: null, monthlyLimit: null }
    const world = {
      scenes: [],
      projectId: 'project-test',
      apiPermissions: perms,
      permissionPosture: 'auto',
    } as unknown as WSM
    await checkApiPermission(world, 'falMusic', { details: { prompt: 'x' } })
    expect(getProjectApiSpend).not.toHaveBeenCalled()
  })
})
