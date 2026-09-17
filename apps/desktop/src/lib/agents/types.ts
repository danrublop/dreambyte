/**
 * Agent system types and interfaces for the Dreambyte AI orchestration layer.
 */

import type { Scene, GlobalStyle, SceneGraph } from '../types'
import type { StoryboardBeat } from './storyboard'
// Runtime import (NOT type-only): calculateCost delegates to this when given a
// modelConfigs registry. One-directional — model-config.ts does not
// import this module — so no load-time cycle; and the call is inside the
// function body, never at module init.
import { getModelPricing as getModelPricingFromConfig } from './model-config'

// ── Agent Types ───────────────────────────────────────────────────────────────

// One unified agent (Master Builder). The multi-persona model is gone —
// specialization happens via Skills & Rules, not agent types.
export type AgentType = 'scene-maker'

/** Extended thinking mode for Claude API */
export type ThinkingMode = 'off' | 'adaptive' | 'deep'

export type ModelId =
  // Anthropic
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-6'
  | 'claude-opus-4-8'
  // OpenAI
  | 'gpt-4o-mini'
  | 'gpt-4o'
  | 'gpt-4.1-nano'
  | 'gpt-4.1-mini'
  | 'gpt-4.1'
  | 'o1'
  | 'o3-mini'
  // Google Gemini
  | 'gemini-2.5-flash-preview-05-20'
  | 'gemini-2.5-pro-preview-05-06'
  // Local models (dynamic — allows arbitrary Ollama model IDs)
  | (string & {})

/** Cost per 1M tokens (input, output) in USD. Local models default to { 0, 0 }. */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-8': { inputPer1M: 5.0, outputPer1M: 25.0 },
  // 5-series. Not in DEFAULT_MODELS yet, but a user-added custom model config can
  // name any of them — and an id missing here prices at $0, so the run cost cap
  // would never trip on it. (claude-3-5-sonnet-20241022 removed: retired, 404s.)
  'claude-opus-5': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-sonnet-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-fable-5': { inputPer1M: 10.0, outputPer1M: 50.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
  o1: { inputPer1M: 15.0, outputPer1M: 60.0 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  // Google list price, https://ai.google.dev/gemini-api/docs/pricing (checked
  // 2026-08-04).
  'gemini-2.5-flash-preview-05-20': { inputPer1M: 0.3, outputPer1M: 2.5 },
  // Pro is tiered ($2.50/$15.00 above a 200k-token prompt); the <=200k rate is
  // the one nearly every agent turn pays.
  'gemini-2.5-pro-preview-05-06': { inputPer1M: 1.25, outputPer1M: 10.0 },
  // Cheap OpenAI-compat agent providers. MUST stay in sync with the
  // costPer1M* fields in model-config.ts DEFAULT_MODELS — the runtime cost ledger
  // (calculateCost → getModelPricing) reads THIS map, not the model config. An id
  // missing here silently prices at $0, so the run cost cap never trips.
  'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'deepseek-v4-pro': { inputPer1M: 0.435, outputPer1M: 0.87 },
  'qwen-flash': { inputPer1M: 0.05, outputPer1M: 0.4 },
  'qwen-plus': { inputPer1M: 0.4, outputPer1M: 1.2 },
  'kimi-k2.5': { inputPer1M: 0.6, outputPer1M: 3.0 },
  'kimi-k2.6': { inputPer1M: 0.95, outputPer1M: 4.0 },
  // K3 flagship: cache-miss input $3.00 (cache-hit $0.30), output $15.00 per 1M.
  'kimi-k3': { inputPer1M: 3.0, outputPer1M: 15.0 },
}

/** Determine provider from model ID. Pass modelConfigs to resolve local models by config lookup. */
export function getModelProvider(
  modelId: ModelId,
  modelConfigs?: import('./model-config').ModelConfig[],
): 'anthropic' | 'openai' | 'google' | 'local' | 'claude-code' | 'deepseek' | 'qwen' | 'kimi' {
  if (!modelId) return 'anthropic' // fallback for undefined/null
  if (modelId === 'codex-cli') return 'openai'
  if (modelId === 'claude-code') return 'claude-code'
  // Check model configs first for local + OpenAI-compat cheap providers (their
  // IDs don't all have a unique prefix, so we prefer the registry over string
  // matching when configs are provided).
  if (modelConfigs) {
    const config = modelConfigs.find((m) => m.id === modelId || m.modelId === modelId)
    if (config?.provider === 'local') return 'local'
    if (config?.provider === 'claude-code') return 'claude-code'
    if (config?.provider === 'deepseek') return 'deepseek'
    if (config?.provider === 'qwen') return 'qwen'
    if (config?.provider === 'kimi') return 'kimi'
  }
  // A colon is the Ollama `name:tag` separator (e.g. `qwen3:8b`, `qwen3.5:8b`,
  // `llama3:8b`). No cloud provider id uses a colon, so an unconfigured colon id
  // is a local Ollama tag — short-circuit before cloud-prefix matching so a
  // dotted-version tag can't slip into the qwen3 prefix.
  if (modelId.includes(':')) return 'local'
  if (modelId.startsWith('claude-')) return 'anthropic'
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) return 'openai'
  if (modelId.startsWith('gemini-')) return 'google'
  if (modelId.startsWith('deepseek-')) return 'deepseek'
  if (modelId.startsWith('qwen-') || /^qwen3[-.]/.test(modelId)) return 'qwen'
  if (modelId.startsWith('kimi-') || modelId.startsWith('moonshot-')) return 'kimi'
  // If none of the known prefixes match, assume local
  const knownPrefixes = [
    'claude-',
    'gpt-',
    'o1',
    'o3',
    'gemini-',
    'deepseek-',
    'qwen-',
    'qwen3-',
    'qwen3.',
    'kimi-',
    'moonshot-',
  ]
  if (!knownPrefixes.some((p) => modelId.startsWith(p))) return 'local'
  return 'anthropic'
}

/** Get pricing for a model, defaulting to free for unknown/local models */
export function getModelPricing(modelId: ModelId): { inputPer1M: number; outputPer1M: number } {
  return MODEL_PRICING[modelId] ?? { inputPer1M: 0, outputPer1M: 0 }
}

/** Provider-specific cache pricing ratios relative to the input rate.
 *  Anthropic: reads 10%, writes 125%. OpenAI: automatic caching, reads ~50%,
 *  no write surcharge. Gemini: implicit caching, reads ~25%, no surcharge.
 *  Unlisted providers fall back to Anthropic's ratios (the prior global
 *  behavior — conservative on writes, generous on reads). */
const CACHE_PRICING_BY_PROVIDER: Record<string, { read: number; creation: number }> = {
  anthropic: { read: 0.1, creation: 1.25 },
  openai: { read: 0.5, creation: 1.0 },
  google: { read: 0.25, creation: 1.0 },
  // OpenAI-compat cheap providers: they speak the OpenAI API
  // shape, so when they report cached tokens the OpenAI ratio is the closer
  // truth than Anthropic's generous 0.1×. Prefix detection in
  // getModelProvider resolves their MODEL_PRICING ids without configs.
  //
  // DeepSeek publishes real cache-hit pricing (api-docs.deepseek.com):
  // v4-flash $0.0028 hit vs $0.14 miss = 0.02×; v4-pro $0.003625/$0.435
  // ≈ 0.008×. Provider-level ratio uses flash's 0.02 — slightly overstates
  // pro's cached share (conservative direction for spend caps).
  deepseek: { read: 0.02, creation: 1.0 },
  // Qwen (Alibaba Model Studio): a context-cache hit on qwen-plus bills
  // $0.08/1M against $0.40/1M input = 0.2x. The 0.5x placeholder here billed
  // cached tokens 2.5x over — visible as an inflated cost chip on the DEFAULT
  // `auto` model. https://www.eesel.ai/blog/qwen-pricing (checked 2026-08-04)
  qwen: { read: 0.2, creation: 1.0 },
  // Kimi (Moonshot): K2.6 cache-hit input $0.16 vs $0.95 miss = 0.168x; K3 is
  // $0.30 vs $3.00 = 0.10x. One provider-level ratio, so take K2.6's (the
  // default model) — it slightly OVER-states K3's cached share, the safe
  // direction for a spend cap.
  // https://platform.kimi.ai/docs/pricing/chat-k26 (checked 2026-08-04)
  kimi: { read: 0.17, creation: 1.0 },
}

/**
 * Cost in USD from token counts and model (the runtime cost ledger's pricer).
 *
 * Pricing source: by default reads the built-in MODEL_PRICING map above,
 * so all existing callers compile and behave UNCHANGED. When the OPTIONAL
 * `modelConfigs` is supplied, pricing is delegated to
 * `model-config.getModelPricing(modelId, modelConfigs)`, which resolves the rate
 * from the user's own registry (or DEFAULT_MODELS) — this is what lets a
 * custom / BYOK model bill non-zero instead of the MODEL_PRICING fallback of $0
 * (which silently let the run cost cap never trip). No import cycle: model-config
 * does NOT import this module, so the runtime `import('./model-config')` here is
 * one-directional.
 *
 * Cache fields are ADDITIVE with inputTokens (Anthropic semantics —
 * input_tokens excludes cache tokens). The provider adapters normalize
 * OpenAI (prompt_tokens INCLUDES cached) and Gemini (promptTokenCount
 * INCLUDES cachedContentTokenCount) usage to the same additive shape by
 * subtracting cached tokens from the prompt count — without that,
 * populating the cache fields here would double-count. Multipliers are
 * provider-aware; previously the Anthropic ratios applied to everyone.
 */
export function calculateCost(
  modelId: ModelId,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
  modelConfigs?: import('./model-config').ModelConfig[],
): number {
  const pricing = modelConfigs ? getModelPricingFromConfig(modelId, modelConfigs) : getModelPricing(modelId)
  if (!pricing || (pricing.inputPer1M === 0 && pricing.outputPer1M === 0)) return 0
  const provider = getModelProvider(modelId)
  const cache = CACHE_PRICING_BY_PROVIDER[provider] ?? CACHE_PRICING_BY_PROVIDER.anthropic
  const inputCost =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (cacheCreationTokens / 1_000_000) * pricing.inputPer1M * cache.creation +
    (cacheReadTokens / 1_000_000) * pricing.inputPer1M * cache.read
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M
  return inputCost + outputCost
}

/**
 * Model tier controls which models each agent gets.
 * - 'auto': balanced default — sonnet for director/scene-maker, haiku for router/editor/dop
 * - 'premium': most capable models — opus for director/scene-maker, sonnet for editor/dop
 * - 'budget': cheapest models — haiku for everything
 */
export type ModelTier = 'auto' | 'premium' | 'budget'

/**
 * Agent run mode — the single user-facing control (chevron picker in the chat).
 * - 'auto': run end-to-end, auto-approve paid generation (except providers set always_deny)
 * - 'ask':  route every paid generation through the existing GenerationConfirmCard
 * - 'plan': write the plan, stop for approval, build nothing (derives planFirstMode)
 * - 'sandbox': substitute free-local / placeholder assets, no paid asset spend (fail-closed)
 * This is the canonical state; planFirstMode/sandboxMode/permissionPosture are DERIVED from it
 * at request-build time (see AgentChat) — one source of truth.
 */
export type AgentRunMode = 'auto' | 'ask' | 'plan' | 'sandbox'

/**
 * Permission posture applied per-run, layered over saved per-provider settings.
 * - 'auto':    allow paid calls (an explicit always_deny provider still wins)
 * - 'ask':     force the confirm card (an explicit always_deny provider still wins)
 * - 'default': use the saved per-provider rules unchanged (Plan mode)
 * Sandbox never reaches the paid path, so it carries no posture.
 */
export type PermissionPosture = 'auto' | 'ask' | 'default'

/**
 * Derive the per-run spend flags from the user-facing run mode (the picker is the
 * single source of truth; this is the "DERIVED at request-build" mapping referenced
 * by AgentRunMode above). Plan-first is derived separately (it has extra run-state
 * conditions), so this only covers the two spend dimensions:
 * - sandboxMode: true only in 'sandbox' (substitute placeholders, no paid spend).
 * - permissionPosture: 'auto' auto-approves paid generation (always_deny + the run
 *   budget cap still gate it); 'ask' forces the confirm card; 'default' (plan +
 *   sandbox) leaves the saved per-provider rules unchanged.
 */
export function runModeSpendFlags(mode: AgentRunMode): {
  sandboxMode: boolean
  permissionPosture: PermissionPosture
} {
  return {
    sandboxMode: mode === 'sandbox',
    permissionPosture: mode === 'auto' ? 'auto' : mode === 'ask' ? 'ask' : 'default',
  }
}

// ── Editor State Snapshot ─────────────────────────────────────────────────────
//
// Surfaced to the agent via the `read_editor_state` tool so it can act
// situationally (e.g. "edit the clip I have selected") instead of scanning
// the world. Captured at run start by the renderer; refreshed lazily on
// agent request.
export interface EditorStateSnapshot {
  selectedSceneId: string | null
  selectedClipIds: string[]
  /** Current playhead position in seconds (0 if no timeline). */
  currentTime: number
  /** Whether the timeline is currently playing back. */
  isPlaying: boolean
  /** Total timeline duration in seconds. */
  totalDuration: number
  /** Timeline horizontal zoom (0–1+). */
  timelineZoom: number
  /** ISO timestamp when this snapshot was captured. */
  capturedAt: string
}

// ── Conversation Types ────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string
  projectId: string
  title: string
  isPinned: boolean
  isArchived: boolean
  totalCostUsd: number
  lastMessageAt: string | null
  createdAt: string
  messages?: { role: string; content: string }[]
}

// ── Message Content (vision support) ─────────────────────────────────────────

export interface ImageAttachment {
  /** data URI, e.g. "data:image/png;base64,..." */
  dataUri: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  fileName?: string
  width?: number
  height?: number
}

export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; image: ImageAttachment }

/** Plain string for text-only messages, ContentBlock[] when images are included */
export type MessageContent = string | ContentBlock[]

/** Extract the text portion from a MessageContent value */
export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join(' ')
}

// ── Multimodal intake ──────────────────────────────────────────────

/** Kind of reference media a user attaches to an agent prompt. */
export type ReferenceMediaKind = 'image' | 'audio' | 'video' | 'doc'

/**
 * Reference media the user attaches to a prompt as inspiration/source ("make a
 * video like this"). Distinct from inline image `ContentBlock`s: reference media
 * is pre-digested into an `UnderstandingBrief` before the agent's first turn.
 * `uri` is the existing upload surface (`dreambyte://uploads/projects/<id>/<file>`).
 */
export interface ReferenceMedia {
  id: string
  kind: ReferenceMediaKind
  uri: string
  mimeType: string
  fileName?: string
  /** audio/video length in seconds (from ffprobe at upload time). */
  durationSec?: number
  width?: number
  height?: number
  /** sha256 of the file bytes (from upload). The media-analysis cache key —
   *  an altered file gets a new hash and re-analyzes. */
  contentHash?: string
}

/** Per-media analysis produced by an intake engine. All fields optional — an
 *  engine fills what it can and degrades to `{}` on error (never blocks a run). */
export interface MediaAnalysis {
  mediaId: string
  kind: ReferenceMediaKind
  /** VLM / audio caption of the media. */
  caption?: string
  /** Text recognized in the media (Florence-2 / VLM OCR, doc text). */
  ocrText?: string
  /** Dominant colors (hex), e.g. from Sharp on an image. */
  palette?: string[]
  /** Short phrase: the visual/auditory mood or tone. */
  mood?: string
  /** Key subjects/entities detected in the media. */
  subjects?: string[]
  /** Speech transcript (Whisper / Gemini audio). */
  transcript?: string
  /** Non-speech audio tags (Whisper-AT / CLAP / Gemini), label + confidence. */
  audioTags?: { label: string; score: number }[]
  /** Temporal structure for video/audio (seconds-precise). */
  events?: { start: number; end: number; description: string }[]
  /** Which engine/model produced this analysis (e.g. "ollama:qwen2.5vl", "gemini"). */
  backend: string
  /** Non-fatal note when the engine partially failed. */
  error?: string
}

/**
 * The synthesized "understanding brief" injected into the Master Builder before
 * its first turn so it plans/builds grounded in the attached reference media.
 */
export interface UnderstandingBrief {
  /** One-paragraph synthesis of what the user referenced. */
  summary: string
  visualStyle?: { palette?: string[]; mood?: string; typography?: string; notes?: string }
  narrative?: { transcriptExcerpt?: string; keyPoints?: string[] }
  subjects?: string[]
  /** Merged temporal structure across video/audio media. */
  timeline?: { t: number; description: string }[]
  /** Aspect/duration/tone hints derived from the media. */
  constraints?: string[]
  /** Raw per-media analyses backing the synthesis. */
  perMedia: MediaAnalysis[]
  /** Total USD spent producing this brief (charged to the run ledger). */
  costUsd: number
  /** Distinct engines/models used, for transparency in the UI. */
  modelsUsed: string[]
}

// ── Message Types ─────────────────────────────────────────────────────────────

/** A segment of a message — a text chunk, a tool call reference, or a completed
 *  reasoning block, in chronological order. Thinking is a first-class segment so
 *  each reasoning block renders BETWEEN the tool calls it happened between
 *  (Cursor-style narrate → think → act), not lumped at the end. */
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string }
  | { type: 'thinking'; text: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: MessageContent
  agentType?: AgentType
  modelId?: ModelId
  /** Tool calls made during this message */
  toolCalls?: ToolCallRecord[]
  /** Chronologically ordered segments of text and tool calls for interleaved display */
  contentSegments?: MessageSegment[]
  /** Token usage and cost tracking */
  usage?: UsageStats
  /** Extended thinking content (reasoning summary) */
  thinking?: string
  /** True while thinking tokens are still streaming */
  isThinkingStreaming?: boolean
  /** Generation log ID for quality signal feedback */
  generationLogId?: string
  /** User feedback rating: 1 = thumbs down, 5 = thumbs up */
  userRating?: number
  timestamp: number
  /** Permission requests that need user approval (from tool results with permissionNeeded) */
  pendingPermissions?: PendingPermission[]
  /** An ask_user clarify question that paused the run (from a tool result with
   *  clarificationNeeded). The resume payload is carried HERE on the message
   *  (like pendingPermissions.toolArgs) — not the singular pausedAgentRun — so a
   *  per-message card resumes correctly with multiple outstanding cards / after a
   *  reload, and a re-pause can't wipe it. */
  pendingClarification?: {
    id: string
    question: string
    options?: string[]
    toolName: string
    toolInput: Record<string, unknown>
    /** Set true once answered → the card renders a quiet resolved state and can't be re-fired. */
    answered?: boolean
  }
  /** Native-search citations accumulated across the message's tool calls. */
  sources?: ResearchSource[]
  /** Routing decision metadata, carried from the agent_routed SSE event. */
  routeMethod?: 'override' | 'default' | 'heuristic' | 'llm' | 'fallback'
  /** True when router was unavailable and a heuristic fallback was used. */
  routingFallback?: boolean
  /** True when the agent run was checkpointed (cost/tool/iteration cap hit). */
  hasCheckpoint?: boolean
  /** Why the checkpoint was taken. */
  checkpointReason?: 'cost_cap' | 'tool_limit' | 'iteration_limit'
  /** Scenes successfully built before the checkpoint. */
  checkpointScenesBuilt?: number
  /**
   * Explicit interrupted-run flag. Set when a message is loaded from
   * the DB still in status='streaming'/'aborted' with no live run — i.e. its
   * run was interrupted (crash, quit, kill mid-stream). Drives the explicit
   * "incomplete — run was interrupted" banner instead of the old fragile
   * content-string sniff, so a partial reply never looks like a finished one.
   */
  incomplete?: boolean
  /**
   * True when the run failed with a provider rate-limit / overload (429/529)
   * Drives the specific rate-limit banner + retry-after countdown
   * in the chat bubble instead of the generic "Server error" message. The live
   * countdown itself is transient component state keyed by this message id.
   */
  rateLimited?: boolean
  /**
   * The run ended in an error (not a clean completion, not a
   * user-stop). The runner emits an error event THEN a done event, and the done
   * handler used to overwrite the error text with the model's last (often empty
   * or upbeat) fullText — so failures rendered as success. With this flag set,
   * the error text survives `done`, a run-level error strip renders, and the
   * message persists with status:'error'.
   */
  errored?: boolean
}

export interface PendingPermission {
  api: string
  estimatedCost: string
  toolName: string
  resolved?: 'allow' | 'deny'
  /**
   * Discriminator. Default 'paid_api' (the legacy permission flow that
   * gated TTS / image / avatar spend). 'mutation_preview' is the
   * destructive-tool gate — for tools tagged with
   * `mutates`, the args ARE the proposed change and the user accepts /
   * rejects before the tool runs. 'web_search' is the one-time per-session search
   * approval (proxy: request_web_search) used when Auto-Accept Web Search is off.
   */
  kind?: 'paid_api' | 'mutation_preview' | 'web_search' | 'biometric_consent'
  /** For mutation_preview: which slice of state this writes to. */
  mutationScope?: 'scene' | 'project' | 'asset'
  /** For biometric_consent (Tier 3 Cast voice clone): the named third party the sample goes to,
   *  the consent text version to record, the voice name, and the consent copy — used to render the
   *  consent card and to record consent on approve. */
  destination?: string
  consentVersion?: string
  voiceName?: string
  reason?: string
  // Rich generation context for the universal confirmation card
  generationType?: import('../types').GenerationType
  prompt?: string
  provider?: string
  availableProviders?: import('../types').GenerationProviderOption[]
  config?: Record<string, any>
  toolArgs?: Record<string, any>
  // User overrides set via the card's dropdowns
  userOverrides?: {
    provider?: string
    prompt?: string
    config?: Record<string, any>
  }
}

export interface UsageStats {
  /** Total input tokens across all iterations */
  inputTokens: number
  /** Total output tokens across all iterations */
  outputTokens: number
  /** Number of Claude API calls made (including multi-turn tool loops) */
  apiCalls: number
  /** Estimated cost in USD */
  costUsd: number
  /** Duration of entire agent run in ms */
  totalDurationMs: number
  /** 'claude-code' | 'codex-cli' when run via CLI subprocess; undefined for API calls */
  provider?: string
  /** Tokens written into the prompt cache (charged at 1.25× input rate). */
  cacheCreationTokens?: number
  /** Tokens served from the prompt cache (charged at 0.1× input rate). */
  cacheReadTokens?: number
}

export interface ToolCallRecord {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: ToolResult
  /** ms elapsed */
  durationMs?: number
  /** Renderer-side inline diff for code-writing tools. Only
   *  attached when the inline-diffs setting is on; bounded by line-diff's
   *  output caps so persisted chat records stay small. */
  codeDiff?: import('../utils/tool-code-diff').ToolCodeDiff
}

// ── SSE Events ────────────────────────────────────────────────────────────────

/**
 * One whole-scene-redundancy cut candidate proposed by the post-build cut
 * review (Gap 3.1). The agent RECOMMENDS; the user disposes. The client opens a
 * review card, re-reads live `world.scenes` (a proposed `sceneId` may have
 * vanished), and applies the approved subset via the cascade-safe `delete_scene`.
 */
export interface StructuralCut {
  /** Scene the review flagged as redundant. The card drops it if it no longer
   *  exists at apply time (live re-read). */
  sceneId: string
  /** Scene name at proposal time, for display. */
  sceneName: string
  /** The reviewer's specific observation (e.g. "repeats scene 1"). */
  detail: string
  /** Finding kind that produced the cut (always 'redundancy' in v1). */
  kind: string
}

/** Why a run loop stopped structurally (the 'run_stopped' event).
 *  Every value maps to a break in runner.ts that used to end the run silently. */
export type RunStopReason =
  | 'cost_cap' // shared RunCostLedger hit the per-run USD cap
  | 'tool_call_cap' // cumulative tool calls hit the per-run cap
  | 'round_cap' // the iteration cap exhausted with work remaining — previously looked like normal completion
  | 'stuck_invalid_args' // the model produced invalid tool arguments and the loop stopped
  | 'stuck' // the model repeated tool calls with no state delta — no-progress guard fired
  | 'checkpoint_save_failed' // a run checkpoint could not be persisted after retry — resume may be unavailable

/** Why runAgent's loop ended — threaded out on the runner's RETURN object
 *  so the service layer above can make lifecycle decisions (the
 *  checkpoint clear) instead of being blind to how the run stopped. Distinct
 *  from RunStopReason (the `run_stopped` SSE event), which only covers
 *  structural mid-run stops; this covers EVERY exit incl. normal completion. */
export type AgentRunStopReason =
  | 'completed' // model finished (end_turn / plan pause / orchestrated handoff / dispatch)
  | 'cost_cap' // per-run USD cap (top-of-loop or post-tool check)
  | 'tool_call_cap' // per-run tool-call cap
  | 'round_cap' // iteration cap exhausted with work remaining
  | 'aborted' // client disconnect / user stop / permission pause (run expects a follow-up)
  | 'stuck_invalid_args' // invalid-tool-args structural stop
  | 'stuck' // no-progress loop guard fired (repeated no-delta tool calls)
  | 'error' // unhandled error — attached to the thrown error as `_stopReason` (the promise rejects)

export type SSEEventType =
  | 'run_start' // first event — carries runId for correlation
  | 'agent_routed' // agent selected — front-loaded before any content streams
  | 'thinking' // agent is routing/planning (no visible text yet)
  | 'thinking_start' // extended thinking block started
  | 'thinking_token' // streamed thinking token
  | 'thinking_complete' // extended thinking block finished
  | 'token' // streamed text token
  | 'iteration_start' // new tool-loop iteration starting
  | 'tool_start' // tool call beginning
  | 'tool_complete' // tool call finished with result
  | 'plan_proposed' // write_plan succeeded; client renders/updates the plan card
  | 'structural_cuts_proposed' // post-build cut review found whole-scene-redundancy cuts; client opens the structural-cuts review card (Gap 3.1). UI-only — never emitted headless.
  | 'fanout_proposed' // agent called dispatch_to_branches; client runs N variant builds via the variant pipeline. UI-only — terminal, ends the run.
  | 'crossproject_proposed' // agent called dispatch_to_projects; client picks target projects + fires dreambyte:agent.dispatchProjects. UI-only — terminal, ends the run.
  | 'todos_updated' // update_todos succeeded; client refreshes the plan card checklist
  | 'preview_update' // scene HTML was regenerated
  | 'state_change' // world state mutated
  | 'selection_trace' // deterministic per-scene skill-injection trace, emitted once at the start of the orchestrated build (plan phase). Soft signal — no UI panel yet; client may ignore.
  | 'sub_agent_start' // orchestrator starting a sub-agent for a scene
  | 'sub_agent_complete' // sub-agent finished building a scene
  | 'run_progress' // live progress update (tool count, cost, iteration)
  | 'intake_started' // reference-media intake began
  | 'intake_complete' // understanding brief ready
  | 'error' // error occurred
  | 'warning' // non-fatal warning (e.g. checkpoint load failure)
  | 'run_stopped' // the run loop stopped for a structural reason (cap hit, invalid tool args, checkpoint save failure) — carries stopReason so the client can explain WHY instead of ending silently
  | 'sources' // native-search citations from Anthropic / OpenAI / Gemini grounding
  | 'capture_request' // server asking client to render + return a frame screenshot
  | 'clip_request' // server asking client to export ONE scene to a low-res MP4 + return the bytes
  | 'export_request' // server asking client to render the project to MP4 headlessly + return the path
  | 'steer_consumed' // a mid-run steer was drained into a turn (client marks the queued message delivered)
  | 'steer_unconsumed' // a queued steer was never reached before the run ended (client resends it)
  | 'heartbeat' // keepalive ping during long operations
  | 'persist_done' // scenes persisted to DB for this run (success/error/abort) — out-of-band-forwarded so the renderer's post-run refresh waits for the durable write instead of racing it
  | 'done' // stream complete

export interface SSEEvent {
  type: SSEEventType
  /** For 'run_start' events — correlation ID for the entire run */
  runId?: string
  /** For 'agent_routed' events — routing decision metadata */
  routeMethod?: 'override' | 'default' | 'heuristic' | 'llm' | 'fallback'
  focusedSceneType?: string
  toolCount?: number
  /** For 'token' and 'thinking_token' events */
  token?: string
  /** For 'thinking_complete' events — full reasoning text */
  fullThinking?: string
  /** For 'iteration_start' events */
  iteration?: number
  maxIterations?: number
  /** For 'tool_start' events */
  toolName?: string
  toolInput?: Record<string, unknown>
  /** For 'tool_complete' events */
  toolResult?: ToolResult
  /** For 'plan_proposed' — the written plan (+ todos) for the plan card */
  plan?: AgentPlan
  /** For 'structural_cuts_proposed' — whole-scene-redundancy cut candidates the
   *  user reviews + approves in the structural-cuts card (Gap 3.1). */
  cuts?: StructuralCut[]
  /** For branch-scoped proposal events ('structural_cuts_proposed') — the
   *  branch this proposal targets (null = default)
   *  and the post-write branch_proposals.version. The client applies the card
   *  only when branchId === active branch AND version > its local row (0015), so
   *  a mid-run branch switch or a late/out-of-order event can't land stale state. */
  branchId?: string | null
  version?: number
  /** For 'fanout_proposed' — how many alternative takes to spawn, the
   *  per-branch build instruction, and the branch to fork from (null = default). */
  fanout?: { count: number; instruction: string; sourceBranchId: string | null }
  /** For 'crossproject_proposed' — the broadcast instruction; the
   *  renderer picks the target projects (user-confirmed) then fires
   *  dreambyte:agent.dispatchProjects. */
  crossProject?: { instruction: string }
  /** For 'todos_updated' — the current todo checklist */
  todos?: AgentTodo[]
  /** For 'selection_trace' — the deterministic per-scene skill-injection
   *  trace for the orchestrated build (which guides are injected per planned
   *  scene + any soft sceneType↔bridge mismatch). The structured attach for the
   *  run; `message` carries the compact human-readable block. */
  selectionTrace?: SceneSelectionTrace[]
  /** For 'preview_update' events */
  sceneId?: string
  /** For 'state_change' events */
  changes?: StateChange[]
  /** For 'error' and 'warning' events */
  error?: string
  /** For 'warning' and 'run_stopped' events — human-readable description */
  message?: string
  /** For 'run_stopped' events — why the loop stopped. The
   *  stop is NOT an error: caps and stuck-detection are guardrails working as
   *  designed; checkpoint_save_failed warns that resume may be unavailable. */
  stopReason?: RunStopReason
  /** For 'persist_done' events — whether the post-run DB persist succeeded.
   *  The renderer waits for this (or a version-poll fallback) before refreshing
   *  the project from the server, so an error/abort can't revert-then-haunt. */
  persistOk?: boolean
  /** For 'done' events */
  agentType?: AgentType
  modelId?: ModelId
  /** Full accumulated text on 'done' */
  fullText?: string
  toolCalls?: ToolCallRecord[]
  /** Token usage and cost for 'done' events */
  usage?: UsageStats
  /** For 'done' on a PAUSE (permission / clarification): the CUMULATIVE run-chain
   *  spend (this run's cost + the resumeSpentUsd it started with), so a resume can
   *  seed its cost ledger and the cap can't be re-granted fresh each pause.
   *  `usage.costUsd` is this-run-only; this is the carry-across-pause figure. */
  ledgerSpentUsd?: number
  /** Generation log ID for quality signal feedback */
  generationLogId?: string
  /** Updated scenes array (on final state_change) */
  updatedScenes?: Scene[]
  /** Updated global style (on final state_change) */
  updatedGlobalStyle?: GlobalStyle
  /** Updated scene graph (on final state_change) */
  updatedSceneGraph?: SceneGraph
  /** Updated project watermark (on final state_change). Only present
   *  when add_watermark ran in this run — undefined otherwise so the renderer
   *  never clobbers an existing project watermark. */
  updatedWatermark?: import('../types/media').WatermarkConfig
  /** Updated NLE timeline (on final state_change; v6 TIMELINE B2). Present only
   *  when a timeline tool ran this run — undefined otherwise so the renderer
   *  (use-agent-run → applyAgentTimeline) never clobbers an existing timeline. */
  updatedTimeline?: import('../types').Timeline | null
  /** For 'run_progress' events — live execution stats */
  runProgress?: {
    toolCallsUsed: number
    toolCallsMax: number
    costUsd: number
    costMax: number
    /** Cumulative tokens so far — lets the client synthesize a usage footer for
     *  an ABORTED run (which never receives the final `done` usage). */
    inputTokens?: number
    outputTokens?: number
    iteration: number
    iterationMax: number
    /** Coarse build phase derived from the current tool name */
    phase?: 'plan' | 'style' | 'build' | 'polish' | 'unknown'
    scenesCreated?: number
    scenesVerified?: number
    errors?: number
    budgetAlert?: string
  }
  /** For 'sub_agent_start' / 'sub_agent_complete' events */
  subAgentId?: string
  subAgentSceneIndex?: number
  subAgentTotal?: number
  subAgentSceneName?: string
  subAgentSuccess?: boolean
  /** For 'sources' events — normalised citations from native-search providers */
  sources?: ResearchSource[]
  /** Which provider produced the citations in a 'sources' event */
  sourceProvider?: 'anthropic' | 'openai' | 'google'
  /** For 'capture_request' events — correlation ID the client POSTs back with the image */
  captureId?: string
  /** For 'capture_request' events — time (seconds) within the scene to capture */
  captureTime?: number
  /** For 'steer_consumed' / 'steer_unconsumed' events — the queued steer ids this
   *  event resolves (delivered, or to be resent). */
  ids?: string[]
  /** For 'clip_request' events — correlation ID the client POSTs back with the MP4 bytes */
  clipId?: string
  /** For 'clip_request' events — longest output dimension for the low-res review clip */
  maxRes?: number
  /** For 'clip_request' events — frame rate for the review clip */
  fps?: number
  /** For 'export_request' events — correlation ID the client POSTs back with the output path */
  exportId?: string
  /** For 'export_request' events — render settings the client passes to exportVideo */
  exportSettings?: { resolution?: '720p' | '1080p' | '4k'; fps?: number }
  /** For 'intake_started' events — number of reference media items being analyzed */
  count?: number
  /** For 'intake_complete' events — cost + engines used producing the brief */
  costUsd?: number
  modelsUsed?: string[]
}

/**
 * Normalised citation shape for native-search results. Each provider (Anthropic
 * `web_search_tool_result`, OpenAI `url_citation` annotations, Gemini `groundingMetadata`)
 * gets adapted into this before hitting the SSE stream, so the UI renders a single shape.
 */
export interface ResearchSource {
  url: string
  title?: string
  /** Optional excerpt — may be the quoted text the model cited. */
  snippet?: string
  /** Which native-search provider produced this source. */
  provider: 'anthropic' | 'openai' | 'google'
  /** Which iteration / tool call emitted it, for grouping. */
  toolUseId?: string
}

// ── Tool Execution ────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  affectedSceneId?: string | null
  changes?: StateChange[]
  error?: string
  /** True when the failure is a user Stop (run abort), not a genuine tool
   *  error. The canonical abort marker: UI renders these as a neutral
   *  "Cancelled" (not a red error), and retry/progress accounting branches
   *  on this flag instead of substring-matching the four abort messages. */
  aborted?: boolean
  data?: unknown
  /**
   * Actual USD cost this tool incurred. Stamped by the runner after the
   * tool runs, drained from the per-world media-spend accumulator that
   * `commitMediaSpend` feeds. The runner commits this into the run cost ledger so
   * a media/generation tool's spend binds against the RUN cap (previously only
   * LLM token cost did — a media-only run could bill past the cap and never stop).
   * Absent/0 for tools that incur no direct paid spend.
   */
  costUsd?: number
  /** When a tool is blocked by permission settings, includes the API + cost so the UI can prompt */
  permissionNeeded?: {
    api: string
    estimatedCost: string
    /** Scalar USD cost estimate that triggered the gate. Populated when the
     *  cost approval gate was engaged; otherwise optional. */
    estimatedCostUsd?: number
    /** True when this prompt fired because the scalar estimate exceeded the
     *  project's single-call threshold, even though the per-API mode would
     *  normally auto-allow. Lets the UI render a distinct "Expensive call" UX. */
    costThresholdExceeded?: boolean
    reason?: string
    details?: {
      prompt?: string
      duration?: number
      model?: string
      resolution?: string
      textLength?: number
    }
    // Rich context for the universal generation confirmation card
    generationType?: import('../types').GenerationType
    prompt?: string
    provider?: string
    availableProviders?: import('../types').GenerationProviderOption[]
    config?: Record<string, any>
    toolArgs?: Record<string, any>
    /** Diff-preview gate. Discriminator + scope. Set to
     *  'mutation_preview' when a destructive tool was intercepted before
     *  execution. Default 'paid_api' (legacy spend gate). */
    kind?: 'paid_api' | 'mutation_preview' | 'web_search' | 'biometric_consent'
    mutationScope?: 'scene' | 'project' | 'asset'
    /** The tool that was paused. Always set when kind is 'mutation_preview'
     *  so the UI can render `<toolName> on <sceneId>` headlines and the
     *  resume path knows what to re-dispatch. */
    toolName?: string
    /** Tier 3 Cast biometric_consent gate: the named third party the voice sample goes to, the
     *  consent text version to record, and the voice name. Rendered as an in-chat consent card;
     *  approving records consent for (project, destination) and resumes the run. Fail-closed —
     *  no sample is sent until consent is recorded. */
    destination?: string
    consentVersion?: string
    voiceName?: string
  }
  /**
   * Set by the `ask_user` clarify tool when it needs a human answer. The runner
   * treats this like `permissionNeeded`: it pauses the run (checkpoint survives,
   * stopReason 'aborted') and surfaces a clarification card. The user's answer
   * comes back as a resumeToolCall run with `_answer` in the tool input, and the
   * handler then returns the answer as its result so the loop continues.
   */
  clarificationNeeded?: {
    /** Stable id for the card (derived from the question). */
    id: string
    /** The question to put to the user. */
    question: string
    /** Optional quick-pick options; free-text is always allowed too. */
    options?: string[]
  }
}

export interface StateChange {
  type: 'scene_updated' | 'scene_created' | 'scene_deleted' | 'global_updated' | 'project_updated' | 'ui_action'
  sceneId?: string
  /** Human-readable description of what changed */
  description: string
}

// ── Context Building ──────────────────────────────────────────────────────────

export interface ContextOpts {
  agentType: AgentType
  activeTools: string[]
  /**
   * Strict tool allowlist. When set (non-empty), the agent is offered EXACTLY these
   * tools (intersected with what exists for the agent + research gating), bypassing
   * the category-enable semantics of `activeTools`. Used by typed sub-agents
   * (Explore/Plan/Verification) to enforce a read-only / narrowed toolset — without
   * it, the always-available base toolset (incl. mutating tools) leaks through.
   */
  toolAllowlist?: string[]
  /** True when this context is for a SUB-AGENT run. Parent-only
   *  tools (the dispatch_* family — all execution-guarded no-ops inside a
   *  sub-agent) are stripped from the offered schemas: pure token savings,
   *  zero capability change, and execution-time enforcement then rejects a
   *  stray call with a clear error instead of a silent no-op. */
  isSubAgent?: boolean
  /** True when THIS run may delegate build work to sub-agents. Resolved by the
   *  runner from `RunConfig.subAgents` (Settings → Agents) OR an explicit ask in
   *  the user's message. Default (absent/false) = SINGLE-AGENT: the parent builds
   *  every scene in its own loop, `SUB_AGENT_BUILD_TOOL_NAMES` are stripped from
   *  the offered schemas, and the prompt's delegation section is swapped for the
   *  build-it-yourself copy. */
  subAgentsEnabled?: boolean
  /** Read-only research sub-agent (Explore/Plan): swap the ~95K-char builder
   *  system prompt for a lean research prompt. Cuts tokens and, critically, stops
   *  the full prompt from swamping small local research models (a 7B emits no
   *  tool calls under the full prompt). Set by runScopedSubAgent for research types. */
  leanResearchPrompt?: boolean
  sceneContext: 'all' | 'selected' | string
  focusedSceneId?: string | null
  audioProviderEnabled?: Record<string, boolean>
  mediaGenEnabled?: Record<string, boolean>
  /** Web Search switch — gates web_search (native, model-gated) + stock/archival media search. */
  webSearchEnabled?: boolean
  /** Web Fetch switch — gates fetch_url_content + fetch_video_from_url (our code, all models). */
  webFetchEnabled?: boolean
  /** Auto-Accept Web Search — when false, native web_search is withheld until session-approved. */
  autoAcceptWebSearch?: boolean
  /** Session allow/deny cache. `sessionPermissions['web_search'] === 'allow'` unlocks search
   *  when Auto-Accept is off. */
  sessionPermissions?: Record<string, string>
  /** User model registry — lets native-search detection resolve user-configured models
   *  (falls back to DEFAULT_MODELS when absent). */
  modelConfigs?: import('./model-config').ModelConfig[]
  /** Per-provider enabled map for media providers (pexels, pixabay, unsplash, archive-org…). */
  researchProviderEnabled?: Record<string, boolean>
  projectAssets?: import('../types').ProjectAsset[]
  mp4Settings?: import('../types').MP4Settings
  brandKit?: import('../types/media').BrandKit | null
  /** OKF Layer 0 — project intent / the compass. Injected into every agent turn
   *  as "## Project Brief" (advisory). */
  projectBrief?: import('../types').ProjectBrief | null
  /** When true, the scorer drops client-only providers (web-speech, puter)
   *  so MP4 exports don't end up silent. Mirrors `world.localMode`. */
  localMode?: boolean
  /** Most-recent user message in the conversation. Used by the context
   *  builder to match a pipeline playbook and inject its guidance. */
  latestUserMessage?: string
  /** Pre-rendered user-authored rules block (Settings → Rules). Built async by
   *  the runner via buildRulesSection() and injected into the prompt cascade so
   *  both the Claude Code and API-agent paths receive it. Empty/undefined = none. */
  rulesSection?: string
  /** Project timeline (read-only) when available. Used by the world-state
   *  summarizer to surface effective (user-trimmed) scene durations. When
   *  the TIMELINE lane seeds `world.timeline`, the runner threads it here. Absent
   *  → scene summaries use scene.duration unchanged (regression-safe). */
  timeline?: import('../types').Timeline | null
}

export interface WorldState {
  projectName: string
  outputMode: 'mp4' | 'interactive'
  globalStyle: GlobalStyle
  sceneCount: number
  totalDuration: number
  scenes: SceneSummary[]
  /** Full scene data for the focused scene */
  focusedScene?: Scene | null
}

export interface SceneSummary {
  id: string
  name: string
  prompt: string
  summary: string
  sceneType: string
  duration: number
  /**
   * Effective played duration in seconds when the scene's V1 timeline clip has
   * been trimmed by the user (clip.duration < scene.duration, or any non-default
   * trim). Undefined when no timeline is available or the clip plays in full —
   * the agent then uses `duration`. Lets the agent stop re-timing footage a user
   * already cut. See context-builder summarizeScene.
   */
  effectiveDuration?: number
  bgColor: string
  layerCount: number
  hasAudio: boolean
  hasVideo: boolean
  transition: string
  interactionCount: number
}

export interface AgentContext {
  systemPrompt: string
  /** Static portion of the system prompt (agent persona + rules). Stable across turns → cacheable. */
  staticPrompt: string
  /** Dynamic portion (world state, scenePlan, run progress). Changes per turn → not cached. */
  dynamicPrompt: string
  /** The run-stable cascade half of dynamicPrompt (brief · style · craft menu · scene
   *  plan · world state). Rebuilt only on refresh, so it gets its OWN cache breakpoint. */
  stableCascade?: string
  /** Uncached tail — empty unless the runner appends a per-turn directive (plan-first mode). */
  volatileState?: string
  worldState: WorldState
  tools: ClaudeToolDefinition[]
  maxTokens: number
  modelId: ModelId
  thinkingMode: ThinkingMode
  promptDocs?: Array<{
    id: string
    title: string
    relativePath: string
    hash: string | null
    chars: number
    loaded: boolean
    truncated: boolean
    error?: string
  }>
}

// ── Claude API Tool Schema ────────────────────────────────────────────────────

export interface ClaudeToolDefinition {
  name: string
  /** Absent for provider-native server tools (e.g. Anthropic's web_search_20250305). */
  description?: string
  /** Absent for provider-native server tools. */
  input_schema?: {
    type: 'object'
    properties: Record<string, ClaudePropertySchema>
    required?: string[]
  }
  /** Set to Anthropic server-tool type (e.g. "web_search_20250305") to delegate execution to the provider. */
  type?: string
  /** Server-tool config — how many calls the model can make per turn. */
  max_uses?: number
  /**
   * When true, this tool is kept in the dispatch registry so existing
   * scripts / MCP callers / older agent runs still work, but it is
   * filtered out of every per-agent tool subset so new agent turns no
   * longer see it. Description should start with `[DEPRECATED]` and name
   * the canonical replacement.
   *
   * Use this when there are multiple tools doing the same job and we want
   * the agent to converge on one. Filtering instead of deletion preserves
   * backward compatibility while shrinking the schema-token cost paid on
   * every prompt.
   */
  deprecated?: boolean
  /**
   * When set, this tool mutates project state. In `previewMode`, the
   * runner intercepts the call before execution and surfaces it to the
   * user as a pending mutation (Cursor-style accept/reject). For tools
   * where the args ARE the proposed change (write_scene_code's new code,
   * delete_scene's target id, etc.) the args alone are enough preview
   * material — no need to dry-run.
   *
   * Scope:
   * - 'scene'    — modifies scene/layer/element/clip state
   * - 'project'  — modifies cross-scene config (global style, brand kit)
   * - 'asset'    — modifies the media library
   *
   * Tools that re-run the LLM internally (regenerate_layer, generate_chart)
   * are intentionally NOT tagged in the first cut — preview-then-execute
   * for those needs a dry-run mechanism that's deferred.
   */
  mutates?: 'scene' | 'project' | 'asset'
}

export interface ClaudePropertySchema {
  /** Optional so "any type" fields (e.g. a default value matching a caller-specified type) can omit it. */
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'
  description?: string
  enum?: string[]
  items?: ClaudePropertySchema
  properties?: Record<string, ClaudePropertySchema>
  required?: string[]
  /** Combined type notation for nullable fields */
  anyOf?: ClaudePropertySchema[]
}

// ── ScenePlan ───────────────────────────────────────────────────────────────

/** A single scene in the Director's scenePlan plan */
export interface SceneSpec {
  /**
   * Stable identifier used to match the same scenePlan scene across
   * proposals/edits for diff + per-scene revert.
   */
  id?: string
  name: string
  purpose: string
  sceneType: string
  duration: number
  transition?: string
  /** Draft narration text — used to calculate duration via word count formula */
  narrationDraft?: string
  /** Key visual elements to include in this scene */
  visualElements?: string
  /** The scene's shot list (Lane 1 — quality by construction). Always present on a
   *  planned scene: plan_scenes derives it from the narration when the agent didn't
   *  author one, so the sub-agent builds against explicit beats/stations rather than
   *  improvising FLOW. See src/lib/agents/storyboard.ts. */
  storyboard?: StoryboardBeat[]
  /** Sound effect or music cues */
  audioNotes?: string
  /** The committed visual form for this beat (set by the art_direct pass, not plan_scenes).
   *  This is the load-bearing decision: it routes skill/tool injection (chart→D3 guide +
   *  generate_chart) AND drives the build-time acceptance check (a 'chart' beat that ships
   *  CSS text fails acceptance → corrective rebuild). 'text' is the last resort. */
  visualForm?: 'chart' | 'imagery' | 'diagram' | '3d' | 'stat' | 'text'
  /** Chart specification if this scene uses D3/DreambyteCharts */
  chartSpec?: { type: string; dataDescription: string }
  /** Planned media overlays: avatar PIP, background music, stock images, etc. */
  mediaLayers?: string
  /** Planned camera motion: kenBurns, cinematicPush, orbit, etc. */
  cameraMovement?: string
  /** For 3d_world scene type: which environment */
  worldEnvironment?: string
  /**
   * Explicit continuity hand-off to the NEXT scene. How this beat
   * passes the baton: a `match-cut` (open the next on the same shape/position),
   * `zoom-into` (push into a detail the next scene starts on), `motif-return`
   * (a recurring visual comes back), or a plain `hard-cut`. Consumed by
   * buildContinuityContext; positional inference is the fallback when absent.
   */
  handoffToNext?: { type: 'match-cut' | 'zoom-into' | 'hard-cut' | 'motif-return'; note?: string }
  /**
   * Concrete visual elements/motifs this scene passes FORWARD to
   * the next (e.g. "the orange arrow", "the grid background"). The next builder
   * is told to carry them so the cut feels continuous, not a hard reset.
   */
  carriedElements?: string[]
}

/**
 * A deterministic, per-planned-scene record of which skill
 * guides the orchestrator injects into the scene-builder sub-agent and why. Built
 * at SELECTION time (pre-build) from pure keyword rules + the skill registry,
 * emitted as a compact plan-phase SSE block and logged with the run.
 *
 * A SOFT signal: `override` surfaces a sceneType↔bridge mismatch (e.g. a react
 * scene leaning on a 3D bridge) so a human/inspector can see it — but the
 * planner's `sceneType` is NEVER changed by this trace.
 */
export interface SceneSelectionTrace {
  /** Planned scene id (falls back to the scene name when the plan omits an id). */
  sceneId: string
  /** The planner's chosen sceneType (usually 'react', the product default). */
  sceneType: string
  /** Skill ids injected into the sub-agent prompt (base renderer + bridges, deduped). */
  injected: string[]
  /** Skill ids pulled in by bridge-keyword rules (a subset of `injected`). */
  bridgeHints: string[]
  /**
   * FLOW soft-signal warnings. Reserved at selection time — there is no scene
   * code yet — so this is empty here; the post-build FLOW scan in
   * quickValidateScene surfaces these downstream (kept in the shape so the trace
   * is the single per-scene record).
   */
  flowWarnings: string[]
  /**
   * Set ONLY on a soft sceneType↔bridge mismatch (the planner kept one sceneType
   * but bridge intent injected a guide for a different renderer). A human-readable
   * note — NOT an applied override; the planner's sceneType is left untouched.
   */
  override?: string
  /**
   * Auto-load read path: the id of the distilled `style` skill injected
   * project-wide into this scene's prompt (top-1 match by intent), or null when
   * no distilled style matched. Same value across every scene in a run (project-
   * wide selection) — recorded per-scene so the trace stays the single record.
   */
  styleApplied?: string | null
}

/** Complete scenePlan produced by plan_scenes */
export interface ScenePlan {
  title: string
  /** The reasoned through-line: how this specific video comes to life as ONE seamless
   *  piece — the spine, what carries across cuts, the researched facts it's grounded in.
   *  Authored by plan_scenes and injected into the scene-builders' prompt (the reasoning
   *  surface the builder actually reads, vs the discarded write_plan prose). */
  approach?: string
  scenes: SceneSpec[]
  totalDuration: number
  styleNotes?: string
  /** Auto-detected feature flags based on content type */
  featureFlags?: {
    narration: boolean
    music: boolean
    sfx: boolean
    interactions: boolean
  }
}

/**
 * A single tracked todo item in the agentic plan surface. The status
 * is the lifecycle the UI renders as an icon SHAPE (non-color, a11y) in the plan
 * card checklist: pending → in_progress → completed (or failed). Mirrors the
 * Claude-Code/Cursor written-plan + todo-list model.
 */
export interface AgentTodo {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

/**
 * The agentic plan artifact. A free-form markdown plan the agent writes
 * via `write_plan`, plus a tracked todo list it maintains via `update_todos`.
 * This is the USER-FACING planning artifact (the plan card). It does NOT replace
 * the `plan_scenes` scenePlan — that is the STRUCTURED build spec the scene-builders
 * consume and `dispatch_scene_builder` requires; the agent authors it via `plan_scenes`
 * (there is no silent derivation from this prose plan). The plan is a written artifact, not a form: the
 * user revises it by replying in chat (reply-to-revise, UI-1), not by editing
 * fields inline.
 */
export interface AgentPlan {
  /** Short title shown in the plan card header. */
  title: string
  /** Free-form markdown plan body, rendered in the card and collapsed after approval. */
  body: string
  /** Epoch ms when the plan was (re)written. A re-issued write_plan supersedes the prior one. */
  createdAt: number
}

/**
 * TaskPacket — the structured contract handed to a scene-builder sub-agent when
 * the unified agent delegates via `dispatch_scene_builder`. Instead of a
 * free-form prompt that lets a sub-agent roam the whole scenePlan, each packet
 * pins the sub-agent to ONE scene: the scope it owns (which scene id it may
 * mutate), the acceptance criteria (the scenePlan's intent for that scene), and
 * the verification it must satisfy before reporting done. This prevents
 * cross-scene stomping and makes "done" objective.
 */
export interface TaskPacket {
  /** Scope: the scene this sub-agent owns. null when it must create the scene
   *  itself (no shell existed). It may only mutate this scene (and the one it
   *  creates); other scenes are read-only context. */
  sceneId: string | null
  sceneName: string
  sceneType: string
  /** Acceptance: the scenePlan's purpose/intent for this scene. */
  purpose: string
  /** The scene's storyboard (shot list) — rendered into the sub-agent prompt as a
   *  MANDATORY beat sequence the built scene must realize (camera travels the stations). */
  storyboard?: StoryboardBeat[]
  /** Concrete acceptance criteria derived from the scenePlan scene, rendered
   *  into the sub-agent's prompt (visual elements present, narration added,
   *  chart rendered, etc.). Prose — the bar the sub-agent reads. */
  acceptanceCriteria: string[]
  /** The machine-checkable subset of the above. After the sub-agent returns,
   *  the orchestrator evaluates these against the built scene objectively
   *  (structural, not semantic) and surfaces any unmet ones — so "done" isn't
   *  taken on the sub-agent's word alone. */
  checks: AcceptanceCheck[]
  /** Verification plan the sub-agent must satisfy before reporting done. */
  verification: string
  /** Set on an auto-redispatch (corrective) pass: the specific problems a prior
   *  build of this scene left unresolved (verify_scene issues + unmet acceptance
   *  criteria). When present the sub-agent is told to fix THESE in place rather
   *  than build from scratch. */
  priorIssues?: string[]
}

/** Structural acceptance checks the orchestrator can evaluate against a built
 *  Scene without a model or vision. Semantic criteria (e.g. "renders a bar
 *  chart growing") are intentionally NOT here — those stay with verify_scene /
 *  vision review. */
// 'imagery'/'3d' are the visualForm siblings of 'chart' — the two forms besides chart
// that have an objective structural signature separating a real build from a CSS fake
// (placed media vs a gradient; a Three.js layer vs a flat div). 'diagram' and 'stat' are
// deliberately NOT gate kinds: a boxes-and-arrows diagram or a big-number stat is
// legitimately buildable in pure JSX/CSS, so a structural gate there would false-reject
// valid scenes and spin the corrective loop (same caution as the chart data-shape check).
export type AcceptanceCheckKind = 'content' | 'narration' | 'chart' | 'imagery' | '3d' | 'duration' | 'transition'

export interface AcceptanceCheck {
  kind: AcceptanceCheckKind
  /** Human-readable label, surfaced when the check is unmet. */
  label: string
  /** For `kind: 'duration'` — the plan's per-scene duration (seconds). The check
   *  fails only when the built scene runs materially longer than this AND that
   *  length isn't explained by a voiceover (VO-driven growth is legitimate and
   *  exempt — clamping it would truncate audio). */
  expectedDuration?: number
  /** For `kind: 'transition'` — the specific transition the plan called for.
   *  Set only when the plan specified a non-default transition, so the check
   *  fires on a real mismatch (e.g. a `set_all_transitions` clobber to
   *  `dissolve`) rather than on every scene. */
  expectedTransition?: string
}

// ── Compaction Config ────────────────────────────────────────────────────────

/** Configuration for session compaction — controls how older messages are
 *  summarized and how much recent context is preserved verbatim. */
export interface CompactionConfig {
  /** Number of recent messages to keep verbatim (default: 8) */
  preserveRecent: number
  /** Token threshold that triggers compaction (default: 6000) */
  maxTokens: number
  /** Include scene state (types, completion) in summary (default: true) */
  includeSceneState: boolean
}

// ── Run Progress ─────────────────────────────────────────────────────────────

/** Tracks progress within an agent run — injected into context each iteration
 *  so the agent can see what it has done and what remains. */
export interface RunProgress {
  /** Current phase: plan → style → build → polish */
  phase: 'plan' | 'style' | 'build' | 'polish' | 'unknown'
  /** How many scenePlan scenes have been created (if scenePlan exists) */
  scenesPlanned: number
  scenePlanScenesBuilt: number
  /** Tool budget tracking */
  iterationsUsed: number
  iterationsMax: number
  toolCallsTotal: number
  /** Errors encountered and whether they were resolved */
  errors: Array<{ tool: string; error: string; resolved: boolean }>
  /** Scene IDs created during this run */
  scenesCreated: string[]
  /**
   * Scene IDs EDITED in place during this run (write_scene_code on an
   * existing scene, patch_layer_code) — distinct from scenesCreated, so the
   * honest run footer can report "N created · M edited" instead of conflating
   * edits with creations. A scene appears at most once. Optional so existing
   * RunProgress literals (tests, checkpoint snapshots) don't all need updating;
   * the runner's live RunProgress always initializes it to [].
   */
  scenesEdited?: string[]
  /** Scene IDs that have been verified (via verify_scene) */
  scenesVerified: string[]
  /** Scene IDs that have narration added */
  scenesWithNarration: string[]
  /**
   * Verification self-correction budget. Each FAILED verify_scene call
   * (`success: false`) costs one cycle. Once `verificationCyclesUsed`
   * reaches `verificationCyclesMax` the agent should stop the fix-verify-fix
   * loop and either ship what's there or hand control back to the user.
   * Resets to 0 the first time `verify_scene` passes on a given scene.
   */
  verificationCyclesUsed: number
  verificationCyclesMax: number
  /**
   * Post-build cut-review budget (Gap 3). The cut-review coordinator owns this
   * loop, not the model: it RESERVES a cycle before each VLM review pass, so the
   * count is an exact hard cap (no off-by-one, no "model keeps calling the
   * exhausted branch"). Default max 1 — one review, optionally one re-review
   * after scene-local fixes. Mirrors verificationCyclesUsed/Max.
   */
  reviewCyclesUsed: number
  reviewCyclesMax: number
  /**
   * Running spend on vision-model visual quality checks (Anthropic
   * claude-haiku-4-5 vision pass on rendered scene frames). Initialized
   * to 0 at run start; incremented by `runVisualQualityCheck` per call;
   * enforced against `VISUAL_CHECK_COST_CAP_USD` to bound per-run spend.
   * Optional so the structural-compat `RunProgressLike` consumers in
   * `services/visual-quality-check.ts` accept partial test fixtures.
   */
  visualCheckCostUsd?: number
}

/** Serialize run progress into a compact string for context injection */
export function serializeRunProgress(p: RunProgress): string {
  const parts: string[] = ['── RUN PROGRESS ──']
  parts.push(
    `Phase: ${p.phase.toUpperCase()} | Iterations: ${p.iterationsUsed}/${p.iterationsMax} | Tools called: ${p.toolCallsTotal}`,
  )

  if (p.scenesPlanned > 0) {
    parts.push(`Scene plan: ${p.scenePlanScenesBuilt}/${p.scenesPlanned} scenes built`)
    const remaining = p.scenesPlanned - p.scenePlanScenesBuilt
    if (remaining > 0) parts.push(`  → ${remaining} scenes still to build`)
  }

  if (p.scenesCreated.length > 0) {
    parts.push(`Scenes created: ${p.scenesCreated.length}`)
  }

  const unverified = p.scenesCreated.filter((id) => !p.scenesVerified.includes(id))
  if (unverified.length > 0) {
    parts.push(`⚠ Unverified scenes: ${unverified.length} — call verify_scene on these`)
  }

  const unnarrated = p.scenesCreated.filter((id) => !p.scenesWithNarration.includes(id))
  if (unnarrated.length > 0 && p.scenesCreated.length >= 2) {
    parts.push(`⚠ Scenes without narration: ${unnarrated.length} — call add_narration on these before finishing`)
  }

  const unresolvedErrors = p.errors.filter((e) => !e.resolved)
  if (unresolvedErrors.length > 0) {
    parts.push(`Errors (${unresolvedErrors.length} unresolved):`)
    for (const e of unresolvedErrors.slice(-3)) {
      parts.push(`  ⚠ ${e.tool}: ${e.error.slice(0, 100)}`)
    }
  }

  const budgetPct = Math.round((p.iterationsUsed / p.iterationsMax) * 100)
  if (budgetPct >= 70) {
    parts.push(`⚠ Budget alert: ${budgetPct}% of iterations used — prioritize remaining work`)
  }

  // Self-correction budget. Surfaces only after the first failed verify so
  // happy-path runs aren't cluttered with budget chatter. The exhausted
  // line is a hard stopping signal — the runner enforces it independently
  // (see runner.ts) but the agent should also see it in context.
  if (p.verificationCyclesUsed > 0) {
    const remaining = Math.max(0, p.verificationCyclesMax - p.verificationCyclesUsed)
    if (remaining === 0) {
      parts.push(
        `STOP: verify_scene has failed ${p.verificationCyclesUsed}/${p.verificationCyclesMax} times. Do not call verify_scene again. Either accept the current state and finish, or hand control back to the user with a summary of what's wrong.`,
      )
    } else {
      parts.push(
        `Self-correction budget: ${remaining}/${p.verificationCyclesMax} verify cycle(s) remaining. After that you must stop iterating.`,
      )
    }
  }

  return parts.join('\n')
}

// ── Run Checkpoint (resume interrupted runs) ─────────────────────────────────

/** Serialized state of an interrupted agent run, persisted to DB so the user
 *  can resume where they left off after a disconnect/timeout/error. */
export interface RunCheckpoint {
  /** Unique run ID for correlation */
  runId: string
  /** Agent type that was running */
  agentType: AgentType
  /** Model used */
  modelId: ModelId
  /** ScenePlan being built (if any) */
  scenePlan: ScenePlan | null
  /** Scene IDs already created during this run */
  completedSceneIds: string[]
  /** ScenePlan scene indexes not yet built */
  remainingSceneIndexes: number[]
  /** Run progress at time of interruption */
  progress: RunProgress
  /** World state snapshot at interruption */
  worldSnapshot: {
    scenes: Scene[]
    globalStyle: GlobalStyle
    sceneGraph: SceneGraph
  }
  /** Original user message that started the run */
  originalMessage: string
  /**
   * Bounded plain-text digest of the conversation at interruption — role-tagged
   * lines, images replaced by `[image]`, tool payloads clipped, tail-kept and
   * hard-capped (see CHECKPOINT_DIGEST_CHARS in runner.ts).
   *
   * The full `messages` array is deliberately NOT persisted: it carries inline
   * base64 frames (a single capture-flow tool_result is ~250KB) into a SQLite
   * TEXT column, so a long run's history would be tens of MB per checkpoint
   * write, on a path that already retries under a disconnect. The digest keeps
   * what a resume actually needs — what was asked, what was tried, what the
   * tools said — at a bounded cost. What it cannot carry (rendered frames,
   * reference media, provider-native tool-call structure) resume TELLS the user
   * about rather than silently dropping. Optional: checkpoints written before
   * this field existed still parse.
   */
  conversationDigest?: string
  /** Token usage accumulated before interruption */
  partialUsage: UsageStats
  /** When the checkpoint was created */
  createdAt: string
  /** Why the run was interrupted */
  reason: 'disconnect' | 'timeout' | 'error' | 'cost-cap' | 'tool-call-cap' | 'round-cap' | 'stuck'
}

// ── Snapshot / Undo ───────────────────────────────────────────────────────────

export interface StateSnapshot {
  id: string
  timestamp: number
  description: string
  scenes: Scene[]
  globalStyle: GlobalStyle
}
