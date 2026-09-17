/**
 * consumeAdapterStream — the single, provider-agnostic loop body that turns a
 * ProviderAdapter's NormalizedStreamEvent stream into the per-turn state the
 * runner needs (assistant text, thinking, tool-use blocks, usage, authoritative
 * content, citations), emitting SSE events along the way.
 *
 * Every provider streams through this one function via its adapter, so the
 * runner has a single provider-agnostic turn loop. It is pure with
 * respect to the runner loop — it touches no world state, executes no tools,
 * does no cost math — so it is unit-testable against a scripted fake adapter.
 *
 * SSE event contract:
 *  - thinking_start on the first thinking_delta, thinking_token per delta,
 *    thinking_complete once when thinking ends (the normalized union has no
 *    per-block stop, so we close on the first non-thinking event or message_stop).
 *  - token per text_delta.
 *  - tool_start on tool_use_start (with empty input).
 *  - Citations are collected into the result; the runner emits the `sources`
 *    SSE event so dedup/formatting stays in one place.
 *
 * Native server-tool pills (web_search) are intentionally NOT reproduced here;
 * the adapter normalizes those into `citation` events. That divergence is
 * documented on the adapter contract and parity tests avoid server tools.
 */

import { timedStream } from './providers/adapter'
import type { ProviderAdapter, StreamChatOptions, NormalizedUsage, StreamTiming } from './providers/adapter'
import type { SSEEvent, ResearchSource } from './types'

export interface AdapterToolUseBlock {
  id: string
  name: string
  /** JSON string assembled from input deltas; the runner JSON.parses it. */
  input: string
}

export type AdapterStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'other' | null

export interface AdapterTurnResult {
  /** Concatenated assistant text from text_delta events. */
  text: string
  /** Concatenated thinking text from thinking_delta events. */
  thinking: string
  toolUseBlocks: AdapterToolUseBlock[]
  stopReason: AdapterStopReason
  usage: NormalizedUsage
  /**
   * Authoritative provider content blocks from a `message_complete` event, or
   * reconstructed from the deltas when the adapter doesn't emit one. The runner
   * pushes this into message history verbatim, so when it is authoritative,
   * provider-specific fields (Anthropic thinking signatures) survive.
   */
  assistantContent: unknown[]
  /** True when assistantContent came from a message_complete passthrough. */
  contentIsAuthoritative: boolean
  citations: ResearchSource[]
  /** Set when the stream ended in an error event; null on success. */
  error: { message: string; retriable: boolean } | null
  /** Per-call latency for this turn's provider stream (duration, ttfb, tokens/sec). */
  timing: StreamTiming
}

const ZERO_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 }

/**
 * Canonical empty error-turn. The runner wraps THROWN stream
 * errors into a turn-shaped value so one recovery path handles thrown and
 * returned errors identically — this factory owns the shape so a field added
 * to AdapterTurnResult can't silently drift in a hand-written literal.
 */
export function makeErrorTurn(message: string, retriable = false): AdapterTurnResult {
  return {
    text: '',
    thinking: '',
    toolUseBlocks: [],
    stopReason: null,
    usage: ZERO_USAGE,
    assistantContent: [],
    contentIsAuthoritative: false,
    citations: [],
    error: { message, retriable },
    timing: { durationMs: 0, ttfbMs: null, outputTokens: null, tokensPerSecond: null },
  }
}

/** OpenAI-compat providers whose reasoning rides `reasoning_content` and MUST
 *  be replayed verbatim on subsequent tool-call turns or the API 400s
 *  (DeepSeek V4, Qwen3-thinking, Kimi K2.6). Their reasoning round-trips in a
 *  provider-tagged `compat_reasoning` block, NOT an Anthropic-shaped
 *  `{type:'thinking'}` block — an unsigned thinking block would be rejected by
 *  the Anthropic API on a mid-chat model switch AND get tagged
 *  provider:'anthropic' by toCanonicalMessages, dropping it from the replay. */
export const COMPAT_REASONING_PROVIDERS = new Set(['deepseek', 'qwen', 'kimi'])

/** Build content blocks from accumulated deltas when no authoritative content
 *  was provided. Shapes match Anthropic content blocks so the runner's
 *  existing history handling works unchanged. See COMPAT_REASONING_PROVIDERS
 *  for why those providers' reasoning is namespaced instead. */
function reconstructContent(
  text: string,
  thinking: string,
  tools: AdapterToolUseBlock[],
  providerId?: string,
): unknown[] {
  const blocks: unknown[] = []
  if (thinking && providerId && COMPAT_REASONING_PROVIDERS.has(providerId)) {
    blocks.push({ type: 'compat_reasoning', provider: providerId, reasoning_content: thinking })
  } else if (thinking) {
    blocks.push({ type: 'thinking', thinking })
  }
  if (text) blocks.push({ type: 'text', text })
  for (const t of tools) {
    let input: Record<string, unknown> = {}
    const s = t.input.trim()
    if (s.length > 0) {
      try {
        input = JSON.parse(s)
      } catch {
        // Leave as {} — the runner re-parses t.input and surfaces the error.
      }
    }
    blocks.push({ type: 'tool_use', id: t.id, name: t.name, input })
  }
  return blocks
}

export async function consumeAdapterStream(
  adapter: ProviderAdapter,
  opts: StreamChatOptions,
  emit: (event: SSEEvent) => void,
): Promise<AdapterTurnResult> {
  let text = ''
  let thinking = ''
  let stopReason: AdapterStopReason = null
  let usage: NormalizedUsage = ZERO_USAGE
  let authoritativeContent: unknown[] | null = null
  let error: AdapterTurnResult['error'] = null
  const toolUseBlocks: AdapterToolUseBlock[] = []
  const toolIndexById = new Map<string, number>()
  const citations: ResearchSource[] = []

  // `thinking` is the cumulative buffer for the whole turn; `runThinking` is
  // just the current contiguous thinking block. The legacy Anthropic branch
  // resets its buffer per thinking block and emits thinking_complete with that
  // block's text only, so we mirror that to keep SSE parity on the rare
  // multi-thinking-block turn.
  let thinkingOpen = false
  let runThinking = ''
  const closeThinking = () => {
    if (thinkingOpen) {
      emit({ type: 'thinking_complete', fullThinking: runThinking })
      thinkingOpen = false
      runThinking = ''
    }
  }

  // Tag citations with the adapter that actually produced them. The old ternary
  // collapsed every OpenAI-compat id (deepseek/qwen/kimi) to 'anthropic', which
  // mislabeled research provenance in the UI. Use the real adapter id. The cast
  // widens past ResearchSource['provider']'s three-way literal (types.ts owned by
  // another PR) — the runtime value is the honest provider id.
  const provider = adapter.id as ResearchSource['provider']

  // timedStream fires onComplete from its finally — runs whether the stream ends
  // normally, errors, or the loop breaks — so `timing` is always set by the time
  // the for-await exits. Captured here and returned for the runner to log.
  let timing: StreamTiming = { durationMs: 0, ttfbMs: null, outputTokens: null, tokensPerSecond: null }

  for await (const event of timedStream(adapter, opts, (t) => (timing = t))) {
    switch (event.type) {
      case 'thinking_delta': {
        if (!thinkingOpen) {
          thinkingOpen = true
          runThinking = ''
          emit({ type: 'thinking_start' })
        }
        thinking += event.text
        runThinking += event.text
        emit({ type: 'thinking_token', token: event.text })
        break
      }
      case 'text_delta': {
        closeThinking()
        text += event.text
        emit({ type: 'token', token: event.text })
        break
      }
      case 'tool_use_start': {
        closeThinking()
        toolIndexById.set(event.id, toolUseBlocks.length)
        toolUseBlocks.push({ id: event.id, name: event.name, input: '' })
        emit({ type: 'tool_start', toolName: event.name, toolInput: {} })
        break
      }
      case 'tool_use_input_delta': {
        const idx = toolIndexById.get(event.id)
        if (idx !== undefined) toolUseBlocks[idx].input += event.partialJson
        break
      }
      case 'tool_use_stop': {
        const idx = toolIndexById.get(event.id)
        if (idx !== undefined) {
          const acc = toolUseBlocks[idx].input.trim()
          let accOk = false
          if (acc.length > 0) {
            try {
              JSON.parse(acc)
              accOk = true
            } catch {
              accOk = false
            }
          }
          // Prefer the adapter's authoritative finalInput when our streamed
          // accumulation is missing OR unparseable — e.g. compat servers that
          // stream `arguments` before the tool `name`, so the early input deltas
          // fired before tool_use_start and were dropped (unmapped id), leaving
          // input empty/partial. Without this the tool dispatches with {} and
          // dead-ends on stuck_invalid_args. A valid streamed accumulation is
          // left untouched (the normal path).
          if (!accOk) {
            const fi = event.finalInput
            if (fi && Object.keys(fi).length > 0) {
              toolUseBlocks[idx].input = JSON.stringify(fi)
            } else if (acc.length === 0) {
              toolUseBlocks[idx].input = JSON.stringify(fi ?? {})
            }
          }
        }
        break
      }
      case 'citation': {
        citations.push({ url: event.sourceUri, title: event.title, provider })
        break
      }
      case 'server_tool': {
        // Provider-hosted server tool (e.g. web search) — render as a UI pill
        // only. NOT added to toolCalls and never dispatched; mirrors what the
        // legacy provider branches emitted for OpenAI web_search activity.
        if (event.phase === 'start') {
          emit({ type: 'tool_start', toolName: event.name, toolInput: {} })
        } else {
          emit({ type: 'tool_complete', toolName: event.name, toolInput: {}, toolResult: { success: true } })
        }
        break
      }
      case 'usage_update': {
        usage = event.usage
        break
      }
      case 'message_complete': {
        if (Array.isArray(event.content) && event.content.length > 0) {
          authoritativeContent = event.content
        }
        break
      }
      case 'message_stop': {
        closeThinking()
        stopReason = event.stopReason
        break
      }
      case 'error': {
        closeThinking()
        // A retriable error is the adapter's backoff signal ("retrying in Ns")
        // OR a terminal failure after retries were exhausted. The two are only
        // distinguishable after the stream ends: a recovered retry finishes with
        // a real stopReason, a terminal failure with stopReason 'error'. Surface
        // it as a non-fatal warning so the user sees retries instead of a frozen
        // UI; the runner decides whether to actually fail based on stopReason.
        if (event.retriable) {
          emit({ type: 'warning', message: event.message })
          // The adapter's 429 retry is transparent to this single `for await`,
          // so the NEXT attempt re-streams thinking/citations from scratch and
          // would APPEND to what attempt 1 accumulated — double-persisting the
          // reasoning block (the widened retry gate now allows a retry after
          // thinking has streamed). Reset the per-turn accumulators that the
          // retry will regenerate. `text`/`toolUseBlocks` are intentionally left:
          // the retry gate only fires before any committed content, so they're
          // already empty — clearing them would mask a broken invariant.
          thinking = ''
          citations.length = 0
        }
        error = { message: event.message, retriable: event.retriable }
        break
      }
    }
  }

  // Defensive: an adapter that returns without a message_stop still leaves a
  // dangling thinking block open. Close it so the UI doesn't hang.
  closeThinking()

  const assistantContent = authoritativeContent ?? reconstructContent(text, thinking, toolUseBlocks, adapter.id)

  return {
    text,
    thinking,
    toolUseBlocks,
    stopReason,
    usage,
    assistantContent,
    contentIsAuthoritative: authoritativeContent !== null,
    citations,
    error,
    timing,
  }
}
