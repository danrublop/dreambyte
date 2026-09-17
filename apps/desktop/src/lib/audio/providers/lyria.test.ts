// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// fetch + the audio dir/url helpers are mocked. The provider's value is its request shape
// (generateContent with AUDIO modality), decoding base64 audio out of the JSON response, its
// fail-loud paths (missing key, non-ok, no inlineData, empty audio), and that `search` refuses
// to generate (the music.search IPC is ungated).
vi.mock('../paths', () => ({
  getAudioDir: () => '/tmp/cench-test-audio',
  audioUrlFor: (f: string) => `/audio/${f}`,
}))
vi.mock('fs/promises', () => ({
  default: { mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) },
}))

import { lyriaMusic } from './lyria'

const fetchMock = vi.fn()

// 4 audio bytes, base64-encoded, returned the way generateContent nests it.
const AUDIO_B64 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64')
function okAudioResponse(b64: string = AUDIO_B64) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'verse/chorus' }, { inlineData: { mimeType: 'audio/mp3', data: b64 } }] } }],
    }),
    text: async () => '',
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.GOOGLE_AI_KEY = 'test-key'
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lyriaMusic.generate', () => {
  it('throws when GOOGLE_AI_KEY is unset', async () => {
    delete process.env.GOOGLE_AI_KEY
    await expect(lyriaMusic.generate!('lofi beat')).rejects.toThrow(/GOOGLE_AI_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on an empty prompt without calling the API', async () => {
    await expect(lyriaMusic.generate!('   ')).rejects.toThrow(/prompt is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs generateContent with AUDIO modality and the x-goog-api-key header; decodes inline audio', async () => {
    fetchMock.mockResolvedValueOnce(okAudioResponse())
    const res = await lyriaMusic.generate!('uplifting cinematic build')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/models/lyria-3-clip-preview:generateContent')
    expect(init.method).toBe('POST')
    expect(init.headers['x-goog-api-key']).toBe('test-key')
    const body = JSON.parse(init.body)
    expect(body.contents[0].parts[0].text).toBe('uplifting cinematic build')
    expect(body.generationConfig.responseModalities).toContain('AUDIO')

    expect(res.provider).toBe('lyria')
    expect(res.audioUrl).toMatch(/^\/audio\/music-lyria-/)
    expect(res.duration).toBe(30)
  })

  it('downloads audio when it comes back as a fileData URI (large clips)', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ fileData: { fileUri: 'https://files.example/abc.mp3' } }] } }],
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer })

    const res = await lyriaMusic.generate!('x')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://files.example/abc.mp3')
    expect(fetchMock.mock.calls[1][1].headers['x-goog-api-key']).toBe('test-key')
    expect(res.audioUrl).toMatch(/^\/audio\/music-lyria-/)
  })

  it('surfaces finishReason when a safety block returns no audio', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
      text: async () => '',
    })
    await expect(lyriaMusic.generate!('x')).rejects.toThrow(/SAFETY/)
  })

  it('fails loud when the response carries no inline audio part', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'only text, no audio' }] } }] }),
      text: async () => '',
    })
    await expect(lyriaMusic.generate!('x')).rejects.toThrow(/no audio/i)
  })

  it('treats an empty-data inline part as no audio (fails loud)', async () => {
    // An inlineData part whose data is '' is filtered out (falsy), so this reaches the
    // no-audio branch rather than the empty-buffer guard — either way it must fail loud.
    fetchMock.mockResolvedValueOnce(okAudioResponse(''))
    await expect(lyriaMusic.generate!('x')).rejects.toThrow(/no audio/i)
  })

  it('fails loud on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
    await expect(lyriaMusic.generate!('x')).rejects.toThrow(/Lyria music generation error \(429\)/)
  })

  it('aborts with a clear timeout when the request hangs past the deadline', async () => {
    vi.useFakeTimers()
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
    const p = lyriaMusic.generate!('x')
    const assertion = expect(p).rejects.toThrow(/timed out after 120s/)
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
    vi.useRealTimers()
  })
})

describe('lyriaMusic.search', () => {
  it('REFUSES to generate (the music.search IPC is ungated) — throws instead', async () => {
    await expect(lyriaMusic.search('lofi')).rejects.toThrow(/generative/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
