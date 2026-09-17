// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// audio-gen does `await import(...)` for the gate, the audio services, the db ledger, and the cost
// estimator. vi.mock intercepts dynamic imports too. The audio-model directory (audio-models.ts)
// is the REAL module — its provider→apiName mapping is part of what we're testing.
const gateMediaSpend = vi.fn()
vi.mock('./media-gate', () => ({ gateMediaSpend: (...a: unknown[]) => gateMediaSpend(...a) }))

const synthesizeTTS = vi.fn()
const searchSFX = vi.fn()
const generateMusic = vi.fn()
vi.mock('./audio', () => ({
  synthesizeTTS: (...a: unknown[]) => synthesizeTTS(...a),
  searchSFX: (...a: unknown[]) => searchSFX(...a),
  generateMusic: (...a: unknown[]) => generateMusic(...a),
}))

const logSpend = vi.fn()
vi.mock('@/lib/db', () => ({ logSpend: (...a: unknown[]) => logSpend(...a) }))
vi.mock('@/lib/permissions', () => ({ estimateApiCostUsd: () => 0.06 }))

// audio-gen dynamically imports getBestTTSProvider to resolve a missing/'auto' provider before gating.
const getBestTTSProvider = vi.fn()
vi.mock('@/lib/audio/router', () => ({ getBestTTSProvider: (...a: unknown[]) => getBestTTSProvider(...a) }))

import { generateNarrationGated, generateSfxGated, generateMusicGated } from './audio-gen'

beforeEach(() => {
  gateMediaSpend.mockReset()
  synthesizeTTS.mockReset()
  searchSFX.mockReset()
  generateMusic.mockReset()
  logSpend.mockReset()
  getBestTTSProvider.mockReset()
  gateMediaSpend.mockResolvedValue(null) // allow by default
})

describe('generateNarrationGated (TTS)', () => {
  it('skips the gate entirely for a FREE provider (web-speech) and never logs spend', async () => {
    synthesizeTTS.mockResolvedValue({ mode: 'client', provider: 'web-speech', text: 'hi', voiceId: null })
    const out = await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1', provider: 'web-speech' })
    expect(gateMediaSpend).not.toHaveBeenCalled()
    expect(synthesizeTTS).toHaveBeenCalled()
    expect(logSpend).not.toHaveBeenCalled()
    expect(out).toMatchObject({ provider: 'web-speech' })
  })

  it('gates a PAID provider against its apiName and returns {error} on deny (no synth, no spend)', async () => {
    gateMediaSpend.mockResolvedValue({ denied: true, reason: 'Monthly cap reached.' })
    const out = await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1', provider: 'elevenlabs' })
    expect(gateMediaSpend).toHaveBeenCalledWith(
      'p1',
      'elevenLabs',
      { prompt: 'hi', model: 'elevenlabs' },
      {
        surfaceAsk: true,
        approvedAsk: undefined,
      },
    )
    expect(synthesizeTTS).not.toHaveBeenCalled()
    expect(out).toEqual({ error: 'Monthly cap reached.' })
  })

  it('on allow, synthesizes and commits spend against the resolved apiName', async () => {
    synthesizeTTS.mockResolvedValue({ url: '/audio/a.mp3', duration: 1, provider: 'elevenlabs', captions: null })
    await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1', provider: 'elevenlabs' })
    expect(logSpend).toHaveBeenCalledWith('p1', 'elevenLabs', 0.06, expect.stringContaining('elevenlabs'))
  })

  it('surfaces permissionNeeded on ASK (always-ask modal) without synthesizing', async () => {
    const permissionNeeded = {
      api: 'elevenLabs',
      estimatedCost: '~$0.06',
      estimatedCostUsd: 0.06,
      reason: 'x',
      details: {},
    }
    gateMediaSpend.mockResolvedValue({ ask: true, permissionNeeded })
    const out = await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1', provider: 'elevenlabs' })
    expect(out).toEqual({ permissionNeeded })
    expect(synthesizeTTS).not.toHaveBeenCalled()
    expect(logSpend).not.toHaveBeenCalled()
  })

  it('REGRESSION: a missing provider resolves to the auto-picked provider and STILL gates (no bypass)', async () => {
    // The bug: provider undefined → apiName null → gate skipped → synthesizeTTS auto-picks a PAID
    // provider and runs ungated/unmetered. Fix: resolve via getBestTTSProvider, gate on that.
    getBestTTSProvider.mockReturnValue('elevenlabs')
    gateMediaSpend.mockResolvedValue({ denied: true, reason: 'cap' })
    const out = await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1' }) // no provider
    expect(getBestTTSProvider).toHaveBeenCalled()
    expect(gateMediaSpend).toHaveBeenCalledWith(
      'p1',
      'elevenLabs',
      { prompt: 'hi', model: 'elevenlabs' },
      {
        surfaceAsk: true,
        approvedAsk: undefined,
      },
    )
    expect(synthesizeTTS).not.toHaveBeenCalled()
    expect(out).toEqual({ error: 'cap' })
  })

  it('a missing provider that resolves to a FREE provider still skips the gate', async () => {
    getBestTTSProvider.mockReturnValue('web-speech')
    synthesizeTTS.mockResolvedValue({ mode: 'client', provider: 'web-speech', text: 'hi', voiceId: null })
    await generateNarrationGated({ projectId: 'p1', text: 'hi', sceneId: 's1' })
    expect(gateMediaSpend).not.toHaveBeenCalled()
    expect(synthesizeTTS).toHaveBeenCalledWith(expect.objectContaining({ provider: 'web-speech' }))
    expect(logSpend).not.toHaveBeenCalled()
  })
})

describe('generateSfxGated', () => {
  it('returns {error} when the gate denies (elevenLabs)', async () => {
    gateMediaSpend.mockResolvedValue({ denied: true, reason: 'disabled' })
    const out = await generateSfxGated({ projectId: 'p1', prompt: 'whoosh' })
    expect(gateMediaSpend).toHaveBeenCalledWith(
      'p1',
      'elevenLabs',
      { prompt: 'whoosh', model: 'elevenlabs-sfx' },
      {
        surfaceAsk: true,
        approvedAsk: undefined,
      },
    )
    expect(out).toEqual({ error: 'disabled' })
    expect(searchSFX).not.toHaveBeenCalled()
  })

  it('on allow, returns the single generated sfx and logs spend', async () => {
    searchSFX.mockResolvedValue({ results: [{ id: 'sfx1', name: 'whoosh', audioUrl: '/audio/w.mp3' }] })
    const out = await generateSfxGated({ projectId: 'p1', prompt: 'whoosh' })
    expect(out).toEqual({ sfx: { id: 'sfx1', name: 'whoosh', audioUrl: '/audio/w.mp3' } })
    expect(logSpend).toHaveBeenCalledWith('p1', 'elevenLabs', 0.06, expect.any(String))
  })
})

describe('generateMusicGated', () => {
  it('gates against falMusic and returns {error} on deny', async () => {
    gateMediaSpend.mockResolvedValue({ denied: true, reason: 'cap' })
    const out = await generateMusicGated({ projectId: 'p1', prompt: 'lofi' })
    expect(gateMediaSpend).toHaveBeenCalledWith(
      'p1',
      'falMusic',
      { prompt: 'lofi', model: 'stable-audio' },
      {
        surfaceAsk: true,
        approvedAsk: undefined,
      },
    )
    expect(out).toEqual({ error: 'cap' })
    expect(generateMusic).not.toHaveBeenCalled()
  })

  it('on allow, returns the generated music and logs spend against falMusic', async () => {
    generateMusic.mockResolvedValue({
      result: { id: 'm1', name: 'lofi', audioUrl: '/audio/m.mp3' },
      provider: 'stable-audio',
    })
    const out = await generateMusicGated({ projectId: 'p1', prompt: 'lofi' })
    expect(out).toEqual({ music: { id: 'm1', name: 'lofi', audioUrl: '/audio/m.mp3' } })
    expect(logSpend).toHaveBeenCalledWith('p1', 'falMusic', 0.06, expect.any(String))
  })
})
