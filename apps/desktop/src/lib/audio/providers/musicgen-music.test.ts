// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../paths', () => ({
  getAudioDir: () => join(tmpdir(), 'dreambyte-musicgen-test'),
  audioUrlFor: (f: string) => `/audio/${f}`,
}))

import { musicgenMusic } from './musicgen-music'

const realFetch = global.fetch
function mockGenerate(headers: Record<string, string> = { 'x-duration': '6.000', 'x-sample-rate': '32000' }) {
  global.fetch = vi.fn(async (_url: any, _init: any) => {
    const wav = new Uint8Array(44 + 1000) // header + a little data
    return {
      ok: true,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => wav.buffer,
      text: async () => '',
    } as any
  }) as any
}

describe('musicgenMusic provider', () => {
  beforeEach(() => {
    process.env.MUSICGEN_URL = 'http://127.0.0.1:8090'
  })
  afterEach(() => {
    global.fetch = realFetch
    delete process.env.MUSICGEN_URL
  })

  it('POSTs {prompt, duration} to MUSICGEN_URL/generate and returns a saved MusicResult', async () => {
    mockGenerate()
    const r = await musicgenMusic.generate!('warm lo-fi piano', 6)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8090/generate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'warm lo-fi piano', duration: 6 }) }),
    )
    expect(r.provider).toBe('musicgen')
    expect(r.audioUrl).toMatch(/^\/audio\/.*\.wav$/)
    expect(r.duration).toBe(6) // from the x-duration header, not a byte estimate
    expect(r.name).toBe('warm lo-fi piano')
  })

  it('clamps duration to 30s', async () => {
    mockGenerate()
    await musicgenMusic.generate!('long track', 120)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"duration":30') }),
    )
  })

  it('search() throws — it is generate-only', async () => {
    await expect(musicgenMusic.search('anything')).rejects.toThrow(/generative/i)
  })

  it('gives an actionable error when the sidecar is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' })
    }) as any
    await expect(musicgenMusic.generate!('x', 5)).rejects.toThrow(/music-sidecar:start|MUSICGEN_URL/)
  })
})
