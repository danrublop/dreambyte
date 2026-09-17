// Provider-agnostic interface for text-to-video generators. Each provider
// returns an operation ID on start and is polled via `pollStatus`. When
// status resolves `done: true`, `download()` fetches the final MP4 bytes.

export type VideoAspectRatio = '16:9' | '9:16' | '1:1'

export interface VideoGenerateOptions {
  prompt: string
  negativePrompt?: string
  aspectRatio: VideoAspectRatio
  /** Target duration in seconds. Providers clamp to their own limits. */
  durationSeconds: number
  /** Optional seed for reproducibility. */
  seed?: number
  /**
   * Optional conditioning image (image-to-video). A fetchable URL. When set, an i2v-capable
   * provider routes to its image-to-video endpoint and animates this still; providers that
   * don't support i2v ignore it (and the catalog `capabilities.i2i` flag gates the UI so an
   * i2v-only request never reaches a t2v-only provider).
   */
  imageUrl?: string
  /**
   * Tier 2 (#5) keyframes: the END / tail frame. When set, the provider routes to its start+end
   * keyframe endpoint, treating `imageUrl` as the START frame and animating an interpolation to
   * this one. Requires `imageUrl` (the start). Gated by `capabilities.keyframes`; a provider with
   * no keyframe endpoint throws (fail loud, never a silent i2v/t2v).
   */
  endImageUrl?: string
  /**
   * Tier 2 (#5) extend: a source clip to continue. When set, the provider routes to its
   * video→video / extend endpoint and produces a follow-on clip. Gated by `capabilities.extend`;
   * a provider with no extend endpoint throws.
   */
  extendVideoUrl?: string
  /**
   * Tier 2 (#4) video→video / Aleph: a source clip to TRANSFORM in place (restyle/relight/add-remove/
   * new-angle/replace-bg). When set, the provider routes to its v2v endpoint, animating the edit
   * described by `prompt` (already framed by the edit compiler) onto this clip. Gated by
   * `capabilities.videoToVideo`; a provider with no v2v endpoint throws. Distinct from
   * `extendVideoUrl` (which lengthens the clip rather than rewriting it).
   */
  editVideoUrl?: string
  /**
   * Tier 2 (#6) performance capture (Runway Act-Two): a DRIVING video whose motion/expression drives
   * the CHARACTER given in `imageUrl`. When set, the provider routes to its act-two endpoint. Requires
   * `imageUrl` (the character). Gated by `capabilities.performanceCapture`; a provider without it throws.
   */
  drivingVideoUrl?: string
  /**
   * Tier 3 (breadth) video upscale: a source clip to UPRES (super-resolution, no other change). When
   * set, the provider routes to its upscale endpoint with `upscaleFactor` as the scale. No prompt,
   * camera, or duration applies — it's a post-process on finished footage. Gated by
   * `capabilities.videoUpscale`; a provider with no upscale endpoint throws (fail loud, never silent).
   */
  upscaleVideoUrl?: string
  /** Tier 3: upscale multiplier (2× or 4×). Defaults to 2 when omitted. Only meaningful with `upscaleVideoUrl`. */
  upscaleFactor?: 2 | 4
}

export interface VideoStatus {
  done: boolean
  /** URI / URL where the finished clip lives once ready. */
  videoUri?: string
  error?: string
}

export interface VideoProviderClient {
  id: string
  /** Human-readable label for logs + UI. */
  name: string
  /** Env var whose presence indicates the provider is configured. */
  envKey: string
  /** Baseline cost per call in USD. Used for cost approval gate + logging. */
  costPerCallUsd: number
  /** Cache-busting tag for the start-cache request hash — the resolved model slug/version.
   *  Distinguishes outputs when a provider's underlying model is env-overridable (fal models).
   *  Omit when the provider maps to a single fixed model (provider.id alone suffices). */
  cacheTag?: string
  /** Tier 3: the resolved video-upscale slug, when this provider supports upscale. Used as the cache
   *  model for an upscale request so the key tracks the ACTUAL upscaler (not the t2v `cacheTag`) — a
   *  changed FAL_VIDEO_UPSCALE_MODEL then busts stale upscaler output. Absent when no upscale endpoint. */
  upscaleCacheTag?: string
  /** Called to kick off generation. Returns an operation ID the route polls. */
  generate(opts: VideoGenerateOptions): Promise<{ operationId: string; enhancedPrompt?: string }>
  /** Poll for completion. */
  pollStatus(operationId: string): Promise<VideoStatus>
  /** Download the final MP4. */
  download(videoUri: string): Promise<Buffer>
}
