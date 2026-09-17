import * as fal from '@fal-ai/serverless-client'
import type { ImageStyle } from '@/lib/types'
import { checkCache, saveToCache, downloadToBuffer } from './media-cache'
import { catalogCostCents, catalogI2iCostCents, falT2iEndpoint, falI2iEndpoint } from '@/lib/media/model-catalog'

const FAL_KEY = () => process.env.FAL_KEY
const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY

// Provider calls run synchronously inside the agent turn — a stalled fal queue or hung socket
// would spin the chat forever. Cap every external call so a slow provider fails loud (clean
// err()) instead of hanging. fal.subscribe takes no timeout option, so it is raced (below).
const FETCH_TIMEOUT_MS = 60_000
const FAL_SUBSCRIBE_TIMEOUT_MS = 120_000

/** Race a fal.subscribe (no native timeout) against a rejecting deadline. */
function withFalTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error('fal image generation timed out after 120s')), FAL_SUBSCRIBE_TIMEOUT_MS)
  })
  // clearTimeout on the winning path so the 120s timer doesn't stay armed
  // (holding the closure + event loop) after fal.subscribe resolves first.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function configureFal() {
  const key = FAL_KEY()
  if (key) {
    fal.config({ credentials: key })
  }
}

// Endpoint slugs + i2i eligibility come from the model catalog (single source of truth via
// falT2iEndpoint/falI2iEndpoint); the catalog row is authoritative for both. Model
// id is a free string validated at runtime: an unknown id has no t2i endpoint → "Unknown
// model" below (rather than a compile-time union check). DALL-E 3 has no fal endpoints and is
// handled by the OpenAI branch before any fal lookup.

const STYLE_PROMPTS: Record<string, string> = {
  illustration: ', vector illustration style, clean lines',
  flat: ', flat design, simple shapes, minimal',
  sketch: ', pencil sketch, hand-drawn, whiteboard style',
  '3d': ', 3D render, octane render, soft lighting',
  watercolor: ', watercolor illustration, painted',
  photorealistic: ', photorealistic, 4K, detailed',
  pixel: ', pixel art style, retro',
}

function aspectRatioToSize(ar: string): '1024x1024' | '1792x1024' | '1024x1792' {
  if (ar === '16:9' || ar === '4:3') return '1792x1024'
  if (ar === '9:16' || ar === '3:4') return '1024x1792'
  return '1024x1024'
}

// gpt-image-1 (the DALL-E 3 successor) supports a DIFFERENT, fixed size set than DALL-E 3:
// 1024x1024 (square), 1536x1024 (landscape), 1024x1536 (portrait), or 'auto'. The old
// 1792x1024 / 1024x1792 DALL-E sizes are rejected by gpt-image-1, so map to its own sizes.
function aspectRatioToGptImageSize(ar: string): '1024x1024' | '1536x1024' | '1024x1536' {
  if (ar === '16:9' || ar === '4:3') return '1536x1024'
  if (ar === '9:16' || ar === '3:4') return '1024x1536'
  return '1024x1024'
}

// FAL uses "portrait_16_9" to mean "portrait orientation of the 16:9 ratio" (i.e. 9:16)
function aspectRatioToFal(ar: string): string {
  if (ar === '16:9') return 'landscape_16_9'
  if (ar === '9:16') return 'portrait_16_9'
  if (ar === '4:3') return 'landscape_4_3'
  if (ar === '3:4') return 'portrait_4_3'
  return 'square_hd'
}

export async function generateImage(opts: {
  prompt: string
  negativePrompt?: string
  /** Catalog model id (e.g. 'flux-1.1-pro'). Validated at runtime against the catalog. */
  model: string
  aspectRatio: string
  style?: ImageStyle | null
  skipCache?: boolean
  /**
   * Optional reference image for image-to-image. May be an http(s) URL or a local app
   * path (publicUrl / storagePath). When present AND the model has a catalog i2i endpoint
   * (falI2iEndpoint), the reference is uploaded to a fetchable URL and passed as `image_url`
   * to the i2i endpoint (true conditioning). A model with no i2i endpoint throws rather than
   * silently falling back to t2i. Recorded in provenance by callers.
   */
  referenceImageUrl?: string | null
  /**
   * Tier 2: MULTIPLE reference images for a single edit (composition/blend). When length > 1
   * the model's multi-reference endpoint is used (falEndpoints.multiRef); a single entry behaves
   * like `referenceImageUrl`. Folded into the cache key.
   */
  referenceImageUrls?: string[] | null
  /**
   * Tier 2: a MASK image for inpaint — white = edit, black = keep. Routes to the model's
   * inpaint endpoint with the reference as `image_url` and this as `mask_url`. Requires a reference.
   */
  maskImageUrl?: string | null
  /**
   * Tier 2: outpaint / canvas-expand — pixels to add per side. Routes to the model's outpaint
   * endpoint, growing the reference image beyond its borders. Requires a reference.
   */
  outpaint?: { left?: number; right?: number; top?: number; bottom?: number } | null
  /** i2i conditioning strength 0..1 (how much the prompt overrides the reference). Default 0.85. */
  strength?: number
  /**
   * Optional RNG seed. Pinning the seed makes a model reproduce the same subject across
   * prompts — the backbone of character consistency (character bundles). Folded into
   * the cache key (seed 1 vs 2 are different images) and forwarded to fal's flux endpoints.
   * DALL-E 3 has no seed param, so it is ignored there.
   */
  seed?: number | null
}): Promise<{ imageUrl: string; width: number; height: number; cost: number }> {
  // Tier 2: normalize the reference(s) — callers may pass a single `referenceImageUrl` (legacy)
  // or an array `referenceImageUrls` (multi-ref). Collapse to one array; refs[0] is the base image
  // for inpaint/outpaint. A 1-element array behaves like the single-ref i2i path.
  const refs = (
    opts.referenceImageUrls && opts.referenceImageUrls.length > 0
      ? opts.referenceImageUrls
      : opts.referenceImageUrl
        ? [opts.referenceImageUrl]
        : []
  ).filter((u): u is string => typeof u === 'string' && u.length > 0)
  // Bound the fan-out: each ref is uploaded (up to 25MB read into the main process) concurrently.
  // An uncapped caller-controlled array would be a memory / fal-upload flood. flux Kontext-multi
  // takes a handful; 8 is generous.
  const MAX_REFS = 8
  if (refs.length > MAX_REFS) throw new Error(`Too many reference images (${refs.length}); max ${MAX_REFS}.`)

  // Tier 2: NORMALIZE outpaint — clamp each side to a non-negative integer ≤ a sane max. Raw
  // caller values (negative, NaN, 1e9) would otherwise reach fal and amplify cost / break the call.
  const MAX_OUTPAINT_PX = 2048
  const clampPx = (v: number | undefined): number => {
    const n = Math.floor(Number(v))
    return !Number.isFinite(n) || n <= 0 ? 0 : Math.min(n, MAX_OUTPAINT_PX)
  }
  const outpaint = opts.outpaint
    ? {
        left: clampPx(opts.outpaint.left),
        right: clampPx(opts.outpaint.right),
        top: clampPx(opts.outpaint.top),
        bottom: clampPx(opts.outpaint.bottom),
      }
    : null

  // Tier 2: pick the edit mode by the richest input present, most-specific first. outpaint and
  // inpaint edit the base image (refs[0]); multi-ref blends N references; i2i conditions on one.
  const { falMultiRefEndpoint, falInpaintEndpoint, falOutpaintEndpoint } = await import('@/lib/media/model-catalog')
  const wantsOutpaint = !!outpaint && outpaint.left + outpaint.right + outpaint.top + outpaint.bottom > 0
  const wantsInpaint = !!opts.maskImageUrl
  const wantsMultiRef = refs.length > 1

  // The explicit edit MODES are mutually exclusive — the cascade below would otherwise silently drop
  // the others (e.g. outpaint + mask → the mask is ignored). Reject the ambiguity loudly (mirrors the
  // keyframe/extend/edit exclusion on the video side).
  const modeSignals = [
    wantsOutpaint && 'outpaint',
    wantsInpaint && 'inpaint',
    wantsMultiRef && 'multi-reference',
  ].filter(Boolean) as string[]
  if (modeSignals.length > 1) {
    throw new Error(`Combine only one image-edit mode at a time (got ${modeSignals.join(' + ')}).`)
  }

  const editMode: 'outpaint' | 'inpaint' | 'multiref' | 'i2i' | 't2i' = wantsOutpaint
    ? 'outpaint'
    : wantsInpaint
      ? 'inpaint'
      : wantsMultiRef
        ? 'multiref'
        : refs.length === 1
          ? 'i2i'
          : 't2i'

  // FAIL LOUD if an edit input is supplied but the model lacks that endpoint — silently falling
  // through to t2i (ignoring the reference/mask/expand) would be a silent degrade, and
  // it would bill for an image that ignored the input. (Each capability ⟺ a catalog endpoint slug.)
  // Runs BEFORE the cache check so an incapable request fails loud even when a prior result exists.
  if (editMode === 'outpaint') {
    if (!refs.length) throw new Error('Outpaint requires a reference image to expand')
    if (falOutpaintEndpoint(opts.model) === null)
      throw new Error(`Model "${opts.model}" does not support outpaint/expand`)
  } else if (editMode === 'inpaint') {
    if (!refs.length) throw new Error('Inpaint requires a reference image (the image to edit) alongside the mask')
    if (falInpaintEndpoint(opts.model) === null) throw new Error(`Model "${opts.model}" does not support mask inpaint`)
  } else if (editMode === 'multiref') {
    if (falMultiRefEndpoint(opts.model) === null)
      throw new Error(`Model "${opts.model}" does not support multi-reference edit`)
  } else if (editMode === 'i2i') {
    if (falI2iEndpoint(opts.model) === null)
      throw new Error(`Model "${opts.model}" does not support image-to-image (no i2i endpoint)`)
  }

  // Cost from the catalog (single source). i2i/inpaint run the flux/dev family (cheaper i2i price);
  // multi-ref (Kontext) and outpaint (Pro fill) hit the pricier flux-pro endpoints → charge the full
  // per-call price, not the cheap i2i price (under-billing those would undercount the spend cap).
  // NOTE: the pre-call cost GATE estimate is still model-flat and unaware of edit
  // mode — closing that needs the gate to read the catalog row (tracked separately).
  const usesProEndpoint = editMode === 'multiref' || editMode === 'outpaint'
  const cost =
    ((editMode === 't2i' || usesProEndpoint ? catalogCostCents(opts.model) : catalogI2iCostCents(opts.model)) ?? 0) /
    100

  // Check cache — keyed on the NORMALIZED refs + editMode + mask + outpaint so an array-passed single
  // ref keys identically to a legacy single ref and never collides with t2i (or another edit mode).
  const cacheParams = {
    prompt: opts.prompt,
    model: opts.model,
    aspectRatio: opts.aspectRatio,
    style: opts.style,
    editMode,
    referenceImageUrl: refs.length === 1 ? refs[0] : null,
    referenceImageUrls: refs.length > 1 ? refs : null,
    maskImageUrl: opts.maskImageUrl ?? null,
    outpaint: wantsOutpaint ? outpaint : null,
    // strength keys the cache only for i2i (the one mode that uses it) — strength 0.3 vs 0.95 is a
    // different image. Keyed on the normalized ref count, not the legacy field, so the array path counts.
    strength: editMode === 'i2i' ? (opts.strength ?? null) : null,
    negativePrompt: opts.negativePrompt ?? null,
    seed: opts.seed ?? null,
  }
  if (!opts.skipCache) {
    const cached = await checkCache('imageGen', cacheParams)
    if (cached) {
      return {
        imageUrl: cached.filePath,
        width: (cached.metadata.width ?? 1024) as number,
        height: (cached.metadata.height ?? 1024) as number,
        cost: 0,
      }
    }
  }

  const fullPrompt = opts.prompt + (opts.style ? (STYLE_PROMPTS[opts.style] ?? '') : '')

  if (opts.model === 'dall-e-3') {
    // DALL-E 3 is retired from the OpenAI API, so this `dall-e-3` model id now routes
    // to its successor, gpt-image-1. This is NOT a drop-in swap:
    //   • gpt-image-1 returns `b64_json` (base64 PNG bytes), NOT a `url` — there's no `response_format`
    //     param and no URL to download; we decode the base64 straight into the buffer the rest of the
    //     pipeline already expects (saveToCache takes a Buffer).
    //   • Its `size` set differs (1024x1024 / 1536x1024 / 1024x1536 / auto) — mapped above.
    //   • Its `quality` enum is low|medium|high|auto (DALL-E 3's standard|hd is gone) — use 'high' to
    //     match the prior 'standard'+ tier; 'medium' would visibly under-deliver vs the old default.
    // The return contract ({ imageUrl: localPath, width, height, cost }) is unchanged.
    // Pre-flight the key so we fail clearly instead of sending `Bearer undefined` → opaque 401.
    if (!OPENAI_API_KEY()) throw new Error('OpenAI image generation needs OPENAI_API_KEY — set it in Settings')
    const size = aspectRatioToGptImageSize(opts.aspectRatio)
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: fullPrompt,
        size,
        quality: 'high',
        n: 1,
        // gpt-image-1 always returns base64; there is no response_format param (sending one 400s).
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message ?? 'OpenAI gpt-image-1 generation failed')

    const b64 = data.data?.[0]?.b64_json
    if (!b64) throw new Error('OpenAI gpt-image-1 returned no image data (expected b64_json)')
    const buffer = Buffer.from(b64, 'base64')
    const [w, h] = size.split('x').map(Number)
    const publicPath = await saveToCache('imageGen', cacheParams, buffer, 'png', { width: w, height: h })
    return { imageUrl: publicPath, width: w, height: h, cost }
  }

  // fal.ai path — use SDK
  configureFal()

  // Tier 2: edit modes (i2i / multi-ref / inpaint / outpaint) all condition on uploaded
  // reference(s) and run a dedicated fal endpoint. The field shapes below are UNVERIFIED vs fal's
  // live catalog (fail loud at subscribe if wrong). Shared download+save tail via finishFalImage.
  if (editMode !== 't2i') {
    const { resolveReferenceToFetchableUrl } = await import('@/lib/media/reference-upload')
    const finishFalImage = async (result: any) => {
      const url = result.images?.[0]?.url
      if (!url) throw new Error(`No image returned from fal.ai (${editMode})`)
      const w = result.images[0].width ?? 1024
      const h = result.images[0].height ?? 1024
      const buffer = await downloadToBuffer(url)
      const publicPath = await saveToCache('imageGen', cacheParams, buffer, 'png', { width: w, height: h })
      return { imageUrl: publicPath, width: w, height: h, cost }
    }
    // Upload every reference once (deduped by content hash inside the resolver).
    const fetchableRefs = await Promise.all(refs.map((r) => resolveReferenceToFetchableUrl(r)))
    const seedField = opts.seed != null ? { seed: opts.seed } : {}

    if (editMode === 'multiref') {
      return finishFalImage(
        await withFalTimeout(
          fal.subscribe(falMultiRefEndpoint(opts.model)!, {
            input: {
              prompt: fullPrompt,
              image_urls: fetchableRefs,
              negative_prompt: opts.negativePrompt,
              ...seedField,
            },
          }),
        ),
      )
    }
    if (editMode === 'inpaint') {
      const maskUrl = await resolveReferenceToFetchableUrl(opts.maskImageUrl!)
      return finishFalImage(
        await withFalTimeout(
          fal.subscribe(falInpaintEndpoint(opts.model)!, {
            input: {
              prompt: fullPrompt,
              image_url: fetchableRefs[0],
              mask_url: maskUrl,
              negative_prompt: opts.negativePrompt,
              ...seedField,
            },
          }),
        ),
      )
    }
    if (editMode === 'outpaint') {
      const o = outpaint! // normalized + clamped above
      return finishFalImage(
        await withFalTimeout(
          fal.subscribe(falOutpaintEndpoint(opts.model)!, {
            input: {
              prompt: fullPrompt,
              image_url: fetchableRefs[0],
              expand_left: o.left,
              expand_right: o.right,
              expand_top: o.top,
              expand_bottom: o.bottom,
              ...seedField,
            },
          }),
        ),
      )
    }
    // i2i (single reference) — unchanged behavior.
    return finishFalImage(
      await withFalTimeout(
        fal.subscribe(falI2iEndpoint(opts.model)!, {
          input: {
            prompt: fullPrompt,
            image_url: fetchableRefs[0],
            strength: opts.strength ?? 0.95, // fal's documented default for flux/dev i2i
            negative_prompt: opts.negativePrompt,
            ...seedField,
          },
        }),
      ),
    )
  }

  // Catalog is the single source for the t2i endpoint. An unknown id (or a non-fal
  // model like dall-e-3, already handled above) returns null → "Unknown model".
  const falModelId = falT2iEndpoint(opts.model)
  if (!falModelId) throw new Error(`Unknown model: ${opts.model}`)

  const result = (await withFalTimeout(
    fal.subscribe(falModelId, {
      input: {
        prompt: fullPrompt,
        negative_prompt: opts.negativePrompt,
        image_size: aspectRatioToFal(opts.aspectRatio),
        num_inference_steps: opts.model === 'flux-schnell' ? 4 : 28,
        guidance_scale: 3.5,
        ...(opts.seed != null ? { seed: opts.seed } : {}),
      },
    }),
  )) as any

  const imageUrl = result.images?.[0]?.url
  if (!imageUrl) throw new Error('No image returned from fal.ai')

  const w = result.images[0].width ?? 1024
  const h = result.images[0].height ?? 1024
  const buffer = await downloadToBuffer(imageUrl)
  const publicPath = await saveToCache('imageGen', cacheParams, buffer, 'png', { width: w, height: h })

  return {
    imageUrl: publicPath,
    width: w,
    height: h,
    cost,
  }
}
