// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createWhisperApiTranscriber, segmentsToSrt } from './whisper-transcriber'

vi.mock('./audio-decode', () => ({ resolveSourceForFfmpeg: (s: string) => s }))
vi.mock('node:fs', () => ({ promises: { readFile: async () => Buffer.from([1, 2, 3]) } }))

const VERBOSE = {
  language: 'en',
  segments: [
    { start: 1, end: 3, text: ' Hello everyone.' },
    { start: 3.5, end: 6, text: 'The numbers.' },
  ],
  words: [
    { word: 'Hello', start: 1, end: 1.4 },
    { word: 'everyone.', start: 1.4, end: 2.9 },
  ],
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('segmentsToSrt', () => {
  it('synthesizes parseable SRT from verbose_json segments', () => {
    const srt = segmentsToSrt(VERBOSE.segments)!
    expect(srt).toContain('00:00:01,000 --> 00:00:03,000')
    expect(srt).toContain('Hello everyone.')
    expect(srt.split('\n\n')).toHaveLength(2)
  })

  it('null on missing/empty/malformed segments (caller falls back)', () => {
    expect(segmentsToSrt(undefined)).toBeNull()
    expect(segmentsToSrt([])).toBeNull()
    expect(segmentsToSrt([{ text: 'no times' }])).toBeNull()
  })
})

describe('whisper word timestamps', () => {
  it('verbose_json path returns words + synthesized srt in ONE request', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(VERBOSE))
    const t = createWhisperApiTranscriber({ fetch: fetchSpy as never, resolveApiKey: () => 'k' })
    const out = await t.transcribe('/a.mp3')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(out.words).toHaveLength(2)
    expect(out.words![0]).toMatchObject({ word: 'Hello', start: 1 })
    expect(out.srt).toContain('Hello everyone.')
    expect(out.language).toBe('en')
    // The first request asked for verbose_json + word granularity.
    const init = (fetchSpy.mock.calls[0] as unknown as [string, { body: Uint8Array }])[1]
    const body = Buffer.from(init.body).toString('latin1')
    expect(body).toContain('verbose_json')
    expect(body).toContain('timestamp_granularities')
  })

  it('falls back to the srt request when verbose_json is unsupported', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unsupported' }, false, 400))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
        json: async () => ({}),
      } as unknown as Response)
    const t = createWhisperApiTranscriber({ fetch: fetchSpy as never, resolveApiKey: () => 'k' })
    const out = await t.transcribe('/a.mp3')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(out.words).toBeUndefined()
    expect(out.srt).toContain('Hi')
  })

  it('falls back when verbose_json returns 200 but no segments (degraded server)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ text: 'flat text only' }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
        json: async () => ({}),
      } as unknown as Response)
    const t = createWhisperApiTranscriber({ fetch: fetchSpy as never, resolveApiKey: () => 'k' })
    const out = await t.transcribe('/a.mp3')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(out.srt).toContain('Hi')
  })
})
