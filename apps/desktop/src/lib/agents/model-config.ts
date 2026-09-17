/**
 * Model registry system for the Dreambyte AI agent configuration.
 * Defines available AI models, their capabilities, costs, and provider settings.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'local'
  | 'claude-code'
  | 'codex-cli'
  | 'heygen'
  | 'elevenlabs'
  | 'fal'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
export type ModelTierName = 'budget' | 'balanced' | 'performance' | 'custom'

// ── Anthropic thinking parameters ────────────────────────────────────────────

/**
 * Anthropic ids that still take the pre-4.6 `thinking.budget_tokens` shape.
 *
 * From Opus 4.6 onward the parameter is deprecated, and on Opus 4.7 / 4.8 /
 * Opus 5 / Sonnet 5 / Fable 5 it is REMOVED — sending it is a hard 400 on every
 * request. `claude-opus-4-8` ships enabled + isDefault in DEFAULT_MODELS below,
 * so the old unconditional `{type:'enabled', budget_tokens}` failed 100% of
 * Anthropic turns. Those models take `{type:'adaptive'}` plus
 * `output_config.effort` instead.
 *
 * Only PRE-4.6 ids are listed, so an unknown or newly added model correctly
 * defaults to adaptive — this list can only ever shrink.
 * Prefix list, not a version parser — Anthropic ids are not semver.
 */
const BUDGET_TOKENS_MODEL_PREFIXES = [
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
  'claude-3',
  'claude-2',
  'claude-instant',
]

/** Fable/Mythos think unconditionally and reject ANY explicit thinking config,
 *  including `{type:'disabled'}`. */
const ALWAYS_THINKING_RE = /^claude-(?:fable|mythos)-/

/**
 * `output_config.effort` per thinking mode.
 *
 * `xhigh` is deliberately absent: it only exists from Opus 4.7 on, and Opus 4.6
 * / Sonnet 4.6 — both shipped here — reject it. `high` is the API default and is
 * valid on every effort-capable model.
 */
const THINKING_EFFORT: Record<'off' | 'adaptive' | 'deep', 'low' | 'medium' | 'high'> = {
  off: 'low',
  adaptive: 'medium',
  deep: 'high',
}

/**
 * The `thinking` (and `output_config`) request fields for one Anthropic call.
 * Spread into the request body; returns `{}` when there is nothing to send.
 *
 * `budgetTokens` is only consulted on pre-4.6 models — pass THINKING_BUDGETS[mode].
 */
export function anthropicThinkingParams(
  modelId: string,
  mode: 'off' | 'adaptive' | 'deep',
  budgetTokens: number,
): Record<string, unknown> {
  if (BUDGET_TOKENS_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
    // Pre-4.6: budget_tokens is the only way to think, and `effort` errors here.
    return mode === 'off' ? {} : { thinking: { type: 'enabled', budget_tokens: budgetTokens } }
  }
  if (mode === 'off') {
    // 'off' has to be an explicit kill switch: from Opus 5 on, OMITTING
    // `thinking` runs adaptive, so silence no longer means off. `{disabled}` is
    // rejected above effort `high`, which the `low` effort here also satisfies.
    return ALWAYS_THINKING_RE.test(modelId)
      ? { output_config: { effort: THINKING_EFFORT.off } }
      : { thinking: { type: 'disabled' }, output_config: { effort: THINKING_EFFORT.off } }
  }
  return { thinking: { type: 'adaptive' }, output_config: { effort: THINKING_EFFORT[mode] } }
}

/**
 * Cloud provider → env var holding its API key. Single source of truth — imported
 * by the agent (context-builder key-gating) and the generation path (resolveTextModel)
 * so a new keyed provider can't be added to one and silently missed by the other.
 * Providers NOT listed here need no key to run (local Ollama endpoints, CLI runtimes).
 */
export const PROVIDER_KEY_ENV: Partial<Record<ModelProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
}

/**
 * Configuration for a single AI model.
 */
export interface ModelConfig {
  /** Unique identifier, e.g. 'claude-sonnet-4-5' or 'gpt-4o' */
  id: string
  provider: ModelProvider
  /** Actual API model string passed to the provider */
  modelId: string
  /** Human-readable label shown in dropdowns */
  displayName: string
  /** Quality/cost tier classification */
  tier: ModelTierName
  /** When false the model is hidden from agent dropdowns */
  enabled: boolean
  /** Built-in models cannot be deleted, only disabled */
  isDefault: boolean
  /** USD cost per 1 million input tokens */
  costPer1MInput: number
  /** USD cost per 1 million output tokens */
  costPer1MOutput: number
  /** Maximum context window in tokens */
  maxTokens: number
  supportsTools: boolean
  supportsStreaming: boolean
  /**
   * Whether this model has a provider-hosted web search tool (Anthropic web_search_20250305,
   * OpenAI web_search_preview, Gemini googleSearch grounding). When true, the agent uses
   * native search and no third-party provider key (Brave/Tavily/Exa) is required.
   */
  nativeWebSearch?: boolean
  /**
   * OpenAI only: whether the model supports the Responses API. When true, native search
   * runs through `responses.create` with `web_search_preview`. When false, the runner
   * falls back to a search-preview Chat Completions model.
   */
  supportsResponsesApi?: boolean
  // Local model fields
  /** HTTP endpoint for local models, e.g. "http://localhost:11434" */
  endpoint?: string
  /** Ollama model name, e.g. "llama3.1:8b" */
  localModelName?: string
}

/**
 * Per-provider connection settings (API keys, base URLs).
 */
export interface ProviderConfig {
  provider: ModelProvider
  /** API key — stored in env on server, client uses placeholder */
  apiKey: string
  enabled: boolean
  /** Override base URL for custom endpoints or proxies */
  baseUrl?: string
}

// ── Default Models ─────────────────────────────────────────────────────────────

export const DEFAULT_MODELS: ModelConfig[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    tier: 'budget',
    enabled: true,
    isDefault: true,
    costPer1MInput: 1.0,
    costPer1MOutput: 5.0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    tier: 'balanced',
    enabled: true,
    isDefault: true,
    costPer1MInput: 3.0,
    costPer1MOutput: 15.0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    modelId: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    tier: 'performance',
    enabled: true,
    isDefault: true,
    costPer1MInput: 5.0,
    costPer1MOutput: 25.0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    tier: 'performance',
    enabled: true,
    isDefault: true,
    costPer1MInput: 5.0,
    costPer1MOutput: 25.0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    tier: 'budget',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.15,
    costPer1MOutput: 0.6,
    maxTokens: 128000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
    supportsResponsesApi: true,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    tier: 'balanced',
    enabled: false,
    isDefault: true,
    costPer1MInput: 2.5,
    costPer1MOutput: 10.0,
    maxTokens: 128000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
    supportsResponsesApi: true,
  },
  {
    id: 'gpt-4.1-nano',
    provider: 'openai',
    modelId: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 nano',
    tier: 'budget',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.1,
    costPer1MOutput: 0.4,
    maxTokens: 1047576,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
    supportsResponsesApi: true,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    tier: 'budget',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.4,
    costPer1MOutput: 1.6,
    maxTokens: 1047576,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
    supportsResponsesApi: true,
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    modelId: 'gpt-4.1',
    displayName: 'GPT-4.1',
    tier: 'balanced',
    enabled: false,
    isDefault: true,
    costPer1MInput: 2.0,
    costPer1MOutput: 8.0,
    maxTokens: 1047576,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
    supportsResponsesApi: true,
  },
  {
    id: 'o1',
    provider: 'openai',
    modelId: 'o1',
    displayName: 'o1',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    costPer1MInput: 15.0,
    costPer1MOutput: 60.0,
    maxTokens: 200000,
    supportsTools: false,
    supportsStreaming: false,
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    modelId: 'o3-mini',
    displayName: 'o3-mini',
    tier: 'balanced',
    enabled: false,
    isDefault: true,
    costPer1MInput: 1.1,
    costPer1MOutput: 4.4,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
    supportsResponsesApi: true,
  },

  // ── DeepSeek ───────────────────────────────────────────────────────────────
  // OpenAI-compatible API at api.deepseek.com (text/reasoning only — the API has
  // no vision; DeepSeek-VL2 is open-weights, not served here). ~10x cheaper than
  // GPT-4-class. Runs through the OpenAI-compat chat adapter as a first-class
  // agent model. V4 facts per the official docs (api-docs.deepseek.com):
  // BOTH v4-flash and v4-pro support tool calls AND dual thinking/non-thinking
  // modes (thinking defaults ON — the runner maps thinkingMode to an explicit
  // override), 1M context, 384K max output. Tool-call conversations REQUIRE
  // reasoning_content replay (handled in the compat adapter; the missing replay
  // was previously misdiagnosed as v4-pro lacking tool support). Legacy
  // deepseek-chat / deepseek-reasoner are deprecated aliases (2026/07/24).
  //
  // `maxTokens` here = CONTEXT WINDOW (drives the compaction budget at
  // runner.ts ~2551). It is NOT sent as a request max_tokens cap — that comes
  // from MAX_TOKENS_BY_AGENT (context-builder).
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'budget',
    enabled: false, // opt-in like OpenAI/Google — enable in Settings after adding a key
    isDefault: true,
    costPer1MInput: 0.14,
    costPer1MOutput: 0.28,
    maxTokens: 1000000,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro (reasoning)',
    tier: 'balanced',
    enabled: false, // opt-in
    isDefault: true,
    // 75% launch promo through 2026/05/31; full price is 4x lower than launch.
    costPer1MInput: 0.435,
    costPer1MOutput: 0.87,
    maxTokens: 1000000,
    // Tool-capable per official docs — usable on the agent tool loop now that
    // the adapter replays reasoning_content (the prior 400s were the missing
    // replay, not missing tool support).
    supportsTools: true,
    supportsStreaming: true,
  },

  // ── Qwen (Alibaba DashScope) ─────────────────────────────────────────────────
  // OpenAI-compatible API at the DashScope international endpoint. Stable model
  // aliases (qwen-flash/qwen-plus) auto-resolve to the latest snapshot; both
  // support OpenAI-style function calling. Prices are the international base tier
  // (0-256K context); long-context tiers cost more — verify on the Model Studio
  // pricing page. Key (DASHSCOPE_API_KEY) is shared with Qwen vision intake.
  // Native web search: DashScope `enable_search` (the qwen_web_search marker; the
  // compat adapter sets enable_search + search_options). The OpenAI-compat endpoint
  // does NOT return citation sources — text answers are grounded but unsourced.
  {
    id: 'qwen-flash',
    provider: 'qwen',
    modelId: 'qwen-flash',
    displayName: 'Qwen Flash',
    tier: 'budget',
    enabled: false, // opt-in like the other cloud providers
    isDefault: true,
    costPer1MInput: 0.05,
    costPer1MOutput: 0.4,
    maxTokens: 1000000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  {
    id: 'qwen-plus',
    provider: 'qwen',
    modelId: 'qwen-plus',
    displayName: 'Qwen Plus',
    tier: 'balanced',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.4,
    costPer1MOutput: 1.2,
    maxTokens: 1000000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },

  // ── Kimi (Moonshot / Kimi Open Platform) ─────────────────────────────────────
  // OpenAI-compatible API at api.moonshot.ai (base_url .../v1), auth
  // `Authorization: Bearer $MOONSHOT_API_KEY`. The "Kimi" key and the "Moonshot"
  // key are the SAME credential — per platform.kimi.ai docs;
  // there is no separate api.kimi.ai host. All support tool calls,
  // JSON mode, streaming. moonshot-v1 / kimi-k2-0711 are EOL (2026/08/31 sunset).
  {
    id: 'kimi-k3',
    provider: 'kimi',
    modelId: 'kimi-k3',
    displayName: 'Kimi K3',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    // Per-1M USD (platform.kimi.ai/docs/pricing/chat-k3): input $3.00 cache-miss
    // ($0.30 cache-hit via auto context caching), output $15.00.
    costPer1MInput: 3.0,
    costPer1MOutput: 15.0,
    maxTokens: 1048576, // 1M-token context window (flagship; 2.8T params, native vision)
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'kimi-k2.5',
    provider: 'kimi',
    modelId: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    tier: 'balanced',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.6,
    costPer1MOutput: 3.0,
    maxTokens: 256000,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'kimi-k2.6',
    provider: 'kimi',
    modelId: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0.95,
    costPer1MOutput: 4.0,
    maxTokens: 256000,
    supportsTools: true,
    supportsStreaming: true,
  },

  // ── Google Gemini ────────────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    modelId: 'gemini-2.5-flash-preview-05-20',
    displayName: 'Gemini 2.5 Flash',
    tier: 'budget',
    enabled: false,
    isDefault: true,
    // https://ai.google.dev/gemini-api/docs/pricing (checked 2026-08-04).
    costPer1MInput: 0.3,
    costPer1MOutput: 2.5,
    maxTokens: 1000000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    modelId: 'gemini-2.5-pro-preview-05-06',
    displayName: 'Gemini 2.5 Pro',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    costPer1MInput: 1.25,
    costPer1MOutput: 10.0,
    maxTokens: 1000000,
    supportsTools: true,
    supportsStreaming: true,
    nativeWebSearch: true,
  },

  // ── Local / Ollama placeholder ─────────────────────────────────────────────
  {
    id: 'ollama-llama3',
    provider: 'local',
    modelId: 'ollama/llama3.1:8b',
    displayName: 'Llama 3.1 8B (Ollama)',
    tier: 'budget',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    maxTokens: 128000,
    supportsTools: true,
    supportsStreaming: true,
    endpoint: 'http://localhost:11434',
    localModelName: 'llama3.1:8b',
  },

  // ── BYO CLI — user-installed command-line agents ──────────────────────────
  //
  // These route the run through the local Claude Code or Codex CLI via a
  // subprocess + an ephemeral MCP bridge (see src/electron/mcp-bridge.ts). The
  // user's CLI subscription pays the bill, not ours — cost fields zeroed.
  // Disabled by default; enabled automatically by the Agents settings tab
  // when the binary is detected on PATH.
  {
    id: 'claude-code-cli',
    provider: 'claude-code',
    modelId: 'claude-code',
    displayName: 'Claude Code CLI',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'codex-cli',
    provider: 'codex-cli',
    modelId: 'codex-cli',
    displayName: 'Codex CLI',
    tier: 'performance',
    enabled: false,
    isDefault: true,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    maxTokens: 200000,
    supportsTools: true,
    supportsStreaming: true,
  },
]

export const DEFAULT_PROVIDER_CONFIGS: ProviderConfig[] = [
  { provider: 'anthropic', apiKey: '', enabled: true },
  { provider: 'openai', apiKey: '', enabled: false },
  { provider: 'google', apiKey: '', enabled: false },
  { provider: 'local', apiKey: '', enabled: false, baseUrl: 'http://localhost:11434' },
  { provider: 'deepseek', apiKey: '', enabled: false },
  { provider: 'qwen', apiKey: '', enabled: false },
  { provider: 'kimi', apiKey: '', enabled: false },
  { provider: 'heygen', apiKey: '', enabled: true },
  { provider: 'elevenlabs', apiKey: '', enabled: true },
  { provider: 'fal', apiKey: '', enabled: true },
]

// ── Query Helpers ──────────────────────────────────────────────────────────────

/** Conservative fallback when a model's context window is unknown. Every
 *  currently-shipped agent model is >= 128K; 200K is the Anthropic default. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/**
 * Pricing (USD per 1M tokens) for a model — the SINGLE source of truth, derived
 * from DEFAULT_MODELS (and any user-supplied `models`, checked first). Replaces
 * the hand-maintained MODEL_PRICING table that lived in types.ts and drifted
 * from here: a paid model added to DEFAULT_MODELS but forgotten in MODEL_PRICING
 * priced at $0 at runtime, silently disabling the cost cap. With one table that
 * can't happen — a model's price travels with its config.
 *
 * Unknown models price at {0,0}: correct for local / CLI passthrough (genuinely
 * free), and a paid model the user can actually select is in DEFAULT_MODELS or
 * their `models`, so it's priced.
 */
export function getModelPricing(modelId: string, models?: ModelConfig[]): { inputPer1M: number; outputPer1M: number } {
  const match =
    models?.find((m) => m.modelId === modelId || m.id === modelId) ??
    DEFAULT_MODELS.find((m) => m.modelId === modelId || m.id === modelId)
  return match
    ? { inputPer1M: match.costPer1MInput, outputPer1M: match.costPer1MOutput }
    : { inputPer1M: 0, outputPer1M: 0 }
}

/** Conservative window for an unknown LOCAL model. Ollama often defaults
 *  num_ctx to 2k-8k regardless of the model's nominal max, so assuming 200k
 *  would let context-pressure compaction never fire before the model 400s.
 *  Only used when a local model isn't found in config (a configured local model
 *  carries its real maxTokens). */
export const LOCAL_FALLBACK_CONTEXT_WINDOW_TOKENS = 8_192

/**
 * Resolve a model's maximum context window (in tokens) from its config.
 * Accepts either the config `id` or the provider `modelId` so callers can pass
 * whichever they have. For an unknown model, falls back to `fallback` (default
 * DEFAULT_CONTEXT_WINDOW_TOKENS) so budgeting never divides by an undefined
 * window. Pass a conservative `fallback` (e.g. LOCAL_FALLBACK_CONTEXT_WINDOW_TOKENS)
 * for local/unknown providers so a small local window still triggers compaction.
 */
export function getContextWindow(
  modelId: string,
  models: ModelConfig[] = DEFAULT_MODELS,
  fallback: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
): number {
  const match = models.find((m) => m.modelId === modelId || m.id === modelId)
  return match?.maxTokens ?? fallback
}

/**
 * Look up a model by its API id or our internal id (or Ollama local name), checking
 * user-configured models first and falling back to DEFAULT_MODELS.
 */
export function findModelConfig(
  modelId: string | undefined | null,
  configs?: readonly ModelConfig[] | null,
): ModelConfig | undefined {
  if (modelId == null || String(modelId).trim() === '') return undefined
  const match = (m: ModelConfig, id: string) =>
    m.modelId === id || m.id === id || (m.localModelName != null && m.localModelName === id)
  const id = String(modelId)
  if (configs?.length) {
    const fromStore = configs.find((m) => match(m, id))
    if (fromStore) return fromStore
  }
  return DEFAULT_MODELS.find((m) => match(m, id))
}

/**
 * Whether the given model has a provider-hosted web search tool. Used by the context
 * builder and runner to decide whether to inject a native-search tool or fall back to
 * the custom (third-party) web_search handler.
 */
export function modelHasNativeWebSearch(
  modelId: string | undefined | null,
  configs?: readonly ModelConfig[] | null,
): boolean {
  return Boolean(findModelConfig(modelId, configs)?.nativeWebSearch)
}

/**
 * OpenAI only: whether the given model supports the Responses API. Governs whether
 * native search runs through `responses.create` (preferred) or a search-preview
 * Chat Completions model fallback.
 */
export function modelSupportsResponsesApi(
  modelId: string | undefined | null,
  configs?: readonly ModelConfig[] | null,
): boolean {
  return Boolean(findModelConfig(modelId, configs)?.supportsResponsesApi)
}

/**
 * Resolve API / persisted model id to the configured display label (e.g. claude-sonnet-4-6 → "Sonnet 4.6").
 */
export function resolveAgentModelDisplayName(
  raw: string | undefined | null,
  configs?: readonly ModelConfig[] | null,
): string {
  if (raw == null || String(raw).trim() === '') return ''

  const match = (m: ModelConfig, id: string) =>
    m.modelId === id || m.id === id || (m.localModelName != null && m.localModelName === id)

  const lookup = (id: string): string | null => {
    if (configs?.length) {
      const fromStore = configs.find((m) => match(m, id))
      if (fromStore?.displayName) return fromStore.displayName
    }
    const builtIn = DEFAULT_MODELS.find((m) => match(m, id))
    return builtIn?.displayName ?? null
  }

  const r = String(raw)

  // CLI provider model IDs: "claude-code:sonnet" → "Claude Code (Sonnet)"
  if (r.startsWith('claude-code:')) {
    const tier = r.split(':')[1] ?? ''
    const tierName = tier.charAt(0).toUpperCase() + tier.slice(1)
    return `Claude Code (${tierName})`
  }

  const direct = lookup(r)
  if (direct) return direct

  const stripDate = r.replace(/-\d{8}$/, '')
  if (stripDate !== r) {
    const d = lookup(stripDate)
    if (d) return d
  }

  const noPrefix = r.replace(/^claude-/, '')
  if (noPrefix !== r) {
    const p = lookup(`claude-${noPrefix}`)
    if (p) return p
  }

  return r.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
