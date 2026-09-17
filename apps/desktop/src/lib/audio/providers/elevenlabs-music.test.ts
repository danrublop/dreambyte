// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// fetch + the audio dir/url helpers are mocked: the provider's value is its request shape
// (POST /v1/music, music_length_ms clamping, model_id), its fail-loud paths (missing key,
// non-ok response, empty stream), and that `search` must NOT generate (music.search is ungated).
vi.mock('../paths', () => ({
  getAudioDir: () => '/tmp/cench-test-audio',
  audioUrlFor: (f: string) => `/audio/${f}`,
}))
vi.mock('fs/promises', () => ({
  default: { mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) },
}))

import { elevenlabsMusic } from './elevenlabs-music'

const fetchMock = vi.fn()

function okAudioResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    text: async () => '',
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.ELEVENLABS_API_KEY = 'test-key'
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('elevenlabsMusic.generate', () => {
  it('throws when ELEVENLABS_API_KEY is unset', async () => {
    delete process.env.ELEVENLABS_API_KEY
    await expect(elevenlabsMusic.generate!('lofi beat')).rejects.toThrow(/ELEVENLABS_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on an empty prompt without calling the API', async () => {
    await expect(elevenlabsMusic.generate!('   ')).rejects.toThrow(/prompt is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs /v1/music with prompt, default 30s length, model_id, and mp3 output_format', async () => {
    fetchMock.mockResolvedValueOnce(okAudioResponse())
    const res = await elevenlabsMusic.generate!('uplifting cinematic build')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/v1/music')
    expect(url).toContain('output_format=mp3_44100_128')
    expect(init.method).toBe('POST')
    expect(init.headers['xi-api-key']).toBe('test-key')
    const body = JSON.parse(init.body)
    expect(body.prompt).toBe('uplifting cinematic build')
    expect(body.music_length_ms).toBe(30_000)
    expect(body.model_id).toBe('music_v1')

    expect(res.provider).toBe('elevenlabs-music')
    expect(res.audioUrl).toMatch(/^\/audio\/music-elevenlabs-/)
    expect(res.duration).toBe(30)
  })

  it('clamps music_length_ms into [3000, 600000]', async () => {
    fetchMock.mockResolvedValue(okAudioResponse())
    await elevenlabsMusic.generate!('x', 9999) // 9999s → cap at 600000ms
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).music_length_ms).toBe(600_000)
    await elevenlabsMusic.generate!('x', 0) // 0s → floor at 3000ms
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).music_length_ms).toBe(3_000)
  })

  it('fails loud on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => 'bad prompt' })
    await expect(elevenlabsMusic.generate!('x')).rejects.toThrow(/ElevenLabs Music generation error \(422\)/)
  })

  it('fails loud on an empty audio stream', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    })
    await expect(elevenlabsMusic.generate!('x')).rejects.toThrow(/empty audio stream/)
  })

  it('fails loud when the API returns JSON instead of audio (would write a corrupt .mp3)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => new Uint8Array([123, 125]).buffer, // non-empty: '{}' — empty-check wouldn't catch it
      text: async () => '{"detail":"async job"}',
    })
    await expect(elevenlabsMusic.generate!('x')).rejects.toThrow(/non-audio response/)
  })

  it('aborts with a clear timeout when the request hangs past the deadline', async () => {
    vi.useFakeTimers()
    // A request that never resolves on its own — only the AbortController unblocks it.
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    )
    const p = elevenlabsMusic.generate!('x')
    const assertion = expect(p).rejects.toThrow(/timed out after 120s/)
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
    vi.useRealTimers()
  })
})

describe('elevenlabsMusic.search', () => {
  it('REFUSES to generate (the music.search IPC is ungated) — throws instead', async () => {
    await expect(elevenlabsMusic.search('lofi')).rejects.toThrow(/generative/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
