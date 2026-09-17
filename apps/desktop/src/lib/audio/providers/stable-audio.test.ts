// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// fal client + the audio downloader are mocked: the provider's value is its response-shape handling
// (the audio_file.url ?? audio.url fallback, the missing-url throw, the FAL_KEY-missing throw) and
// the fact that `search` must NOT generate (the music.search IPC is ungated).
const subscribe = vi.fn()
const config = vi.fn()
vi.mock('@fal-ai/serverless-client', () => ({
  config: (...a: unknown[]) => config(...a),
  subscribe: (...a: unknown[]) => subscribe(...a),
}))
vi.mock('../download', () => ({ downloadToLocal: async (u: string) => `local:${u}` }))

import { stableAudioMusic } from './stable-audio'

beforeEach(() => {
  subscribe.mockReset()
  config.mockReset()
  process.env.FAL_KEY = 'test-key'
})

describe('stableAudioMusic.generate', () => {
  it('throws when FAL_KEY is unset', async () => {
    delete process.env.FAL_KEY
    await expect(stableAudioMusic.generate!('lofi beat')).rejects.toThrow(/FAL_KEY/)
  })

  it('accepts both audio_file.url and audio.url response shapes', async () => {
    subscribe.mockResolvedValueOnce({ audio_file: { url: 'https://v3.fal.media/a.mp3' } })
    expect((await stableAudioMusic.generate!('x')).audioUrl).toBe('local:https://v3.fal.media/a.mp3')
    subscribe.mockResolvedValueOnce({ audio: { url: 'https://fal.media/b.mp3' } })
    expect((await stableAudioMusic.generate!('x')).audioUrl).toBe('local:https://fal.media/b.mp3')
  })

  it('throws when fal returns no url', async () => {
    subscribe.mockResolvedValueOnce({})
    await expect(stableAudioMusic.generate!('x')).rejects.toThrow(/No audio returned/)
  })

  it('clamps duration into fal stable-audio bounds (1..47s)', async () => {
    subscribe.mockResolvedValue({ audio_file: { url: 'https://fal.media/c.mp3' } })
    await stableAudioMusic.generate!('x', 9999)
    expect(subscribe.mock.calls[0][1].input.seconds_total).toBe(47)
    await stableAudioMusic.generate!('x', 0)
    expect(subscribe.mock.calls[1][1].input.seconds_total).toBe(1)
  })
})

describe('stableAudioMusic.generate — fal.subscribe timeout race', () => {
  it('rejects with a clear timeout when fal.subscribe never resolves', async () => {
    vi.useFakeTimers()
    // A fal queue that hangs forever — the only thing that unblocks the turn is the race deadline.
    subscribe.mockImplementationOnce(() => new Promise(() => {}))
    const p = stableAudioMusic.generate!('x')
    const assertion = expect(p).rejects.toThrow(/Stable Audio generation timed out after 120s/)
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
    vi.useRealTimers()
  })
})

describe('stableAudioMusic.search', () => {
  it('REFUSES to generate (the music.search IPC is ungated) — throws instead', async () => {
    await expect(stableAudioMusic.search('lofi')).rejects.toThrow(/generative/i)
    expect(subscribe).not.toHaveBeenCalled()
  })
})
