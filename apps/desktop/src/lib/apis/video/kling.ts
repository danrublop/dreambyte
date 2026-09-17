// Kling 2.1 text-to-video via fal.ai. Now a thin config over the generic fal-video factory
// (src/lib/apis/video/fal-video.ts) — the queue API is identical across fal video models, so the
// per-model code is just the slug + cost + duration bounds. Slug stays overridable via
// KLING_FAL_MODEL so upgrades don't need a code change.

import { makeFalVideoProvider } from './fal-video'
import { SHARED_UPSCALE_MODEL, SHARED_UPSCALE_MODEL_ENV } from './fal-models'

export const klingProvider = makeFalVideoProvider({
  id: 'kling',
  name: 'Kling 2.1',
  defaultModel: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  modelEnvVar: 'KLING_FAL_MODEL',
  // i2v: the image-to-video route of the same Kling app. Env-overridable + 404-loud; verify
  // against fal's live catalog before relying (A2 / i2v).
  i2vModel: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  i2vModelEnvVar: 'KLING_FAL_I2V_MODEL',
  // Tier 2: start+end keyframe + extend routes of the same Kling app. Slugs UNVERIFIED vs
  // fal's live catalog (env-overridable + 404-loud) — they back capabilities.keyframes/extend.
  // Kling's end-frame field is `tail_image_url` (the factory default).
  keyframeModel: 'fal-ai/kling-video/v2.1/standard/start-end-to-video',
  keyframeModelEnvVar: 'KLING_FAL_KEYFRAME_MODEL',
  extendModel: 'fal-ai/kling-video/v2.1/standard/extend',
  extendModelEnvVar: 'KLING_FAL_EXTEND_MODEL',
  // Tier 3 (breadth): shared fal video upscaler (Topaz) — model-agnostic, same slug + env override
  // across all fal providers. UNVERIFIED; backs capabilities.videoUpscale.
  upscaleModel: SHARED_UPSCALE_MODEL,
  upscaleModelEnvVar: SHARED_UPSCALE_MODEL_ENV,
  costPerCallUsd: 0.45,
  minDuration: 5,
  maxDuration: 10,
})
