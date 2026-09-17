/**
 * Scene-code generation service.
 *
 * Thin wrappers over `src/lib/generation/generate.ts` `generateCode()` that
 * normalize the response shape per scene type. The Electron IPC handlers
 * and agent tool handlers call these functions rather than fetching each other.
 * tool handlers all call these functions rather than fetching each other.
 *
 * The underlying `generateCode()` already supports Anthropic, OpenAI,
 * Google, and local (Ollama) providers — routing happens in there based
 * on `modelId` + `modelConfigs`.
 *
 * Only the canvas variant is exposed today; motion/three/react/lottie/zdog
 * extract in follow-up commits.
 */

import { generateCode, completeText, resolveTextModel, type GenerateCodeOptions } from '@/lib/generation/generate'
import type { ModelConfig } from '@/lib/agents/model-config'
import { LOTTIE_OVERLAY_PROMPT } from '@/lib/generation/prompts'
import { validateLottieJSON } from '@/lib/motion/lottie-validator'
import { scoreLottieQuality } from '@/lib/motion/quality-score'
import { createLogger } from '@/lib/logger'

const log = createLogger('generation')
import type { MotionPersonality } from '@/lib/motion/easing'
import type { APIName } from '@/lib/types/permissions'

export type UsageShape = {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

export interface GenerateCanvasInput {
  prompt: string
  palette?: string[]
  bgColor?: string
  duration?: number
  previousSummary?: string
  modelId?: GenerateCodeOptions['modelId']
  modelConfigs?: GenerateCodeOptions['modelConfigs']
}

export interface GenerateCanvasResult {
  result: string
  usage: UsageShape
  truncated?: boolean
}

/**
 * Canvas2D scene code. Returns raw JS code as a string — no JSON parsing,
 * no structured fields. Returns `{ result: string, usage }`.
 */
export async function generateCanvas(input: GenerateCanvasInput): Promise<GenerateCanvasResult> {
  if (!input.prompt) {
    throw new GenerationValidationError('prompt is required')
  }
  const gen = await generateCode('canvas2d', input.prompt, {
    palette: input.palette,
    bgColor: input.bgColor,
    duration: input.duration,
    previousSummary: input.previousSummary,
    modelId: input.modelId,
    modelConfigs: input.modelConfigs,
  })
  return { result: gen.code, usage: gen.usage, truncated: gen.truncated }
}

// ── Motion ─────────────────────────────────────────────────────────────────

export interface GenerateMotionInput extends GenerateCanvasInput {
  font?: string
}

export interface GenerateMotionResult {
  result: { sceneCode: string; styles?: unknown; htmlContent?: unknown }
  usage: UsageShape
  truncated?: boolean
}

export async function generateMotion(input: GenerateMotionInput): Promise<GenerateMotionResult> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')
  const gen = await generateCode('motion', input.prompt, {
    palette: input.palette,
    bgColor: input.bgColor,
    duration: input.duration,
    previousSummary: input.previousSummary,
    font: input.font,
    modelId: input.modelId,
    modelConfigs: input.modelConfigs,
  })
  return {
    result: { sceneCode: gen.code, styles: gen.styles, htmlContent: gen.htmlContent },
    usage: gen.usage,
    truncated: gen.truncated,
  }
}

// ── Three ──────────────────────────────────────────────────────────────────

export interface GenerateThreeInput extends GenerateCanvasInput {}

export interface GenerateThreeResult {
  result: { sceneCode: string }
  usage: UsageShape
  truncated?: boolean
}

export async function generateThree(input: GenerateThreeInput): Promise<GenerateThreeResult> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')
  const gen = await generateCode('three', input.prompt, {
    palette: input.palette,
    bgColor: input.bgColor,
    duration: input.duration,
    previousSummary: input.previousSummary,
    modelId: input.modelId,
    modelConfigs: input.modelConfigs,
  })
  return { result: { sceneCode: gen.code }, usage: gen.usage, truncated: gen.truncated }
}

// ── React ──────────────────────────────────────────────────────────────────

export interface GenerateReactInput extends GenerateMotionInput {}

export interface GenerateReactResult {
  result: { sceneCode: string; styles?: unknown }
  usage: UsageShape
  truncated?: boolean
}

export async function generateReact(input: GenerateReactInput): Promise<GenerateReactResult> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')
  const gen = await generateCode('react', input.prompt, {
    palette: input.palette,
    bgColor: input.bgColor,
    duration: input.duration,
    previousSummary: input.previousSummary,
    font: input.font,
    modelId: input.modelId,
    modelConfigs: input.modelConfigs,
  })
  return { result: { sceneCode: gen.code, styles: gen.styles }, usage: gen.usage, truncated: gen.truncated }
}

// ── D3 data visualization ──────────────────────────────────────────────────

export interface GenerateD3Input {
  prompt: string
  palette?: string[]
  font?: string
  bgColor?: string
  duration?: number
  previousSummary?: string
  d3Data?: unknown
}

export interface GenerateD3Result {
  result: {
    chartLayers: unknown[]
    sceneCode: string
    d3Data: unknown
    styles: unknown
    suggestedData: unknown
  }
  usage: UsageShape
}

export async function generateD3(input: GenerateD3Input): Promise<GenerateD3Result> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  const { runStructuredD3Generation } = await import('@/lib/generation/d3-structured-run')

  const out = await runStructuredD3Generation({
    prompt: input.prompt,
    palette: input.palette ?? ['#1a1a2e', '#e84545', '#16a34a', '#2563eb'],
    font: input.font ?? 'Caveat',
    bgColor: input.bgColor ?? '#fffef9',
    duration: input.duration ?? 8,
    previousSummary: input.previousSummary ?? '',
    d3Data: input.d3Data,
  })
  const costUsd = (out.usage.input_tokens / 1_000_000) * 3 + (out.usage.output_tokens / 1_000_000) * 15
  return {
    result: {
      chartLayers: out.chartLayers,
      sceneCode: out.sceneCode,
      d3Data: out.d3Data,
      styles: out.styles,
      suggestedData: out.d3Data,
    },
    usage: { input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens, cost_usd: costUsd },
  }
}

// ── Lottie overlay ─────────────────────────────────────────────────────────
// Different shape from canvas/motion/three/react — goes straight to
// Anthropic (no `generateCode` wrapper) because it needs motionPersonality
// in the system prompt + post-generation validation + quality scoring.

export interface GenerateLottieInput {
  prompt: string
  palette?: string[]
  font?: string
  duration?: number
  previousSummary?: string
  motionPersonality?: MotionPersonality
  modelId?: string
  modelConfigs?: { id?: string; modelId?: string; endpoint?: string; localModelName?: string }[]
}

export interface GenerateLottieResult {
  result: string
  usage: UsageShape
  quality: { score: number; dimensions: unknown; suggestions: unknown }
  fixCount?: number
}

export class LottieParseError extends Error {
  readonly code = 'LOTTIE_PARSE' as const
  constructor(
    message: string,
    public readonly usage: UsageShape,
  ) {
    super(message)
    this.name = 'LottieParseError'
  }
}

export async function generateLottie(input: GenerateLottieInput): Promise<GenerateLottieResult> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')

  const palette = input.palette ?? ['#1a1a2e', '#e84545', '#16a34a', '#2563eb']
  const font = input.font ?? 'Caveat'
  const duration = input.duration ?? 8
  const motionPersonality = input.motionPersonality ?? 'corporate'

  const systemPrompt = LOTTIE_OVERLAY_PROMPT(
    palette,
    font,
    duration,
    input.previousSummary ?? '',
    true,
    undefined,
    motionPersonality,
  )

  const model = resolveTextModel(input.modelId, 'auto', input.modelConfigs as ModelConfig[] | undefined)
  const completion = await completeText(
    model,
    systemPrompt,
    input.prompt,
    8192,
    input.modelConfigs as ModelConfig[] | undefined,
  )
  const text = completion.raw
  const usage: UsageShape = {
    input_tokens: completion.inputTokens,
    output_tokens: completion.outputTokens,
    cost_usd: completion.costUsd,
  }

  let cleaned: string
  let parsed: Record<string, unknown>
  try {
    cleaned = text
      .replace(/^```json\s*/, '')
      .replace(/```\s*$/, '')
      .trim()
    parsed = JSON.parse(cleaned)
  } catch {
    log.error('generate-lottie: model returned invalid JSON', { extra: { sample: text.slice(0, 200) } })
    throw new LottieParseError('Model returned invalid Lottie JSON. Please try again.', usage)
  }

  const validation = validateLottieJSON(parsed, { fix: true })
  if (validation.warnings.length > 0) {
    log.warn('generate-lottie: validation warnings', {
      extra: { count: validation.warnings.length, warnings: validation.warnings },
    })
  }
  if (!validation.valid) {
    log.error('generate-lottie: validation errors after auto-fix', { extra: { errors: validation.errors } })
  }

  const finalJson = validation.fixCount > 0 ? validation.fixed! : parsed
  const resultJson = validation.fixCount > 0 ? JSON.stringify(finalJson) : cleaned

  const quality = scoreLottieQuality(finalJson, {
    personality: motionPersonality,
    expectedDuration: duration,
  })
  if (quality.total < 40) {
    log.warn('generate-lottie: low quality score', {
      extra: { score: quality.total, suggestions: quality.suggestions },
    })
  }

  return {
    result: resultJson,
    usage,
    quality: { score: quality.total, dimensions: quality.dimensions, suggestions: quality.suggestions },
    ...(validation.fixCount > 0 && { fixCount: validation.fixCount }),
  }
}

// ── SVG main + enhance + summarize + edit ──────────────────────────────────
// SVG generation has four modes (main / enhance / summarize / edit).
// Each is its own service function so callers don't have to juggle body
// flags. All route through the provider-agnostic `completeText` (Anthropic /
// OpenAI / Google / DeepSeek / Qwen / Kimi / local Ollama); `resolveTextModel`
// picks a default that respects which provider keys exist, so a
// DeepSeek/Qwen/Kimi-only setup works instead of dead-ending on Anthropic.

type ModelConfigLike = { id?: string; modelId?: string; endpoint?: string; localModelName?: string }

export interface GenerateSvgInput {
  prompt: string
  palette?: string[]
  strokeWidth?: number
  font?: string
  duration?: number
  previousSummary?: string
  modelId?: string
  modelConfigs?: ModelConfigLike[]
}

export async function generateSvg(input: GenerateSvgInput): Promise<{ result: string; usage: UsageShape }> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')

  const { SVG_SYSTEM_PROMPT } = await import('@/lib/generation/prompts')
  const systemPrompt = SVG_SYSTEM_PROMPT(
    input.palette ?? ['#1a1a2e', '#16213e', '#0f3460', '#e94560'],
    input.strokeWidth ?? 2,
    input.font ?? 'Caveat',
    input.duration ?? 8,
    input.previousSummary ?? '',
  )
  const model = resolveTextModel(input.modelId, 'auto', input.modelConfigs as ModelConfig[] | undefined)
  const c = await completeText(model, systemPrompt, input.prompt, 8192, input.modelConfigs as ModelConfig[] | undefined)
  return {
    result: c.raw,
    usage: { input_tokens: c.inputTokens, output_tokens: c.outputTokens, cost_usd: c.costUsd },
  }
}

export interface EnhancePromptInput {
  prompt: string
  modelId?: string
  modelConfigs?: ModelConfigLike[]
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<{ result: string; usage: UsageShape }> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')
  const { ENHANCE_SYSTEM_PROMPT } = await import('@/lib/generation/prompts')
  const userContent = `Enhance this scene description: "${input.prompt}"`

  const model = resolveTextModel(input.modelId, 'auto', input.modelConfigs as ModelConfig[] | undefined)
  const c = await completeText(
    model,
    ENHANCE_SYSTEM_PROMPT,
    userContent,
    512,
    input.modelConfigs as ModelConfig[] | undefined,
  )
  return {
    result: c.raw,
    usage: { input_tokens: c.inputTokens, output_tokens: c.outputTokens, cost_usd: c.costUsd },
  }
}

export interface SummarizeSceneInput {
  prompt: string
  svgContent?: string
  modelId?: string
  modelConfigs?: ModelConfigLike[]
}

export async function summarizeScene(input: SummarizeSceneInput): Promise<{ result: string }> {
  const { SUMMARY_SYSTEM_PROMPT } = await import('@/lib/generation/prompts')
  const svgSnippet = (input.svgContent ?? '').slice(0, 2000)
  const userContent = `Original prompt: "${input.prompt ?? ''}"\n\nSVG content (truncated): ${svgSnippet}`

  // 'budget' tier — summarization is a cheap task (was Haiku).
  const model = resolveTextModel(input.modelId, 'budget', input.modelConfigs as ModelConfig[] | undefined)
  const c = await completeText(
    model,
    SUMMARY_SYSTEM_PROMPT,
    userContent,
    200,
    input.modelConfigs as ModelConfig[] | undefined,
  )
  return { result: c.raw }
}

export interface EditSvgInput {
  svgContent: string
  editInstruction: string
  modelId?: string
  modelConfigs?: ModelConfigLike[]
}

export async function editSvg(input: EditSvgInput): Promise<{ result: string; usage: UsageShape }> {
  if (!input.svgContent || !input.editInstruction) {
    throw new GenerationValidationError('svgContent and editInstruction required')
  }
  const { EDIT_SYSTEM_PROMPT } = await import('@/lib/generation/prompts')
  const userContent = `EXISTING SVG:\n${input.svgContent}\n\nEDIT INSTRUCTION:\n${input.editInstruction}`

  const model = resolveTextModel(input.modelId, 'auto', input.modelConfigs as ModelConfig[] | undefined)
  const c = await completeText(
    model,
    EDIT_SYSTEM_PROMPT,
    userContent,
    8192,
    input.modelConfigs as ModelConfig[] | undefined,
  )
  return {
    result: c.raw,
    usage: { input_tokens: c.inputTokens, output_tokens: c.outputTokens, cost_usd: c.costUsd },
  }
}

// ── Avatar / video status polling ──────────────────────────────────────────
// These are GET endpoints today. The renderer polls every 15s until the
// underlying async job completes; moving them to IPC keeps packaged Electron
// from hitting localhost for polling.

export interface StartHeygenAvatarInput {
  projectId?: string
  sceneId?: string
  layerId?: string
  avatarId: string
  voiceId: string
  script: string
  width?: number
  height?: number
  bgColor?: string
}

export interface StartHeygenAvatarResult {
  videoId: string
  estimatedSeconds: number
  estimatedCost: number
  sceneId?: string
  layerId?: string
}

/**
 * Kick off a HeyGen avatar video.
 * Returns immediately — callers poll via `pollHeygenStatus`.
 * Shared by the Electron IPC handler and agent tools so every caller sees
 * the same error strings + spend logging.
 */
export async function startHeygenAvatar(input: StartHeygenAvatarInput): Promise<StartHeygenAvatarResult> {
  if (!input.avatarId || !input.voiceId || !input.script) {
    throw new GenerationValidationError('avatarId, voiceId, and script are required')
  }
  if (!process.env.HEYGEN_API_KEY) {
    throw new GenerationValidationError('HEYGEN_API_KEY not configured')
  }
  const { generateAvatarVideo } = await import('@/lib/apis/heygen')
  const { logSpend } = await import('@/lib/db')

  const { videoId, estimatedSeconds } = await generateAvatarVideo({
    avatarId: input.avatarId,
    voiceId: input.voiceId,
    script: input.script,
    width: input.width,
    height: input.height,
    bgColor: input.bgColor,
  })
  const estimatedCost = estimatedSeconds * 0.01
  if (input.projectId) {
    await logSpend(input.projectId, 'heygen', estimatedCost, `Avatar ${input.avatarId}: ${input.script.slice(0, 80)}`)
  }
  return {
    videoId,
    estimatedSeconds,
    estimatedCost,
    sceneId: input.sceneId,
    layerId: input.layerId,
  }
}

export interface StartVideoInput {
  projectId?: string
  sceneId?: string
  layerId?: string
  provider?: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  duration?: number
  seed?: number
  /** Optional camera/motion spec. Compiled into the prompt for camera:'prompt' models. */
  camera?: import('@/lib/media/camera').CameraSpec
  /** Optional cinematic optics (focal length, aperture/DoF, lens, film stock). Compiled into the
   *  prompt alongside the camera clause. See src/lib/media/optics.ts. */
  optics?: import('@/lib/media/optics').OpticsSpec
  /**
   * Tier 2 (#8): a VFX effect preset id (see src/lib/media/effects.ts) — explosion / bullet-time / glitch /
   * etc. Compiled into the prompt (VFX fragment + the preset's bundled camera move) and folded into
   * the cache hash. Prompt-only, so it applies to any video model (no capability gate).
   */
  effect?: string
  /**
   * Optional conditioning image (image-to-video). A fetchable URL or app reference. Routes an
   * i2v-capable provider to its image-to-video endpoint. Folded into the cache hash so an i2v
   * request never serves a cached t2v clip (and vice versa).
   */
  imageUrl?: string
  /**
   * Tier 2 (#5) keyframes: the END / tail frame (a fetchable URL or app reference). With `imageUrl`
   * as the START frame, routes a keyframe-capable provider to its start+end endpoint. Requires
   * `imageUrl`. Enforced here against the model's `capabilities.keyframes` — a model without it is
   * rejected (never silently downgraded). Folded into the cache hash.
   */
  endImageUrl?: string
  /**
   * Tier 2 (#5) extend: a source clip to continue (a fetchable URL or app reference; trust-guarded
   * as VIDEO). Routes an extend-capable provider to its video→video endpoint. Enforced against
   * `capabilities.extend`. Folded into the cache hash.
   */
  extendVideoUrl?: string
  /**
   * Tier 2 (#4) video→video / Aleph: a source clip to TRANSFORM in place (a fetchable URL or app
   * reference; trust-guarded as VIDEO). Routes a v2v-capable provider to its edit endpoint. Enforced
   * against `capabilities.videoToVideo`. Folded into the cache hash.
   */
  editVideoUrl?: string
  /**
   * Tier 2 (#4) the edit operation (restyle/relight/add-object/remove-object/new-angle/replace-bg).
   * With `editVideoUrl`, the operation frames `prompt` into the edit instruction sent to the v2v
   * model (see src/lib/media/video-edit.ts). Folded into the cache hash so a different operation on the
   * same clip+prompt is a distinct cached result.
   */
  edit?: import('@/lib/media/video-edit').VideoEditSpec
  /**
   * Tier 2 (#6) performance capture (Act-Two): a DRIVING video whose motion drives the character in
   * `imageUrl`. Requires `imageUrl`. Enforced against `capabilities.performanceCapture`. In the cache hash.
   */
  drivingVideoUrl?: string
  /**
   * Tier 3 (breadth) video upscale: a source clip to upres (a fetchable URL or app reference,
   * trust-guarded as VIDEO). Routes an upscale-capable provider to its super-resolution endpoint.
   * Enforced against `capabilities.videoUpscale`. No prompt applies. Folded into the cache hash.
   */
  upscaleVideoUrl?: string
  /** Tier 3: upscale multiplier (2× or 4×); defaults to 2. Only meaningful with `upscaleVideoUrl`. */
  upscaleFactor?: 2 | 4
  /**
   * Skip startVideo's OWN project-row permission gate. Set by callers that already ran an
   * equivalent gate (the agent tool handler runs the world-based checkApiPermission +
   * enrichPermission UX) — avoids double-gating / a second divergent policy read. The
   * start-cache, reservation, provider call, and durable job row still run. Default false.
   */
  skipPermissionGate?: boolean
  /** The user approved this 'ask' in the always-ask modal — proceed past the prompt (never past a
   *  'deny'). Set by the renderer when re-dispatching after approval. */
  approvedAsk?: boolean
}

export interface StartVideoResult {
  operationName: string
  enhancedPrompt: string
  estimatedCost: number
  provider: string
  reservationId: string | null
  projectId?: string
  sceneId?: string
  layerId?: string
  /** Permission gate — present when the call was blocked by project policy. */
  permissionNeeded?: {
    api: string
    estimatedCost: string
    estimatedCostUsd: number
    costThresholdExceeded?: boolean
    reason?: string
    details: Record<string, unknown>
  }
  error?: string
}

/**
 * Kick off a text-to-video generation (Veo3 / Kling / Runway). Returns the
 * permission-gate block in the
 * result when the project's settings would deny or require approval —
 * callers should handle `permissionNeeded` rather than treating the
 * resolution as success.
 */
export async function startVideo(input: StartVideoInput): Promise<StartVideoResult> {
  // Upscale is a pure post-process (source clip → upres) with no prompt; every other mode needs one.
  if (!input.prompt && !input.upscaleVideoUrl) throw new GenerationValidationError('Prompt is required')

  const { firstConfiguredVideoProvider, getVideoProvider } = await import('@/lib/apis/video/registry')
  const {
    API_COST_ESTIMATES,
    API_DISPLAY_NAMES,
    checkPermission,
    createDefaultAPIPermissions,
    createDefaultPermissionConfig,
    estimateApiCostUsd,
  } = await import('@/lib/permissions')
  const { reserveSpend } = await import('@/lib/agents/budget-tracker')
  const { db, getProjectApiSpend } = await import('@/lib/db')
  const { projects: projectsTable } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')

  // Provider resolution
  let provider: ReturnType<typeof getVideoProvider> | null = null
  if (!input.provider || input.provider === 'auto') {
    provider = firstConfiguredVideoProvider()
    if (!provider) {
      throw new GenerationValidationError(
        'No video provider configured. Add GOOGLE_AI_KEY, FAL_KEY, or RUNWAY_API_KEY.',
      )
    }
  } else {
    provider = getVideoProvider(input.provider)
    if (!provider) throw new GenerationValidationError(`Unknown video provider: ${input.provider}`)
    if (!process.env[provider.envKey]) {
      throw new GenerationValidationError(
        `${provider.name} not configured — set ${provider.envKey} or pick a different provider.`,
      )
    }
  }

  // Tier 3: an upscale is a post-process, not a generation. It gets its OWN billing/permission
  // identity ('videoUpscale') regardless of which fal provider carries the routing — the upscaler is
  // ONE shared, model-agnostic endpoint, so keying permission/cost/spend on the generation provider
  // would let a caller run the same paid Topaz job under any allowed generation bucket (and bill it by
  // a fake duration). Resolved once here; the permission gate, reservation, cache, and commit all read
  // it instead of provider.id when upscaling.
  const isUpscale = !!input.upscaleVideoUrl
  // Every video provider id is also an APIName (permission + cost gate key). Narrow to it so
  // the new fal models (ltx/wan/seedance) are gated + reserved like veo3/kling/runway — not
  // silently skipped (which would bypass the cost cap).
  const VIDEO_APIS = [
    'veo3',
    'kling',
    'runway',
    'ltx',
    'wan',
    'seedance',
    'hailuo',
    'veo31',
    'kling25',
    'seedance2',
  ] as const
  const api: APIName | null = isUpscale
    ? 'videoUpscale'
    : (VIDEO_APIS as readonly string[]).includes(provider.id)
      ? (provider.id as (typeof VIDEO_APIS)[number])
      : null
  const aspectRatio = input.aspectRatio ?? '16:9'

  // Tier 2 (#5): enforce keyframe/extend capability + lift the duration cap per-model. The catalog
  // row backs the provider's real endpoints (capability ⟺ a configured slug). ENFORCING here — not
  // just in the composer — is the Tier 1 lesson: a direct IPC/agent/MCP caller would otherwise reach
  // a provider that silently ignores the input (or downgrades) and bill for the wrong clip. startVideo
  // is the single choke point every caller passes through, so this gate covers all of them.
  const { modelsForProvider, clampVideoDuration } = await import('@/lib/media/model-catalog')
  const videoRow = modelsForProvider(provider.id).find((r) => r.modality === 'video')
  if (input.endImageUrl) {
    if (!videoRow?.capabilities.keyframes) {
      throw new GenerationValidationError(
        `${provider.name} does not support start/end keyframes — pick a keyframe-capable model.`,
      )
    }
    if (!input.imageUrl) {
      throw new GenerationValidationError(
        'Keyframe generation requires a start frame (imageUrl) as well as the end frame.',
      )
    }
  }
  if (input.extendVideoUrl && !videoRow?.capabilities.extend) {
    throw new GenerationValidationError(
      `${provider.name} does not support extending a clip — pick an extend-capable model.`,
    )
  }
  // Tier 2 (#4): enforce in-video edit (v2v / Aleph) capability the same way.
  if (input.editVideoUrl && !videoRow?.capabilities.videoToVideo) {
    throw new GenerationValidationError(
      `${provider.name} does not support in-video editing (video→video) — pick a v2v-capable model like Runway.`,
    )
  }
  // Tier 2 (#6): enforce performance capture (Act-Two) — needs the capability AND a character image.
  if (input.drivingVideoUrl) {
    if (!videoRow?.capabilities.performanceCapture) {
      throw new GenerationValidationError(
        `${provider.name} does not support performance capture (Act-Two) — pick a capable model like Runway.`,
      )
    }
    if (!input.imageUrl) {
      throw new GenerationValidationError(
        'Performance capture requires a character image (imageUrl) to drive with the performance video.',
      )
    }
  }
  // Tier 3 (breadth): enforce video upscale the same way — capability ⟺ a configured upscale slug.
  if (input.upscaleVideoUrl && !videoRow?.capabilities.videoUpscale) {
    throw new GenerationValidationError(
      `${provider.name} does not support video upscale — pick an upscale-capable model like Kling, LTX, Wan, or Seedance.`,
    )
  }
  // The advanced modes are MUTUALLY EXCLUSIVE: each routes to a different provider endpoint, and the
  // route cascade would otherwise silently drop the others — fal would run one mode while Runway ran
  // another for the same request (a provider-dependent bill/result). Reject an ambiguous combination
  // loudly instead. (imageUrl alone = i2v, or imageUrl+endImageUrl = keyframe, are fine.)
  const advancedModes = [
    input.endImageUrl && 'keyframe',
    input.extendVideoUrl && 'extend',
    input.editVideoUrl && 'edit',
    input.drivingVideoUrl && 'performance-capture',
    input.upscaleVideoUrl && 'upscale',
  ].filter(Boolean) as string[]
  if (advancedModes.length > 1) {
    throw new GenerationValidationError(
      `Pick only one of keyframe / extend / edit / performance-capture / upscale per generation (got ${advancedModes.join(' + ')}).`,
    )
  }
  // Tier 2 (#4): an edit needs a VALID operation. The tool/MCP boundary casts the operation from
  // arbitrary args, so a missing/garbage op would otherwise compile to '' and silently route to the
  // paid v2v endpoint with the un-framed base prompt — fail loud here instead (the codebase's own
  // "never silently bill for an ignored input" rule).
  if (input.editVideoUrl) {
    const { isVideoEditOperation } = await import('@/lib/media/video-edit')
    if (!isVideoEditOperation(input.edit?.operation)) {
      throw new GenerationValidationError(
        'In-video editing requires a valid edit operation: restyle | relight | add-object | remove-object | new-angle | replace-bg.',
      )
    }
  }
  // Per-model duration ceiling (lifts the old global 5/8s cap); fall back to 8 when the catalog has
  // no row for this provider so a misconfig can't grant an unbounded duration. clampVideoDuration
  // also FLOORS at 1 — a bare `Math.min` upper-clamp let a negative duration survive into the cache
  // hash + cost estimate while the provider clamped it up to its 5s minimum (cache/billing drift).
  const maxDuration = videoRow?.capabilities.maxDurationSeconds ?? 8
  const duration = clampVideoDuration(input.duration, maxDuration)

  // Canonical request hash — used to dedupe at start (below) AND to alias the finished clip
  // at completion (pollVideoStatus) so the next identical request hits the start-cache.
  // Camera control: compile the move spec into prompt text for camera:'prompt' models
  // (shared with the agent path via cameraClauseForProvider — one capability-aware fold).
  const { cameraClauseForProvider } = await import('@/lib/media/camera')
  // Tier 2 (#6): performance capture (Act-Two) has no text prompt or camera direction — the driving
  // video supplies the motion. Suppress the camera clause so it neither reaches the provider nor
  // fragments the cache (two camera inputs would otherwise burn separate Act-Two jobs for one request).
  // Tier 3: upscale (like Act-Two) takes no camera direction — the source clip's motion is preserved
  // as-is. Suppress the clause so it neither reaches the provider nor fragments the cache.
  const cameraClause = input.drivingVideoUrl || isUpscale ? '' : cameraClauseForProvider(provider.id, input.camera)
  // Cinematic optics (lens/aperture/film stock): compiled into the prompt like the camera clause, and
  // suppressed on the same no-prompt-direction paths (Act-Two driving video / upscale) so it neither
  // reaches the provider nor fragments the cache.
  const { compileOpticsToPrompt } = await import('@/lib/media/optics')
  const opticsClause = input.drivingVideoUrl || isUpscale ? '' : compileOpticsToPrompt(input.optics)
  // Tier 2 (#8): compile the VFX effect preset's clause (VFX text + the preset's bundled camera move).
  // Normalize the id first: an UNKNOWN id (an agent typo) becomes null, so it neither pretends an
  // effect was applied nor mints a distinct cache key for what is really a no-effect request. Suppress
  // the effect's bundled camera when the user already set one (avoid two contradictory camera clauses).
  const { compileEffect, isEffectId } = await import('@/lib/media/effects')
  // Tier 3: a VFX effect makes no sense on an upscale (pure super-resolution) — drop it so it neither
  // compiles into the (ignored) prompt nor mints a distinct cache key for byte-identical output.
  const effect = isEffectId(input.effect) && !isUpscale ? input.effect : null
  const effectClause = compileEffect(provider.id, effect, { withCamera: !cameraClause })
  // Tier 2 (#4): for an in-video edit, the operation reframes the WHOLE prompt (restyle/relight/...)
  // and that compiled prompt REPLACES the base — camera/effect don't apply to footage you're editing
  // in place. Empty when there's no edit (or no operation), so other modes are unchanged.
  const { editPromptForProvider, effectiveVideoPrompt } = await import('@/lib/media/video-edit')
  const editPrompt = input.editVideoUrl ? editPromptForProvider(provider.id, input.edit, input.prompt) : ''
  // Tier 3: upscale carries no prompt — base '' so effectiveVideoPrompt yields an empty instruction.
  const effectivePrompt = effectiveVideoPrompt({
    basePrompt: input.prompt ?? '',
    editPrompt,
    cameraClause,
    opticsClause,
    effectClause,
  })

  const { computeCacheHash } = await import('@/lib/apis/cache-hash')
  // Tier 3: an upscale's identity is PROVIDER-INDEPENDENT — the upscaler is one shared endpoint, so
  // upscaling clip X at 4× must hit the same cache whether the caller routed via Kling or LTX. Key it
  // on a fixed 'videoUpscale' tag + the resolved upscale slug (not the t2v cacheTag — so a changed
  // FAL_VIDEO_UPSCALE_MODEL busts stale output) + the source clip + factor, and NOTHING else (prompt/
  // camera/effect/duration/aspect/seed are all stripped before the call, so folding them would only
  // let a caller vary an ignored field to dodge dedupe and launch a duplicate paid job).
  const requestHash = isUpscale
    ? computeCacheHash({
        provider: 'videoUpscale',
        model: provider.upscaleCacheTag ?? 'video-upscale',
        upscaleVideoUrl: input.upscaleVideoUrl ?? null,
        upscaleFactor: input.upscaleFactor === 4 ? 4 : 2,
      })
    : computeCacheHash({
        provider: provider.id,
        // cacheTag = the resolved model slug; busts the cache if the provider's underlying model
        // changes (env override) so a different model never serves a stale clip under this hash.
        model: provider.cacheTag ?? provider.id,
        prompt: input.prompt,
        // The COMPILED prompt actually sent to the model (edit framing + camera clause). Folding it in
        // busts the cache when the edit-frame template changes between versions — the operation enum
        // alone wouldn't, so a stale clip could be served under the same prompt+operation (Tier 2 #4).
        effectivePrompt,
        camera: cameraClause, // different camera moves → different cached clip
        effect, // Tier 2 (#8): the NORMALIZED preset (invalid id → null), so a typo keys like no-effect
        // i2v: the conditioning image is part of the identity — an i2v clip must never collide with a
        // t2v clip (or a different source image) under the same hash. Same for the Tier 2 (#5) keyframe
        // end frame and the extend source clip — different inputs → different cached clip.
        imageUrl: input.imageUrl ?? null,
        endImageUrl: input.endImageUrl ?? null,
        extendVideoUrl: input.extendVideoUrl ?? null,
        // Tier 2 (#4): the edit source clip + operation are part of the identity — a restyle and a
        // relight of the same clip+prompt must not collide, and an edit must never serve a t2v clip.
        editVideoUrl: input.editVideoUrl ?? null,
        editOperation: input.edit?.operation ?? null,
        // Tier 2 (#6): the driving performance video is part of the identity (with the character imageUrl above).
        drivingVideoUrl: input.drivingVideoUrl ?? null,
        // Tier 3: the upscale source clip + scale factor are part of the identity — a 2× and a 4× upres of
        // the same clip must not collide, and an upscale must never serve a generated clip under this hash.
        upscaleVideoUrl: input.upscaleVideoUrl ?? null,
        upscaleFactor: input.upscaleVideoUrl ? (input.upscaleFactor ?? 2) : null,
        negativePrompt: input.negativePrompt ?? null,
        aspectRatio,
        duration,
        seed: input.seed ?? null,
      })

  if (input.projectId && api && !input.skipPermissionGate) {
    const row = await db.query.projects.findFirst({
      where: eq(projectsTable.id, input.projectId),
      columns: { apiPermissions: true },
    })
    if (row) {
      const defaults = createDefaultAPIPermissions()
      const stored = (row.apiPermissions as Partial<ReturnType<typeof createDefaultAPIPermissions>> | null) ?? {}
      const permissions = { ...defaults, ...stored }
      // Hydrate cap counters from the live apiSpend ledger — logSpend never writes
      // apiPermissions.sessionSpend/monthlySpend, so without this the session/monthly caps read a
      // stale zero and never fire. (Same fix as gateMediaSpend; per-project, per-api.)
      const live = await getProjectApiSpend(input.projectId, api)
      const cfg = permissions[api] ?? createDefaultPermissionConfig()
      permissions[api] = { ...cfg, sessionSpend: live.session, monthlySpend: live.monthly }
      // Tier 3: fold the upscale factor into the estimate so the gate prices 4× at ~2× base — the SAME
      // amount the reservation/commit charge. undefined for non-upscale. Duration is not an upscale lever.
      const estimatedCostUsd = estimateApiCostUsd(api, { duration, upscaleFactor: input.upscaleFactor })
      const permission = checkPermission(
        permissions,
        api,
        API_COST_ESTIMATES[api] ?? 'unknown',
        `Generate ${provider.name} video`,
        { prompt: input.prompt, duration, resolution: String(aspectRatio) },
        new Map(),
        { estimatedCostUsd },
      )
      if (permission.action === 'deny') {
        return {
          operationName: '',
          enhancedPrompt: input.prompt,
          estimatedCost: 0,
          provider: provider.id,
          reservationId: null,
          projectId: input.projectId,
          sceneId: input.sceneId,
          layerId: input.layerId,
          error: permission.reason,
        }
      }
      if (permission.action === 'ask' && !input.approvedAsk) {
        return {
          operationName: '',
          enhancedPrompt: input.prompt,
          estimatedCost: 0,
          provider: provider.id,
          reservationId: null,
          projectId: input.projectId,
          sceneId: input.sceneId,
          layerId: input.layerId,
          permissionNeeded: {
            api,
            estimatedCost: API_COST_ESTIMATES[api] ?? 'unknown',
            estimatedCostUsd,
            costThresholdExceeded: permission.request.costThresholdExceeded,
            reason: permission.request.reason,
            details: { prompt: input.prompt, duration, resolution: String(aspectRatio) },
          },
        }
      }
    }
  }

  // Start-cache: an identical prior request whose clip is cached returns it now —
  // no reservation, no provider call, no bill. Runs AFTER the permission gate so a deny/ask
  // policy is still honored (we don't serve cached output the project policy forbids).
  if (input.projectId) {
    const { getCachedMedia } = await import('@/lib/db')
    const cached = await getCachedMedia(requestHash).catch(() => null)
    if (cached?.filePath) {
      const fs = await import('node:fs/promises')
      // Env-aware mount resolution : packaged Electron's generated
      // mount lives under userData, not cwd()/public. null → cache miss.
      const { resolvePublicMediaPath } = await import('@/lib/media-paths')
      const abs = resolvePublicMediaPath(cached.filePath)
      const exists = abs
        ? await fs.access(abs).then(
            () => true,
            () => false,
          )
        : false
      if (exists) {
        const { recordCachedVideoJob } = await import('@/lib/db/queries/video-jobs')
        const { deadlineFor } = await import('@/lib/services/video-job-deadline')
        // Per-project op id: the media cache is global by hash, but the job row is per-project
        // so two projects with the same prompt don't clobber each other's row.
        const operationName = `cached-${input.projectId}-${requestHash}`
        // Only return the synthetic cached op if the row actually persisted — otherwise the
        // poll would hit the provider with a fake op id. On failure, fall through to generate.
        const recorded = await recordCachedVideoJob({
          operationName,
          projectId: input.projectId,
          provider: provider.id,
          requestHash,
          videoUrl: cached.filePath,
          deadlineAtMs: deadlineFor(provider.id, Date.now()),
        }).then(
          () => true,
          (e) => {
            log.warn('cached video job insert failed; falling through to generate', { error: e })
            return false
          },
        )
        if (recorded) {
          return {
            operationName,
            enhancedPrompt: input.prompt,
            estimatedCost: 0,
            provider: provider.id,
            reservationId: null,
            projectId: input.projectId,
            sceneId: input.sceneId,
            layerId: input.layerId,
          }
        }
      }
    }
  }

  // In-flight dedup: if an identical request is ALREADY pending (and not past its
  // deadline), return its operation instead of issuing a second paid provider job — the
  // start-cache above only catches COMPLETED clips. Both callers then poll the same job, which
  // completes + bills exactly once (completeVideoJob is atomic). Best-effort check-then-act:
  // catches the common fast double-fire; a truly simultaneous double can still slip (single-user).
  if (input.projectId) {
    const { getPendingVideoJobByRequestHash } = await import('@/lib/db/queries/video-jobs')
    const { isJobExpired } = await import('@/lib/services/video-job-deadline')
    const inflight = await getPendingVideoJobByRequestHash(input.projectId, requestHash).catch(() => null)
    if (inflight && !isJobExpired(inflight.deadlineAt.getTime(), Date.now())) {
      return {
        operationName: inflight.operationName,
        enhancedPrompt: input.prompt,
        estimatedCost: 0,
        provider: inflight.provider,
        // NULL, not the first call's reservationId: the deduped caller has NO claim on that
        // reservation (the original job row owns it, and pollVideoStatus reconciles via
        // job.reservationId). Handing it back would let this caller's poll commit it again on
        // a transient job-row lookup miss (the !job fallback path), double-billing.
        reservationId: null,
        projectId: input.projectId,
        sceneId: input.sceneId,
        layerId: input.layerId,
      }
    }
  }

  let reservationId: string | null = null
  // Duration-scaled estimate — reserved now AND persisted on the job row so the stateless poll
  // commits this exact amount (a flat per-call commit would disagree ~Nx for per-second models).
  // Number.isFinite: an unknown-cost model returns Infinity (the always_ask sentinel); reserving
  // Infinity while the row stores null (→ commit falls back to the flat cost) would be a reserve≠commit
  // divergence, so only reserve a real, finite amount.
  const estimatedCostUsd = api ? estimateApiCostUsd(api, { duration, upscaleFactor: input.upscaleFactor }) : 0
  if (input.projectId && api && Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0) {
    reservationId = reserveSpend(input.projectId, api, estimatedCostUsd).id
  }

  const ALLOWED_AR = ['16:9', '9:16', '1:1'] as const
  const narrowAspect = (ALLOWED_AR as readonly string[]).includes(aspectRatio)
    ? (aspectRatio as '16:9' | '9:16' | '1:1')
    : ('16:9' as const)
  let generated: Awaited<ReturnType<typeof provider.generate>>
  try {
    generated = await provider.generate({
      prompt: effectivePrompt, // includes the compiled camera clause for camera:'prompt' models
      negativePrompt: input.negativePrompt,
      aspectRatio: narrowAspect,
      durationSeconds: duration,
      seed: input.seed,
      imageUrl: input.imageUrl, // i2v: routes the provider to its image-to-video endpoint
      endImageUrl: input.endImageUrl, // Tier 2 (#5): start+end keyframe endpoint
      extendVideoUrl: input.extendVideoUrl, // Tier 2 (#5): extend / video→video endpoint
      editVideoUrl: input.editVideoUrl, // Tier 2 (#4): in-video edit (v2v / Aleph) endpoint
      drivingVideoUrl: input.drivingVideoUrl, // Tier 2 (#6): performance capture (Act-Two) endpoint
      upscaleVideoUrl: input.upscaleVideoUrl, // Tier 3: video upscale / super-resolution endpoint
      upscaleFactor: input.upscaleFactor, // Tier 3: 2× or 4× (defaults to 2 in the factory)
    })
  } catch (e) {
    // Release the reservation if the provider start fails — otherwise budget stays held until
    // the stale-reservation sweep. Agent video starts route through here, so a transient
    // provider/network error stranding budget is now a real path, not just the in-app one.
    if (reservationId && input.projectId) {
      const { releaseSpend } = await import('@/lib/agents/budget-tracker')
      releaseSpend(input.projectId, reservationId)
    }
    throw e
  }
  const { operationId, enhancedPrompt } = generated

  // Persist a durable job row so the (stateless) poll loop can enforce a deadline.
  // Non-fatal: if this write fails the poll just runs without timeout protection, exactly
  // as it did before — never block a started generation on the bookkeeping row.
  if (input.projectId) {
    try {
      const { createVideoJob } = await import('@/lib/db/queries/video-jobs')
      const { deadlineFor } = await import('@/lib/services/video-job-deadline')
      await createVideoJob({
        operationName: operationId,
        projectId: input.projectId,
        provider: provider.id,
        reservationId,
        deadlineAtMs: deadlineFor(provider.id, Date.now()),
        requestHash,
        // Persist the reserved cost so the poll commits reserve==commit. Round to cents;
        // Infinity (unknown-cost always_ask sentinel) is not a real charge → store null.
        estimatedCostCents: Number.isFinite(estimatedCostUsd) ? Math.round(estimatedCostUsd * 100) : null,
      })
    } catch (e) {
      // Durability is best-effort (generation already succeeded), but log it — a silent
      // failure here means the migration didn't apply and the deadline guard is off.
      log.warn('video job row insert failed; generation will run without a deadline', { error: e })
    }
  }

  return {
    operationName: operationId,
    enhancedPrompt: enhancedPrompt ?? input.prompt,
    estimatedCost: provider.costPerCallUsd,
    provider: provider.id,
    reservationId,
    projectId: input.projectId,
    sceneId: input.sceneId,
    layerId: input.layerId,
  }
}

export interface PollHeygenStatusResult {
  status: 'completed' | 'processing' | 'failed' | string
  videoUrl?: string
  thumbnailUrl?: string
  /** Real rendered clip length (seconds) from HeyGen — used to fit the scene to
   *  the avatar instead of the word-count estimate. Present on completion only. */
  durationSeconds?: number
  error?: string
}

/**
 * Poll HeyGen for an in-flight avatar video. When complete, downloads
 * the video to the media cache and returns the public path.
 */
export async function pollHeygenStatus(videoId: string): Promise<PollHeygenStatusResult> {
  if (!videoId) throw new GenerationValidationError('videoId is required')
  const { getVideoStatus, downloadVideo } = await import('@/lib/apis/heygen')
  const { saveToCache } = await import('@/lib/apis/media-cache')
  const { db } = await import('@/lib/db')
  const { avatarVideos } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')

  // Durability (v4 #8): the avatar_videos row carries a persisted deadline + the
  // poll handle. Look it up so the deadline is enforced HERE — on every poll, by any
  // caller (renderer or agent) — and the durable record's status tracks the render.
  // A render with no row (legacy / non-HeyGen) polls exactly as before (all row
  // logic is guarded on `row`).
  const [row] = await db
    .select({ id: avatarVideos.id, status: avatarVideos.status, deadlineAt: avatarVideos.deadlineAt })
    .from(avatarVideos)
    .where(eq(avatarVideos.heygenVideoId, videoId))
    .limit(1)
  const inFlight = !!row && row.status === 'generating'

  if (inFlight) {
    const { isAvatarDeadlinePassed, avatarTimeoutMessage } = await import('./avatar-job-deadline')
    if (isAvatarDeadlinePassed(row!.deadlineAt?.getTime(), Date.now())) {
      // Wedged render past its deadline: flip the durable record to error and report a
      // timeout so the caller marks the layer failed instead of polling forever.
      await db
        .update(avatarVideos)
        .set({ status: 'error', errorMessage: avatarTimeoutMessage() })
        .where(eq(avatarVideos.id, row!.id))
      return { status: 'failed', error: avatarTimeoutMessage() }
    }
  }

  const status = await getVideoStatus(videoId)
  if (status.status === 'completed' && status.videoUrl) {
    const buffer = await downloadVideo(status.videoUrl)
    const publicPath = await saveToCache('heygen', { videoId }, buffer, 'mp4')
    // Mark the durable record ready on completion (fixes the orphaned 'generating'
    // row). Only while in-flight, so a re-poll doesn't churn an already-finished row.
    if (inFlight) {
      await db
        .update(avatarVideos)
        .set({ status: 'ready', videoUrl: publicPath, durationSeconds: status.durationSeconds ?? null })
        .where(eq(avatarVideos.id, row!.id))
    }
    return {
      status: 'completed',
      videoUrl: publicPath,
      thumbnailUrl: status.thumbnailUrl,
      durationSeconds: status.durationSeconds,
    }
  }
  if (status.status === 'failed' && inFlight) {
    await db
      .update(avatarVideos)
      .set({ status: 'error', errorMessage: status.error ?? 'Avatar render failed.' })
      .where(eq(avatarVideos.id, row!.id))
  }
  return { status: status.status, error: status.error }
}

export interface PollVideoStatusInput {
  operationName: string
  projectId?: string
  prompt?: string
  providerId?: string
  reservationId?: string
}

export interface PollVideoStatusResult {
  done: boolean
  videoUrl?: string
  provider?: string
  error?: string
}

/**
 * Poll Veo3/Kling/Runway for an in-flight text-to-video job. On completion,
 * downloads the video, saves to cache, and calls `logSpend` to commit the
 * reserved cost.
 */
export async function pollVideoStatus(input: PollVideoStatusInput): Promise<PollVideoStatusResult> {
  if (!input.operationName) throw new GenerationValidationError('operationName is required')
  const { firstConfiguredVideoProvider, getVideoProvider } = await import('@/lib/apis/video/registry')
  const { saveToCache } = await import('@/lib/apis/media-cache')
  const { logSpend } = await import('@/lib/db')

  // Load the durable job row first — it carries the authoritative provider + reservation
  // (the renderer's poll call doesn't pass them).
  const { getVideoJob, transitionVideoJobFromPending, completeVideoJob } = await import('@/lib/db/queries/video-jobs')
  const { isJobExpired, timeoutMessage } = await import('@/lib/services/video-job-deadline')
  const job = await getVideoJob(input.operationName).catch((e) => {
    log.warn('video job lookup failed; polling without durability', { error: e })
    return null
  })

  // Provider resolution: explicit id → the persisted job.provider → first configured. Using
  // job.provider stops a Kling/Runway op being polled against Veo just because Veo is first.
  const providerId = input.providerId && input.providerId !== 'auto' ? input.providerId : (job?.provider ?? null)
  const provider = providerId ? getVideoProvider(providerId) : firstConfiguredVideoProvider()
  if (!provider) {
    throw new GenerationValidationError('No video provider configured. Add GOOGLE_AI_KEY, FAL_KEY, or RUNWAY_API_KEY.')
  }

  // Already-terminal jobs: return the known outcome WITHOUT re-polling the provider or
  // re-billing. A 'done' job returns its stored clip directly — this serves both a multi-tab
  // re-poll AND a start-cache HIT (the synthetic `cached-*` op that never had a provider call).
  if (job?.status === 'done' && job.videoUrl) {
    // Verify the clip still exists — a 'done' row (real or cache-hit) can outlive its file
    // (eviction/cleanup). A dead URL would silently break playback; surface an error so the
    // caller re-requests (startVideo's fs.access miss then regenerates).
    const fsx = await import('node:fs/promises')
    // Env-aware mount resolution, like the start-cache check above: a
    // cwd()/public join would always miss in packaged builds, reporting every
    // done job as "no longer available".
    const { resolvePublicMediaPath: resolveMediaPath } = await import('@/lib/media-paths')
    const absVideo = resolveMediaPath(job.videoUrl)
    const stillThere = absVideo
      ? await fsx.access(absVideo).then(
          () => true,
          () => false,
        )
      : false
    if (stillThere) return { done: true, videoUrl: job.videoUrl, provider: job.provider }
    return { done: true, error: 'Cached clip no longer available — please regenerate.', provider: job.provider }
  }
  if (job?.status === 'timeout') return { done: true, error: timeoutMessage(job.provider), provider: job.provider }
  if (job?.status === 'error')
    return { done: true, error: job.errorReason ?? 'Video generation failed.', provider: job.provider }

  // Deadline: a still-pending job past its deadline is timed out here. Atomic transition so
  // only the winning poll releases the reservation (concurrent/late polls don't double-release).
  if (job && job.status === 'pending' && isJobExpired(job.deadlineAt.getTime(), Date.now())) {
    const won = await transitionVideoJobFromPending(input.operationName, 'timeout', 'deadline exceeded').catch(
      () => false,
    )
    if (won && job.projectId && job.reservationId) {
      const { releaseSpend } = await import('@/lib/agents/budget-tracker')
      releaseSpend(job.projectId, job.reservationId)
    }
    return { done: true, error: timeoutMessage(job.provider), provider: job.provider }
  }

  const result = await provider.pollStatus(input.operationName)
  if (result.done && result.videoUri) {
    const buffer = await provider.download(result.videoUri)
    const publicPath = await saveToCache(provider.id, { operationName: input.operationName }, buffer, 'mp4')
    // Atomically claim pending→done (storing the clip URL). Only the winner aliases the cache +
    // logs spend, so a second tab / late re-poll can't double-bill. No job row (durability
    // write failed at start) → fall back to logging (old behavior).
    const won = job ? await completeVideoJob(input.operationName, publicPath).catch(() => false) : false

    if (won && job?.requestHash) {
      // Alias the finished clip under the request hash so the NEXT identical request hits the
      // start-cache and skips generation/billing entirely.
      const { setCachedMedia } = await import('@/lib/db')
      await setCachedMedia(job.requestHash, provider.id, publicPath, input.prompt ?? '', '', '{}').catch(() => {})
    }

    // Project id is AUTHORITATIVE from the job row — the renderer polls with only the
    // operationName, so gating commit on input.projectId let a winning poll flip the job to
    // done, return the clip, and skip logSpend → the start reservation was never committed and
    // got swept → free video (defeats reserve==commit). Use job.projectId like we already
    // do for job.reservationId.
    const commitProjectId = job?.projectId ?? input.projectId
    if (commitProjectId && (won || !job)) {
      // Reconcile the ORIGINAL reservation (from the job row), committing actual spend and
      // freeing the estimate so budget isn't over-counted. Commit the duration-scaled cost the
      // start reserved (persisted on the row) so reserve and commit agree for per-second
      // models; fall back to the provider's flat per-call cost only when the row predates the
      // column (no estimate stored).
      const committedUsd = job?.estimatedCostCents != null ? job.estimatedCostCents / 100 : provider.costPerCallUsd
      // Tier 3: an upscale was RESERVED under 'videoUpscale' at start, so it must COMMIT under the same
      // bucket or reserve≠commit leaves the ledger inconsistent. The op name encodes the upscale slug
      // (`<slug>::<id>`), so detect it here without a job-row schema change. Generation ops commit under
      // the provider as before.
      const { resolveSharedUpscaleSlug } = await import('@/lib/apis/video/fal-models')
      const isUpscaleOp = input.operationName.startsWith(`${resolveSharedUpscaleSlug()}::`)
      await logSpend(
        commitProjectId,
        isUpscaleOp ? 'videoUpscale' : provider.id,
        committedUsd,
        `${isUpscaleOp ? 'Video upscale' : provider.name}: ${(input.prompt ?? '').slice(0, 100)}`,
        job?.reservationId ?? input.reservationId,
      )
    }
    return { done: true, videoUrl: publicPath, provider: provider.id }
  }

  if (result.done && result.error) {
    const won = job
      ? await transitionVideoJobFromPending(input.operationName, 'error', result.error).catch(() => false)
      : false
    // Provider failed — only the winner releases, so the failed spend isn't held against budget.
    if (won && job?.projectId && job.reservationId) {
      const { releaseSpend } = await import('@/lib/agents/budget-tracker')
      releaseSpend(job.projectId, job.reservationId)
    }
    return { done: true, error: result.error, provider: provider.id }
  }
  return { done: false, provider: provider.id }
}

// ── Image generation ───────────────────────────────────────────────────────

export interface GenerateImageInput {
  prompt: string
  negativePrompt?: string
  model?: string
  aspectRatio?: string
  style?: string | null
  removeBackground?: boolean
  /** Pinned RNG seed for reproducibility (Cinema Studio manual control). Forwarded to generateImage. */
  seed?: number | null
  /** i2i conditioning strength 0..1, only meaningful with a reference. Forwarded to generateImage. */
  strength?: number | null
  /** i2i: a single conditioning/reference image (URL or app reference). */
  referenceImageUrl?: string | null
  /** Tier 2 (#7): multiple reference images for a single edit (multi-ref). */
  referenceImageUrls?: string[] | null
  /** Tier 2 (#7): a mask image for inpaint (white = edit). Requires a reference. */
  maskImageUrl?: string | null
  /** Tier 2 (#7): outpaint/expand — pixels to add per side. Requires a reference. */
  outpaint?: { left?: number; right?: number; top?: number; bottom?: number } | null
  /** When set, spend is logged against this project. */
  projectId?: string
  /** Unused by the service but preserved for route parity. */
  sceneId?: string
  /**
   * Skip generateImageAsset's OWN project-row permission gate. Set by callers that already ran
   * an equivalent gate (the agent tool handler). The renderer IPC NEVER sets it, so in-app image
   * generation is gated by project policy + spend caps. Mirrors StartVideoInput. Default false.
   */
  skipPermissionGate?: boolean
  /** The user approved this 'ask' in the always-ask modal — proceed past the prompt (never past a
   *  'deny'). Set by the renderer when re-dispatching after approval. Mirrors StartVideoInput. */
  approvedAsk?: boolean
}

export interface GenerateImageResult {
  imageUrl: string
  stickerUrl: string | null
  width: number
  height: number
  cost: number
  /** Set when the project policy DENIED the call (spend cap exceeded / api disabled). No spend. */
  error?: string
  /** Always-ask gate — present when the project policy requires interactive approval. The renderer
   *  pops the modal, then re-dispatches with approvedAsk:true. Mirrors StartVideoResult. */
  permissionNeeded?: {
    api: string
    estimatedCost: string
    estimatedCostUsd: number
    costThresholdExceeded?: boolean
    reason?: string
    details: Record<string, unknown>
  }
}

export async function generateImageAsset(input: GenerateImageInput): Promise<GenerateImageResult> {
  if (!input.prompt) throw new GenerationValidationError('prompt is required')

  // Permission / spend gate (shared gateMediaSpend, mirrors startVideo). The renderer IPC is the
  // only caller and never sets skipPermissionGate, so in-app image generation is gated by project
  // policy + spend caps BEFORE any paid provider call. 'deny' (cap/disabled) returns no-spend;
  // 'ask' surfaces permissionNeeded so the renderer pops the always-ask modal (then re-dispatches
  // with approvedAsk:true). The agent path gates itself in its tool handler and does not call this.
  if (!input.skipPermissionGate) {
    const { gateMediaSpend } = await import('./media-gate')
    const gate = await gateMediaSpend(
      input.projectId,
      'imageGen',
      { model: input.model ?? 'flux-schnell', prompt: input.prompt },
      { surfaceAsk: true, approvedAsk: input.approvedAsk },
    )
    if (gate && 'denied' in gate)
      return { imageUrl: '', stickerUrl: null, width: 0, height: 0, cost: 0, error: gate.reason }
    if (gate && 'ask' in gate)
      return { imageUrl: '', stickerUrl: null, width: 0, height: 0, cost: 0, permissionNeeded: gate.permissionNeeded }
  }

  // Lazy-imported — provider SDKs are heavy and only needed when this runs.
  const { generateImage } = await import('@/lib/apis/image-gen')
  const { removeImageBackground, BG_REMOVAL_COST } = await import('@/lib/apis/background-removal')
  const { logSpend } = await import('@/lib/db')

  const result = await generateImage({
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    model: (input.model ?? 'flux-schnell') as Parameters<typeof generateImage>[0]['model'],
    aspectRatio: (input.aspectRatio ?? '1:1') as Parameters<typeof generateImage>[0]['aspectRatio'],
    style: (input.style ?? null) as Parameters<typeof generateImage>[0]['style'],
    seed: input.seed ?? null,
    strength: input.strength ?? undefined,
    // Tier 2 (#7): i2i / multi-ref / inpaint / outpaint inputs. image-gen enforces the model's
    // capability (an edit input to an incapable model throws) and routes to the right fal endpoint.
    referenceImageUrl: input.referenceImageUrl ?? undefined,
    referenceImageUrls: input.referenceImageUrls ?? undefined,
    maskImageUrl: input.maskImageUrl ?? undefined,
    outpaint: input.outpaint ?? undefined,
  })

  if (result.cost > 0 && input.projectId) {
    await logSpend(
      input.projectId,
      'imageGen',
      result.cost,
      `${input.model ?? 'flux-schnell'}: ${input.prompt.slice(0, 100)}`,
    )
  }

  let stickerUrl: string | null = null
  if (input.removeBackground) {
    const bgResult = await removeImageBackground(result.imageUrl)
    stickerUrl = bgResult.resultUrl
    if (bgResult.cost > 0 && input.projectId) {
      await logSpend(
        input.projectId,
        'backgroundRemoval',
        bgResult.cost,
        `BG removal for: ${input.prompt.slice(0, 80)}`,
      )
    }
  }

  return {
    imageUrl: result.imageUrl,
    stickerUrl,
    width: result.width,
    height: result.height,
    cost: result.cost + (stickerUrl ? BG_REMOVAL_COST : 0),
  }
}

export class GenerationValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'GenerationValidationError'
  }
}
