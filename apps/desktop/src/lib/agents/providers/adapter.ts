/**
 * ProviderAdapter — interface for swapping LLM provider streaming behind a
 * normalized event union.
 *
 * Every provider implements this interface and the runner drives all of them
 * through one loop (`consumeAdapterStream`), so message translation, tool
 * conversion, stream parsing and usage accounting live per-provider instead of
 * as duplicated runner branches.
 *
 * Adapter responsibilities:
 *  - Translate canonical messages + tools into provider-specific shapes.
 *  - Stream the response, normalizing every event into NormalizedStreamEvent.
 *  - Surface usage (input/output/cache tokens) in normalized form.
 *  - Throw on hard errors; return-and-keep-going for soft retries.
 *
 * NOT the adapter's job:
 *  - Cost calculation (runner does it via getModelPricing / model-config).
 *  - Tool execution (runner dispatches via tool-executor).
 *  - Compaction, retry policy, cost cap (runner-level concerns).
 */

import type { ClaudeToolDefinition } from '../types'
import type { ModelProvider } from '../model-config'

/**
 * Discriminated union mirroring the runner's existing `SSEEvent` for the
 * streaming-relevant subset. Adapters emit these via async iteration; the
 * runner translates each into the appropriate SSE event for the renderer.
 *
 * Any provider-specific quirk (e.g. Gemini's grounding metadata, Anthropic's
 * thinking blocks) is normalized here so downstream code stays
 * provider-agnostic. Add a new variant when introducing a new shared
 * concern; do NOT leak provider-specific fields.
 */
export type NormalizedStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_stop'; id: string; finalInput: Record<string, unknown> }
  /**
   * Authoritative final assistant content from the provider, passed through
   * opaquely. The runner pushes this verbatim into message history so
   * provider-specific fields the normalized deltas can't represent — most
   * importantly Anthropic thinking-block `signature`s, which the API requires
   * on the next turn when extended thinking is on — survive round-trips.
   *
   * Optional: adapters that can't surface authoritative content (or have
   * nothing extra beyond the deltas) simply don't emit it, and the consumer
   * reconstructs content blocks from the deltas instead. Emit it, when
   * available, BEFORE `message_stop`.
   */
  | { type: 'message_complete'; content: unknown[] }
  | { type: 'message_stop'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'other' }
  /**
   * Cumulative token usage for the turn (a snapshot, NOT a delta). The consumer
   * takes the latest usage_update as authoritative, so an adapter may emit it
   * once at the end (Anthropic, from finalMessage) or repeatedly with the
   * running cumulative total. Providers that report per-chunk deltas (Gemini)
   * MUST accumulate into a cumulative figure before emitting — do not emit raw
   * deltas, or the consumer will undercount.
   */
  | { type: 'usage_update'; usage: NormalizedUsage }
  | { type: 'citation'; sourceUri: string; title?: string }
  /**
   * Provider-hosted server-tool activity (e.g. OpenAI/Gemini web search running
   * server-side). UI-only — the consumer surfaces it as a tool_start/tool_complete
   * "pill" so the user sees the activity, but it is NOT an executable tool call
   * and is never dispatched or added to the run's tool-call records.
   */
  | { type: 'server_tool'; name: string; phase: 'start' | 'stop' }
  | { type: 'error'; message: string; retriable: boolean }

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens written to the prompt cache (Anthropic only today). */
  cacheCreationTokens?: number
  /** Tokens served from the prompt cache. */
  cacheReadTokens?: number
}

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'tool'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; mimeType: string; dataBase64: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
        | ProviderRawBlock
      >
}

/**
 * Opaque passthrough for provider-specific content blocks the canonical types
 * above can't represent — most importantly Anthropic `thinking` /
 * `redacted_thinking` blocks, whose `signature`/`data` the API requires intact
 * on the next turn when extended thinking is on. The block is carried verbatim
 * and the originating adapter re-emits it unchanged; adapters for a DIFFERENT
 * provider than `provider` must skip blocks they don't understand (a foreign
 * reasoning block has no meaning in another provider's request).
 *
 * This is the input-side mirror of the `message_complete` output event: both
 * exist so a turn can round-trip through the canonical layer losslessly.
 */
export interface ProviderRawBlock {
  type: 'provider_raw'
  provider: ModelProvider
  block: unknown
}

/**
 * Anthropic-style cache_control breakpoints. Adapters that don't support
 * caching (currently OpenAI Chat Completions and Gemini) ignore these.
 * Don't let the absence of caching elsewhere force the adapter to drop
 * the breakpoint — keep it through the canonical layer so future cache
 * support works without runner changes.
 */
export interface CacheBreakpoint {
  position: 'system' | 'tool_definitions'
  /** Only ephemeral is supported by Anthropic today. */
  type: 'ephemeral'
}

/**
 * Ordered system-prompt segments. Lets a caller preserve the static/dynamic
 * split that drives Anthropic prompt caching: the large, stable persona+rules
 * segment is marked `cache: true` (stays cache-hot), while the per-turn world
 * state is a separate uncached segment so it doesn't invalidate the cache each
 * turn. Adapters that don't support multi-segment system (OpenAI, Gemini) join
 * the segments and use `systemPrompt` instead.
 */
export interface SystemSegment {
  text: string
  /** Apply an ephemeral cache breakpoint to this segment (Anthropic only). */
  cache?: boolean
}

export interface StreamChatOptions {
  model: string
  /** Single-string system prompt. Always set; used by adapters that don't
   *  support multi-segment system, and as the fallback when systemSegments is
   *  absent. */
  systemPrompt: string
  /** Preferred multi-segment system for cache-aware adapters (Anthropic). When
   *  present it takes precedence over systemPrompt + the 'system' cacheBreakpoint. */
  systemSegments?: SystemSegment[]
  messages: CanonicalMessage[]
  tools?: ClaudeToolDefinition[]
  maxTokens: number
  temperature?: number
  cacheBreakpoints?: CacheBreakpoint[]
  abortSignal?: AbortSignal
  /** Per-call overrides (Anthropic thinking budget, OpenAI reasoning effort). */
  providerOverrides?: Record<string, unknown>
}

export interface ProviderAdapter {
  readonly id: ModelProvider
  /**
   * Stream a chat completion as normalized events. The async iterable
   * MUST emit a final `message_stop` event so the runner knows the
   * stream is done; adapters that crash mid-stream should emit
   * `{ type: 'error', retriable }` and then return.
   */
  streamChat(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent>
}

/**
 * Run-time registry for adapters. Stays empty until adapters are wired in
 * via `registerAdapter` (typically in providers/index.ts at module load).
 * Until then, callers must check `getAdapter(provider) === undefined` and
 * fall back to the legacy runner branches.
 */
const _adapters = new Map<ModelProvider, ProviderAdapter>()

export function registerAdapter(adapter: ProviderAdapter): void {
  if (_adapters.has(adapter.id)) {
    throw new Error(`ProviderAdapter already registered for ${adapter.id}`)
  }
  _adapters.set(adapter.id, adapter)
}

export function getAdapter(provider: ModelProvider): ProviderAdapter | undefined {
  return _adapters.get(provider)
}

/** Test-only seam to clear the registry between tests. */
export function __resetAdapterRegistryForTesting(): void {
  _adapters.clear()
}

/**
 * Per-call latency metrics for one adapter stream. Reported once, when the
 * stream finishes (cleanly, by error, or by the consumer breaking early).
 */
export interface StreamTiming {
  /** Wall-clock from the call starting to the stream ending, in ms. */
  durationMs: number
  /** Time to the first yielded event (time-to-first-token), in ms. `null` if
   *  the stream produced no events before ending. */
  ttfbMs: number | null
  /** Output tokens from the last `usage_update` seen, or `null` if none was
   *  emitted (e.g. the stream errored before reporting usage). */
  outputTokens: number | null
  /** `outputTokens / (durationMs / 1000)`. `null` when tokens or duration are
   *  unavailable, so a caller never divides by zero or reports a fake rate. */
  tokensPerSecond: number | null
}

/**
 * Wrap an adapter stream with per-call timing. Passes every event through
 * unchanged and, when the stream ends, invokes `onComplete` with the latency
 * metrics. Adapter-mode only — the legacy runner branches are not affected.
 *
 * The report fires from a `finally`, so it runs whether the stream completes
 * normally, throws, or the consumer breaks out of the `for await` early (an
 * abort). `onComplete` is invoked exactly once; keep it cheap and non-throwing
 * (a logger call), since it runs on the teardown path of the stream.
 */
export async function* timedStream(
  adapter: ProviderAdapter,
  opts: StreamChatOptions,
  onComplete: (timing: StreamTiming) => void,
): AsyncIterable<NormalizedStreamEvent> {
  const start = Date.now()
  let ttfbMs: number | null = null
  let outputTokens: number | null = null
  try {
    for await (const event of adapter.streamChat(opts)) {
      if (ttfbMs === null) ttfbMs = Date.now() - start
      // usage_update is cumulative (see NormalizedStreamEvent); the last one wins.
      if (event.type === 'usage_update') outputTokens = event.usage.outputTokens
      yield event
    }
  } finally {
    const durationMs = Date.now() - start
    const tokensPerSecond = outputTokens !== null && durationMs > 0 ? (outputTokens / durationMs) * 1000 : null
    onComplete({ durationMs, ttfbMs, outputTokens, tokensPerSecond })
  }
}
