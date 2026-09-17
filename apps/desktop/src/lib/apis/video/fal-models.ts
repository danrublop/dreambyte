// fal-hosted video models built from the generic factory.
//
// Slugs VERIFIED against fal.ai's catalog (2026-06) and env-overridable for future upgrades
// (a wrong/renamed slug 404s loudly at generate(), never silent). Pricing from fal model
// pages: LTX 2.3 ~$0.06/s (1080p), Seedance 2.0 ~$0.30/s (720p), Wan ~$0.20/clip (estimate).
//   LTX 2.3:      https://fal.ai/models/fal-ai/ltx-2.3/text-to-video
//   Wan:          https://fal.ai/models/fal-ai/wan-t2v
//   Seedance Pro: https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video

import { makeFalVideoProvider } from './fal-video'

// Tier 3: the fal video upscaler is ONE shared, model-agnostic endpoint (Topaz). Every fal provider
// points its `upscaleModel` at this single slug + env override, so the slug has ONE source of truth
// here — generation.ts also reads `resolveSharedUpscaleSlug()` to recognize an upscale operation at
// commit time (it encodes the slug into the operationId). UNVERIFIED vs fal's live catalog, 404-loud.
export const SHARED_UPSCALE_MODEL = 'fal-ai/topaz/upscale/video'
export const SHARED_UPSCALE_MODEL_ENV = 'FAL_VIDEO_UPSCALE_MODEL'
export function resolveSharedUpscaleSlug(): string {
  return process.env[SHARED_UPSCALE_MODEL_ENV] || SHARED_UPSCALE_MODEL
}

// i2v slugs mirror the t2v slug with the image-to-video route — env-overridable + 404-loud like
// t2v. Verify against fal's live catalog before relying in production (Tier 1 / i2v).
export const ltxProvider = makeFalVideoProvider({
  id: 'ltx',
  name: 'LTX Video 2.3',
  defaultModel: 'fal-ai/ltx-2.3/text-to-video',
  modelEnvVar: 'LTX_FAL_MODEL',
  i2vModel: 'fal-ai/ltx-2.3/image-to-video',
  i2vModelEnvVar: 'LTX_FAL_I2V_MODEL',
  // Tier 2 (#5): LTX start+end keyframe + extend routes. Slugs UNVERIFIED (env-overridable +
  // 404-loud) — they back capabilities.keyframes/extend. LTX names the tail frame `end_image_url`.
  keyframeModel: 'fal-ai/ltx-2.3/keyframes',
  keyframeModelEnvVar: 'LTX_FAL_KEYFRAME_MODEL',
  endImageField: 'end_image_url',
  extendModel: 'fal-ai/ltx-2.3/extend',
  extendModelEnvVar: 'LTX_FAL_EXTEND_MODEL',
  // Tier 2 (#4): LTX video-to-video (restyle/edit) route. Slug UNVERIFIED — backs videoToVideo.
  v2vModel: 'fal-ai/ltx-2.3/video-to-video',
  v2vModelEnvVar: 'LTX_FAL_V2V_MODEL',
  // Tier 3 (breadth): fal video upscaler (Topaz). The upscaler is model-AGNOSTIC — the same endpoint
  // upres a clip from any generator — so every fal provider shares this slug + the ONE env override
  // (FAL_VIDEO_UPSCALE_MODEL). UNVERIFIED vs fal's live catalog; backs capabilities.videoUpscale.
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.06,
  minDuration: 5,
  maxDuration: 10,
})

export const wanProvider = makeFalVideoProvider({
  id: 'wan',
  name: 'Wan Video',
  defaultModel: 'fal-ai/wan-t2v',
  modelEnvVar: 'WAN_FAL_MODEL',
  i2vModel: 'fal-ai/wan-i2v',
  i2vModelEnvVar: 'WAN_FAL_I2V_MODEL',
  // Tier 2 (#4): Wan video-to-video (restyle/edit) route. Slug UNVERIFIED — backs videoToVideo.
  v2vModel: 'fal-ai/wan-v2v',
  v2vModelEnvVar: 'WAN_FAL_V2V_MODEL',
  // Tier 3: shared fal video upscaler (see LTX note).
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.2,
  minDuration: 5,
  maxDuration: 10,
})

export const seedanceProvider = makeFalVideoProvider({
  id: 'seedance',
  name: 'Seedance 1.0 Pro',
  defaultModel: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
  modelEnvVar: 'SEEDANCE_FAL_MODEL',
  i2vModel: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  i2vModelEnvVar: 'SEEDANCE_FAL_I2V_MODEL',
  // Tier 2 (#5): Seedance Pro first-last-frame (keyframe) route. Slug UNVERIFIED (env-overridable +
  // 404-loud) — backs capabilities.keyframes. No verified extend route yet, so extend stays off.
  keyframeModel: 'fal-ai/bytedance/seedance/v1/pro/first-last-frame-to-video',
  keyframeModelEnvVar: 'SEEDANCE_FAL_KEYFRAME_MODEL',
  endImageField: 'end_image_url',
  // Tier 3: shared fal video upscaler (see LTX note).
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.3,
  minDuration: 5,
  maxDuration: 10,
})

// Model-breadth: Hailuo (MiniMax) — popular fal-hosted t2v/i2v with strong motion + prompt
// adherence. t2v + i2v only for now (no verified keyframe/extend route → those capabilities stay
// off, honest per the catalog integrity test). Slugs UNVERIFIED + env-overridable + 404-loud, same
// stance as the other fal video models; verify against fal's catalog before relying.
export const hailuoProvider = makeFalVideoProvider({
  id: 'hailuo',
  name: 'Hailuo 02 (MiniMax)',
  defaultModel: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
  modelEnvVar: 'HAILUO_FAL_MODEL',
  i2vModel: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
  i2vModelEnvVar: 'HAILUO_FAL_I2V_MODEL',
  // Tier 3: shared fal video upscaler (see LTX note).
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.28,
  minDuration: 6,
  maxDuration: 10,
})

// Frontier breadth: Veo 3.1 (Google) via fal — its own provider/card so the newest Veo shows next to
// the prior native Veo 3 (src/lib/apis/video/veo3.ts). t2v + i2v + shared upscale; no verified keyframe/
// extend slug, so those capabilities stay off (honest per the integrity test). Veo caps at ~8s.
// Slugs UNVERIFIED + env-overridable (VEO31_FAL_*) + 404-loud; verify against fal's catalog.
export const veo31Provider = makeFalVideoProvider({
  id: 'veo31',
  name: 'Veo 3.1',
  defaultModel: 'fal-ai/veo3.1/text-to-video',
  modelEnvVar: 'VEO31_FAL_MODEL',
  i2vModel: 'fal-ai/veo3.1/image-to-video',
  i2vModelEnvVar: 'VEO31_FAL_I2V_MODEL',
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 1.0,
  minDuration: 4,
  maxDuration: 8,
})

// Frontier breadth: Kling 2.5 Turbo via fal — its own provider/card next to the prior Kling 2.1
// (src/lib/apis/video/kling.ts). t2v + i2v + shared upscale; no verified 2.5 keyframe/extend slug yet, so
// those stay off (honest). Slugs UNVERIFIED + env-overridable (KLING25_FAL_*) + 404-loud.
export const kling25Provider = makeFalVideoProvider({
  id: 'kling25',
  name: 'Kling 2.5 Turbo',
  defaultModel: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
  modelEnvVar: 'KLING25_FAL_MODEL',
  i2vModel: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
  i2vModelEnvVar: 'KLING25_FAL_I2V_MODEL',
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.35,
  minDuration: 5,
  maxDuration: 10,
})

// Frontier breadth: Seedance 2.0 Pro (ByteDance) via fal — its own provider/card next to Seedance 1.0
// Pro. t2v + i2v + first-last-frame keyframe + shared upscale; no verified extend slug → off (honest).
// Slugs UNVERIFIED + env-overridable (SEEDANCE2_FAL_*) + 404-loud; verify against fal's catalog.
export const seedance2Provider = makeFalVideoProvider({
  id: 'seedance2',
  name: 'Seedance 2.0 Pro',
  defaultModel: 'fal-ai/bytedance/seedance/v2/pro/text-to-video',
  modelEnvVar: 'SEEDANCE2_FAL_MODEL',
  i2vModel: 'fal-ai/bytedance/seedance/v2/pro/image-to-video',
  i2vModelEnvVar: 'SEEDANCE2_FAL_I2V_MODEL',
  keyframeModel: 'fal-ai/bytedance/seedance/v2/pro/first-last-frame-to-video',
  keyframeModelEnvVar: 'SEEDANCE2_FAL_KEYFRAME_MODEL',
  endImageField: 'end_image_url',
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.3,
  minDuration: 5,
  maxDuration: 10,
})
