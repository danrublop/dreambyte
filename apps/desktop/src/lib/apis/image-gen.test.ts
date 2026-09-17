import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every fal.subscribe call (endpoint id + input body). The real catalog drives routing.
const subscribeCalls: { model: string; input: Record<string, any> }[] = []
vi.mock('@fal-ai/serverless-client', () => ({
  config: vi.fn(),
  subscribe: vi.fn(async (model: string, opts: { input: Record<string, any> }) => {
    subscribeCalls.push({ model, input: opts.input })
    return { images: [{ url: 'https://fal/out.png', width: 1024, height: 1024 }] }
  }),
}))
vi.mock('@/lib/media/reference-upload', () => ({
  resolveReferenceToFetchableUrl: vi.fn(async (r: string) => `https://fetchable/${r}`),
}))
// hoisted so the spy exists when vi.mock's factory (also hoisted) runs.
const { checkCacheSpy } = vi.hoisted(() => ({
  // Default: always a miss. Individual tests override with mockResolvedValueOnce to
  // simulate a cache HIT (request-hash dedupe), so the return type must allow the hit shape.
  checkCacheSpy: vi.fn<
    (api: string, params: Record<string, unknown>) => Promise<{ filePath: string; metadata: Record<string, unknown> } | null>
  >(async () => null),
}))
const { saveToCacheSpy } = vi.hoisted(() => ({
  saveToCacheSpy: vi.fn<
    (api: string, params: Record<string, unknown>, buffer: Buffer, ext: string, metadata?: unknown) => Promise<string>
  >(async () => '/generated/out.png'),
}))
vi.mock('./media-cache', () => ({
  checkCache: checkCacheSpy,
  saveToCache: saveToCacheSpy,
  downloadToBuffer: vi.fn(async () => Buffer.from('img')),
}))

import { generateImage } from './image-gen'

const base = { prompt: 'a cat', aspectRatio: '1:1', skipCache: true as const }

describe('generateImage edit routing (Tier 2 #7)', () => {
  beforeEach(() => {
    subscribeCalls.length = 0
    process.env.FAL_KEY = 'k'
  })

  it('t2i (no reference): hits the t2i endpoint', async () => {
    await generateImage({ ...base, model: 'flux-1.1-pro' })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux-pro/v1.1')
    expect(subscribeCalls[0].input.image_url).toBeUndefined()
  })

  it('i2i (one reference): hits the i2i endpoint with image_url', async () => {
    await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrl: 'app://a.png' })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux/dev/image-to-image')
    expect(subscribeCalls[0].input.image_url).toBe('https://fetchable/app://a.png')
  })

  it('multi-ref (2+ references): hits the multiRef endpoint with image_urls[]', async () => {
    await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrls: ['app://a.png', 'app://b.png'] })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux-pro/kontext/multi')
    expect(subscribeCalls[0].input.image_urls).toEqual([
      'https://fetchable/app://a.png',
      'https://fetchable/app://b.png',
    ])
  })

  it('inpaint (reference + mask): hits the inpaint endpoint with image_url + mask_url', async () => {
    await generateImage({
      ...base,
      model: 'flux-1.1-pro',
      referenceImageUrl: 'app://a.png',
      maskImageUrl: 'app://m.png',
    })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux/dev/inpainting')
    expect(subscribeCalls[0].input.image_url).toBe('https://fetchable/app://a.png')
    expect(subscribeCalls[0].input.mask_url).toBe('https://fetchable/app://m.png')
  })

  it('outpaint (reference + expand): hits the outpaint endpoint with per-side pixels', async () => {
    await generateImage({
      ...base,
      model: 'flux-1.1-pro',
      referenceImageUrl: 'app://a.png',
      outpaint: { left: 128, right: 64 },
    })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux-pro/v1/fill')
    expect(subscribeCalls[0].input.expand_left).toBe(128)
    expect(subscribeCalls[0].input.expand_right).toBe(64)
    expect(subscribeCalls[0].input.expand_top).toBe(0)
  })

  // NOTE: combining edit modes is now REJECTED (mutual exclusion), not silently resolved by
  // priority — see the 'rejects combining two edit modes' case below.

  it('FAILS LOUD: multi-ref to a model without a multiRef endpoint (no network)', async () => {
    await expect(generateImage({ ...base, model: 'flux-schnell', referenceImageUrls: ['a', 'b'] })).rejects.toThrow(
      /does not support multi-reference/,
    )
    expect(subscribeCalls.length).toBe(0)
  })

  it('FAILS LOUD: inpaint to a model without an inpaint endpoint', async () => {
    await expect(
      generateImage({ ...base, model: 'flux-schnell', referenceImageUrl: 'a', maskImageUrl: 'm' }),
    ).rejects.toThrow(/does not support mask inpaint/)
    expect(subscribeCalls.length).toBe(0)
  })

  it('FAILS LOUD: outpaint to a model without an outpaint endpoint (SD3)', async () => {
    await expect(
      generateImage({ ...base, model: 'stable-diffusion-3', referenceImageUrl: 'a', outpaint: { left: 32 } }),
    ).rejects.toThrow(/does not support outpaint/)
  })

  it('a SINGLE-element referenceImageUrls array routes to i2i, not multi-ref', async () => {
    await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrls: ['app://a.png'] })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux/dev/image-to-image')
    expect(subscribeCalls[0].input.image_url).toBe('https://fetchable/app://a.png')
  })

  it('ALL-ZERO outpaint is not an outpaint request — falls through to i2i', async () => {
    await generateImage({
      ...base,
      model: 'flux-1.1-pro',
      referenceImageUrl: 'app://a.png',
      outpaint: { left: 0, right: 0, top: 0, bottom: 0 },
    })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux/dev/image-to-image')
  })

  it('clamps outpaint pixels: negative → 0, oversized → 2048', async () => {
    await generateImage({
      ...base,
      model: 'flux-1.1-pro',
      referenceImageUrl: 'a',
      outpaint: { left: -500, right: 999999, top: 100 },
    })
    expect(subscribeCalls[0].model).toBe('fal-ai/flux-pro/v1/fill')
    expect(subscribeCalls[0].input.expand_left).toBe(0) // negative clamped
    expect(subscribeCalls[0].input.expand_right).toBe(2048) // oversized clamped
    expect(subscribeCalls[0].input.expand_top).toBe(100)
  })

  it('inpaint with no reference fails loud (no network)', async () => {
    await expect(generateImage({ ...base, model: 'flux-1.1-pro', maskImageUrl: 'm' })).rejects.toThrow(
      /Inpaint requires a reference/,
    )
    expect(subscribeCalls.length).toBe(0)
  })

  it('outpaint with no reference fails loud', async () => {
    await expect(generateImage({ ...base, model: 'flux-1.1-pro', outpaint: { left: 32 } })).rejects.toThrow(
      /Outpaint requires a reference/,
    )
    expect(subscribeCalls.length).toBe(0)
  })

  it('caps the reference count (no upload flood)', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `app://r${i}.png`)
    await expect(generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrls: many })).rejects.toThrow(
      /Too many reference images/,
    )
    expect(subscribeCalls.length).toBe(0)
  })

  it('DALL-E path fails loud (no fetch) when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    await expect(generateImage({ ...base, model: 'dall-e-3' })).rejects.toThrow(
      /OpenAI image generation needs OPENAI_API_KEY/,
    )
  })

  // P0-E: DALL-E 3 was removed from the OpenAI API; the `dall-e-3` id now drives gpt-image-1,
  // which returns base64 (no url) and a different size/quality contract.
  it('dall-e-3 id → gpt-image-1: posts gpt-image-1 body, decodes b64_json into the saved buffer', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    saveToCacheSpy.mockClear()
    const pngBytes = Buffer.from('PNGDATA')
    const b64 = pngBytes.toString('base64')
    let capturedBody: any
    const fetchSpy = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body)
      return { ok: true, json: async () => ({ data: [{ b64_json: b64 }] }) } as any
    })
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const out = await generateImage({ ...base, model: 'dall-e-3', aspectRatio: '16:9' })
      // request body: gpt-image-1 model, its OWN landscape size, no response_format, quality enum.
      expect(capturedBody.model).toBe('gpt-image-1')
      expect(capturedBody.size).toBe('1536x1024')
      expect(capturedBody).not.toHaveProperty('response_format')
      expect(['low', 'medium', 'high', 'auto']).toContain(capturedBody.quality)
      // b64_json decoded straight into saveToCache's buffer (the 4th positional arg).
      const savedBuffer = saveToCacheSpy.mock.calls[0][2] as Buffer
      expect(Buffer.compare(savedBuffer, pngBytes)).toBe(0)
      // return contract preserved: local path + derived dims + cost.
      expect(out.imageUrl).toBe('/generated/out.png')
      expect(out.width).toBe(1536)
      expect(out.height).toBe(1024)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('dall-e-3 → gpt-image-1: throws when the response carries no b64_json', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{}] }) }) as any)
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await expect(generateImage({ ...base, model: 'dall-e-3' })).rejects.toThrow(/no image data/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects combining two edit modes (outpaint + inpaint)', async () => {
    await expect(
      generateImage({
        ...base,
        model: 'flux-1.1-pro',
        referenceImageUrl: 'a',
        maskImageUrl: 'm',
        outpaint: { left: 32 },
      }),
    ).rejects.toThrow(/only one image-edit mode/)
  })

  it('bills the i2i price for i2i/inpaint and the pro price for multi-ref/outpaint', async () => {
    // flux-1.1-pro: perCallCents 5 (=0.05), i2iCallCents 3 (=0.03).
    expect((await generateImage({ ...base, model: 'flux-1.1-pro' })).cost).toBe(0.05) // t2i
    expect((await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrl: 'a' })).cost).toBe(0.03) // i2i
    expect(
      (await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrl: 'a', maskImageUrl: 'm' })).cost,
    ).toBe(0.03) // inpaint
    expect((await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrls: ['a', 'b'] })).cost).toBe(0.05) // multi-ref → pro price
    expect(
      (await generateImage({ ...base, model: 'flux-1.1-pro', referenceImageUrl: 'a', outpaint: { left: 32 } })).cost,
    ).toBe(0.05) // outpaint → pro price
  })

  it('cache key reflects the NORMALIZED ref — an array-passed single ref keys like i2i, not t2i', async () => {
    checkCacheSpy.mockClear()
    await generateImage({
      prompt: 'a cat',
      aspectRatio: '1:1',
      model: 'flux-1.1-pro',
      referenceImageUrls: ['app://a.png'],
    })
    const params = checkCacheSpy.mock.calls[0][1] as Record<string, unknown>
    expect(params.referenceImageUrl).toBe('app://a.png') // not null — the collision Codex flagged
    expect(params.editMode).toBe('i2i')
  })

  // V7 P0-2 idempotency: image gen ALREADY dedupes at this layer (request-hash cache).
  // A retry of an identical request must hit the cache and re-bill $0 WITHOUT a provider
  // call — this is the image half of "mirror the video path's dedupe", already in place.
  it('idempotency: a cache HIT returns the prior image at cost 0 with NO provider call (no re-bill)', async () => {
    subscribeCalls.length = 0
    checkCacheSpy.mockResolvedValueOnce({ filePath: '/generated/images/prior.png', metadata: { width: 1024, height: 1024 } })
    const out = await generateImage({ prompt: 'a fox', aspectRatio: '1:1', model: 'flux-1.1-pro' }) // no skipCache
    expect(out.imageUrl).toBe('/generated/images/prior.png')
    expect(out.cost).toBe(0) // the retry did not bill
    expect(subscribeCalls.length).toBe(0) // and never reached the provider
  })
})
