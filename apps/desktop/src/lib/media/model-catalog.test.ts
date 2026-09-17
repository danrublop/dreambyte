import { describe, it, expect } from 'vitest'
import {
  MEDIA_MODEL_CATALOG,
  getModelRow,
  modelsForProvider,
  modelsForModality,
  catalogCostCents,
  catalogI2iCostCents,
  falT2iEndpoint,
  falI2iEndpoint,
  maxDurationFor,
  clampVideoDuration,
} from './model-catalog'
import { listCandidatesForIntent, ROUTER_MODEL_IDS } from './router'
import { MEDIA_PROVIDERS } from './provider-registry'
import { getVideoProvider } from '@/lib/apis/video/registry'
import { estimateApiCostUsd, API_COST_SCALARS } from '@/lib/permissions'

describe('media model catalog', () => {
  it('every row has a unique id and a providerId that exists in MEDIA_PROVIDERS', () => {
    const ids = MEDIA_MODEL_CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    const providerIds = new Set(MEDIA_PROVIDERS.map((p) => p.id))
    for (const row of MEDIA_MODEL_CATALOG) {
      // Not just truthy — a typo'd providerId must fail here, or the row routes to nothing.
      expect(providerIds.has(row.providerId), `catalog row "${row.id}" → unknown provider "${row.providerId}"`).toBe(
        true,
      )
      expect(row.label).toBeTruthy()
    }
  })

  // Integrity invariants that make model breadth safe-by-construction — a new row that lies about
  // cost or capabilities fails CI instead of silently bypassing the spend cap or advertising a
  // capability with no backing endpoint (the recurring "UNVERIFIED slug / capability-without-route"
  // and "missing cost → cap bypass" classes).
  describe('integrity invariants (breadth safety net)', () => {
    it('every row has a non-null perCallCents so nothing renders uncapped (model_pricing_drift)', () => {
      for (const row of MEDIA_MODEL_CATALOG) {
        expect(
          row.costScalars.perCallCents,
          `catalog row "${row.id}" has null perCallCents — it would bypass the run cost cap`,
        ).not.toBeNull()
      }
    })

    it('every video row resolves to a real routing backend (no orphan catalog rows)', () => {
      for (const row of MEDIA_MODEL_CATALOG.filter((r) => r.modality === 'video')) {
        expect(
          getVideoProvider(row.providerId),
          `catalog video row "${row.id}" → provider "${row.providerId}" has no routing client`,
        ).not.toBeNull()
      }
    })

    // The miss this suite previously didn't catch: a video provider needs an APIName/billing identity
    // (API_COST_SCALARS) or its generation bypasses the cost cap + gets billed under the wrong bucket
    // (the model_pricing_drift class). A new video provider without it now fails CI here.
    it('every video providerId has an API billing identity (cost-cap + correct-bucket guard)', () => {
      const billable = new Set(Object.keys(API_COST_SCALARS))
      for (const row of MEDIA_MODEL_CATALOG.filter((r) => r.modality === 'video')) {
        expect(
          billable.has(row.providerId),
          `video provider "${row.providerId}" (row "${row.id}") is not in API_COST_SCALARS — it would bypass the cost cap`,
        ).toBe(true)
      }
    })

    it('video-only capabilities are not claimed on image/avatar rows (capability ⟺ modality)', () => {
      const videoOnly = [
        'keyframes',
        'extend',
        'videoToVideo',
        'performanceCapture',
        'videoUpscale',
        'duration',
      ] as const
      for (const row of MEDIA_MODEL_CATALOG.filter((r) => r.modality !== 'video')) {
        for (const cap of videoOnly) {
          expect(
            row.capabilities[cap],
            `catalog ${row.modality} row "${row.id}" claims video-only capability "${cap}"`,
          ).toBeFalsy()
        }
      }
    })

    it('image-only edit capabilities are not claimed on video/avatar rows', () => {
      const imageOnly = ['inpaint', 'outpaint', 'multiReference'] as const
      for (const row of MEDIA_MODEL_CATALOG.filter((r) => r.modality !== 'image')) {
        for (const cap of imageOnly) {
          expect(
            row.capabilities[cap],
            `catalog ${row.modality} row "${row.id}" claims image-only capability "${cap}"`,
          ).toBeFalsy()
        }
      }
    })

    it('a video row that claims duration declares a maxDurationSeconds (and vice versa)', () => {
      for (const row of MEDIA_MODEL_CATALOG.filter((r) => r.modality === 'video')) {
        const { duration, maxDurationSeconds } = row.capabilities
        expect(
          duration === (maxDurationSeconds != null),
          `catalog video row "${row.id}": duration=${duration} but maxDurationSeconds=${maxDurationSeconds}`,
        ).toBe(true)
      }
    })
  })

  it('getModelRow resolves and misses cleanly', () => {
    expect(getModelRow('flux-1.1-pro')?.label).toBe('Flux 1.1 Pro')
    expect(getModelRow('nope')).toBeNull()
  })

  it('catalogCostCents returns null for unknown models (the always_ask guard)', () => {
    expect(catalogCostCents('flux-schnell')).toBe(0.3)
    expect(catalogCostCents('does-not-exist')).toBeNull()
  })

  // T18: i2i runs a different (cheaper) endpoint than t2i for flux-1.1-pro, so it must bill the
  // i2i price, not the t2i price. Models without an i2i-specific price fall back to perCallCents.
  it('catalogI2iCostCents uses the i2i price when set, else falls back to t2i', () => {
    expect(catalogCostCents('flux-1.1-pro')).toBe(5) // t2i price unchanged
    expect(catalogI2iCostCents('flux-1.1-pro')).toBe(3) // i2i runs flux/dev, cheaper
    expect(catalogI2iCostCents('stable-diffusion-3')).toBe(3) // no override → t2i price (3)
    expect(catalogI2iCostCents('does-not-exist')).toBeNull()
  })

  it('route estimates quote the i2i price for i2i, the t2i price for t2i (T18)', () => {
    // listCandidatesForIntent is readiness-independent (used for the Generate UI dropdown).
    const t2iCents = listCandidatesForIntent('t2i').find((c) => c.modelId === 'flux-1.1-pro')?.cents
    const i2iCents = listCandidatesForIntent('i2i').find((c) => c.modelId === 'flux-1.1-pro')?.cents
    expect(t2iCents).toBe(5)
    expect(i2iCents).toBe(3) // matches what generateImage bills, not the 5c t2i price
  })

  it('provider + modality filters work', () => {
    expect(modelsForProvider('imageGen').length).toBeGreaterThan(0)
    expect(modelsForModality('video').map((m) => m.id)).toContain('veo-3')
  })

  it('capability flags are set per model', () => {
    expect(getModelRow('flux-1.1-pro')?.capabilities.i2i).toBe(true)
    expect(getModelRow('flux-schnell')?.capabilities.i2i).toBe(false)
    expect(getModelRow('veo-3')?.capabilities.camera).toBe('prompt')
    expect(getModelRow('dall-e-3')?.capabilities.seed).toBe(false)
  })

  // Regression: the catalog is the new single cost source. These are the EXACT cents the
  // router PREFERENCE table hardcoded before the refactor — behavior must be preserved.
  it('router cost is unchanged after sourcing cost from the catalog', () => {
    const cents = (intent: Parameters<typeof listCandidatesForIntent>[0], modelId: string) =>
      listCandidatesForIntent(intent).find((c) => c.modelId === modelId)?.cents

    expect(cents('t2i', 'flux-1.1-pro')).toBe(5)
    // The 'dall-e-3' catalog row now backs gpt-image-1 direct-OpenAI pricing (~$0.17),
    // deliberately raised from DALL-E 3's old ~4c so the cost gate doesn't under-count
    // (see the misbilling note in model-catalog.ts). The 4c was the pre-refactor seed.
    expect(cents('t2i', 'dall-e-3')).toBe(17)
    expect(cents('t2i', 'flux-schnell')).toBe(0.3) // corrected from 1c seed to real ~$0.003
    expect(cents('sticker', 'recraft-v3')).toBe(4)
    expect(cents('video', 'veo-3')).toBe(100)
    expect(cents('avatar', 'heygen-v2')).toBe(30)
    expect(cents('avatar', 'musetalk')).toBe(10)
  })

  // Runnability guard: generateImage() only executes FAL ('imageGen') and OpenAI
  // ('dall-e') models — it has NO Google path. The router must never offer an image
  // intent a model it can't run (regression: imagen-3 used to be listed and crashed
  // when FAL was off + Google on). Re-adding a Google image model without a generateImage
  // Google path fails here.
  it('image intents only route to models generateImage can run (imageGen | dall-e | fal breadth)', () => {
    // generateImage runs any model with a falEndpoints.t2i (routed by model id) + the OpenAI 'dall-e'
    // native path. The frontier fal cards (seedream/gptImage/nanoBanana) carry t2i+i2i endpoints, so
    // they're runnable; googleImageGen still is NOT (no Google path).
    const RUNNABLE = new Set(['imageGen', 'dall-e', 'seedream', 'gptImage', 'nanoBanana'])
    for (const intent of ['t2i', 'i2i', 'sticker'] as const) {
      for (const cand of listCandidatesForIntent(intent)) {
        expect(
          RUNNABLE.has(cand.providerId),
          `${intent} routes to non-runnable provider "${cand.providerId}" (${cand.modelId})`,
        ).toBe(true)
      }
    }
  })

  // F4: i2i must offer every i2i-capable model so preferModel keeps the user's pick instead
  // of silently swapping (e.g. sd3 -> pricier flux-1.1-pro). Both have catalog i2i endpoints.
  it('i2i routes to all i2i-capable image models (no silent model swap)', () => {
    const ids = listCandidatesForIntent('i2i').map((c) => c.modelId)
    expect(ids).toContain('flux-1.1-pro')
    expect(ids).toContain('stable-diffusion-3')
  })

  // T16: the catalog is now the SINGLE source for fal endpoints + i2i eligibility (was a
  // parallel MODEL_IDS/I2I_MODEL_IDS pair in image-gen.ts that could drift from the i2i flag).
  describe('fal endpoint consolidation (T16)', () => {
    const falImageRows = MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'image' && m.providerId === 'imageGen')

    it('every fal image row has a t2i endpoint, and i2i flag ⟺ i2i endpoint (no drift)', () => {
      for (const row of falImageRows) {
        expect(row.falEndpoints?.t2i, `${row.id} missing t2i endpoint`).toBeTruthy()
        // The invariant that killed the imagen-3 drift: the boolean and the endpoint agree.
        expect(!!row.falEndpoints?.i2i, `${row.id} i2i flag ≠ i2i endpoint presence`).toBe(row.capabilities.i2i)
      }
    })

    // Tier 2 (#7): the same drift guard for the new edit capabilities — each flag ⟺ its endpoint slug.
    it('multiReference / inpaint / outpaint flags ⟺ their endpoint slugs (no drift)', () => {
      for (const row of MEDIA_MODEL_CATALOG) {
        if (row.modality !== 'image') {
          expect(row.capabilities.multiReference, `${row.id}`).toBe(false)
          expect(row.capabilities.inpaint, `${row.id}`).toBe(false)
          expect(row.capabilities.outpaint, `${row.id}`).toBe(false)
          continue
        }
        expect(!!row.falEndpoints?.multiRef, `${row.id} multiReference flag ≠ multiRef endpoint`).toBe(
          row.capabilities.multiReference,
        )
        expect(!!row.falEndpoints?.inpaint, `${row.id} inpaint flag ≠ inpaint endpoint`).toBe(row.capabilities.inpaint)
        expect(!!row.falEndpoints?.outpaint, `${row.id} outpaint flag ≠ outpaint endpoint`).toBe(
          row.capabilities.outpaint,
        )
      }
    })

    it('declares the Tier 2 #7 edit capabilities per model', () => {
      const cap = (id: string) => getModelRow(id)!.capabilities
      // flux-1.1-pro: multi-ref + inpaint + outpaint. SD3: inpaint only. Others: none.
      expect(cap('flux-1.1-pro').multiReference).toBe(true)
      expect(cap('flux-1.1-pro').inpaint).toBe(true)
      expect(cap('flux-1.1-pro').outpaint).toBe(true)
      expect(cap('stable-diffusion-3').inpaint).toBe(true)
      expect(cap('stable-diffusion-3').multiReference).toBe(false)
      expect(cap('stable-diffusion-3').outpaint).toBe(false)
      expect(cap('flux-schnell').inpaint).toBe(false)
      expect(cap('dall-e-3').multiReference).toBe(false)
    })

    it('preserves the exact endpoints image-gen used before consolidation', () => {
      expect(falT2iEndpoint('flux-1.1-pro')).toBe('fal-ai/flux-pro/v1.1')
      expect(falI2iEndpoint('flux-1.1-pro')).toBe('fal-ai/flux/dev/image-to-image')
      expect(falT2iEndpoint('flux-schnell')).toBe('fal-ai/flux/schnell')
      expect(falI2iEndpoint('flux-schnell')).toBeNull() // t2i-only
      expect(falI2iEndpoint('stable-diffusion-3')).toBe('fal-ai/stable-diffusion-v3-medium/image-to-image')
    })

    it('non-fal / unknown models have no fal endpoints', () => {
      expect(falT2iEndpoint('dall-e-3')).toBeNull() // OpenAI transport
      expect(falI2iEndpoint('dall-e-3')).toBeNull()
      expect(falT2iEndpoint('made-up')).toBeNull()
    })

    it('imagen-3 i2i drift is fixed (no wired i2i endpoint → flag is false)', () => {
      expect(getModelRow('imagen-3')?.capabilities.i2i).toBe(false)
    })

    // Ties the router to the catalog: every model i2i routing offers must actually have an
    // i2i endpoint to run, or the reference would be silently ignored at generate time.
    it('every i2i router candidate has a catalog i2i endpoint', () => {
      for (const cand of listCandidatesForIntent('i2i')) {
        expect(falI2iEndpoint(cand.modelId), `i2i candidate ${cand.modelId} has no i2i endpoint`).not.toBeNull()
      }
    })
  })

  // Phase 2 fal video breadth: each new model must be wired end-to-end — a video provider
  // adapter, a tier-1 toggle (MEDIA_PROVIDERS), a catalog row, AND a cost-gate entry. A half-
  // wired model (e.g. provider but no permission scalar) would mis-gate spend.
  it.each(['ltx', 'wan', 'seedance', 'hailuo', 'veo31', 'kling25', 'seedance2'])(
    'fal video model %s is fully wired',
    (id) => {
      expect(getVideoProvider(id), `${id} not in VIDEO_PROVIDERS`).not.toBeNull()
      expect(
        MEDIA_PROVIDERS.some((p) => p.id === id),
        `${id} not a provider toggle`,
      ).toBe(true)
      const row = MEDIA_MODEL_CATALOG.find((m) => m.providerId === id && m.modality === 'video')
      expect(row, `${id} has no video catalog row`).toBeTruthy()
      expect(row?.capabilities.camera).toBe('prompt') // fal video = prompt-driven camera
      // Cost gate keys on the provider/API id for video; must return a real (non-zero) price.
      expect(estimateApiCostUsd(id as Parameters<typeof estimateApiCostUsd>[0])).toBeGreaterThan(0)
    },
  )

  // Every video provider toggle must have at least one catalog row, so the agent/UI can see
  // and price it. (kling/runway were missing rows until the capability-truth pass.)
  it('every video provider in MEDIA_PROVIDERS has a catalog row', () => {
    const videoProviders = MEDIA_PROVIDERS.filter((p) => p.category === 'video').map((p) => p.id)
    const rowProviders = new Set(MEDIA_MODEL_CATALOG.filter((m) => m.modality === 'video').map((m) => m.providerId))
    for (const id of videoProviders) {
      expect(rowProviders.has(id), `video provider "${id}" has no catalog row`).toBe(true)
    }
  })

  // Drift guard: every model the router can pick MUST have a catalog row, or its cost
  // silently falls back to 0 (free) in the permission dialog — the model_pricing_drift
  // silent-overspend class. Adding a model to the router without a catalog row fails here.
  it('every router model id resolves to a catalog row with a known price', () => {
    for (const modelId of ROUTER_MODEL_IDS) {
      const row = getModelRow(modelId)
      expect(row, `router model "${modelId}" has no catalog row`).not.toBeNull()
      expect(catalogCostCents(modelId), `router model "${modelId}" has no price`).not.toBeNull()
    }
  })

  // Tier 2 (#5): keyframe/extend capability + per-model duration cap declarations. These pin the
  // honest per-model truth so a future edit can't flip a flag (the fal-video invariant separately
  // proves a flipped flag must also route differently).
  it('declares Tier 2 keyframe/extend + maxDurationSeconds per video model', () => {
    const cap = (id: string) => getModelRow(id)!.capabilities
    // Veo: no start/end or extend route; capped at its real 8s API limit.
    expect(cap('veo-3').keyframes).toBe(false)
    expect(cap('veo-3').extend).toBe(false)
    expect(cap('veo-3').maxDurationSeconds).toBe(8)
    // Kling/Runway/LTX: keyframe + extend, 10s.
    for (const id of ['kling-v2.1', 'runway-gen4', 'ltx-video']) {
      expect(cap(id).keyframes, `${id} keyframes`).toBe(true)
      expect(cap(id).extend, `${id} extend`).toBe(true)
      expect(cap(id).maxDurationSeconds, `${id} max`).toBe(10)
    }
    // Seedance: keyframe only. Wan: i2v + v2v (no keyframe/extend slug yet).
    expect(cap('seedance-video').keyframes).toBe(true)
    expect(cap('seedance-video').extend).toBe(false)
    expect(cap('wan-video').keyframes).toBe(false)
    expect(cap('wan-video').extend).toBe(false)
  })

  it('declares Tier 2 #4 videoToVideo (Aleph/v2v) per video model', () => {
    const v2v = (id: string) => getModelRow(id)!.capabilities.videoToVideo
    // Runway (Aleph headline) + LTX + Wan transform clips; Veo/Kling/Seedance do not (yet).
    expect(v2v('runway-gen4')).toBe(true)
    expect(v2v('ltx-video')).toBe(true)
    expect(v2v('wan-video')).toBe(true)
    expect(v2v('veo-3')).toBe(false)
    expect(v2v('kling-v2.1')).toBe(false)
    expect(v2v('seedance-video')).toBe(false)
  })

  it('declares Tier 2 #6 performanceCapture (Act-Two) per video model — Runway only', () => {
    const pc = (id: string) => getModelRow(id)!.capabilities.performanceCapture
    expect(pc('runway-gen4')).toBe(true)
    expect(pc('veo-3')).toBe(false)
    expect(pc('kling-v2.1')).toBe(false)
    expect(pc('ltx-video')).toBe(false)
    // non-video models never claim it
    expect(getModelRow('flux-1.1-pro')!.capabilities.performanceCapture).toBe(false)
  })

  it('declares Tier 3 videoUpscale per video model — the fal providers, not Veo/Runway', () => {
    const up = (id: string) => getModelRow(id)!.capabilities.videoUpscale
    // The shared fal Topaz upscaler backs Kling/LTX/Wan/Seedance.
    expect(up('kling-v2.1')).toBe(true)
    expect(up('ltx-video')).toBe(true)
    expect(up('wan-video')).toBe(true)
    expect(up('seedance-video')).toBe(true)
    // Veo (native) + Runway (bespoke adapter) have no fal upscale route wired → false (honest).
    expect(up('veo-3')).toBe(false)
    expect(up('runway-gen4')).toBe(false)
    // non-video models never claim it
    expect(getModelRow('flux-1.1-pro')!.capabilities.videoUpscale).toBe(false)
    expect(getModelRow('musetalk')!.capabilities.videoUpscale).toBe(false)
  })

  // Every video model must carry a real (non-null) duration cap, so the cap-lift can never grant an
  // unbounded clip; image/avatar models carry null (duration:false).
  it('video models have a numeric maxDurationSeconds; non-video are null', () => {
    for (const row of MEDIA_MODEL_CATALOG) {
      if (row.modality === 'video') {
        expect(typeof row.capabilities.maxDurationSeconds, `${row.id} cap`).toBe('number')
        expect(row.capabilities.maxDurationSeconds!).toBeGreaterThan(0)
      } else {
        expect(row.capabilities.maxDurationSeconds, `${row.id} cap`).toBeNull()
      }
    }
  })

  // startVideo gates keyframe/extend + the duration cap off modelsForProvider(id).find(video) — the
  // FIRST video row for a provider. That's only correct while each provider has exactly one video
  // row; assert the invariant so the day a provider gains a second video model, this fails loudly
  // instead of silently gating against the wrong row's caps.
  it('each video provider has exactly one video catalog row (first-row capability lookup is safe)', () => {
    const counts = new Map<string, number>()
    for (const m of MEDIA_MODEL_CATALOG) {
      if (m.modality === 'video') counts.set(m.providerId, (counts.get(m.providerId) ?? 0) + 1)
    }
    for (const [providerId, n] of counts) {
      expect(n, `provider "${providerId}" has ${n} video rows — startVideo's first-row lookup is ambiguous`).toBe(1)
    }
  })
})

// Tier 2 (#5): the shared duration helpers that keep startVideo, the store, and the composer from
// diverging. clampVideoDuration's lower FLOOR is the fix for a negative duration surviving into the
// cache key / cost estimate while the provider clamped it up to its 5s minimum.
describe('maxDurationFor / clampVideoDuration', () => {
  it('maxDurationFor returns the row cap, or 8 for an unknown model', () => {
    expect(maxDurationFor('veo-3')).toBe(8)
    expect(maxDurationFor('kling-v2.1')).toBe(10)
    expect(maxDurationFor('not-a-real-model')).toBe(8) // conservative fallback, never unbounded
  })

  it('clamps to [1, max], rounds, and defaults a missing/zero/NaN request to 5', () => {
    expect(clampVideoDuration(10, 10)).toBe(10) // inclusive ceiling
    expect(clampVideoDuration(11, 10)).toBe(10) // over-cap clamps down
    expect(clampVideoDuration(7, 8)).toBe(7) // under cap untouched
    expect(clampVideoDuration(8.4, 10)).toBe(8) // rounds
    expect(clampVideoDuration(0, 10)).toBe(5) // falsy-zero → default 5
    expect(clampVideoDuration(undefined, 10)).toBe(5)
    expect(clampVideoDuration(Number.NaN, 10)).toBe(5)
  })

  it('FLOORS a negative duration at 1 (it must not survive into cost/cache as a negative)', () => {
    expect(clampVideoDuration(-3, 10)).toBe(1)
    expect(clampVideoDuration(-0.4, 10)).toBe(1)
  })
})
