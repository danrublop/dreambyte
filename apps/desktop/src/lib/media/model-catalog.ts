/**
 * Media model catalog — the single source of truth for individual MODELS.
 *
 * Two-tier registry:
 *
 *   tier 1  provider-registry.ts  MEDIA_PROVIDERS   ← user enable/disable (~12 toggles)
 *   tier 2  model-catalog.ts      MEDIA_MODEL_CATALOG ← the agent routes over these rows
 *
 * Users toggle PROVIDERS (fal/imageGen, veo3, dall-e, ...). They do NOT toggle 200
 * individual models. The catalog carries per-model capability flags + cost so the agent
 * can pick within enabled providers, and so cost lives in exactly ONE place.
 *
 * Cost-on-row: cost lives on the row so it has ONE home. The catalog feeds routing and
 * display cost (router estimate, Generate dropdown), and the permission/cost-cap gate
 * (`estimateApiCostUsd` in permissions.ts) prefers the row cost whenever `details.model`
 * names a catalog model, falling back to the per-API API_COST_SCALARS otherwise.
 *
 * UNKNOWN-cost semantics: `perCallCents === null` (a MISSING row, NOT a zero price) is
 * what the cap layer must treat as unknown → always_ask. A `0` is a genuinely free model
 * and stays free — null and zero are distinct.
 *
 * Adding a model = appending one row here (+ an adapter only if the provider transport
 * is new). No new toggle. Reconciling the closed ImageModel union with catalog string
 * ids (so preferModel can target any model, not just the 6 image ones) is still open.
 */

/** Coarse media kind. Maps many intents (t2i/i2i/sticker → image) to one transport family. */
export type MediaModality = 'image' | 'video' | 'audio' | 'avatar'

/**
 * Per-model capability flags. INTENDED to drive routing, the Generate/Director UI, and
 * graceful degradation — e.g. `camera: 'native'` routes a camera move to the provider's
 * camera API, `camera: 'prompt'` compiles it into prompt text, `false` hides it. Not every
 * flag is consumed by routing/UI yet (e.g. native camera) — keep them accurate but
 * don't assume a flag is enforced unless its doc says so.
 */
export interface MediaCapabilities {
  /** Accepts a reference image for image-to-image conditioning. */
  i2i: boolean
  /**
   * Tier 2 (#7): accepts MULTIPLE reference images for a single edit (composition/blend). Like
   * `i2i`, this is enforced in the generate path and backed by a real endpoint slug (falEndpoints
   * .multiRef) — capability ⟺ endpoint, asserted by a test.
   */
  multiReference: boolean
  /**
   * Tier 2 (#7): mask-based inpaint — edit only the masked region of an image (image_url + mask_url).
   * Enforced + slug-backed (falEndpoints.inpaint).
   */
  inpaint: boolean
  /**
   * Tier 2 (#7): outpaint / canvas-expand — grow the image beyond its borders. Enforced + slug-backed
   * (falEndpoints.outpaint).
   */
  outpaint: boolean
  /** Camera/motion control support: native API, prompt-compiled, or none. */
  camera: 'native' | 'prompt' | false
  /** Honors a numeric seed for reproducibility. */
  seed: boolean
  /** Honors a negative prompt. */
  negativePrompt: boolean
  /** Honors a duration (video). */
  duration: boolean
  /**
   * Tier 2 (#5): start+end keyframe conditioning — generate a clip that begins on the i2v source
   * image and interpolates to an END frame (Kling/Luma/LTX-style). Like `i2i`, this is a declared
   * capability that MUST be enforced in the generate path (startVideo rejects an end-frame request
   * for a model with `keyframes:false`) AND backed by a real endpoint slug, mirroring the
   * i2i⟺falEndpoints.i2i invariant. UNVERIFIED slugs fail loud (404) at generate(), never silent.
   */
  keyframes: boolean
  /**
   * Tier 2 (#5): extend / continue an existing clip (video→video continuation). Takes a source
   * VIDEO (trust-guarded like the image refs) and produces a follow-on clip. Enforced + slug-backed
   * exactly like `keyframes`.
   */
  extend: boolean
  /**
   * Tier 2 (#4): in-video editing (Runway Aleph-class) — take a source clip and TRANSFORM it
   * (restyle / relight / add-remove object / new camera angle / replace background) per a prompt,
   * keeping the original motion. Distinct from `extend` (which lengthens): v2v rewrites the same
   * span. Takes a source VIDEO + a compiled edit prompt (see src/lib/media/video-edit.ts). Enforced at
   * startVideo + slug-backed exactly like `keyframes`/`extend`.
   */
  videoToVideo: boolean
  /**
   * Tier 2 (#6): performance capture (Runway Act-Two) — drive a CHARACTER (an `imageUrl` reference)
   * with a DRIVING video's motion/expression, producing the character performing it. Distinct from
   * Tier 1 lipsync (image/audio → talking head). Takes a driving VIDEO (trust-guarded) + a character
   * image. Enforced at startVideo + slug-backed exactly like the other advanced video modes.
   */
  performanceCapture: boolean
  /**
   * Tier 3 (breadth): video upscale / super-resolution — take a finished clip and upres it (no other
   * change). Distinct from every generation mode: it's a post-process, takes a source VIDEO + a scale
   * factor, no prompt/camera/duration. Enforced at startVideo + slug-backed (FalVideoConfig.upscaleModel)
   * exactly like the other advanced video modes — capability ⟺ a configured endpoint.
   */
  videoUpscale: boolean
  /**
   * Tier 2 (#5): hard ceiling on clip duration in seconds for this model; `null` when `duration`
   * is false (image/avatar). Lifts the old GLOBAL 5/8s cap — startVideo clamps the requested
   * duration to this, and the composer reads it to build the duration picker. Veo stays 8 (its
   * real API limit); fal models go to 10.
   */
  maxDurationSeconds: number | null
  /** Aspect ratios the model can emit. */
  aspectRatios: string[]
}

/** Cost in USD cents. `perCallCents === null` means UNKNOWN → cap layer forces always_ask. */
export interface CostScalars {
  perCallCents: number | null
  perSecondCents?: number | null
  per1KCharsCents?: number | null
  /**
   * Per-call cost in cents when the model runs its IMAGE-TO-IMAGE endpoint. i2i often
   * hits a different (cheaper) fal endpoint than t2i — e.g. flux-1.1-pro's i2i routes to
   * flux/dev — so charging perCallCents would mis-bill. Omitted → i2i falls back to perCallCents.
   */
  i2iCallCents?: number | null
}

/**
 * fal endpoint slugs for an image model — the SINGLE source of truth for what `generateImage`
 * actually calls. Previously these lived in a parallel `MODEL_IDS`/`I2I_MODEL_IDS` pair
 * inside image-gen.ts that could drift from the catalog's `i2i` flag. Now `i2i` capability ⟺
 * an `i2i` endpoint here (asserted by a test). Models on a non-fal transport (DALL-E/OpenAI)
 * omit this entirely.
 */
export interface FalImageEndpoints {
  t2i: string
  /** Present iff the model supports image-to-image. Its presence is the i2i source of truth. */
  i2i?: string
  /** Tier 2 (#7): present iff the model supports MULTI-reference edit. Source of truth for `multiReference`. */
  multiRef?: string
  /** Tier 2 (#7): present iff the model supports mask inpaint. Source of truth for `inpaint`. */
  inpaint?: string
  /** Tier 2 (#7): present iff the model supports outpaint/expand. Source of truth for `outpaint`. */
  outpaint?: string
}

/** A single model row — the tier-2 unit the agent routes over. */
export interface MediaModelRow {
  /** Canonical model id passed to the underlying API (e.g. 'flux-1.1-pro', 'veo-3'). */
  id: string
  /** Owning provider id from MEDIA_PROVIDERS (the thing the user toggles). */
  providerId: string
  modality: MediaModality
  label: string
  capabilities: MediaCapabilities
  costScalars: CostScalars
  /** fal endpoint slugs (image models on the fal transport only). */
  falEndpoints?: FalImageEndpoints
}

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const VIDEO_RATIOS = ['16:9', '9:16', '1:1']

/** Capability preset for a no-camera, fragment-only image model. */
function imageCaps(over: Partial<MediaCapabilities> = {}): MediaCapabilities {
  return {
    i2i: false,
    multiReference: false,
    inpaint: false,
    outpaint: false,
    camera: false,
    seed: true,
    negativePrompt: true,
    duration: false,
    keyframes: false,
    extend: false,
    videoToVideo: false,
    performanceCapture: false,
    videoUpscale: false,
    maxDurationSeconds: null,
    aspectRatios: IMAGE_RATIOS,
    ...over,
  }
}

/**
 * Capability preset for a fal-family video model. Tier 2 (#5) centralizes the video defaults so
 * the keyframes/extend/maxDurationSeconds fields have ONE home and per-row noise stays low; rows
 * override only what differs (Runway has no negative prompt, Veo caps at 8s, etc.). Every video
 * model is i2v-capable, prompt-driven camera, 16:9/9:16/1:1, ≤10s unless overridden.
 */
function videoCaps(over: Partial<MediaCapabilities> = {}): MediaCapabilities {
  return {
    i2i: true,
    multiReference: false,
    inpaint: false,
    outpaint: false,
    camera: 'prompt',
    seed: true,
    negativePrompt: true,
    duration: true,
    keyframes: false,
    extend: false,
    videoToVideo: false,
    performanceCapture: false,
    videoUpscale: false,
    maxDurationSeconds: 10,
    aspectRatios: VIDEO_RATIOS,
    ...over,
  }
}

/** Capability preset for a presenter/avatar model — no image/camera/keyframe controls. */
function avatarCaps(over: Partial<MediaCapabilities> = {}): MediaCapabilities {
  return {
    i2i: false,
    multiReference: false,
    inpaint: false,
    outpaint: false,
    camera: false,
    seed: false,
    negativePrompt: false,
    duration: false,
    keyframes: false,
    extend: false,
    videoToVideo: false,
    performanceCapture: false,
    videoUpscale: false,
    maxDurationSeconds: null,
    aspectRatios: VIDEO_RATIOS,
    ...over,
  }
}

/**
 * The catalog. Seeded to match TODAY's behavior exactly — same models, same cents as the
 * old router PREFERENCE table and permissions scalars — so introducing it is a pure,
 * behavior-preserving refactor. New fal breadth rows land here in Phase 2.
 */
export const MEDIA_MODEL_CATALOG: MediaModelRow[] = [
  // ── Image (fal / imageGen) ────────────────────────────────────────────────
  {
    id: 'flux-1.1-pro',
    providerId: 'imageGen',
    modality: 'image',
    label: 'Flux 1.1 Pro',
    // Tier 2 (#7): Flux also does multi-reference edit (Kontext), mask inpaint, and outpaint/expand
    // (fill). Slugs UNVERIFIED vs fal's live catalog — env-overridable is not wired for image yet,
    // but capability ⟺ endpoint presence (asserted by a test); a wrong slug fails loud at subscribe.
    capabilities: imageCaps({ i2i: true, multiReference: true, inpaint: true, outpaint: true }),
    // t2i runs flux-pro/v1.1 (~5c); i2i runs the cheaper flux/dev endpoint (~3c).
    costScalars: { perCallCents: 5, i2iCallCents: 3 },
    // flux-1.1-pro's t2i endpoint has no prompt-guided i2i, so i2i routes to flux/dev i2i.
    falEndpoints: {
      t2i: 'fal-ai/flux-pro/v1.1',
      i2i: 'fal-ai/flux/dev/image-to-image',
      multiRef: 'fal-ai/flux-pro/kontext/multi',
      inpaint: 'fal-ai/flux/dev/inpainting',
      outpaint: 'fal-ai/flux-pro/v1/fill',
    },
  },
  {
    id: 'flux-schnell',
    providerId: 'imageGen',
    modality: 'image',
    label: 'Flux Schnell',
    capabilities: imageCaps(),
    costScalars: { perCallCents: 0.3 }, // fal flux-schnell ~$0.003 (fractional cents; not 1c)
    falEndpoints: { t2i: 'fal-ai/flux/schnell' },
  },
  {
    id: 'ideogram-v3',
    providerId: 'imageGen',
    modality: 'image',
    label: 'Ideogram v3',
    capabilities: imageCaps(),
    costScalars: { perCallCents: 8 },
    falEndpoints: { t2i: 'fal-ai/ideogram/v3' },
  },
  {
    id: 'recraft-v3',
    providerId: 'imageGen',
    modality: 'image',
    label: 'Recraft v3',
    capabilities: imageCaps(),
    costScalars: { perCallCents: 4 },
    falEndpoints: { t2i: 'fal-ai/recraft-v3' },
  },
  {
    id: 'stable-diffusion-3',
    providerId: 'imageGen',
    modality: 'image',
    label: 'Stable Diffusion 3',
    // SD3 does mask inpaint too; no verified multi-ref / outpaint slug, so those stay false (honest:
    // capability ⟺ a configured endpoint).
    capabilities: imageCaps({ i2i: true, inpaint: true }),
    costScalars: { perCallCents: 3 },
    falEndpoints: {
      t2i: 'fal-ai/stable-diffusion-v3-medium',
      i2i: 'fal-ai/stable-diffusion-v3-medium/image-to-image',
      inpaint: 'fal-ai/stable-diffusion-v3-medium/inpainting',
    },
  },
  // ── Image (Google Imagen) ─────────────────────────────────────────────────
  {
    id: 'imagen-3',
    providerId: 'googleImageGen',
    modality: 'image',
    label: 'Google Imagen 3',
    // i2i:false — Google Imagen i2i is not wired in our pipeline (no fal/OpenAI i2i endpoint),
    // so claiming it caused catalog↔pipeline drift. Honest capability until it's built.
    capabilities: imageCaps({ seed: false }),
    costScalars: { perCallCents: 4 },
  },
  // ── Image (OpenAI) ────────────────────────────────────────────────────────
  // The `dall-e-3` id is the routing key for OpenAI-DIRECT image generation (generateImage's
  // OpenAI branch keys on this id). DALL-E 3 was retired from the OpenAI API, so this
  // id now drives its successor gpt-image-1 under the hood — the id stays stable to avoid churning
  // every caller/router/cost-key that references it (distinct from the fal-hosted `gpt-image-1` row
  // below, which routes through fal, not OpenAI-direct).
  {
    id: 'dall-e-3',
    providerId: 'dall-e',
    modality: 'image',
    label: 'OpenAI gpt-image-1',
    capabilities: imageCaps({ seed: false, negativePrompt: false }),
    // gpt-image-1 at quality 'high' costs ~$0.17 for 1024x1024 (more for landscape/portrait) per
    // OpenAI's published image pricing — far above DALL-E 3's old ~4c. Bill ~17c so the cost gate /
    // spend cap don't systematically under-count (the misbilling learning). NOTE (maintainer review):
    // confirm against current OpenAI image pricing; lower to 'medium' quality in image-gen.ts if 17c/
    // image is too steep for the default path.
    costScalars: { perCallCents: 17 },
  },
  // ── Image (frontier breadth, fal-hosted) ──────────────────────────────────
  // Each routes through generateImage's FAL path by model id (falEndpoints.t2i/i2i) and gates under
  // the shared 'imageGen' bucket. Own provider/card per the "one card per model" choice. i2i⟺i2i
  // endpoint (integrity test). Slugs UNVERIFIED + 404-loud; verify against fal's catalog.
  {
    id: 'seedream-4',
    providerId: 'seedream',
    modality: 'image',
    label: 'Seedream 4 (ByteDance)',
    capabilities: imageCaps({ i2i: true }),
    costScalars: { perCallCents: 4 },
    falEndpoints: {
      t2i: 'fal-ai/bytedance/seedream/v4/text-to-image',
      i2i: 'fal-ai/bytedance/seedream/v4/edit',
    },
  },
  {
    id: 'gpt-image-1',
    providerId: 'gptImage',
    modality: 'image',
    label: 'GPT Image (OpenAI)',
    // OpenAI's gpt-image-1 via fal; no seed control on the OpenAI image API → seed:false (honest).
    capabilities: imageCaps({ i2i: true, seed: false }),
    costScalars: { perCallCents: 8 },
    falEndpoints: {
      t2i: 'fal-ai/gpt-image-1/text-to-image',
      i2i: 'fal-ai/gpt-image-1/edit-image',
    },
  },
  {
    id: 'nano-banana',
    providerId: 'nanoBanana',
    modality: 'image',
    label: 'Nano Banana (Gemini 2.5 Flash Image)',
    capabilities: imageCaps({ i2i: true }),
    costScalars: { perCallCents: 4 },
    falEndpoints: {
      t2i: 'fal-ai/gemini-25-flash-image',
      i2i: 'fal-ai/gemini-25-flash-image/edit',
    },
  },
  // Phase 2 frontier bumps. Slugs verified against fal's catalog (model pages, 2026):
  //   fal.ai/models/fal-ai/bytedance/seedream/v4.5/{text-to-image,edit}
  //   fal.ai/models/fal-ai/gemini-3-pro-image-preview{,/edit}
  // Reuse the existing seedream / nanoBanana provider toggles (same vendor) and gate under the
  // shared 'imageGen' bucket like the rest of this block; per-model cost is set below.
  {
    id: 'seedream-4.5',
    providerId: 'seedream',
    modality: 'image',
    label: 'Seedream 4.5 (ByteDance)',
    capabilities: imageCaps({ i2i: true }),
    costScalars: { perCallCents: 4 }, // ~$0.04/image on fal
    falEndpoints: {
      t2i: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
      i2i: 'fal-ai/bytedance/seedream/v4.5/edit',
    },
  },
  {
    id: 'nano-banana-pro',
    providerId: 'nanoBanana',
    modality: 'image',
    label: 'Nano Banana Pro (Gemini 3 Pro Image)',
    // Pro tier: best-in-class text rendering + character consistency, higher cost than the 2.5 tier.
    // i2i via the /edit endpoint; richer multi-ref/inpaint endpoints aren't wired yet (declared honestly).
    capabilities: imageCaps({ i2i: true }),
    costScalars: { perCallCents: 15 }, // ~$0.15/image on fal (4K ~$0.30)
    falEndpoints: {
      t2i: 'fal-ai/gemini-3-pro-image-preview',
      i2i: 'fal-ai/gemini-3-pro-image-preview/edit',
    },
  },
  // ── Video (Veo3, native direct) ───────────────────────────────────────────
  {
    id: 'veo-3',
    providerId: 'veo3',
    modality: 'video',
    label: 'Veo 3',
    // Veo image-to-video wired (image bytes inline in the body — UNVERIFIED, see veo3.ts).
    // Veo has no start/end-frame or extend endpoint and caps at 8s — keyframes/extend stay false,
    // maxDurationSeconds 8 (Tier 2 #5: enforcement blocks an end-frame/extend request here).
    capabilities: videoCaps({ keyframes: false, extend: false, maxDurationSeconds: 8 }),
    costScalars: { perCallCents: 100, perSecondCents: 20 },
  },
  // ── Video (Kling / Runway, established providers) ─────────────────────────
  {
    id: 'kling-v2.1',
    providerId: 'kling',
    modality: 'video',
    label: 'Kling 2.1',
    // i2v + start/end keyframe + extend all route through the fal factory (see kling.ts) — slugs
    // UNVERIFIED, env-overridable, 404-loud. keyframes/extend capability ⟺ those slugs exist.
    // Tier 3: videoUpscale ⟺ the shared fal Topaz upscaler slug.
    capabilities: videoCaps({ keyframes: true, extend: true, videoUpscale: true }),
    costScalars: { perCallCents: 45, perSecondCents: 9 },
  },
  {
    // The bespoke adapter routes image_to_video (promptImage), keyframe (first/last
    // frame), extend, and in-video edit (Runway Aleph / gen4_aleph) endpoints when those inputs are
    // supplied; text-only stays text_to_video. Endpoints/fields UNVERIFIED vs live Runway docs (see
    // runway.ts). No neg prompt. videoToVideo:true → Aleph is the headline Tier 2 #4 model.
    id: 'runway-gen4',
    providerId: 'runway',
    modality: 'video',
    label: 'Runway Gen-4',
    capabilities: videoCaps({
      negativePrompt: false,
      keyframes: true,
      extend: true,
      videoToVideo: true,
      performanceCapture: true,
    }),
    costScalars: { perCallCents: 90, perSecondCents: 18 },
  },
  // ── Video (fal breadth, Phase 2) ──────────────────────────────────────────
  // camera:'prompt' — fal video is prompt-driven (no native camera API); the camera compiler
  // will fold moves into the prompt. Costs mirror API_COST_SCALARS (cents).
  {
    id: 'ltx-video',
    providerId: 'ltx',
    modality: 'video',
    label: 'LTX Video 2.3',
    // LTX exposes start/end keyframe, extend, and video-to-video routes (see fal-models.ts) — slugs
    // UNVERIFIED. Tier 3: videoUpscale ⟺ the shared fal Topaz upscaler slug.
    capabilities: videoCaps({ keyframes: true, extend: true, videoToVideo: true, videoUpscale: true }),
    costScalars: { perCallCents: 6, perSecondCents: 6 }, // LTX 2.3 ~$0.06/s
  },
  {
    id: 'wan-video',
    providerId: 'wan',
    modality: 'video',
    label: 'Wan Video',
    // i2v + video-to-video (restyle/edit) on fal; no verified keyframe/extend slug yet, so those
    // stay false (honest: capability ⟺ a configured endpoint). Tier 3: videoUpscale ⟺ Topaz slug.
    capabilities: videoCaps({ videoToVideo: true, videoUpscale: true }),
    costScalars: { perCallCents: 20, perSecondCents: 4 },
  },
  {
    id: 'seedance-video',
    providerId: 'seedance',
    modality: 'video',
    label: 'Seedance 1.0 Pro',
    // Seedance Pro exposes a first-last-frame (keyframe) route; no verified extend slug yet.
    // Tier 3: videoUpscale ⟺ the shared fal Topaz upscaler slug.
    capabilities: videoCaps({ keyframes: true, videoUpscale: true }),
    costScalars: { perCallCents: 30, perSecondCents: 30 }, // Seedance ~$0.30/s
  },
  {
    // Model-breadth: Hailuo 02 (MiniMax) — fal-hosted t2v/i2v. t2v + i2v only (no verified keyframe/
    // extend route yet, so those capabilities stay off — honest per the integrity test). videoUpscale
    // ⟺ the shared fal Topaz slug. Slugs UNVERIFIED + env-overridable (HAILUO_FAL_*) + 404-loud.
    id: 'hailuo-video',
    providerId: 'hailuo',
    modality: 'video',
    label: 'Hailuo 02 (MiniMax)',
    capabilities: videoCaps({ videoUpscale: true }),
    costScalars: { perCallCents: 28, perSecondCents: null }, // ~$0.28/clip (flat)
  },
  {
    // Frontier breadth: Veo 3.1 (fal-hosted) — own provider/card next to native Veo 3. t2v+i2v+shared
    // Topaz upscale; no verified keyframe/extend slug → off (honest). Caps at Veo's 8s.
    id: 'veo-3.1',
    providerId: 'veo31',
    modality: 'video',
    label: 'Veo 3.1',
    capabilities: videoCaps({ videoUpscale: true, maxDurationSeconds: 8 }),
    costScalars: { perCallCents: 100, perSecondCents: 20 },
  },
  {
    // Frontier breadth: Kling 2.5 Turbo (fal-hosted) — own provider/card next to Kling 2.1. t2v+i2v+
    // shared upscale; no verified 2.5 keyframe/extend slug yet → off (honest).
    id: 'kling-v2.5',
    providerId: 'kling25',
    modality: 'video',
    label: 'Kling 2.5 Turbo',
    capabilities: videoCaps({ videoUpscale: true }),
    costScalars: { perCallCents: 35, perSecondCents: 7 },
  },
  {
    // Frontier breadth: Seedance 2.0 Pro (fal-hosted) — own provider/card next to Seedance 1.0 Pro.
    // t2v+i2v + first-last-frame keyframe + shared upscale; no verified extend slug → off (honest).
    id: 'seedance-v2',
    providerId: 'seedance2',
    modality: 'video',
    label: 'Seedance 2.0 Pro',
    capabilities: videoCaps({ keyframes: true, videoUpscale: true }),
    costScalars: { perCallCents: 30, perSecondCents: 30 }, // ~$0.30/s
  },
  // ── Avatar ────────────────────────────────────────────────────────────────
  {
    id: 'heygen-v2',
    providerId: 'heygen',
    modality: 'avatar',
    label: 'HeyGen',
    capabilities: avatarCaps(),
    costScalars: { perCallCents: 30 },
  },
  {
    id: 'musetalk',
    providerId: 'musetalk',
    modality: 'avatar',
    label: 'MuseTalk',
    capabilities: avatarCaps(),
    costScalars: { perCallCents: 10 },
  },
]

// Frozen so a stray runtime/test/HMR push() can't desync BY_ID from the array and make
// getModelRow() silently miss a row (→ null → "free"). The catalog is static config.
Object.freeze(MEDIA_MODEL_CATALOG)

const BY_ID = new Map(MEDIA_MODEL_CATALOG.map((m) => [m.id, m]))

/** O(1) row lookup by model id. */
export function getModelRow(modelId: string): MediaModelRow | null {
  return BY_ID.get(modelId) ?? null
}

/** All catalog rows belonging to a provider (the models under one user toggle). */
export function modelsForProvider(providerId: string): MediaModelRow[] {
  return MEDIA_MODEL_CATALOG.filter((m) => m.providerId === providerId)
}

/** All rows of a modality. */
export function modelsForModality(modality: MediaModality): MediaModelRow[] {
  return MEDIA_MODEL_CATALOG.filter((m) => m.modality === modality)
}

/**
 * Per-call cost in cents for a model, FROM the catalog row (single source of truth).
 * Returns null when the price is unknown/missing — callers MUST treat null as
 * "force always_ask", never as free (the silent-overspend guard).
 */
export function catalogCostCents(modelId: string): number | null {
  const row = BY_ID.get(modelId)
  if (!row) return null
  return row.costScalars.perCallCents
}

/**
 * Per-call cost in cents for the IMAGE-TO-IMAGE path. Returns the row's `i2iCallCents`
 * when set (i2i often hits a cheaper endpoint than t2i), else falls back to the t2i
 * `perCallCents`. Same null = unknown semantics as catalogCostCents.
 */
export function catalogI2iCostCents(modelId: string): number | null {
  const row = BY_ID.get(modelId)
  if (!row) return null
  return row.costScalars.i2iCallCents ?? row.costScalars.perCallCents
}

/** The fal t2i endpoint for an image model, or null (unknown model / non-fal transport). */
export function falT2iEndpoint(modelId: string): string | null {
  return BY_ID.get(modelId)?.falEndpoints?.t2i ?? null
}

/**
 * The fal i2i endpoint for an image model, or null if the model has no i2i endpoint. This is
 * the SINGLE source of i2i eligibility for the fal image path: a model is i2i-capable
 * iff this returns non-null. The catalog `capabilities.i2i` flag mirrors it (test-asserted).
 */
export function falI2iEndpoint(modelId: string): string | null {
  return BY_ID.get(modelId)?.falEndpoints?.i2i ?? null
}

/** Tier 2 (#7): the fal multi-reference-edit endpoint for a model, or null. Presence ⟺ the
 *  `multiReference` capability (test-asserted), the single source of multi-ref eligibility. */
export function falMultiRefEndpoint(modelId: string): string | null {
  return BY_ID.get(modelId)?.falEndpoints?.multiRef ?? null
}

/** Tier 2 (#7): the fal mask-inpaint endpoint for a model, or null. Presence ⟺ `inpaint`. */
export function falInpaintEndpoint(modelId: string): string | null {
  return BY_ID.get(modelId)?.falEndpoints?.inpaint ?? null
}

/** Tier 2 (#7): the fal outpaint/expand endpoint for a model, or null. Presence ⟺ `outpaint`. */
export function falOutpaintEndpoint(modelId: string): string | null {
  return BY_ID.get(modelId)?.falEndpoints?.outpaint ?? null
}

/** The video duration ceiling in seconds for a model — its declared cap, or 8 when the catalog has
 *  no row for it. The 8 fallback (Veo's real limit) is deliberately conservative: a missing row must
 *  never grant an unbounded clip. Tier 2 (#5) single home for the `?? 8` that used to be copied
 *  across startVideo, the store, and the composer. */
const DEFAULT_VIDEO_MAX_DURATION = 8
export function maxDurationFor(modelId: string): number {
  return BY_ID.get(modelId)?.capabilities.maxDurationSeconds ?? DEFAULT_VIDEO_MAX_DURATION
}

/**
 * Clamp a requested clip duration to [1, max], rounding and defaulting a missing/zero/NaN request to
 * 5s. Tier 2 (#5) single clamp policy shared by startVideo and the store so a negative/fractional
 * duration can't diverge between the cache key, the billed cost, and the clip the provider makes
 * (a bare upper-only `Math.min` let a negative duration survive into cost estimation). `max` is the
 * caller's resolved per-model ceiling (maxDurationFor, or the provider's catalog row).
 */
export function clampVideoDuration(requested: number | undefined, max: number): number {
  const base = Math.round(Number(requested) || 5)
  return Math.min(Math.max(1, base), max)
}
