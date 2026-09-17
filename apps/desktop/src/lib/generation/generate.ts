/**
 * Multi-provider code generation for scene layers.
 * Supports Anthropic (default), OpenAI, and Google Gemini.
 * Selects the correct system prompt and parsing strategy per SceneType.
 *
 * Provider clients come from `src/lib/agents/providers.ts` so BYOK key changes
 * propagate to the scene-codegen path the same way they do to the agent
 * loop. Model selection stays separate (TIER_GEN_MODELS below) because
 * codegen is single-shot/no-tools and has different tier requirements than
 * the multi-turn agent — but both paths share the same underlying SDK
 * clients.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SceneType } from '../types'
import type { ZdogComposedSceneSpec } from '../types'
import { logSpend } from '../db'
import { createLogger } from '../logger'

const log = createLogger('generation.code')
import { getModelPricing, getModelProvider } from '../agents/types'
import type { ModelId, ModelTier } from '../agents/types'
import { PROVIDER_KEY_ENV, type ModelConfig } from '../agents/model-config'
import { isRetriableStatus, deepseekThinkingParam } from '../agents/providers/openai-compat-chat-adapter'
import {
  getAnthropicClient,
  getOpenAIClient as getAgentOpenAIClient,
  getGoogleClient as getAgentGoogleClient,
  getLocalClient as getAgentLocalClient,
  getDeepseekClient,
  getQwenClient,
  getKimiClient,
} from '../agents/providers'
import {
  SVG_SYSTEM_PROMPT,
  CANVAS_SYSTEM_PROMPT,
  D3_SYSTEM_PROMPT,
  THREE_SYSTEM_PROMPT,
  MOTION_SYSTEM_PROMPT,
  LOTTIE_OVERLAY_PROMPT,
  ZDOG_SYSTEM_PROMPT,
  REACT_SYSTEM_PROMPT,
} from './prompts'
import { composeDeterministicZdogScene } from '../zdog'

/** Max output tokens per scene type — prevents runaway output */
const MAX_TOKENS_BY_TYPE: Record<string, number> = {
  svg: 12288,
  canvas2d: 16384,
  d3: 5120,
  three: 5120,
  motion: 5120,
  lottie: 4096,
  zdog: 4096,
  react: 8192,
}

/**
 * Extra max_tokens granted when DeepSeek thinking is on (v4-pro). For DeepSeek,
 * max_tokens caps TOTAL output including reasoning_content, so without headroom
 * the chain-of-thought eats the code budget and returns empty content. Tuned to
 * v4-pro's reasoning budget; lives at module scope next to the other generation
 * tuning constants.
 */
const REASONING_HEADROOM = 24_000

/**
 * Default model per tier for code generation, used when the caller passes no
 * explicit `options.modelId`. (The agent path always passes one — the agent's
 * own model via world.modelId — so these defaults serve legacy/API callers.)
 */
const TIER_GEN_MODELS: Record<ModelTier, () => ModelId> = {
  budget: () => 'claude-haiku-4-5-20251001',
  auto: () => 'claude-sonnet-4-6',
  premium: () => 'claude-opus-4-6',
}

/**
 * Resolve the codegen model (eng-review 3B): codegen FOLLOWS the agent's
 * provider. When the agent runs on DeepSeek, the quality tier maps within
 * DeepSeek — budget/auto → v4-flash (fast, cheap), premium → v4-pro
 * (reasoning) — EXPLICITLY, not via the registry `tier` field (v4-pro is
 * registered 'balanced'; the mapping here is the codegen contract).
 *
 * Non-DeepSeek requested models pass through unchanged, and absent a
 * requested model the Claude tier defaults apply. The former
 * DREAMBYTE_DEEPSEEK_BUDGET env flag is gone — it routed budget codegen to
 * DeepSeek while the agent ran on Claude, a combination 3B retired (one
 * routing rule: provider follows the agent). See CHANGELOG.
 */
function resolveGenModel(requested: string | undefined, tier: ModelTier, modelConfigs?: ModelConfig[]): string {
  if (requested && getModelProvider(requested as ModelId, modelConfigs) === 'deepseek') {
    return tier === 'premium' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
  }
  return requested ?? TIER_GEN_MODELS[tier]?.() ?? 'claude-sonnet-4-6'
}

/** @internal test helper — exposes 3B routing so tests can assert the matrix. */
export const __testResolveGenModel = resolveGenModel

/**
 * Resolve a text model for non-agent auxiliary tasks (enhance prompt, summarize
 * scene, edit SVG, the legacy svg/lottie services). These aren't tied to an
 * agent run, so when the caller passes no explicit model we pick a default that
 * respects WHICH provider keys actually exist — a DeepSeek/Qwen/Kimi-only setup
 * must not dead-end on a hardcoded Anthropic model. Anthropic stays first when
 * its key is present, preserving existing behavior.
 *
 * `tier`: 'budget' = cheap/fast, 'auto' = standard quality.
 */
export function resolveTextModel(
  requested: string | undefined,
  tier: 'budget' | 'auto',
  modelConfigs?: ModelConfig[],
): string {
  // Explicit model wins (honors the DeepSeek flash/pro tier mapping + passthrough).
  if (requested) return resolveGenModel(requested, tier, modelConfigs)
  // First provider (in preference order) whose key is set.
  const pick = TEXT_PROVIDER_PREFERENCE.find((p) => process.env[p.envVar])
  if (pick) return pick[tier]
  // Nothing configured — return the Anthropic default; the completeText key
  // guard surfaces a clear "add an API key" error rather than misrouting.
  return tier === 'budget' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6'
}

/**
 * Single source of truth for the text-provider preference order + per-tier
 * default model. `resolveTextModel` and `hasAnyTextProviderKey` both derive
 * from this so the key list and routing can never drift (review finding).
 * Anthropic is first to preserve the prior default; then the cheap
 * OpenAI-compat trio, then OpenAI, then Google. Every id is a real registry id.
 */
const TEXT_PROVIDER_PREFERENCE: Array<{ envVar: string; budget: string; auto: string }> = [
  { envVar: 'ANTHROPIC_API_KEY', budget: 'claude-haiku-4-5-20251001', auto: 'claude-sonnet-4-6' },
  // flash for both tiers — pro's reasoning latency isn't worth it for aux text.
  { envVar: 'DEEPSEEK_API_KEY', budget: 'deepseek-v4-flash', auto: 'deepseek-v4-flash' },
  { envVar: 'DASHSCOPE_API_KEY', budget: 'qwen-flash', auto: 'qwen-plus' },
  { envVar: 'MOONSHOT_API_KEY', budget: 'kimi-k2.6', auto: 'kimi-k2.6' },
  { envVar: 'OPENAI_API_KEY', budget: 'gpt-4.1-mini', auto: 'gpt-4o' },
  { envVar: 'GOOGLE_AI_KEY', budget: 'gemini-2.5-flash-preview-05-20', auto: 'gemini-2.5-flash-preview-05-20' },
]

/** True when at least one text-capable provider key is configured. Lets
 *  optional LLM features (semantic memory, summarization) skip cleanly when no
 *  provider is available instead of assuming Anthropic. */
export function hasAnyTextProviderKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return TEXT_PROVIDER_PREFERENCE.some((p) => env[p.envVar])
}

/** Result of a single-shot text completion through the provider router. */
export interface CompletionResult {
  raw: string
  inputTokens: number
  outputTokens: number
  truncated: boolean
  costUsd: number
}

/**
 * Provider-agnostic single-shot text completion. The one place that knows how
 * to dispatch a (system, user) prompt to Anthropic / OpenAI / Google / DeepSeek
 * / Qwen / Kimi / local Ollama and price the result. `generateCode` and the
 * legacy `src/lib/services/generation.ts` text services both route through here, so
 * provider support never drifts between them.
 */
export async function completeText(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  modelConfigs?: ModelConfig[],
): Promise<CompletionResult> {
  const provider = getModelProvider(model as ModelId, modelConfigs)

  // Clear, actionable error when the resolved provider has no key (review:
  // dropping the legacy 'ANTHROPIC_API_KEY not set' guard otherwise surfaced a
  // confusing partially-redacted 401). Local needs no key.
  const keyEnv = PROVIDER_KEY_ENV[provider]
  if (provider !== 'local' && keyEnv && !process.env[keyEnv]) {
    throw new Error(`No API key for ${provider} (${keyEnv}) — add one in Settings → Models`)
  }

  let raw: string
  let inputTokens: number
  let outputTokens: number
  let truncated: boolean

  if (provider === 'local') {
    const localConfig = modelConfigs?.find((m) => m.id === model || m.modelId === model)
    const endpoint = localConfig?.endpoint ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434'
    const localModelName = localConfig?.localModelName ?? model
    ;({ raw, inputTokens, outputTokens, truncated } = await callLocal(
      endpoint,
      localModelName,
      systemPrompt,
      userContent,
      maxTokens,
    ))
  } else if (provider === 'openai') {
    ;({ raw, inputTokens, outputTokens, truncated } = await callOpenAI(model, systemPrompt, userContent, maxTokens))
  } else if (provider === 'google') {
    ;({ raw, inputTokens, outputTokens, truncated } = await callGoogle(model, systemPrompt, userContent, maxTokens))
  } else if (provider === 'deepseek') {
    ;({ raw, inputTokens, outputTokens, truncated } = await callOpenAICompat(
      getDeepseekClient(),
      'DeepSeek',
      model,
      systemPrompt,
      userContent,
      maxTokens,
    ))
  } else if (provider === 'qwen') {
    ;({ raw, inputTokens, outputTokens, truncated } = await callOpenAICompat(
      getQwenClient(),
      'Qwen',
      model,
      systemPrompt,
      userContent,
      maxTokens,
    ))
  } else if (provider === 'kimi') {
    ;({ raw, inputTokens, outputTokens, truncated } = await callOpenAICompat(
      getKimiClient(),
      'Kimi',
      model,
      systemPrompt,
      userContent,
      maxTokens,
    ))
  } else {
    ;({ raw, inputTokens, outputTokens, truncated } = await callAnthropic(model, systemPrompt, userContent, maxTokens))
  }

  const pricing = getModelPricing(model as ModelId)
  const costUsd = (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M
  return { raw, inputTokens, outputTokens, truncated, costUsd }
}

export interface GenerateCodeOptions {
  palette?: string[]
  bgColor?: string
  duration?: number
  font?: string
  strokeWidth?: number
  previousSummary?: string
  d3Data?: unknown
  /** Model ID to use for generation — defaults based on tier */
  modelId?: string
  /** Model tier — determines default model when modelId not specified */
  modelTier?: ModelTier
  /** Deterministic no-LLM Zdog composition spec */
  zdogComposedSpec?: ZdogComposedSceneSpec
  /** Model configs for resolving local model endpoints */
  modelConfigs?: ModelConfig[]
}

export interface GenerateCodeResult {
  code: string
  /** For D3/Motion types that include a CSS styles block */
  styles?: string
  /** For Motion types that include HTML body content */
  htmlContent?: string
  /** For D3 types that return suggested data */
  suggestedData?: unknown
  usage: { input_tokens: number; output_tokens: number; cost_usd: number }
  /** True if the LLM output was cut off by hitting max_tokens */
  truncated?: boolean
}

/**
 * Generate code for a scene layer.
 * Routes to Anthropic, OpenAI, or Google based on the resolved model.
 */
export async function generateCode(
  layerType: SceneType,
  prompt: string,
  options: GenerateCodeOptions,
  projectId?: string,
): Promise<GenerateCodeResult> {
  const {
    palette,
    bgColor = '#181818',
    duration = 8,
    font,
    strokeWidth = 2,
    previousSummary = '',
    d3Data,
    modelId: requestedModel,
    modelTier = 'auto',
  } = options
  // When no palette/font provided (no preset active), use neutral fallbacks
  // but mark them so system prompts can skip the "suggested palette" line
  const effectivePalette = palette ?? ['#f0ece0', '#e84545', '#4595e8', '#45e87a']
  const effectiveFont = font ?? 'Inter'
  const hasExplicitPalette = palette != null && palette.length > 0

  if (layerType === 'zdog' && options.zdogComposedSpec) {
    const composedCode = composeDeterministicZdogScene(options.zdogComposedSpec, { duration })
    return {
      code: composedCode,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      truncated: false,
    }
  }

  // Resolve model: 3B provider-follow (deepseek tier map) → explicit override →
  // tier default → Sonnet fallback
  const model = resolveGenModel(requestedModel, modelTier, options.modelConfigs)
  const maxTokens = MAX_TOKENS_BY_TYPE[layerType] ?? 6144

  // ── Build system prompt and user content per layer type ───────────────────

  let systemPrompt: string
  let userContent: string = prompt

  switch (layerType) {
    case 'svg':
      systemPrompt = SVG_SYSTEM_PROMPT(
        effectivePalette,
        strokeWidth,
        effectiveFont,
        duration,
        previousSummary,
        hasExplicitPalette,
      )
      break
    case 'canvas2d':
      systemPrompt = CANVAS_SYSTEM_PROMPT(effectivePalette, bgColor, duration, previousSummary, hasExplicitPalette)
      break
    case 'd3':
      systemPrompt = D3_SYSTEM_PROMPT(
        effectivePalette,
        effectiveFont,
        bgColor,
        duration,
        previousSummary,
        hasExplicitPalette,
      )
      if (d3Data) {
        userContent = `${prompt}\n\nExisting data to visualize:\n${JSON.stringify(d3Data, null, 2)}`
      }
      break
    case 'three':
      systemPrompt = THREE_SYSTEM_PROMPT(effectivePalette, bgColor, duration, previousSummary, hasExplicitPalette)
      break
    case 'motion':
      systemPrompt = MOTION_SYSTEM_PROMPT(
        effectivePalette,
        effectiveFont,
        bgColor,
        duration,
        previousSummary,
        hasExplicitPalette,
      )
      break
    case 'lottie':
      systemPrompt = LOTTIE_OVERLAY_PROMPT(
        effectivePalette,
        effectiveFont,
        duration,
        previousSummary,
        hasExplicitPalette,
      )
      break
    case 'zdog':
      systemPrompt = ZDOG_SYSTEM_PROMPT(effectivePalette, bgColor, duration, previousSummary, hasExplicitPalette)
      break
    case 'react':
      systemPrompt = REACT_SYSTEM_PROMPT(
        effectivePalette,
        effectiveFont,
        bgColor,
        duration,
        previousSummary,
        hasExplicitPalette,
      )
      break
    default:
      throw new Error(`Unknown layer type: ${layerType}`)
  }

  // ── Route to provider (shared dispatch — see completeText) ──────────────────

  const provider = getModelProvider(model as ModelId, options.modelConfigs)
  log.info('start', { extra: { type: layerType, model, provider, promptHead: prompt.slice(0, 120) } })

  const { raw, inputTokens, outputTokens, truncated, costUsd } = await completeText(
    model,
    systemPrompt,
    userContent,
    maxTokens,
    options.modelConfigs,
  )

  log.info('complete', {
    extra: {
      type: layerType,
      model,
      inputTokens,
      outputTokens,
      costUsd: Number(costUsd.toFixed(4)),
      codeLen: raw.length,
      truncated,
    },
  })

  if (projectId) {
    await logSpend(projectId, `generation:${layerType}`, costUsd, prompt.slice(0, 200))
  }

  const usageResult = { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd }

  // ── Parse response per layer type ─────────────────────────────────────────

  switch (layerType) {
    case 'svg': {
      // The SVG prompt asks for a raw <svg>…</svg> followed by an animation
      // <script> that drives window.__tl. Models still occasionally wrap output
      // in ```svg fences or prepend prose ("Here's your logo:") — injecting that
      // verbatim paints garbage. Extract from the first <svg to the last </svg>,
      // preserving any trailing <script>…</script> block appended after </svg>.
      const svgStart = raw.search(/<svg[\s>]/i)
      // Anchor the close on the SAME validated regex used to slice (matchAll
      // requires the `>`), not a looser lastIndexOf('</svg') — those could target
      // different positions and `indexOf('>')` returning -1 silently produced an
      // EMPTY extraction returned as success (blank scene).
      const svgCloseMatches = [...raw.matchAll(/<\/svg\s*>/gi)]
      if (svgStart === -1 || svgCloseMatches.length === 0) {
        log.error('svg extraction failed — no <svg>…</svg> found', { extra: { rawLength: raw.length } })
        throw new Error(
          truncated
            ? 'SVG was truncated — simplify the logo/illustration or split it across layers'
            : 'Model returned no <svg>…</svg> element — please retry',
        )
      }
      // End just after the LAST </svg>. If an animation <script>…</script> follows
      // it (drives window.__tl), extend the slice through the last </script> — but
      // only when a <script> actually OPENS in the trailing text, so a stray
      // "</script>" in prose can't pull garbage in.
      const lastSvgClose = svgCloseMatches[svgCloseMatches.length - 1]
      const svgClose = (lastSvgClose.index ?? 0) + lastSvgClose[0].length
      const trailing = raw.slice(svgClose)
      let endIdx = svgClose
      if (/<script[\s>]/i.test(trailing)) {
        const scriptCloseMatches = [...trailing.matchAll(/<\/script\s*>/gi)]
        if (scriptCloseMatches.length > 0) {
          const lastScriptClose = scriptCloseMatches[scriptCloseMatches.length - 1]
          endIdx = svgClose + (lastScriptClose.index ?? 0) + lastScriptClose[0].length
        }
      }
      const extracted = raw.slice(svgStart, endIdx).trim()
      // Guard against an empty/degenerate slice slipping through as success.
      if (!extracted || !/<svg[\s>]/i.test(extracted)) {
        log.error('svg extraction produced empty result', { extra: { rawLength: raw.length, svgStart, endIdx } })
        throw new Error('Model returned no usable <svg>…</svg> element — please retry')
      }
      // Not sanitized here: sanitizeSvg (src/lib/services/sanitize-svg.ts) uses USE_PROFILES svg/svgFilters
      // (no html profile) and FORBID_TAGS, so it strips the trailing animation
      // <script> that drives window.__tl. Sanitizing here would silently kill the
      // animation, so it's deferred until it can be applied to the svg element only.
      return { code: extracted, usage: usageResult, truncated }
    }

    case 'canvas2d':
      return { code: raw, usage: usageResult, truncated }

    case 'lottie': {
      // Strip markdown fences and validate JSON
      const lottieRaw = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()
      try {
        JSON.parse(lottieRaw) // validate
      } catch {
        log.error('lottie JSON parse failed', { extra: { rawLength: raw.length } })
        throw new Error(
          truncated
            ? 'Lottie JSON was truncated — try a simpler animation'
            : 'Generated Lottie output is not valid JSON',
        )
      }
      return { code: lottieRaw, usage: usageResult, truncated }
    }

    case 'zdog':
      return { code: raw, usage: usageResult, truncated }

    case 'd3': {
      const cleaned = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()
      let parsed: any
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        log.error('d3 JSON parse failed', { extra: { rawLength: raw.length } })
        throw new Error(
          truncated
            ? 'D3 scene code was too long and got cut off — try a simpler prompt'
            : 'Model returned invalid JSON for D3 scene — please retry',
        )
      }
      return {
        code: parsed.sceneCode ?? '',
        styles: parsed.styles,
        suggestedData: parsed.suggestedData,
        usage: usageResult,
        truncated,
      }
    }

    case 'three': {
      const cleaned = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()
      let parsed: any
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        log.error('three.js JSON parse failed', { extra: { rawLength: raw.length } })
        throw new Error(
          truncated
            ? 'Three.js scene code was too long and got cut off — try a simpler prompt'
            : 'Model returned invalid JSON for Three.js scene — please retry',
        )
      }
      return { code: parsed.sceneCode ?? '', usage: usageResult, truncated }
    }

    case 'motion': {
      const cleaned = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()
      let parsed: any
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        log.error('motion JSON parse failed', { extra: { rawLength: raw.length } })
        throw new Error(
          truncated
            ? 'Motion scene code was too long and got cut off — try a simpler prompt'
            : 'Model returned invalid JSON for Motion scene — please retry',
        )
      }
      return {
        code: parsed.sceneCode ?? '',
        styles: parsed.styles,
        htmlContent: parsed.htmlContent,
        usage: usageResult,
        truncated,
      }
    }

    case 'react': {
      const cleaned = raw
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim()
      let parsed: any
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        // If JSON parse fails, treat the raw output as sceneCode directly
        return { code: raw, usage: usageResult, truncated }
      }
      return {
        code: parsed.sceneCode ?? '',
        styles: parsed.styles,
        usage: usageResult,
        truncated,
      }
    }

    default:
      return { code: raw, usage: usageResult, truncated }
  }
}

// ── Provider call implementations ─────────────────────────────────────────────

interface ProviderResult {
  raw: string
  inputTokens: number
  outputTokens: number
  truncated: boolean
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<ProviderResult> {
  const params = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: userContent }],
  }

  let result: Anthropic.Message
  const anthropic = getAnthropicClient()
  try {
    result = await anthropic.messages.create(params, { timeout: 60_000 })
  } catch (firstErr) {
    log.warn('Anthropic first attempt failed, retrying in 1s', { extra: { message: (firstErr as Error).message } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    result = await anthropic.messages.create(params, { timeout: 60_000 })
  }

  const truncated = result.stop_reason === 'max_tokens'
  if (truncated) {
    log.warn('Anthropic output truncated', { extra: { maxTokens, used: result.usage.output_tokens } })
  }

  const textBlock = result.content.find((b) => b.type === 'text')
  return {
    raw: textBlock?.type === 'text' ? textBlock.text : '',
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    truncated,
  }
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<ProviderResult> {
  const client = getAgentOpenAIClient()

  let result: any
  try {
    result = await client.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      { timeout: 60_000 },
    )
  } catch (firstErr) {
    log.warn('OpenAI first attempt failed, retrying in 1s', { extra: { message: (firstErr as Error).message } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    result = await client.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      { timeout: 60_000 },
    )
  }

  const finishReason = result.choices?.[0]?.finish_reason
  const truncated = finishReason === 'length'
  if (truncated) {
    log.warn('OpenAI output truncated', { extra: { maxTokens } })
  }

  return {
    raw: result.choices?.[0]?.message?.content ?? '',
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    truncated,
  }
}

/**
 * DeepSeek call. OpenAI-compatible Chat Completions API at api.deepseek.com.
 *
 * Wire identical to `callOpenAI` because the protocol is the same — only the
 * client (baseURL + API key) differs. Kept as its own function so future
 * provider-specific quirks (e.g. DeepSeek's `cache_hit_tokens` reporting,
 * different finish_reason values) have a place to live without bloating the
 * OpenAI path with conditionals.
 */
/**
 * Single-shot call to any OpenAI-compatible chat provider (DeepSeek / Qwen /
 * Kimi). Parameterized by client + label so one body serves all three; one retry
 * on the first RETRIABLE failure (these budget tiers rate-limit more than the
 * majors). 401/400 fail fast — retrying a bad key or bad request only wastes a
 * second call (shares isRetriableStatus with the streaming adapter).
 *
 * DeepSeek V4 thinking control (eng-review 6A): the API defaults thinking ON,
 * which for single-shot codegen means paying chain-of-thought tokens and
 * latency before the code arrives. Tier mapping: v4-flash (budget/auto) gets
 * thinking DISABLED — fast, cheap scenes; v4-pro (premium) keeps thinking
 * ENABLED — reasoning quality is what the premium tier buys. Qwen/Kimi get no
 * thinking param (their semantics differ).
 */
async function callOpenAICompat(
  client: ReturnType<typeof getDeepseekClient>,
  label: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<ProviderResult> {
  const thinkingEnabled = model === 'deepseek-v4-pro'
  const thinkingParam =
    model === 'deepseek-v4-flash' ? deepseekThinkingParam(false) : thinkingEnabled ? deepseekThinkingParam(true) : {}
  const body = {
    model,
    max_tokens: thinkingEnabled ? maxTokens + REASONING_HEADROOM : maxTokens,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userContent },
    ],
    ...thinkingParam,
  }

  let result: any
  try {
    result = await client.chat.completions.create(body as any, { timeout: 90_000 })
  } catch (firstErr) {
    const status: number | undefined = (firstErr as any)?.status ?? (firstErr as any)?.response?.status
    if (!isRetriableStatus(status)) throw firstErr
    log.warn(`${label} first attempt failed, retrying in 1s`, {
      extra: { message: (firstErr as Error).message, status },
    })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    result = await client.chat.completions.create(body as any, { timeout: 90_000 })
  }

  const message = result.choices?.[0]?.message
  const finishReason = result.choices?.[0]?.finish_reason
  const content = message?.content ?? ''
  // Thinking-on responses (v4-pro) put chain-of-thought in reasoning_content
  // and the answer in content. Empty content alongside non-empty reasoning
  // means reasoning consumed the budget before any code was emitted — even
  // when finish_reason is 'stop' (reasoning "completed"). Flag it as truncated
  // so the caller surfaces a real failure instead of silently writing an empty
  // scene (the headroom above makes this rare, but it must never corrupt).
  const reasoningAteBudget =
    !content && typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0
  const truncated = finishReason === 'length' || reasoningAteBudget
  if (finishReason === 'length') {
    log.warn(`${label} output truncated`, { extra: { maxTokens } })
  }
  if (reasoningAteBudget) {
    log.warn(`${label} returned reasoning but no content — raise maxTokens or simplify the prompt`, {
      extra: { model, reasoningChars: message.reasoning_content.length, finishReason },
    })
  }

  return {
    raw: content,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    truncated,
  }
}

/** @internal test helper — exposes the single-shot compat call (retry policy,
 *  per-model thinking param, reasoning-ate-budget truncation) for unit tests. */
export const __testCallOpenAICompat = callOpenAICompat

async function callGoogle(
  model: string,
  systemPrompt: string,
  userContent: string,
  _maxTokens: number,
): Promise<ProviderResult> {
  const client = getAgentGoogleClient()

  let result: any
  try {
    result = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction: systemPrompt,
      },
    })
  } catch (firstErr) {
    log.warn('Google first attempt failed, retrying in 1s', { extra: { message: (firstErr as Error).message } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    result = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction: systemPrompt,
      },
    })
  }

  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const usageMetadata = result?.usageMetadata ?? {}
  const finishReason = result?.candidates?.[0]?.finishReason
  const truncated = finishReason === 'MAX_TOKENS'
  if (truncated) {
    log.warn('Google output truncated (hit max_tokens)')
  }

  return {
    raw: text,
    inputTokens: usageMetadata.promptTokenCount ?? 0,
    outputTokens: usageMetadata.candidatesTokenCount ?? 0,
    truncated,
  }
}

async function callLocal(
  endpoint: string,
  localModelName: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<ProviderResult> {
  const client = getAgentLocalClient(endpoint)

  let result: any
  try {
    result = await client.chat.completions.create(
      {
        model: localModelName,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      { timeout: 120_000 },
    )
  } catch (firstErr) {
    log.warn('Local LLM first attempt failed, retrying in 1s', { extra: { message: (firstErr as Error).message } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    result = await client.chat.completions.create(
      {
        model: localModelName,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      { timeout: 120_000 },
    )
  }

  const finishReason = result.choices?.[0]?.finish_reason
  const truncated = finishReason === 'length'
  if (truncated) {
    log.warn('Local LLM output truncated', { extra: { maxTokens } })
  }

  return {
    raw: result.choices?.[0]?.message?.content ?? '',
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    truncated,
  }
}
