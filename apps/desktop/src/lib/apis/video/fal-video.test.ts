import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFalVideoProvider } from './fal-video'
import { klingProvider } from './kling'

// i2v resolves the reference to a fetchable URL (fal/runway) or raw bytes (Veo) via this module.
vi.mock('@/lib/media/reference-upload', () => ({
  resolveReferenceToFetchableUrl: vi.fn(async (r: string) => `https://fetchable/${r}`),
  resolveReferenceToBytes: vi.fn(async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' })),
}))
// Veo's generate enhances the prompt via an LLM — stub it so the invariant test doesn't make a call.
vi.mock('@/lib/media/enhance', () => ({ enhance: vi.fn(async (o: { rawPrompt: string }) => o.rawPrompt) }))

describe('makeFalVideoProvider', () => {
  it('builds a VideoProviderClient from config (fal models all key on FAL_KEY)', () => {
    const p = makeFalVideoProvider({
      id: 'ltx',
      name: 'LTX 2',
      defaultModel: 'fal-ai/ltx-video/text-to-video',
      costPerCallUsd: 0.2,
    })
    expect(p.id).toBe('ltx')
    expect(p.name).toBe('LTX 2')
    expect(p.costPerCallUsd).toBe(0.2)
    expect(p.envKey).toBe('FAL_KEY')
    expect(typeof p.generate).toBe('function')
    expect(typeof p.pollStatus).toBe('function')
    expect(typeof p.download).toBe('function')
  })

  it('each config produces an independent provider (no shared slug)', () => {
    const a = makeFalVideoProvider({ id: 'a', name: 'A', defaultModel: 'fal-ai/a', costPerCallUsd: 1 })
    const b = makeFalVideoProvider({ id: 'b', name: 'B', defaultModel: 'fal-ai/b', costPerCallUsd: 2 })
    expect(a.id).not.toBe(b.id)
    expect(a.costPerCallUsd).not.toBe(b.costPerCallUsd)
  })

  it('kling is now built from the factory but keeps its identity', () => {
    expect(klingProvider.id).toBe('kling')
    expect(klingProvider.name).toBe('Kling 2.1')
    expect(klingProvider.costPerCallUsd).toBe(0.45)
    expect(klingProvider.envKey).toBe('FAL_KEY')
  })
})

describe('makeFalVideoProvider i2v routing', () => {
  const T2V = 'fal-ai/ltx-2.3/text-to-video'
  const I2V = 'fal-ai/ltx-2.3/image-to-video'
  const provider = makeFalVideoProvider({
    id: 'ltx',
    name: 'LTX 2.3',
    defaultModel: T2V,
    i2vModel: I2V,
    costPerCallUsd: 0.06,
  })
  const calls: { url: string; body?: unknown }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.FAL_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
        if (url.endsWith('/status')) return { ok: true, json: async () => ({ status: 'COMPLETED' }) } as Response
        if (url.includes('/requests/'))
          return { ok: true, json: async () => ({ video: { url: 'http://v/clip.mp4' } }) } as Response
        return { ok: true, json: async () => ({ request_id: 'req-123' }) } as Response // submit
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('t2v (no image): posts the text-to-video slug, returns a BARE request_id (unchanged)', async () => {
    const out = await provider.generate({ prompt: 'a cat', aspectRatio: '16:9', durationSeconds: 5 })
    expect(calls[0].url).toBe(`https://queue.fal.run/${T2V}`)
    expect((calls[0].body as Record<string, unknown>).image_url).toBeUndefined()
    expect(out.operationId).toBe('req-123') // no slug encoding
  })

  it('i2v (image set): posts the IMAGE-to-video slug with image_url, encodes the slug into operationId', async () => {
    const out = await provider.generate({
      prompt: 'a cat',
      aspectRatio: '16:9',
      durationSeconds: 5,
      imageUrl: 'data:image/png;base64,AAAA',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${I2V}`)
    expect((calls[0].body as Record<string, unknown>).image_url).toBe('https://fetchable/data:image/png;base64,AAAA')
    expect(out.operationId).toBe(`${I2V}::req-123`)
  })

  it('pollStatus decodes the i2v slug so it polls the SAME endpoint the request was submitted to', async () => {
    await provider.pollStatus(`${I2V}::req-123`)
    expect(calls[0].url).toBe(`https://queue.fal.run/${I2V}/requests/req-123/status`)
  })

  it('pollStatus on a bare (t2v) operationId uses the configured t2v slug', async () => {
    await provider.pollStatus('req-123')
    expect(calls[0].url).toBe(`https://queue.fal.run/${T2V}/requests/req-123/status`)
  })

  it('FAILS LOUD when an image is supplied to a provider with no i2v slug (no silent t2v)', async () => {
    const t2vOnly = makeFalVideoProvider({ id: 'x', name: 'T2V Only', defaultModel: T2V, costPerCallUsd: 0.1 })
    await expect(
      t2vOnly.generate({
        prompt: 'a cat',
        aspectRatio: '16:9',
        durationSeconds: 5,
        imageUrl: 'data:image/png;base64,AAAA',
      }),
    ).rejects.toThrow(/does not support image-to-video/)
    expect(calls.length).toBe(0) // never hit the network
  })
})

// Tier 2 (#5): start+end keyframe + extend share the same submit→poll spine as i2v — a distinct
// endpoint slug encoded into the operationId so pollStatus hits the same place. These assert the
// route selection (most-specific input wins), the body fields, the opId encoding, and fail-loud.
describe('makeFalVideoProvider keyframe + extend routing', () => {
  const T2V = 'fal-ai/kling/text-to-video'
  const I2V = 'fal-ai/kling/image-to-video'
  const KF = 'fal-ai/kling/start-end-to-video'
  const EXT = 'fal-ai/kling/extend'
  const provider = makeFalVideoProvider({
    id: 'kling',
    name: 'Kling',
    defaultModel: T2V,
    i2vModel: I2V,
    keyframeModel: KF,
    extendModel: EXT,
    costPerCallUsd: 0.45,
  })
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.FAL_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
        if (url.endsWith('/status')) return { ok: true, json: async () => ({ status: 'COMPLETED' }) } as Response
        if (url.includes('/requests/'))
          return { ok: true, json: async () => ({ video: { url: 'http://v/clip.mp4' } }) } as Response
        return { ok: true, json: async () => ({ request_id: 'req-9' }) } as Response // submit
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keyframe (start image + end image): posts the keyframe slug with image_url + tail_image_url, encodes slug', async () => {
    const out = await provider.generate({
      prompt: 'morph',
      aspectRatio: '16:9',
      durationSeconds: 5,
      imageUrl: 'data:image/png;base64,START',
      endImageUrl: 'data:image/png;base64,END',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${KF}`)
    expect(calls[0].body!.image_url).toBe('https://fetchable/data:image/png;base64,START')
    expect(calls[0].body!.tail_image_url).toBe('https://fetchable/data:image/png;base64,END') // default end field
    expect(out.operationId).toBe(`${KF}::req-9`)
  })

  it('honors a custom endImageField (e.g. end_image_url)', async () => {
    const p = makeFalVideoProvider({
      id: 'ltx',
      name: 'LTX',
      defaultModel: T2V,
      keyframeModel: KF,
      endImageField: 'end_image_url',
      costPerCallUsd: 0.06,
    })
    await p.generate({
      prompt: 'x',
      aspectRatio: '16:9',
      durationSeconds: 5,
      imageUrl: 'data:image/png;base64,S',
      endImageUrl: 'data:image/png;base64,E',
    })
    expect(calls[0].body!.end_image_url).toBe('https://fetchable/data:image/png;base64,E')
    expect(calls[0].body!.tail_image_url).toBeUndefined()
  })

  it('extend (source clip): posts the extend slug with video_url, encodes slug', async () => {
    const out = await provider.generate({
      prompt: 'continue',
      aspectRatio: '16:9',
      durationSeconds: 5,
      extendVideoUrl: 'https://cdn/clip.mp4',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${EXT}`)
    expect(calls[0].body!.video_url).toBe('https://fetchable/https://cdn/clip.mp4')
    expect(out.operationId).toBe(`${EXT}::req-9`)
  })

  it('route priority: extend wins over keyframe/i2v when a source clip is present', async () => {
    await provider.generate({
      prompt: 'x',
      aspectRatio: '16:9',
      durationSeconds: 5,
      imageUrl: 'data:image/png;base64,S',
      endImageUrl: 'data:image/png;base64,E',
      extendVideoUrl: 'https://cdn/clip.mp4',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${EXT}`)
  })

  it('keyframe requires a start frame: endImageUrl without imageUrl fails loud (no network)', async () => {
    await expect(
      provider.generate({
        prompt: 'x',
        aspectRatio: '16:9',
        durationSeconds: 5,
        endImageUrl: 'data:image/png;base64,E',
      }),
    ).rejects.toThrow(/requires a start frame/)
    expect(calls.length).toBe(0)
  })

  it('FAILS LOUD when keyframes/extend are requested of a provider with no such slug', async () => {
    const plain = makeFalVideoProvider({
      id: 'wan',
      name: 'Wan',
      defaultModel: T2V,
      i2vModel: I2V,
      costPerCallUsd: 0.2,
    })
    await expect(
      plain.generate({
        prompt: 'x',
        aspectRatio: '16:9',
        durationSeconds: 5,
        imageUrl: 'data:image/png;base64,S',
        endImageUrl: 'data:image/png;base64,E',
      }),
    ).rejects.toThrow(/does not support start\/end keyframes/)
    await expect(
      plain.generate({ prompt: 'x', aspectRatio: '16:9', durationSeconds: 5, extendVideoUrl: 'https://cdn/clip.mp4' }),
    ).rejects.toThrow(/does not support extend/)
    expect(calls.length).toBe(0)
  })

  it('pollStatus decodes a keyframe/extend slug so it polls the SAME endpoint', async () => {
    await provider.pollStatus(`${KF}::req-9`)
    expect(calls[0].url).toBe(`https://queue.fal.run/${KF}/requests/req-9/status`)
    calls.length = 0
    await provider.pollStatus(`${EXT}::req-9`)
    expect(calls[0].url).toBe(`https://queue.fal.run/${EXT}/requests/req-9/status`)
  })
})

// Tier 2 (#4): video→video / edit route — a source clip + the (already-framed) edit prompt to a v2v
// slug, same submit→poll spine, slug-encoded operationId.
describe('makeFalVideoProvider video-to-video (edit) routing', () => {
  const T2V = 'fal-ai/ltx/text-to-video'
  const V2V = 'fal-ai/ltx/video-to-video'
  const EXT = 'fal-ai/ltx/extend'
  const provider = makeFalVideoProvider({
    id: 'ltx',
    name: 'LTX',
    defaultModel: T2V,
    v2vModel: V2V,
    extendModel: EXT,
    costPerCallUsd: 0.06,
  })
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.FAL_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
        if (url.endsWith('/status')) return { ok: true, json: async () => ({ status: 'COMPLETED' }) } as Response
        if (url.includes('/requests/'))
          return { ok: true, json: async () => ({ video: { url: 'http://v/clip.mp4' } }) } as Response
        return { ok: true, json: async () => ({ request_id: 'r-edit' }) } as Response
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('edit (editVideoUrl): posts the v2v slug with video_url + the edit prompt, encodes slug', async () => {
    const out = await provider.generate({
      prompt: 'Restyle this video as neon cyberpunk.',
      aspectRatio: '16:9',
      durationSeconds: 5,
      editVideoUrl: 'https://cdn/source.mp4',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${V2V}`)
    expect(calls[0].body!.video_url).toBe('https://fetchable/https://cdn/source.mp4')
    expect(calls[0].body!.prompt).toBe('Restyle this video as neon cyberpunk.')
    expect(out.operationId).toBe(`${V2V}::r-edit`)
  })

  it('route priority: extend (continue) wins over edit when both source clips are set', async () => {
    await provider.generate({
      prompt: 'x',
      aspectRatio: '16:9',
      durationSeconds: 5,
      extendVideoUrl: 'https://cdn/a.mp4',
      editVideoUrl: 'https://cdn/b.mp4',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${EXT}`)
  })

  it('FAILS LOUD when an edit is requested of a provider with no v2v slug', async () => {
    const plain = makeFalVideoProvider({ id: 'wan', name: 'Wan', defaultModel: T2V, costPerCallUsd: 0.2 })
    await expect(
      plain.generate({ prompt: 'x', aspectRatio: '16:9', durationSeconds: 5, editVideoUrl: 'https://cdn/b.mp4' }),
    ).rejects.toThrow(/does not support video-to-video editing/)
    expect(calls.length).toBe(0)
  })

  it('pollStatus decodes the v2v slug so it polls the same endpoint', async () => {
    await provider.pollStatus(`${V2V}::r-edit`)
    expect(calls[0].url).toBe(`https://queue.fal.run/${V2V}/requests/r-edit/status`)
  })
})

describe('makeFalVideoProvider video upscale routing (Tier 3)', () => {
  const T2V = 'fal-ai/ltx/text-to-video'
  const UP = 'fal-ai/topaz/upscale/video'
  const provider = makeFalVideoProvider({
    id: 'ltx',
    name: 'LTX',
    defaultModel: T2V,
    upscaleModel: UP,
    costPerCallUsd: 0.06,
  })
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.FAL_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
        if (url.endsWith('/status')) return { ok: true, json: async () => ({ status: 'COMPLETED' }) } as Response
        if (url.includes('/requests/'))
          return { ok: true, json: async () => ({ video: { url: 'http://v/up.mp4' } }) } as Response
        return { ok: true, json: async () => ({ request_id: 'r-up' }) } as Response
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('upscale: posts the upscale slug with video_url + scale, strips prompt/duration/aspect, encodes slug', async () => {
    const out = await provider.generate({
      prompt: 'ignored for upscale',
      aspectRatio: '16:9',
      durationSeconds: 5,
      upscaleVideoUrl: 'https://cdn/source.mp4',
      upscaleFactor: 4,
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${UP}`)
    expect(calls[0].body!.video_url).toBe('https://fetchable/https://cdn/source.mp4')
    expect(calls[0].body!.scale).toBe(4)
    // A pure post-process: no prompt/duration/aspect_ratio should reach the upscaler.
    expect(calls[0].body!.prompt).toBeUndefined()
    expect(calls[0].body!.duration).toBeUndefined()
    expect(calls[0].body!.aspect_ratio).toBeUndefined()
    expect(out.operationId).toBe(`${UP}::r-up`)
  })

  it('defaults the scale to 2 when upscaleFactor is omitted', async () => {
    await provider.generate({
      prompt: '',
      aspectRatio: '16:9',
      durationSeconds: 5,
      upscaleVideoUrl: 'https://cdn/s.mp4',
    })
    expect(calls[0].body!.scale).toBe(2)
  })

  it('upscale wins over generation modes (most-specific route)', async () => {
    await provider.generate({
      prompt: 'x',
      aspectRatio: '16:9',
      durationSeconds: 5,
      upscaleVideoUrl: 'https://cdn/u.mp4',
      imageUrl: 'data:image/png;base64,S',
    })
    expect(calls[0].url).toBe(`https://queue.fal.run/${UP}`)
  })

  it('FAILS LOUD when upscale is requested of a provider with no upscale slug', async () => {
    const plain = makeFalVideoProvider({ id: 'veo', name: 'Veo', defaultModel: T2V, costPerCallUsd: 1 })
    await expect(
      plain.generate({ prompt: '', aspectRatio: '16:9', durationSeconds: 5, upscaleVideoUrl: 'https://cdn/u.mp4' }),
    ).rejects.toThrow(/does not support video upscale/)
    expect(calls.length).toBe(0)
  })

  it('pollStatus decodes the upscale slug so it polls the same endpoint', async () => {
    await provider.pollStatus(`${UP}::r-up`)
    expect(calls[0].url).toBe(`https://queue.fal.run/${UP}/requests/r-up/status`)
  })

  // Tier 3 (cache identity): upscaleCacheTag exposes the RESOLVED upscale slug so an upscale request's
  // cache key tracks the actual upscaler (not the t2v cacheTag). A changed env override must surface
  // here, so a re-pointed upscaler busts stale output instead of serving the old model's clip.
  it('exposes the resolved upscale slug as upscaleCacheTag (env-overridable), undefined without one', () => {
    expect(provider.upscaleCacheTag).toBe(UP)
    const overridden = makeFalVideoProvider({
      id: 'ltx',
      name: 'LTX',
      defaultModel: T2V,
      upscaleModel: UP,
      upscaleModelEnvVar: 'TEST_UP_ENV',
      costPerCallUsd: 0.06,
    })
    expect(overridden.upscaleCacheTag).toBe(UP)
    process.env.TEST_UP_ENV = 'fal-ai/some/other-upscaler'
    const rebuilt = makeFalVideoProvider({
      id: 'ltx',
      name: 'LTX',
      defaultModel: T2V,
      upscaleModel: UP,
      upscaleModelEnvVar: 'TEST_UP_ENV',
      costPerCallUsd: 0.06,
    })
    expect(rebuilt.upscaleCacheTag).toBe('fal-ai/some/other-upscaler')
    delete process.env.TEST_UP_ENV
    // A provider with no upscale endpoint exposes no tag.
    const plain = makeFalVideoProvider({ id: 'veo', name: 'Veo', defaultModel: T2V, costPerCallUsd: 1 })
    expect(plain.upscaleCacheTag).toBeUndefined()
  })
})

// Invariant: every video model the catalog flags i2v-capable (capabilities.i2i:true) must actually
// CONDITION on the image — i.e. the i2v request differs from the t2v request (a different endpoint
// for fal/Runway, or the same endpoint with the image in the body for Veo). Ties the catalog flag
// (which gates the composer UI) to real provider behavior so a flag can't claim i2v it can't deliver.
describe('catalog i2i flag ⟺ provider i2v routing', () => {
  const calls: { url: string; body?: string }[] = []
  beforeEach(() => {
    calls.length = 0
    process.env.FAL_KEY = 'k'
    process.env.RUNWAY_API_KEY = 'k'
    process.env.GOOGLE_AI_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body })
        // One response satisfying every provider's id field (fal request_id / Runway id / Veo name).
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: 'r', id: 'r', name: 'models/op/r' }),
        } as Response
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('every i2i:true video model conditions on the image (i2v request differs from t2v)', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const i2vRows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.i2i)
    expect(i2vRows.length).toBeGreaterThan(0)
    for (const row of i2vRows) {
      const provider = getVideoProvider(row.providerId)
      expect(provider, `catalog i2v model "${row.id}" → no video provider "${row.providerId}"`).toBeTruthy()
      const base = { prompt: 'x', aspectRatio: '16:9' as const, durationSeconds: 5 }
      calls.length = 0
      await provider!.generate(base) // t2v — the FIRST fetch is the submit call
      const t2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider!.generate({ ...base, imageUrl: 'data:image/png;base64,AAAA' }) // i2v
      const i2v = JSON.stringify(calls[0])
      expect(i2v, `${row.providerId} flagged i2v but its i2v request is identical to t2v`).not.toBe(t2v)
    }
  })

  // Tier 2 (#5): a model flagged keyframes/extend must actually route those inputs somewhere
  // DIFFERENT from a plain i2v/t2v request — otherwise the capability flag (which gates the
  // composer + the agent tool) is a lie that bills for the wrong clip.
  it('every keyframes:true video model routes a start+end request differently from i2v', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const rows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.keyframes)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const provider = getVideoProvider(row.providerId)!
      const base = {
        prompt: 'x',
        aspectRatio: '16:9' as const,
        durationSeconds: 5,
        imageUrl: 'data:image/png;base64,S',
      }
      calls.length = 0
      await provider.generate(base) // i2v
      const i2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider.generate({ ...base, endImageUrl: 'data:image/png;base64,E' }) // keyframe
      expect(JSON.stringify(calls[0]), `${row.providerId} flagged keyframes but its request == i2v`).not.toBe(i2v)
    }
  })

  it('every extend:true video model routes an extend request differently from t2v', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const rows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.extend)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const provider = getVideoProvider(row.providerId)!
      const base = { prompt: 'x', aspectRatio: '16:9' as const, durationSeconds: 5 }
      calls.length = 0
      await provider.generate(base) // t2v
      const t2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider.generate({ ...base, extendVideoUrl: 'https://cdn/clip.mp4' }) // extend
      expect(JSON.stringify(calls[0]), `${row.providerId} flagged extend but its request == t2v`).not.toBe(t2v)
    }
  })

  it('every videoToVideo:true model routes an edit request differently from t2v (Tier 2 #4)', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const rows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.videoToVideo)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const provider = getVideoProvider(row.providerId)!
      const base = { prompt: 'x', aspectRatio: '16:9' as const, durationSeconds: 5 }
      calls.length = 0
      await provider.generate(base) // t2v
      const t2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider.generate({ ...base, editVideoUrl: 'https://cdn/clip.mp4' }) // v2v edit
      expect(JSON.stringify(calls[0]), `${row.providerId} flagged videoToVideo but its request == t2v`).not.toBe(t2v)
    }
  })

  it('every performanceCapture:true model routes a driving-video request differently from i2v (Tier 2 #6)', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const rows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.performanceCapture)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const provider = getVideoProvider(row.providerId)!
      const base = {
        prompt: 'x',
        aspectRatio: '16:9' as const,
        durationSeconds: 5,
        imageUrl: 'data:image/png;base64,S',
      }
      calls.length = 0
      await provider.generate(base) // i2v (character image only)
      const i2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider.generate({ ...base, drivingVideoUrl: 'https://cdn/drive.mp4' }) // act-two
      expect(JSON.stringify(calls[0]), `${row.providerId} flagged performanceCapture but its request == i2v`).not.toBe(
        i2v,
      )
    }
  })

  // Tier 3 (breadth): a model flagged videoUpscale must actually route an upscale request to a
  // DIFFERENT endpoint than t2v — otherwise the capability (which gates the agent tool) bills a
  // generation for what the user asked to upscale.
  it('every videoUpscale:true model routes an upscale request differently from t2v (Tier 3)', async () => {
    const { MEDIA_MODEL_CATALOG } = await import('@/lib/media/model-catalog')
    const { getVideoProvider } = await import('./registry')
    const rows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video' && m.capabilities.videoUpscale)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const provider = getVideoProvider(row.providerId)!
      const base = { prompt: 'x', aspectRatio: '16:9' as const, durationSeconds: 5 }
      calls.length = 0
      await provider.generate(base) // t2v
      const t2v = JSON.stringify(calls[0])
      calls.length = 0
      await provider.generate({ ...base, upscaleVideoUrl: 'https://cdn/clip.mp4' }) // upscale
      expect(JSON.stringify(calls[0]), `${row.providerId} flagged videoUpscale but its request == t2v`).not.toBe(t2v)
    }
  })
})
