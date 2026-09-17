// @vitest-environment node
// Without this the suite picks up the developer's real (postgres) DATABASE_URL
// from .env, and every best-effort action-log / spend write burns seconds
// failing against a libsql client that cannot speak it.
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createAudioToolHandler } from './audio-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

// dub_video dynamically imports the dub runtime; intercept it.
const runDubJob = vi.fn<(...a: any[]) => any>()
vi.mock('@/lib/services/dub/run-dub', () => ({ runDubJob: (...a: any[]) => runDubJob(...a) }))
// clone_voice dynamically imports the voice-clone service; intercept it.
const cloneVoiceGated = vi.fn<(...a: any[]) => any>()
vi.mock('@/lib/services/voice-clone', () => ({
  cloneVoiceGated: (...a: any[]) => cloneVoiceGated(...a),
}))
// add_narration statically imports synthesizeTTS and dynamically imports the
// TTS resolver; intercept both so we can drive the server-vs-client outcome.
const synthesizeTTS = vi.fn<(...a: any[]) => any>()
const searchSFX = vi.fn<(...a: any[]) => any>()
const searchMusic = vi.fn<(...a: any[]) => any>()
const generateMusic = vi.fn<(...a: any[]) => any>()
vi.mock('@/lib/services/audio', () => ({
  synthesizeTTS: (...a: any[]) => synthesizeTTS(...a),
  searchSFX: (...a: any[]) => searchSFX(...a),
  searchMusic: (...a: any[]) => searchMusic(...a),
  generateMusic: (...a: any[]) => generateMusic(...a),
}))
const resolveTTSForNarration = vi.fn<(...a: any[]) => any>()
vi.mock('@/lib/audio/resolve-best-tts-provider', () => ({
  resolveTTSForNarration: (...a: any[]) => resolveTTSForNarration(...a),
}))

/**
 * Direct coverage for the set_audio_mix mutation (no external services / deps
 * are touched by this tool, so the stubs below are never called):
 *   - honest no-op when the scene has no audio
 *   - error on unknown scene
 *   - partial-merge into audioProcessing (raw kept) + clamp surfaced in `resolved`
 *   - ducking.enabled/duckLevel mirrored to the legacy MusicTrack both mixers gate on
 */
const handler = createAudioToolHandler({
  checkApiPermission: () => null,
  enrichPermission: (r: unknown) => r,
} as unknown as Parameters<typeof createAudioToolHandler>[0])

function makeScene(audioLayer: unknown): Scene {
  return {
    id: 'A',
    name: 'A',
    sceneType: 'react',
    durationSeconds: 5,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    transition: 'none',
    audioLayer,
  } as unknown as Scene
}

function makeWorld(audioLayer: unknown): WorldStateMutable {
  return {
    scenes: [makeScene(audioLayer)],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: 'A' } as unknown as SceneGraph,
  } as unknown as WorldStateMutable
}

describe('set_audio_mix', () => {
  // E1: `applied:false` is still honest (nothing is audible yet), but the mix
  // must be STORED. attachMusicTrack explicitly honors "a ducking intent set via
  // set_audio_mix BEFORE music existed" — and that intent could never exist,
  // because this branch dropped the patch on the floor and returned success.
  it('stores the mix (applied:false) when the scene has no audio yet', async () => {
    const world = makeWorld(null)
    const r = await handler('set_audio_mix', { sceneId: 'A', masterGain: 2, ducking: { enabled: false } }, world)
    expect(r.success).toBe(true)
    expect((r.data as { applied?: boolean })?.applied).toBe(false)
    const layer = world.scenes[0].audioLayer as unknown as {
      enabled: boolean
      audioProcessing: { masterGain: number; ducking: { enabled: boolean } }
    }
    expect(layer.audioProcessing.masterGain).toBe(2)
    expect(layer.audioProcessing.ducking.enabled).toBe(false)
    // Storing a mix must not switch on an empty audio layer.
    expect(layer.enabled).toBe(false)
  })

  it('a ducking intent set before any music survives to attachMusicTrack', async () => {
    const world = makeWorld(null)
    await handler('set_audio_mix', { sceneId: 'A', ducking: { enabled: false } }, world)
    // add_background_music defaults duckDuringTTS:true; the pre-set intent wins.
    searchMusic.mockResolvedValue({ results: [{ name: 'bed', audioUrl: '/audio/m.mp3', provider: 'pixabay-music' }] })
    await handler('add_music', { sceneId: 'A', query: 'calm' }, world)
    const m = (world.scenes[0].audioLayer as unknown as { music: { duckDuringTTS: boolean } }).music
    expect(m.duckDuringTTS).toBe(false)
  })

  it('errors on an unknown scene', async () => {
    const r = await handler('set_audio_mix', { sceneId: 'ZZ' }, makeWorld({ enabled: true, tts: { src: '/t.wav' } }))
    expect(r.success).toBe(false)
  })

  it('partial-merges audioProcessing (raw kept) and clamps in the resolved summary', async () => {
    const world = makeWorld({ enabled: true, tts: { src: '/t.wav' }, audioProcessing: { masterGain: 2, ttsGain: 1.5 } })
    const r = await handler('set_audio_mix', { sceneId: 'A', musicGain: 999 }, world)
    expect((r.data as { applied?: boolean })?.applied).toBe(true)
    const ap = (world.scenes[0].audioLayer as unknown as { audioProcessing: Record<string, number> }).audioProcessing
    expect(ap.masterGain).toBe(2) // untouched sibling
    expect(ap.ttsGain).toBe(1.5) // untouched sibling
    expect(ap.musicGain).toBe(999) // raw merge keeps the input value
    expect((r.data as { resolved: { musicGain: number } }).resolved.musicGain).toBe(4) // clamped in resolved
  })

  it('mirrors ducking.enabled + duckLevel to the legacy MusicTrack', async () => {
    const world = makeWorld({
      enabled: true,
      tts: { src: '/t.wav' },
      music: { src: '/m.mp3', volume: 0.1, loop: false, duckDuringTTS: false, duckLevel: 0.2 },
    })
    await handler('set_audio_mix', { sceneId: 'A', ducking: { enabled: true, duckLevel: 0.4 } }, world)
    const m = (world.scenes[0].audioLayer as unknown as { music: { duckDuringTTS: boolean; duckLevel: number } }).music
    expect(m.duckDuringTTS).toBe(true)
    expect(m.duckLevel).toBe(0.4)
  })
})

describe('generate_music (agent generative music)', () => {
  const allow = createAudioToolHandler({
    checkApiPermission: () => null,
    enrichPermission: (r: unknown) => r,
  } as unknown as Parameters<typeof createAudioToolHandler>[0])

  const savedEnv = {
    el: process.env.ELEVENLABS_API_KEY,
    g: process.env.GOOGLE_AI_KEY,
    f: process.env.FAL_KEY,
  }
  beforeEach(() => {
    generateMusic.mockReset()
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.GOOGLE_AI_KEY
    delete process.env.FAL_KEY
  })
  afterEach(() => {
    process.env.ELEVENLABS_API_KEY = savedEnv.el
    process.env.GOOGLE_AI_KEY = savedEnv.g
    process.env.FAL_KEY = savedEnv.f
  })

  it('auto-picks ElevenLabs Music when its key is set, generates, and attaches as scene music', async () => {
    process.env.ELEVENLABS_API_KEY = 'k'
    generateMusic.mockResolvedValueOnce({
      result: { audioUrl: '/audio/m.mp3', name: 'warm lofi', provider: 'elevenlabs-music' },
      provider: 'elevenlabs-music',
    })
    const world = makeWorld(null)
    const r = await allow('generate_music', { sceneId: 'A', prompt: 'warm lofi piano' }, world)

    expect(r.success).toBe(true)
    expect(generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'elevenlabs-music', prompt: 'warm lofi piano' }),
    )
    const music = (world.scenes[0].audioLayer as unknown as { music: { src: string; loop: boolean } }).music
    expect(music.src).toBe('/audio/m.mp3')
    expect(music.loop).toBe(true)
  })

  it('rejects a non-generative (library) provider with guidance toward add_background_music', async () => {
    process.env.ELEVENLABS_API_KEY = 'k'
    const r = await allow('generate_music', { sceneId: 'A', prompt: 'x', provider: 'pixabay-music' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not a generative|add_background_music/i)
    expect(generateMusic).not.toHaveBeenCalled()
  })

  it('errors when no generative provider key is configured', async () => {
    const r = await allow('generate_music', { sceneId: 'A', prompt: 'x' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No generative music provider/i)
    expect(generateMusic).not.toHaveBeenCalled()
  })

  it('respects a denying spend gate — does not generate', async () => {
    process.env.ELEVENLABS_API_KEY = 'k'
    const deny = createAudioToolHandler({
      checkApiPermission: () => ({ success: false, error: 'cap exceeded' }),
      enrichPermission: (r: unknown) => r,
    } as unknown as Parameters<typeof createAudioToolHandler>[0])
    const r = await deny('generate_music', { sceneId: 'A', prompt: 'x' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(generateMusic).not.toHaveBeenCalled()
  })

  it('errors on a missing prompt', async () => {
    process.env.ELEVENLABS_API_KEY = 'k'
    const r = await allow('generate_music', { sceneId: 'A', prompt: '  ' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(generateMusic).not.toHaveBeenCalled()
  })
})

describe('dub_video (Tier 3 dubbing)', () => {
  const allow = createAudioToolHandler({
    checkApiPermission: () => null,
    enrichPermission: (r: unknown) => r,
  } as unknown as Parameters<typeof createAudioToolHandler>[0])

  beforeEach(() => runDubJob.mockReset())

  it('errors (no job) when sourceVideoUrl or targetLanguage is missing', async () => {
    const r = await allow('dub_video', { targetLanguage: 'es' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/sourceVideoUrl/)
    expect(runDubJob).not.toHaveBeenCalled()
  })

  it('sandbox: skips dubbing with no transcription/TTS/relip', async () => {
    const world = { ...makeWorld(null), sandboxMode: true } as WorldStateMutable
    const r = await allow('dub_video', { sourceVideoUrl: '/u/c.mp4', targetLanguage: 'es' }, world)
    expect(r.success).toBe(true)
    expect((r.data as { sandbox?: boolean })?.sandbox).toBe(true)
    expect(runDubJob).not.toHaveBeenCalled()
  })

  it('runs the dub job and returns the dubbed video', async () => {
    runDubJob.mockResolvedValue({ videoUrl: 'dub.mp4', segmentCount: 3, driftMs: 0, detectedLanguage: 'en' })
    const r = await allow(
      'dub_video',
      { sourceVideoUrl: '/u/c.mp4', targetLanguage: 'Spanish', voiceId: 'el_v' },
      makeWorld(null),
    )
    expect(r.success).toBe(true)
    expect((r.data as { videoUrl?: string })?.videoUrl).toBe('dub.mp4')
    expect(runDubJob).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'Spanish', voiceId: 'el_v' }))
  })

  it('surfaces the spend permission card and does NOT run the job when TTS spend is blocked', async () => {
    const blocked = createAudioToolHandler({
      checkApiPermission: (_w: unknown, api: string) =>
        api === 'elevenLabs' ? { success: false, permissionNeeded: { api } } : null,
      enrichPermission: (r: unknown) => r,
    } as unknown as Parameters<typeof createAudioToolHandler>[0])
    const r = await blocked('dub_video', { sourceVideoUrl: '/u/c.mp4', targetLanguage: 'es' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.permissionNeeded?.api).toBe('elevenLabs')
    expect(runDubJob).not.toHaveBeenCalled()
  })
})

describe('clone_voice (Tier 3 Cast)', () => {
  // Allows spend by default (checkApiPermission → null); enrichPermission passes through.
  const allowHandler = createAudioToolHandler({
    checkApiPermission: () => null,
    enrichPermission: (r: unknown) => r,
  } as unknown as Parameters<typeof createAudioToolHandler>[0])

  beforeEach(() => {
    cloneVoiceGated.mockReset()
  })

  it('errors (no provider call) when name or audioUrl is missing', async () => {
    const r = await allowHandler('clone_voice', { name: 'My Voice' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/audioUrl/)
    expect(cloneVoiceGated).not.toHaveBeenCalled()
  })

  it('sandbox: skips the clone entirely (no third-party call, $0)', async () => {
    const world = { ...makeWorld(null), sandboxMode: true } as WorldStateMutable
    const r = await allowHandler('clone_voice', { name: 'V', audioUrl: 'data:audio/mpeg;base64,AAAA' }, world)
    expect(r.success).toBe(true)
    expect((r.data as { sandbox?: boolean })?.sandbox).toBe(true)
    expect(cloneVoiceGated).not.toHaveBeenCalled()
  })

  it('surfaces a consent card (permissionNeeded kind=biometric_consent) when consent is missing', async () => {
    cloneVoiceGated.mockResolvedValue({
      consentNeeded: { destination: 'ElevenLabs (US)', version: 'v1', consentText: 'consent copy', voiceName: 'V' },
    })
    const r = await allowHandler('clone_voice', { name: 'V', audioUrl: 'data:audio/mpeg;base64,AAAA' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.permissionNeeded?.kind).toBe('biometric_consent')
    expect(r.permissionNeeded?.destination).toBe('ElevenLabs (US)')
    expect(r.permissionNeeded?.consentVersion).toBe('v1')
    expect(r.permissionNeeded?.toolName).toBe('clone_voice') // carries re-dispatch context
  })

  it('returns the created cloned voice on success', async () => {
    cloneVoiceGated.mockResolvedValue({ id: 'cv1', name: 'V', provider: 'elevenlabs', providerVoiceId: 'el_v' })
    const r = await allowHandler('clone_voice', { name: 'V', audioUrl: 'data:audio/mpeg;base64,AAAA' }, makeWorld(null))
    expect(r.success).toBe(true)
    expect((r.data as { clonedVoiceId?: string })?.clonedVoiceId).toBe('cv1')
    expect((r.data as { voiceId?: string })?.voiceId).toBe('el_v')
  })

  it('surfaces the spend permission card and does NOT call the service when ElevenLabs spend is blocked', async () => {
    const blockedHandler = createAudioToolHandler({
      checkApiPermission: () => ({ success: false, permissionNeeded: { api: 'elevenLabs', estimatedCost: '$0.06' } }),
      enrichPermission: (r: unknown) => r,
    } as unknown as Parameters<typeof createAudioToolHandler>[0])
    const r = await blockedHandler(
      'clone_voice',
      { name: 'V', audioUrl: 'data:audio/mpeg;base64,AAAA' },
      makeWorld(null),
    )
    expect(r.success).toBe(false)
    expect(r.permissionNeeded?.api).toBe('elevenLabs')
    expect(cloneVoiceGated).not.toHaveBeenCalled() // never reached the paid clone
  })
})

describe('add_narration (server-output requirement — silent-export guard)', () => {
  const allow = createAudioToolHandler({
    checkApiPermission: () => null,
    enrichPermission: (r: unknown) => r,
  } as unknown as Parameters<typeof createAudioToolHandler>[0])

  beforeEach(() => {
    synthesizeTTS.mockReset()
    resolveTTSForNarration.mockReset()
  })

  it('requires server output from the resolver (auto provider) so the export is exportable', async () => {
    resolveTTSForNarration.mockReturnValue({ provider: 'elevenlabs', reason: 'server', ranking: [] })
    synthesizeTTS.mockResolvedValue({ url: '/audio/a.wav', duration: 2.3, provider: 'elevenlabs', captions: null })
    const r = await allow('add_narration', { sceneId: 'A', text: 'hello world' }, makeWorld(null))
    expect(resolveTTSForNarration).toHaveBeenCalledWith(expect.objectContaining({ requiresServerOutput: true }))
    expect(r.success).toBe(true)
    expect((r.data as { audioUrl?: string })?.audioUrl).toBe('/audio/a.wav')
  })

  it("threads the project's audioSettings so the user's default TTS provider is honored", async () => {
    resolveTTSForNarration.mockReturnValue({ provider: 'pocket-tts', reason: 'user default', ranking: [] })
    synthesizeTTS.mockResolvedValue({ url: '/audio/p.wav', duration: 1, provider: 'pocket-tts', captions: null })
    const world = makeWorld(null)
    ;(world as unknown as { audioSettings: unknown }).audioSettings = {
      defaultTTSProvider: 'pocket-tts',
      pocketTTSUrl: 'http://localhost:8000',
    }
    await allow('add_narration', { sceneId: 'A', text: 'hi' }, world)
    // The resolver must receive `settings` (was dropped before — the user's
    // pocket-tts default was silently ignored and it fell back to ElevenLabs).
    expect(resolveTTSForNarration).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ defaultTTSProvider: 'pocket-tts' }),
      }),
    )
  })

  it('writes a real audio file (success, src set) when a server provider is available', async () => {
    resolveTTSForNarration.mockReturnValue({ provider: 'openai-tts', reason: 'server', ranking: [] })
    synthesizeTTS.mockResolvedValue({ url: '/audio/b.wav', duration: 1, provider: 'openai-tts', captions: null })
    const world = makeWorld(null)
    const r = await allow('add_narration', { sceneId: 'A', text: 'narrate me' }, world)
    expect(r.success).toBe(true)
    const layer = world.scenes[0].audioLayer as unknown as { src: string; tts: { src: string } }
    expect(layer.src).toBe('/audio/b.wav')
    expect(layer.tts.src).toBe('/audio/b.wav')
  })

  // E1: this used to assert success:true with a WARNING string. It was the
  // worst kind of lie — the handler returned ok() and never called updateScene,
  // so the scene got NO tts layer at all (not even the browser preview the
  // message promised) while the agent read success and reported the video as
  // narrated. Nothing was written ⇒ nothing succeeded.
  it('FAILS honestly (no mutation, no synthesis) when no server provider is configured', async () => {
    resolveTTSForNarration.mockReturnValue({ provider: null, reason: 'no provider available', ranking: [] })
    const world = makeWorld(null)
    const r = await allow('add_narration', { sceneId: 'A', text: 'hello' }, world)
    expect(synthesizeTTS).not.toHaveBeenCalled() // short-circuits before synthesis
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/nothing was added to the scene/i)
    expect(r.error).toMatch(/API key/i)
    // …and it names the escape hatch for a preview-only voiceover.
    expect(r.error).toMatch(/web-speech/)
    // The scene is untouched — the old code claimed a preview narration it never wrote.
    expect(world.scenes[0].audioLayer).toBeNull()
  })

  it('still warns (does not report a clean success) when an explicit client-only provider is picked', async () => {
    resolveTTSForNarration.mockReturnValue({ provider: 'web-speech', reason: 'x', ranking: [] })
    synthesizeTTS.mockResolvedValue({ mode: 'client', provider: 'web-speech', text: 'hi', voiceId: null })
    const r = await allow('add_narration', { sceneId: 'A', text: 'hi', provider: 'web-speech' }, makeWorld(null))
    expect(r.success).toBe(true)
    const desc = (r.changes?.[0] as { description?: string })?.description ?? ''
    expect(desc).toMatch(/SILENT/)
    expect((r.data as { exportSilent?: boolean })?.exportSilent).toBe(true)
  })

  it('degrades gracefully (browser preview + honest warning) when a configured LOCAL TTS server is unreachable', async () => {
    // The scorer picks a configured-but-dead local server (it can't ping); the
    // synth then fails fast (connection refused). Rather than an opaque
    // "Narration failed" that leaves the scene silent with nothing to act on,
    // fall back to a browser voice for the preview and disclose the silent
    // export + how to fix it.
    resolveTTSForNarration.mockReturnValue({ provider: 'pocket-tts', reason: 'local', ranking: [] })
    synthesizeTTS.mockRejectedValue(new Error('fetch failed (ECONNREFUSED 127.0.0.1:8000)'))
    const world = makeWorld(null)
    const r = await allow('add_narration', { sceneId: 'A', text: 'narrate me' }, world)
    expect(r.success).toBe(true) // graceful, not a hard failure
    const desc = (r.changes?.[0] as { description?: string })?.description ?? ''
    expect(desc).toMatch(/unreachable/i)
    expect(desc).toMatch(/SILENT/)
    expect((r.data as { exportSilent?: boolean })?.exportSilent).toBe(true)
    expect((r.data as { localServerUnreachable?: string })?.localServerUnreachable).toBe('pocket-tts')
    // preview layer switched to a client voice so the browser still narrates
    const layer = world.scenes[0].audioLayer as unknown as { enabled: boolean; tts: { provider: string; src: null } }
    expect(layer.enabled).toBe(true)
    expect(layer.tts.provider).toBe('web-speech')
    expect(layer.tts.src).toBeNull()
  })

  it('still hard-fails honestly when a CLOUD provider errors (not swallowed as a silent-export warning)', async () => {
    resolveTTSForNarration.mockReturnValue({ provider: 'elevenlabs', reason: 'server', ranking: [] })
    synthesizeTTS.mockRejectedValue(new Error('401 unauthorized'))
    const r = await allow('add_narration', { sceneId: 'A', text: 'narrate me' }, makeWorld(null))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Narration failed/i)
  })
})

describe('add_sound_effect — trigger clamp (T13)', () => {
  const sfxHandler = createAudioToolHandler({
    checkApiPermission: () => null,
    regenerateHTML: async () => ({ htmlWritten: true }),
  } as unknown as Parameters<typeof createAudioToolHandler>[0])

  function world5sScene() {
    const w = makeWorld(null)
    ;(w.scenes[0] as unknown as { duration: number }).duration = 5
    return w
  }

  it('clamps an SFX past the scene end into the scene and reports the clamp honestly', async () => {
    searchSFX.mockResolvedValue({
      results: [{ name: 'whoosh', audioUrl: 'http://x/w.mp3', duration: 1 }],
      provider: 'pixabay',
    })
    const r = await sfxHandler('add_sound_effect', { sceneId: 'A', query: 'whoosh', triggerAt: 12 }, world5sScene())
    expect(r.success).toBe(true)
    // Clamped to just inside the 5s scene, NOT the requested 12s (which would be
    // dropped by -shortest at export).
    expect((r.data as { sfx: { triggerAt: number } }).sfx.triggerAt).toBeCloseTo(4.95)
    const desc = (r.changes?.[0] as { description?: string })?.description ?? ''
    expect(desc).toMatch(/clamped from 12s/)
  })

  it('leaves an in-range trigger untouched and validates NaN volume', async () => {
    searchSFX.mockResolvedValue({
      results: [{ name: 'pop', audioUrl: 'http://x/p.mp3', duration: 1 }],
      provider: 'pixabay',
    })
    const r = await sfxHandler(
      'add_sound_effect',
      { sceneId: 'A', query: 'pop', triggerAt: 2, volume: NaN },
      world5sScene(),
    )
    const sfx = (r.data as { sfx: { triggerAt: number; volume: number } }).sfx
    expect(sfx.triggerAt).toBe(2)
    expect(sfx.volume).toBe(0.8) // NaN fell back to the default
  })
})
