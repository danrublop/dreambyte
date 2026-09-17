import type { APIName, APIPermissions, PermissionConfig, PermissionRequest, PermissionResponse } from './types'
import { getModelRow } from './media/model-catalog'

// ── Default permissions ─────────────────────────────────────────────────────

/** Project-level default for the single-call cost approval threshold.
 *  Any tool call whose estimated USD cost exceeds this value prompts the
 *  user even if the per-API mode is `always_allow`. Per-API
 *  `singleCallCostThreshold` overrides this. $0.50 matches OpenMontage. */
export const DEFAULT_SINGLE_CALL_COST_THRESHOLD_USD = 0.5

export function createDefaultPermissionConfig(): PermissionConfig {
  return {
    mode: 'always_ask',
    sessionLimit: null,
    monthlyLimit: null,
    sessionSpend: 0,
    monthlySpend: 0,
    singleCallCostThreshold: null,
  }
}

export function createDefaultAPIPermissions(): APIPermissions {
  return {
    heygen: createDefaultPermissionConfig(),
    veo3: createDefaultPermissionConfig(),
    kling: createDefaultPermissionConfig(),
    runway: createDefaultPermissionConfig(),
    ltx: createDefaultPermissionConfig(),
    wan: createDefaultPermissionConfig(),
    seedance: createDefaultPermissionConfig(),
    hailuo: createDefaultPermissionConfig(),
    veo31: createDefaultPermissionConfig(),
    kling25: createDefaultPermissionConfig(),
    seedance2: createDefaultPermissionConfig(),
    imageGen: createDefaultPermissionConfig(),
    videoUpscale: createDefaultPermissionConfig(),
    backgroundRemoval: createDefaultPermissionConfig(),
    elevenLabs: createDefaultPermissionConfig(),
    elevenLabsMusic: createDefaultPermissionConfig(),
    googleLyria: createDefaultPermissionConfig(),
    unsplash: createDefaultPermissionConfig(),
    googleTts: createDefaultPermissionConfig(),
    googleImageGen: createDefaultPermissionConfig(),
    openaiTts: createDefaultPermissionConfig(),
    geminiTts: createDefaultPermissionConfig(),
    falMusic: createDefaultPermissionConfig(),
    freesound: { ...createDefaultPermissionConfig(), mode: 'always_allow' },
    pixabay: { ...createDefaultPermissionConfig(), mode: 'always_allow' },
    falAvatar: createDefaultPermissionConfig(),
  }
}

// ── Cost estimates ──────────────────────────────────────────────────────────

export const API_COST_ESTIMATES: Record<string, string> = {
  heygen: '~$0.10–$1.00 per video',
  veo3: '~$0.50–$2.00 per clip',
  kling: '~$0.40–$0.55 per clip',
  runway: '~$0.70–$1.20 per clip',
  ltx: '~$0.06/s (LTX 2.3, 1080p)',
  wan: '~$0.20 per clip',
  seedance: '~$0.30/s (Seedance, 720p)',
  hailuo: '~$0.28 per clip (Hailuo / MiniMax)',
  veo31: '~$1.00 + ~$0.20/s (Veo 3.1)',
  kling25: '~$0.35 + ~$0.07/s (Kling 2.5 Turbo)',
  seedance2: '~$0.30/s (Seedance 2.0 Pro, 720p)',
  imageGen: '~$0.04–$0.08 per image (FAL: flux/seedream/gpt-image/nano-banana)',
  'imageGen:flux-1.1-pro': '~$0.05',
  'imageGen:flux-schnell': '~$0.003',
  'imageGen:ideogram-v3': '~$0.08',
  'imageGen:recraft-v3': '~$0.04',
  'imageGen:stable-diffusion-3': '~$0.03',
  'imageGen:dall-e-3': '~$0.17 (OpenAI gpt-image-1)',
  videoUpscale: '~$0.15–$0.30 per clip (2×/4×)',
  backgroundRemoval: '~$0.01',
  elevenLabs: '~$0.01–$0.10 per segment',
  elevenLabsMusic: '~$0.40 per clip (~$0.80/min)',
  googleLyria: '~$0.06–$0.10 per 30s clip',
  googleTts: '~$0.004 per 100 chars',
  googleImageGen: '~$0.02–$0.04 per image',
  openaiTts: '~$0.015-0.030/1K chars',
  geminiTts: '~$0.01-0.02/1K chars',
  falMusic: '~$0.05 per clip (Stable Audio)',
  freesound: 'Free (CC licensed)',
  pixabay: 'Free (royalty-free)',
  falAvatar: '~$0.04–$0.15 per scene',
}

// ── Scalar cost estimates (USD) ─────────────────────────────────────────────
//
// Parallel to API_COST_ESTIMATES (display strings) but numeric so the cost
// approval gate can compare against thresholds. Picked to approximate the
// midpoint of each public pricing range as of 2026-04. Override via
// `estimateApiCostUsd()` when args are known (duration, resolution, length).

interface CostScalar {
  /** Typical per-call cost in USD. */
  perCall: number
  /** If set, cost scales with this arg. e.g. `{ perSecond: 0.5 }` for video. */
  perSecond?: number
  /** If set, cost scales per 1000 characters of text (TTS). */
  per1KChars?: number
}

export const API_COST_SCALARS: Record<APIName, CostScalar> = {
  heygen: { perCall: 0.5 },
  veo3: { perCall: 1.25, perSecond: 0.2 },
  kling: { perCall: 0.45, perSecond: 0.09 },
  runway: { perCall: 0.9, perSecond: 0.18 },
  // fal video breadth — verified against fal model pages (2026-06).
  ltx: { perCall: 0.06, perSecond: 0.06 }, // LTX 2.3 ~$0.06/s (1080p)
  wan: { perCall: 0.2, perSecond: 0.04 }, // Wan — estimate (page lists no per-s)
  seedance: { perCall: 0.3, perSecond: 0.3 }, // Seedance ~$0.30/s (720p)
  hailuo: { perCall: 0.28 }, // Hailuo / MiniMax ~$0.28 flat per clip (no per-second)
  // Frontier video breadth (fal-hosted) — own billing identity so spend gates per model.
  veo31: { perCall: 1.0, perSecond: 0.2 }, // Veo 3.1 — mirrors Veo 3 pricing
  kling25: { perCall: 0.35, perSecond: 0.07 }, // Kling 2.5 Turbo — slightly under Kling 2.1
  seedance2: { perCall: 0.3, perSecond: 0.3 }, // Seedance 2.0 Pro ~$0.30/s (mirrors 1.0 Pro)
  imageGen: { perCall: 0.04 },
  // Tier 3: video upscale base cost (2×). 4× is scaled to 2x this in startVideo. Flat per-call, NOT
  // per-second — a durationless post-process; duration must never be a billing lever for it.
  videoUpscale: { perCall: 0.15 },
  backgroundRemoval: { perCall: 0.01 },
  elevenLabs: { perCall: 0.06, per1KChars: 0.3 },
  // ElevenLabs Music ~$0.80/min → ~$0.40 for a typical 30s clip. Flat estimate for the cap;
  // the gate's estimateApiCostUsd only sees {prompt}, not duration, so per-second is moot here.
  elevenLabsMusic: { perCall: 0.4 },
  // Google Lyria ~$0.06–$0.10 per 30s clip. Flat estimate for the cap (gate sees only {prompt}).
  googleLyria: { perCall: 0.08 },
  unsplash: { perCall: 0 },
  googleTts: { perCall: 0.004, per1KChars: 0.04 },
  googleImageGen: { perCall: 0.03 },
  openaiTts: { perCall: 0.015, per1KChars: 0.022 },
  geminiTts: { perCall: 0.01, per1KChars: 0.015 },
  // fal Stable Audio (music gen) ~$0.05/clip — flat per-call (duration scaling not exposed by fal).
  falMusic: { perCall: 0.05 },
  freesound: { perCall: 0 },
  pixabay: { perCall: 0 },
  falAvatar: { perCall: 0.1 },
}

/** Estimate the USD cost of a single API call, using any `details` we have.
 *  Falls back to `perCall` when args don't refine the estimate.
 *
 *  Per-model precedence: when `details.model` names a catalog model, its row cost is
 *  authoritative — the flat per-API scalar under-priced models (imageGen 4c flat vs flux 5c
 *  / ideogram 8c). A catalog model with an UNKNOWN price (perCallCents null) returns
 *  Infinity so the cost gate forces approval (always_ask fail-safe) rather than billing a
 *  guessed-cheap default. Duration/text scaling from the scalar still layers on top. */
export function estimateApiCostUsd(
  api: APIName,
  details?: PermissionRequest['details'] & { textLength?: number },
): number {
  const scalar = API_COST_SCALARS[api]
  const model = details?.model
  if (model) {
    const row = getModelRow(model)
    if (row) {
      if (row.costScalars.perCallCents === null) return Number.POSITIVE_INFINITY // unknown → force ask
      let cost = row.costScalars.perCallCents / 100
      if (scalar?.perSecond && details?.duration && details.duration > 0) {
        cost = Math.max(cost, scalar.perSecond * details.duration)
      }
      if (scalar?.per1KChars) {
        const len = details?.textLength ?? (details?.prompt ? details.prompt.length : 0)
        if (len > 0) cost = Math.max(cost, (scalar.per1KChars * len) / 1000)
      }
      return cost
    }
  }
  if (!scalar) return 0
  let cost = scalar.perCall
  if (scalar.perSecond && details?.duration && details.duration > 0) {
    cost = Math.max(cost, scalar.perSecond * details.duration)
  }
  if (scalar.per1KChars) {
    const len = details?.textLength ?? (details?.prompt ? details.prompt.length : 0)
    if (len > 0) cost = Math.max(cost, (scalar.per1KChars * len) / 1000)
  }
  // Tier 3: video upscale costs ~2× the base at 4×. Scaling HERE (not just in startVideo's reservation)
  // means the cost-approval gate evaluates the SAME amount that gets reserved + committed — otherwise a
  // 4× upscale could auto-allow under a threshold it should have asked/denied on (the base under-estimate).
  if (api === 'videoUpscale' && details?.upscaleFactor === 4) {
    cost *= 2
  }
  return cost
}

/** Resolve the effective single-call threshold for an API, falling back
 *  from per-API override → project default. `null` or undefined means
 *  "no threshold — never upgrade auto-allow to ask on cost alone". */
export function resolveCostThreshold(
  config: PermissionConfig,
  projectDefault: number | null = DEFAULT_SINGLE_CALL_COST_THRESHOLD_USD,
): number | null {
  if (config.singleCallCostThreshold !== undefined && config.singleCallCostThreshold !== null) {
    return config.singleCallCostThreshold
  }
  return projectDefault
}

export const API_DISPLAY_NAMES: Record<APIName, string> = {
  heygen: 'HeyGen Avatars',
  veo3: 'Veo 3 Video',
  kling: 'Kling 2.1 Video',
  runway: 'Runway Gen-4 Video',
  ltx: 'LTX Video (FAL)',
  wan: 'Wan Video (FAL)',
  seedance: 'Seedance Video (FAL)',
  hailuo: 'Hailuo / MiniMax (FAL)',
  veo31: 'Veo 3.1 (FAL)',
  kling25: 'Kling 2.5 Turbo (FAL)',
  seedance2: 'Seedance 2.0 Pro (FAL)',
  imageGen: 'Image Generation (FAL)',
  videoUpscale: 'Video Upscale (Super-Resolution)',
  backgroundRemoval: 'Background Removal',
  elevenLabs: 'ElevenLabs TTS',
  elevenLabsMusic: 'ElevenLabs Music',
  googleLyria: 'Google Lyria (Music)',
  unsplash: 'Unsplash Images',
  googleTts: 'Google Cloud TTS',
  googleImageGen: 'Imagen (Google)',
  openaiTts: 'OpenAI TTS',
  geminiTts: 'Gemini TTS',
  falMusic: 'Music Generation (Stable Audio / FAL)',
  freesound: 'Freesound',
  pixabay: 'Pixabay',
  falAvatar: 'Avatar Generation (FAL)',
}

// ── Permission check (synchronous, for auto-modes) ─────────────────────────

export type PermissionCheckResult =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; request: PermissionRequest }

export interface CheckPermissionExtras {
  /** Scalar cost estimate in USD. Used to evaluate the per-API or project
   *  single-call threshold. If omitted, the cost gate is a no-op. */
  estimatedCostUsd?: number
  /** Project-level default threshold. Overrides the built-in $0.50 when set. */
  projectCostThreshold?: number | null
}

/**
 * Per-provider spend-cap check, shared by `checkPermission` and the agentRunMode
 * posture path in tool-executor. Returns a deny reason if a session or monthly
 * cap is already reached, else null. Spend caps apply in EVERY mode/posture —
 * Auto must never blow past a cap the user deliberately set.
 */
export function spendCapExceeded(config: PermissionConfig): string | null {
  if (config.sessionLimit !== null && config.sessionSpend >= config.sessionLimit) {
    return `Session spend limit reached ($${config.sessionSpend.toFixed(2)} / $${config.sessionLimit.toFixed(2)})`
  }
  if (config.monthlyLimit !== null && config.monthlySpend >= config.monthlyLimit) {
    return `Monthly spend limit reached ($${config.monthlySpend.toFixed(2)} / $${config.monthlyLimit.toFixed(2)})`
  }
  return null
}

export function checkPermission(
  permissions: APIPermissions,
  api: APIName,
  estimatedCost: string,
  reason: string,
  details: PermissionRequest['details'],
  sessionPermissions: Map<string, string>,
  extras?: CheckPermissionExtras,
): PermissionCheckResult {
  // Backfill: projects written before a new APIName was added (e.g. kling,
  // runway) have `permissions[api] === undefined`. Treat those
  // as always_ask defaults so the call goes through a user prompt rather
  // than crashing with `config.mode` on undefined.
  const config = permissions[api] ?? createDefaultPermissionConfig()

  // Check spend limits
  const capReason = spendCapExceeded(config)
  if (capReason) return { action: 'deny', reason: capReason }

  // Resolve the effective decision from mode + session history. Free APIs
  // (cost scalar == 0) always skip the cost gate.
  const threshold = resolveCostThreshold(config, extras?.projectCostThreshold)
  const estimate = extras?.estimatedCostUsd ?? 0
  const wouldExceedThreshold = threshold !== null && estimate > threshold

  let autoDecision: 'allow' | 'deny' | 'ask' = 'ask'
  switch (config.mode) {
    case 'always_allow':
      autoDecision = 'allow'
      break
    case 'always_deny':
      return { action: 'deny', reason: `${API_DISPLAY_NAMES[api]} is disabled in project settings.` }
    case 'ask_once': {
      const sessionDecision = sessionPermissions.get(api)
      if (sessionDecision === 'allow') autoDecision = 'allow'
      else if (sessionDecision === 'deny') return { action: 'deny', reason: 'Previously denied this session.' }
      // else fall through to ask
      break
    }
    case 'always_ask':
    default:
      autoDecision = 'ask'
      break
  }

  // Upgrade auto-allow to ask when the scalar estimate exceeds the threshold.
  // This is the cost approval gate — it catches expensive single calls even
  // when the user has granted a blanket "always_allow" for an API.
  const costTriggered = autoDecision === 'allow' && wouldExceedThreshold

  if (autoDecision === 'allow' && !costTriggered) return { action: 'allow' }

  // Need to ask the user
  const request: PermissionRequest = {
    id: crypto.randomUUID(),
    api,
    estimatedCost,
    estimatedCostUsd: extras?.estimatedCostUsd,
    costThresholdExceeded: costTriggered,
    reason: costTriggered
      ? `${reason} — estimated $${estimate.toFixed(2)} exceeds the $${threshold?.toFixed(2)} single-call approval threshold.`
      : reason,
    details,
  }
  return { action: 'ask', request }
}
