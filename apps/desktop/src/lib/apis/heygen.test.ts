// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// P0-D: HeyGen serves the video status poll ONLY at v1. The prior code hit /v2/video_status.get,
// which 404s — so every avatar billed at generate time, then the poll threw, holding the layer
// 'processing' to the 15-min deadline (paid, no avatar). getVideoStatus now targets the v1 base.
// NOTE: these are CONTRACT tests against a mocked fetch — the maintainer must still run a live-key
// smoke test (we can't reach the real HeyGen API here).

import { getVideoStatus } from './heygen'

describe('getVideoStatus — v1 endpoint (P0-D)', () => {
  beforeEach(() => {
    process.env.HEYGEN_API_KEY = 'hg-test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('polls the v1 status URL (not v2) with the api key header', async () => {
    let capturedUrl = ''
    let capturedHeaders: any
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      capturedUrl = url
      capturedHeaders = init.headers
      return { ok: true, json: async () => ({ data: { status: 'processing' } }) } as any
    })
    vi.stubGlobal('fetch', fetchSpy)

    const out = await getVideoStatus('vid-123')
    expect(capturedUrl).toBe('https://api.heygen.com/v1/video_status.get?video_id=vid-123')
    expect(capturedUrl).not.toContain('/v2/')
    expect(capturedHeaders['X-Api-Key']).toBe('hg-test')
    expect(out.status).toBe('processing')
  })

  it('parses the v1 { data: { status, video_url, duration } } shape on completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 100,
          data: { status: 'completed', video_url: 'https://heygen/out.mp4', thumbnail_url: 'https://heygen/t.jpg', duration: 7.5 },
          message: 'ok',
        }),
      }) as any),
    )
    const out = await getVideoStatus('vid-1')
    expect(out.status).toBe('completed')
    expect(out.videoUrl).toBe('https://heygen/out.mp4')
    expect(out.thumbnailUrl).toBe('https://heygen/t.jpg')
    expect(out.durationSeconds).toBe(7.5)
  })

  it("folds v1 'waiting' into 'pending' so the poll loop keeps waiting", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { status: 'waiting' } }) }) as any))
    const out = await getVideoStatus('vid-1')
    expect(out.status).toBe('pending')
  })

  it('surfaces a v1 error object as a message string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { status: 'failed', error: { message: 'render failed' } } }) }) as any),
    )
    const out = await getVideoStatus('vid-1')
    expect(out.status).toBe('failed')
    expect(out.error).toBe('render failed')
  })

  it('throws on a non-ok HTTP response (e.g. a real 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ message: 'not found' }) }) as any))
    await expect(getVideoStatus('vid-1')).rejects.toThrow(/not found|404/)
  })

  it('fails loud when HEYGEN_API_KEY is unset (no fetch)', async () => {
    delete process.env.HEYGEN_API_KEY
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(getVideoStatus('vid-1')).rejects.toThrow(/HEYGEN_API_KEY/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
