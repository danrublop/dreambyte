// Generic fal.ai text-to-video provider factory.
//
// fal's queue API is uniform across every hosted video model: POST the model slug → get a
// request_id → poll /requests/{id}/status → COMPLETED → GET /requests/{id} for the video URL.
// The Kling adapter hard-coded one slug; this factory parameterizes it so adding a fal video
// model (LTX, Wan, Seedance, ...) is a few lines + a verified slug, not a new file.
//
// Slugs are env-overridable (modelEnvVar) so a slug that fal renames is a one-env-var fix,
// not a code change. Defaults must be verified against fal's live catalog before production —
// a wrong slug 404s at generate() (fails loudly, never silent).

import type { VideoProviderClient, VideoStatus } from './types'

const FAL_BASE = 'https://queue.fal.run'

// Cap every fal queue call so a stalled queue can't hang the agent turn — 60s for the
// submit/status/result JSON calls, 120s for the video download.
const FETCH_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface FalVideoConfig {
  id: string
  name: string
  /** Default fal model slug, e.g. 'fal-ai/kling-video/v2.1/standard/text-to-video'. */
  defaultModel: string
  /** Optional env var that overrides the slug at runtime. */
  modelEnvVar?: string
  /** fal image-to-video model slug (image-to-video endpoint). Present iff the provider does i2v. */
  i2vModel?: string
  /** Optional env var that overrides the i2v slug at runtime. */
  i2vModelEnvVar?: string
  /**
   * Tier 2 (#5) fal start+end keyframe model slug. Present iff the provider does keyframes (its
   * presence is the source of truth that backs the catalog `capabilities.keyframes` flag). The
   * endpoint takes a START frame (`image_url`) + an END frame (`endImageField`).
   */
  keyframeModel?: string
  /** Optional env var that overrides the keyframe slug at runtime. */
  keyframeModelEnvVar?: string
  /** Body field for the END/tail frame on the keyframe endpoint. fal models differ — Kling uses
   *  `tail_image_url`, others `end_image_url`. Default `tail_image_url`. */
  endImageField?: string
  /**
   * Tier 2 (#5) fal extend / video→video model slug. Present iff the provider does extend (backs
   * `capabilities.extend`). The endpoint takes a source clip (`videoField`).
   */
  extendModel?: string
  /** Optional env var that overrides the extend slug at runtime. */
  extendModelEnvVar?: string
  /**
   * Tier 2 (#4) fal video→video / edit model slug (restyle/relight/etc). Present iff the provider
   * does v2v (backs `capabilities.videoToVideo`). The endpoint takes a source clip (`videoField`) +
   * the compiled edit prompt.
   */
  v2vModel?: string
  /** Optional env var that overrides the v2v slug at runtime. */
  v2vModelEnvVar?: string
  /** Body field for the source clip on the extend AND v2v endpoints. Default `video_url`. */
  videoField?: string
  /**
   * Tier 3 (breadth) fal upscale / super-resolution model slug. Present iff the provider does video
   * upscale (backs `capabilities.videoUpscale`). The endpoint takes a source clip (`videoField`) + a
   * `scale` factor. UNVERIFIED slugs 404 loud at generate(), never silent.
   */
  upscaleModel?: string
  /** Optional env var that overrides the upscale slug at runtime. */
  upscaleModelEnvVar?: string
  costPerCallUsd: number
  minDuration?: number
  maxDuration?: number
}

// i2v ops encode the submit slug into the operationId (`<slug>::<request_id>`) so pollStatus hits
// the SAME endpoint the request was submitted to — fal's queue status/result URLs are addressed by
// the full submit path, and the provider only gets the request_id back at poll time. t2v ops stay
// bare (unchanged), so this is additive and never alters existing text-to-video behavior.
const OP_SEP = '::'

function getKey(): string {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not configured — add it to use fal video models')
  return key
}

export function makeFalVideoProvider(cfg: FalVideoConfig): VideoProviderClient {
  const min = cfg.minDuration ?? 5
  const max = cfg.maxDuration ?? 10
  const resolveModel = () => (cfg.modelEnvVar && process.env[cfg.modelEnvVar]) || cfg.defaultModel
  const resolveI2vModel = () => (cfg.i2vModelEnvVar && process.env[cfg.i2vModelEnvVar]) || cfg.i2vModel
  const resolveKeyframeModel = () =>
    (cfg.keyframeModelEnvVar && process.env[cfg.keyframeModelEnvVar]) || cfg.keyframeModel
  const resolveExtendModel = () => (cfg.extendModelEnvVar && process.env[cfg.extendModelEnvVar]) || cfg.extendModel
  const resolveV2vModel = () => (cfg.v2vModelEnvVar && process.env[cfg.v2vModelEnvVar]) || cfg.v2vModel
  const resolveUpscaleModel = () => (cfg.upscaleModelEnvVar && process.env[cfg.upscaleModelEnvVar]) || cfg.upscaleModel
  const endImageField = cfg.endImageField ?? 'tail_image_url'
  const videoField = cfg.videoField ?? 'video_url'
  // The model slug a queued op was submitted to: decoded from a slug-encoded operationId (any
  // non-t2v route — i2v / keyframe / extend), else the configured t2v slug. Used by
  // pollStatus/download to build the correct fal queue URLs.
  const modelForOp = (operationId: string): { model: string; id: string } => {
    const sep = operationId.indexOf(OP_SEP)
    if (sep === -1) return { model: resolveModel(), id: operationId }
    const prefix = operationId.slice(0, sep)
    // Only treat the prefix as an encoded slug when it actually looks like a fal model path
    // (contains '/'). fal request_ids are UUIDs (no '/'), so a stray '::' in an id never
    // masquerades as a slug and send the poller to a bogus endpoint.
    if (!prefix.includes('/')) return { model: resolveModel(), id: operationId }
    return { model: prefix, id: operationId.slice(sep + OP_SEP.length) }
  }

  return {
    id: cfg.id,
    name: cfg.name,
    envKey: 'FAL_KEY',
    costPerCallUsd: cfg.costPerCallUsd,
    // The resolved slug (env override captured at construction) busts the start-cache when
    // an operator points this provider at a different model — no stale cross-model clip.
    cacheTag: resolveModel(),
    // Tier 3: the resolved upscale slug (if configured), so an upscale request's cache key tracks the
    // actual upscaler, not the t2v cacheTag. undefined when this provider has no upscale endpoint.
    upscaleCacheTag: resolveUpscaleModel(),

    async generate(opts) {
      const key = getKey()
      // Pick the route by the richest input present, most-specific first: extend (lengthen a clip) →
      // v2v/edit (transform a clip) → keyframe (start+end frames) → i2v (a single conditioning image)
      // → t2v. Each non-t2v route needs its own configured slug; FAIL LOUD if the input is supplied
      // but the slug is missing — silently downgrading to t2v would charge for a clip that ignores
      // the input. The composer gates on the catalog capability flags, but a direct caller isn't.
      const { resolveReferenceToFetchableUrl } = await import('@/lib/media/reference-upload')
      const clamped = String(Math.max(min, Math.min(max, opts.durationSeconds)))
      const body: Record<string, unknown> = { prompt: opts.prompt, duration: clamped, aspect_ratio: opts.aspectRatio }
      if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt
      if (typeof opts.seed === 'number') body.seed = opts.seed

      let model: string
      let encodeSlug = false // non-t2v routes encode the slug into the operationId for pollStatus
      if (opts.upscaleVideoUrl) {
        // Tier 3: pure post-process — upres a finished clip. No prompt/duration/aspect apply, so strip
        // them from the body (an upscaler that reads `prompt`/`duration` would otherwise be misfed).
        const upscaleModel = resolveUpscaleModel()
        if (!upscaleModel)
          throw new Error(`${cfg.name} does not support video upscale (no upscale endpoint configured)`)
        model = upscaleModel
        encodeSlug = true
        // A pure post-process: strip every generation field (prompt/duration/aspect AND the optional
        // negative_prompt/seed set above) so none is misfed to the upscaler.
        delete body.prompt
        delete body.duration
        delete body.aspect_ratio
        delete body.negative_prompt
        delete body.seed
        body[videoField] = await resolveReferenceToFetchableUrl(opts.upscaleVideoUrl, undefined, { kind: 'video' })
        // Clamp the scale to the only two supported factors HERE, at the lowest level — a direct caller
        // (not just the agent handler) could pass an arbitrary factor, and an absurd scale would mean a
        // far larger/costlier render on the paid endpoint. 4 only when asked; everything else → 2.
        body.scale = opts.upscaleFactor === 4 ? 4 : 2
      } else if (opts.extendVideoUrl) {
        const extendModel = resolveExtendModel()
        if (!extendModel) throw new Error(`${cfg.name} does not support extend (no extend endpoint configured)`)
        model = extendModel
        encodeSlug = true
        body[videoField] = await resolveReferenceToFetchableUrl(opts.extendVideoUrl, undefined, { kind: 'video' })
      } else if (opts.editVideoUrl) {
        const v2vModel = resolveV2vModel()
        if (!v2vModel)
          throw new Error(`${cfg.name} does not support video-to-video editing (no v2v endpoint configured)`)
        model = v2vModel
        encodeSlug = true
        // The edit operation is already framed into opts.prompt by the edit compiler upstream.
        body[videoField] = await resolveReferenceToFetchableUrl(opts.editVideoUrl, undefined, { kind: 'video' })
      } else if (opts.endImageUrl) {
        const keyframeModel = resolveKeyframeModel()
        if (!keyframeModel)
          throw new Error(`${cfg.name} does not support start/end keyframes (no keyframe endpoint configured)`)
        if (!opts.imageUrl) throw new Error(`${cfg.name} keyframe generation requires a start frame (imageUrl)`)
        model = keyframeModel
        encodeSlug = true
        // Resolve start + end frames in parallel — two independent uploads, no data dependency
        // (mirrors runway.ts). Sequential awaits doubled keyframe submit latency.
        const [startFrame, endFrame] = await Promise.all([
          resolveReferenceToFetchableUrl(opts.imageUrl),
          resolveReferenceToFetchableUrl(opts.endImageUrl),
        ])
        body.image_url = startFrame
        body[endImageField] = endFrame
      } else if (opts.imageUrl) {
        const i2vModel = resolveI2vModel()
        if (!i2vModel) throw new Error(`${cfg.name} does not support image-to-video (no i2v endpoint configured)`)
        model = i2vModel
        encodeSlug = true
        body.image_url = await resolveReferenceToFetchableUrl(opts.imageUrl)
      } else {
        model = resolveModel()
      }

      const res = await fetch(`${FAL_BASE}/${model}`, {
        method: 'POST',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? `${cfg.name} error: ${res.status}`)
      const requestId = data.request_id as string | undefined
      if (!requestId) throw new Error(`${cfg.name} response missing request_id`)
      // Encode the submit slug so pollStatus hits the same (non-default) endpoint; t2v stays bare.
      return { operationId: encodeSlug ? `${model}${OP_SEP}${requestId}` : requestId }
    },

    async pollStatus(operationId): Promise<VideoStatus> {
      const key = getKey()
      const { model, id: requestId } = modelForOp(operationId)
      const res = await fetch(`${FAL_BASE}/${model}/requests/${requestId}/status`, {
        headers: { Authorization: `Key ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail ?? `${cfg.name} status error: ${res.status}`)
      if (data.status === 'COMPLETED') {
        const out = await fetch(`${FAL_BASE}/${model}/requests/${requestId}`, {
          headers: { Authorization: `Key ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        const final = await out.json()
        const videoUri = final?.video?.url ?? final?.output?.video?.url
        if (!videoUri) return { done: true, error: `${cfg.name} completed without a video URL` }
        return { done: true, videoUri }
      }
      if (data.status === 'FAILED') {
        return { done: true, error: data.logs?.[0]?.message ?? `${cfg.name} generation failed` }
      }
      return { done: false }
    },

    async download(uri) {
      const res = await fetch(uri, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${cfg.name} download failed: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
  }
}
