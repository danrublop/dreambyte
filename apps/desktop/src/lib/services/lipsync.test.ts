// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// lipsync does `await import(...)` for the gate, audio router, reference upload, avatar service, db.
// audio-models (ttsApiNameFor) is the REAL module. vi.mock intercepts dynamic imports.
const gateMediaSpend = vi.fn()
vi.mock('./media-gate', () => ({ gateMediaSpend: (...a: unknown[]) => gateMediaSpend(...a) }))

const getBestTTSProvider = vi.fn()
const ttsGenerate = vi.fn()
vi.mock('@/lib/audio/router', () => ({
  getBestTTSProvider: () => getBestTTSProvider(),
  getTTSProvider: async () => ({ generate: (a: unknown) => ttsGenerate(a) }),
}))

const resolveRef = vi.fn(async (r: string) => `https://fetchable/${r}`)
vi.mock('@/lib/media/reference-upload', () => ({ resolveReferenceToFetchableUrl: (r: string) => resolveRef(r) }))

const providerGenerate = vi.fn()
const estimateCost = vi.fn(() => 0.04)
vi.mock('@/lib/avatar', () => ({
  AvatarService: {
    getProvider: (id: string) => {
      if (id === 'nope') throw new Error('Unknown avatar provider: nope')
      return { id, generate: (a: unknown, b: unknown) => providerGenerate(a, b), estimateCost }
    },
  },
}))

const logSpend = vi.fn()
vi.mock('@/lib/db', () => ({ logSpend: (...a: unknown[]) => logSpend(...a) }))
vi.mock('@/lib/permissions', () => ({ estimateApiCostUsd: () => 0.05 }))

import { generateLipsyncAsset } from './lipsync'

beforeEach(() => {
  process.env.FAL_KEY = 'test-key' // the early FAL_KEY guard must pass for the happy paths
  gateMediaSpend.mockReset().mockResolvedValue(null) // allow by default
  getBestTTSProvider.mockReset().mockReturnValue('elevenlabs')
  ttsGenerate.mockReset().mockResolvedValue({ audioUrl: '/audio/x.mp3' })
  resolveRef.mockClear()
  providerGenerate.mockReset().mockResolvedValue({ videoUrl: 'http://v/clip.mp4', durationSeconds: 6, costUsd: 0.04 })
  logSpend.mockReset()
})

describe('generateLipsyncAsset', () => {
  it('requires a face image', async () => {
    const out = await generateLipsyncAsset({ provider: 'musetalk', sourceImageUrl: '', text: 'hi' })
    expect(out).toEqual({ error: expect.stringMatching(/face image is required/i) })
  })

  it('rejects a non-whitelisted provider (only musetalk/fabric/aurora reachable)', async () => {
    const out = await generateLipsyncAsset({
      provider: 'heygen',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
    })
    expect(out).toEqual({ error: expect.stringMatching(/unsupported lipsync provider/i) })
    expect(providerGenerate).not.toHaveBeenCalled()
  })

  it('fails fast when FAL_KEY is missing — BEFORE any paid TTS', async () => {
    delete process.env.FAL_KEY
    const out = await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'musetalk',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
    })
    expect(out).toEqual({ error: expect.stringMatching(/FAL_KEY/i) })
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(logSpend).not.toHaveBeenCalled()
  })

  it('returns {error} when the spend gate denies (falAvatar) — no provider call', async () => {
    gateMediaSpend.mockResolvedValueOnce({ denied: true, reason: 'Monthly cap reached.' })
    const out = await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'musetalk',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
    })
    expect(gateMediaSpend).toHaveBeenCalledWith(
      'p1',
      'falAvatar',
      { prompt: 'hi', model: 'musetalk' },
      {
        surfaceAsk: true,
        approvedAsk: undefined,
      },
    )
    expect(out).toEqual({ error: 'Monthly cap reached.' })
    expect(providerGenerate).not.toHaveBeenCalled()
  })

  it('surfaces permissionNeeded on ASK (falAvatar) — no provider call', async () => {
    const permissionNeeded = {
      api: 'falAvatar',
      estimatedCost: '~$0.50',
      estimatedCostUsd: 0.5,
      reason: 'x',
      details: {},
    }
    gateMediaSpend.mockResolvedValueOnce({ ask: true, permissionNeeded })
    const out = await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'musetalk',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
    })
    expect(out).toEqual({ permissionNeeded })
    expect(providerGenerate).not.toHaveBeenCalled()
  })

  it('refuses a client-only TTS provider (no server voice for the speech)', async () => {
    getBestTTSProvider.mockReturnValue('web-speech')
    const out = await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'musetalk',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
    })
    expect(out).toEqual({ error: expect.stringMatching(/server TTS provider/i) })
    expect(providerGenerate).not.toHaveBeenCalled()
  })

  it('happy path: TTS → fetchable audio + face → provider.generate → video, logs both spends', async () => {
    const out = await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'musetalk',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hello world',
    })
    // both refs resolved to fetchable URLs (fal fetches them server-side)
    expect(resolveRef).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(resolveRef).toHaveBeenCalledWith('/audio/x.mp3')
    // provider got fetchable image + audio
    expect(providerGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImageUrl: 'https://fetchable/data:image/png;base64,AAAA',
        audioUrl: 'https://fetchable//audio/x.mp3',
      }),
      {},
    )
    // result carries the LOCAL audio so the store attaches it as a paired (audible) scene track
    expect(out).toEqual({ videoUrl: 'http://v/clip.mp4', durationSeconds: 6, audioUrl: '/audio/x.mp3' })
    // TTS spend (elevenLabs) + avatar spend (falAvatar) both committed
    expect(logSpend).toHaveBeenCalledWith('p1', 'elevenLabs', 0.05, expect.any(String))
    expect(logSpend).toHaveBeenCalledWith('p1', 'falAvatar', 0.04, expect.any(String))
  })

  it('skips TTS when an audio source is supplied', async () => {
    await generateLipsyncAsset({
      projectId: 'p1',
      provider: 'aurora',
      sourceImageUrl: 'data:image/png;base64,AAAA',
      text: 'hi',
      audioUrl: '/audio/pre.mp3',
    })
    expect(getBestTTSProvider).not.toHaveBeenCalled()
    expect(ttsGenerate).not.toHaveBeenCalled()
    expect(providerGenerate).toHaveBeenCalled()
  })

  it('times out (returns {error}) when the avatar provider stalls — no infinite generating', async () => {
    vi.useFakeTimers()
    try {
      providerGenerate.mockReturnValue(new Promise(() => {})) // never resolves
      const promise = generateLipsyncAsset({
        projectId: 'p1',
        provider: 'musetalk',
        sourceImageUrl: 'data:image/png;base64,AAAA',
        text: 'hi',
        audioUrl: '/audio/pre.mp3',
      })
      await vi.advanceTimersByTimeAsync(241_000) // past the 240s avatar timeout
      const out = await promise
      expect(out).toEqual({ error: expect.stringMatching(/timed out/i) })
    } finally {
      vi.useRealTimers()
    }
  })
})
