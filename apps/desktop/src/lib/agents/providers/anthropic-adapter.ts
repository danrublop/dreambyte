/**
 * Anthropic adapter.
 *
 * Extracts the Anthropic streaming branch from src/lib/agents/runner.ts (~lines
 * 2692-2918) into the ProviderAdapter interface so the runner can eventually
 * replace that branch with a single consumption loop over NormalizedStreamEvent.
 *
 * STATUS: LIVE in production — `runConfig.useProviderAdapters` defaults to
 * true (DEFAULT_RUN_CONFIG in runner.ts), so this adapter serves all Anthropic
 * runs. The runner's legacy Anthropic branch remains only as a rollback path
 * when the flag is explicitly disabled.
 *
 * ── Anthropic stream event → NormalizedStreamEvent mapping ──────────────────
 *
 *   content_block_start  (thinking)          → thinking_delta (buffer start)
 *   content_block_start  (text)              → (no event; text comes via delta)
 *   content_block_start  (tool_use)          → tool_use_start
 *   content_block_start  (server_tool_use)   → [CONTRACT GAP — see note A]
 *   content_block_start  (web_search_tool_result) → citation (per result item)
 *   content_block_delta  (thinking_delta)    → thinking_delta
 *   content_block_delta  (text_delta)        → text_delta
 *   content_block_delta  (input_json_delta)  → tool_use_input_delta
 *   content_block_stop   (thinking block)    → (no additional event; buffer already streamed)
 *   content_block_stop   (tool_use block)    → tool_use_stop (with parsed finalInput)
 *   message_start        → usage_update (input/cache tokens)
 *   message_delta        → (output tokens accumulated; emitted with message_stop)
 *   message_stop         → usage_update (output tokens) + message_stop
 *
 * ── Contract gaps flagged ────────────────────────────────────────────────────
 *
 * NOTE A — server_tool_use blocks (e.g. web_search_20250305): Anthropic-native
 *   server tools execute on Anthropic's infrastructure; we don't run them
 *   locally. They are surfaced as the non-executable `server_tool` event
 *   (start+stop → a UI pill), NEVER `tool_use_start` — the consumer adds
 *   tool_use_start blocks to the executable toolUseBlocks set, which would make
 *   the runner run the tool (e.g. web_search) locally with empty args. Results
 *   arrive separately as web_search_tool_result → citation events.
 *
 * NOTE B — `warning` SSE event (rate-limit retry feedback): the runner emits
 *   `{ type: 'warning', message }` to the client during 429 back-off. The
 *   NormalizedStreamEvent union has no `warning` variant. The adapter emits
 *   an `error` event with `retriable: true` instead, which gives the consumer
 *   the same information at slightly lower resolution. Add a `warning` variant
 *   if the UI needs to distinguish transient back-off from hard errors.
 *
 * NOTE C — `thinking_complete` SSE event: runner emits `thinking_complete`
 *   with `fullThinking` at content_block_stop. The union has no
 *   `thinking_complete` event — only `thinking_delta`. The full thinking text
 *   can be reconstructed by concatenating all `thinking_delta.text` values.
 *   Add `| { type: 'thinking_complete'; fullThinking: string }` to the union
 *   if downstream consumers need the assembled block without buffering.
 */

// @vitest-environment node

import { getAnthropicClient } from '../providers'
import type {
  ProviderAdapter,
  NormalizedStreamEvent,
  NormalizedUsage,
  StreamChatOptions,
  CacheBreakpoint,
  SystemSegment,
} from './adapter'
import { markConversationCache, toAnthropicMessages } from '../canonical-messages'
import { adaptAnthropicCitations } from '../research-citations'
import { STREAM_INACTIVITY_TIMEOUT_MS, withInactivityTimeout } from './stream-timeout'
import { MAX_STREAM_RETRIES, classifyStreamError, yieldRetryBackoff, authErrorMessage } from './retry'

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_429_RETRIES = MAX_STREAM_RETRIES

// ── Test seam ─────────────────────────────────────────────────────────────────
// The retry sleep now lives in ./retry (shared across adapters). Re-export the
// historical names so existing anthropic-adapter tests keep working unchanged.
export {
  __setRetrySleepForTesting as __setBackoffSleepForTesting,
  __resetRetrySleepForTesting as __resetBackoffSleepForTesting,
} from './retry'

/**
 * Map an Anthropic stop_reason to the normalized union.
 * Anthropic values: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null
 */
function normalizeStopReason(
  reason: string | null | undefined,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'other' {
  if (reason === 'end_turn') return 'end_turn'
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  return 'other'
}

/**
 * System-prompt cache breakpoints use the 1-hour TTL, not the 5-minute default.
 *
 * `iterationToolBudgetMs` allows 600s of tool work per turn (runner.ts), which is
 * REACHABLE — one 180s media-gen call (MEDIA_GEN_TOOL_TIMEOUT_MS) plus a vision
 * check plus a verify. Any turn over 300s expired every ephemeral breakpoint and
 * re-wrote the whole ~112KB prefix at 1.25x instead of reading it at 0.1x. The 1h
 * TTL writes at 2x once and survives any turn length: one extra 0.75x write beats
 * a guaranteed full-prefix rewrite on a media-heavy run. No beta header needed.
 * (Chosen over shortening the tool budget, which would skip legitimate tool calls
 * mid-turn on multi-scene builds.)
 */
const SYSTEM_CACHE_CONTROL = { type: 'ephemeral' as const, ttl: '1h' as const }

/**
 * Build the system blocks array from a system prompt string plus optional
 * cache breakpoints. Mirrors the runner's three-case logic:
 *  1. systemPrompt only → single block with ephemeral cache_control if
 *     'system' breakpoint is present.
 *  2. cacheBreakpoints present → attach ephemeral to the block as specified.
 *
 * For the adapter's simpler interface (single systemPrompt string rather than
 * the runner's staticPrompt/dynamicPrompt split), we apply cache_control when
 * the caller includes a `{ position: 'system', type: 'ephemeral' }` breakpoint.
 */
export function buildSystemBlocks(
  systemPrompt: string,
  cacheBreakpoints?: CacheBreakpoint[],
  systemSegments?: SystemSegment[],
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> {
  // Multi-segment takes precedence: emit one block per non-empty segment,
  // attaching cache_control to the ones marked cache:true. This preserves the
  // runner's static(cached)+dynamic(uncached) split so the big persona block
  // stays cache-hot across turns.
  if (systemSegments && systemSegments.length > 0) {
    const blocks = systemSegments
      .filter((seg) => seg.text.length > 0)
      .map((seg) => ({
        type: 'text' as const,
        text: seg.text,
        ...(seg.cache ? { cache_control: SYSTEM_CACHE_CONTROL } : {}),
      }))
    if (blocks.length > 0) return blocks
  }
  const hasSystemCache = cacheBreakpoints?.some((bp) => bp.position === 'system' && bp.type === 'ephemeral')
  return [
    {
      type: 'text' as const,
      text: systemPrompt,
      ...(hasSystemCache ? { cache_control: SYSTEM_CACHE_CONTROL } : {}),
    },
  ]
}

/**
 * Build the tools array in Anthropic format, honoring tool_definitions cache
 * breakpoint by attaching cache_control to the last tool when the breakpoint
 * is present. Mirrors runner.ts's server-tool pass-through logic: tools that
 * already carry a `type` field (Anthropic-native server tools) are passed
 * through untouched; custom tools get { name, description, input_schema }.
 */
function buildAnthropicTools(
  tools: StreamChatOptions['tools'],
  cacheBreakpoints?: CacheBreakpoint[],
): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined

  const hasToolCache = cacheBreakpoints?.some((bp) => bp.position === 'tool_definitions' && bp.type === 'ephemeral')

  const mapped = tools.map((t, idx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyT = t as any
    let tool: Record<string, unknown>

    if (typeof anyT.type === 'string') {
      // Anthropic-native server tool — pass through untouched
      tool = { ...anyT }
    } else {
      tool = {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }
    }

    // Attach cache breakpoint to the last tool in the array
    if (hasToolCache && idx === tools.length - 1) {
      tool['cache_control'] = { type: 'ephemeral' }
    }

    return tool
  })

  return mapped
}

// ── Adapter implementation ────────────────────────────────────────────────────

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  async *streamChat(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
    const {
      model,
      systemPrompt,
      systemSegments,
      messages,
      tools,
      maxTokens,
      temperature,
      cacheBreakpoints,
      abortSignal,
      providerOverrides,
    } = opts

    // Build request params
    const systemBlocks = buildSystemBlocks(systemPrompt, cacheBreakpoints, systemSegments)
    const anthropicTools = buildAnthropicTools(tools, cacheBreakpoints)
    // Cache the history too, not just the system prefix — see markConversationCache.
    const anthropicMessages = markConversationCache(toAnthropicMessages(messages))

    // Thinking config from providerOverrides (the runner builds it with
    // anthropicThinkingParams). `output_config` carries the effort level that
    // replaced budget_tokens on 4.6+ models, so it has to ride along — dropping
    // it here would silently run every adaptive turn at the API's default effort.
    const thinkingParam = {
      ...(providerOverrides?.thinking !== undefined ? { thinking: providerOverrides.thinking } : {}),
      ...(providerOverrides?.output_config !== undefined ? { output_config: providerOverrides.output_config } : {}),
    }

    const createParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: anthropicMessages,
      stream: true as const,
      ...(anthropicTools ? { tools: anthropicTools } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...thinkingParam,
    }

    // ── Open stream + consume with 429 retry ──────────────────────────────
    //
    // M1 of the gap-review fix: the SDK's `messages.stream()` returns
    // synchronously and surfaces 429s during iteration, not at creation.
    // The earlier implementation wrapped only the synchronous create call,
    // which left actual rate-limit errors unhandled.
    //
    // The retry envelope here wraps BOTH creation AND iteration. We retry
    // as long as NO normalized event has been yielded yet (`anyYielded`
    // flag). Once we yield the first text/tool/citation/usage event, the
    // consumer has committed to this stream and an error past that point
    // must propagate — we can't unstream what we've already sent.
    const anthropicClient = getAnthropicClient()
    let stream: ReturnType<typeof anthropicClient.messages.stream> | null = null

    // State that survives across retries (resets each attempt would be wrong
    // for these — they accumulate during the consumption that ultimately
    // succeeds, and inner-loop scope makes that natural).
    let currentBlockType: 'thinking' | 'text' | 'tool_use' | 'server_tool_use' | 'web_search_tool_result' | null = null
    const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = []
    let currentToolIndex = -1
    let inputTokens = 0
    let outputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let stopReason: string | null = null
    let anyYielded = false
    // Stricter retry gate than `anyYielded`. Anthropic's per-minute input-token
    // limit frequently 429s AFTER message_start / some thinking has streamed but
    // BEFORE any committed assistant content (text or tool_use). Retrying in that
    // window is safe — thinking_delta / citation / server_tool pills are not
    // replayed to the user as authoritative output, and on retry the model
    // regenerates from scratch. We only block a retry once a `text_delta` or a
    // `tool_use_*` event has been yielded this attempt: replaying those would
    // duplicate visible/committed output. Set per-attempt (reset below) so a
    // retry that itself reaches committed content can't be retried again.
    let anyCommittedContent = false

    retryLoop: for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      // Don't open (or re-open after backoff) a stream for an aborted run.
      if (abortSignal?.aborted) {
        yield { type: 'error', message: 'Anthropic stream aborted', retriable: false }
        yield { type: 'message_stop', stopReason: 'error' }
        return
      }
      // Reset per-attempt state. We're either re-opening because the
      // previous attempt's stream is unusable, or this is the first attempt.
      currentBlockType = null
      toolUseBlocks.length = 0
      currentToolIndex = -1
      inputTokens = 0
      outputTokens = 0
      cacheCreationTokens = 0
      cacheReadTokens = 0
      stopReason = null
      // Per-attempt: a fresh stream re-emits content from the top, so the
      // "have we committed visible output THIS attempt?" gate must reset too.
      anyCommittedContent = false

      // ── (a) Open stream ────────────────────────────────────────────────
      // If we're retrying after a 429, the previous attempt's stream may
      // still hold the SSE connection. The SDK's MessageStream exposes
      // .abort() — call it to release the underlying HTTP request before
      // opening a fresh one. Otherwise repeated 429s pin connections until
      // GC. Safe to call .abort() on an already-finished stream (no-op).
      if (stream) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(stream as any).abort?.()
        } catch {
          // Abort failures are best-effort — the GC will eventually free it.
        }
        stream = null
      }
      try {
        stream = anthropicClient.messages.stream(
          createParams as unknown as Parameters<typeof anthropicClient.messages.stream>[0],
          // Abort signal rides in the SDK's request OPTIONS — putting it in the
          // body params serializes it into the JSON request and the API rejects
          // the run with 400 "signal: Extra inputs are not permitted".
          abortSignal ? { signal: abortSignal } : undefined,
        )
      } catch (err) {
        // Synchronous creation failures — auth, bad model, malformed params.
        // 429s rarely surface here (the SDK fires the HTTP request async),
        // but if they do, retry the same way as iteration-time 429s.
        const { retriable, isRateLimit } = classifyStreamError(err)

        if (!isRateLimit || attempt >= MAX_429_RETRIES) {
          yield {
            type: 'error',
            message:
              authErrorMessage(err, 'Anthropic') ?? `Anthropic stream creation failed: ${(err as Error).message}`,
            retriable,
          }
          yield { type: 'message_stop', stopReason: 'error' }
          return
        }

        yield* yieldRetryBackoff(err, attempt, MAX_429_RETRIES, abortSignal)
        continue retryLoop
      }

      // ── (b) Consume stream ─────────────────────────────────────────────
      try {
        for await (const event of withInactivityTimeout(stream, STREAM_INACTIVITY_TIMEOUT_MS, 'Anthropic stream')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = event as any

          // Buffer per-event normalized outputs so we can mark `anyYielded`
          // at a single point. Once any event has been yielded this run,
          // the iteration-time catch below is no longer allowed to retry.
          const pending: NormalizedStreamEvent[] = []

          switch (e.type) {
            case 'message_start': {
              if (e.message?.usage) {
                const u = e.message.usage
                inputTokens += u.input_tokens ?? 0
                cacheCreationTokens += u.cache_creation_input_tokens ?? 0
                cacheReadTokens += u.cache_read_input_tokens ?? 0
              }
              break
            }

            case 'content_block_start': {
              const blockType: string = e.content_block?.type ?? ''
              currentBlockType = blockType as unknown as typeof currentBlockType

              if (blockType === 'thinking') {
                // no event for block start; delta events carry the text
              } else if (blockType === 'text') {
                // no event; deltas carry text
              } else if (blockType === 'tool_use') {
                const tb = e.content_block as { id: string; name: string }
                currentToolIndex = toolUseBlocks.length
                toolUseBlocks.push({ id: tb.id, name: tb.name, inputJson: '' })
                pending.push({ type: 'tool_use_start', id: tb.id, name: tb.name })
              } else if (blockType === 'server_tool_use') {
                // Anthropic-native server tool (e.g. web_search_20250305) runs on
                // Anthropic's infrastructure. Surface as a non-executable `server_tool`
                // pill — NOT `tool_use_start`, which the consumer adds to the
                // executable toolUseBlocks set, causing the runner to run the tool
                // (e.g. web_search) LOCALLY with empty args. Results arrive
                // separately as web_search_tool_result → citations below.
                const tb = e.content_block as { id: string; name: string }
                pending.push({ type: 'server_tool', name: tb.name, phase: 'start' })
                pending.push({ type: 'server_tool', name: tb.name, phase: 'stop' })
              } else if (blockType === 'web_search_tool_result') {
                // Anthropic native web_search results — emit a citation per URL.
                const tb = e.content_block as {
                  tool_use_id?: string
                  content?: Array<{ type?: string; title?: string; url?: string }>
                }
                const sources = adaptAnthropicCitations(tb.content, tb.tool_use_id)
                for (const src of sources) {
                  pending.push({ type: 'citation', sourceUri: src.url, title: src.title })
                }
              }
              break
            }

            case 'content_block_delta': {
              const deltaType: string = e.delta?.type ?? ''

              if (deltaType === 'thinking_delta') {
                const thinking: string = e.delta?.thinking ?? ''
                pending.push({ type: 'thinking_delta', text: thinking })
              } else if (deltaType === 'text_delta') {
                const text: string = e.delta?.text ?? ''
                pending.push({ type: 'text_delta', text })
              } else if (deltaType === 'input_json_delta' && currentToolIndex >= 0) {
                const partial: string = e.delta?.partial_json ?? ''
                toolUseBlocks[currentToolIndex].inputJson += partial
                const tool = toolUseBlocks[currentToolIndex]
                pending.push({ type: 'tool_use_input_delta', id: tool.id, partialJson: partial })
              }
              break
            }

            case 'content_block_stop': {
              if (currentBlockType === 'tool_use' && currentToolIndex >= 0) {
                const tool = toolUseBlocks[currentToolIndex]
                let finalInput: Record<string, unknown> = {}
                const jsonStr = tool.inputJson.trim()
                if (jsonStr.length > 0) {
                  try {
                    finalInput = JSON.parse(jsonStr)
                  } catch {
                    // Malformed JSON — surface an error but don't crash the stream
                    pending.push({
                      type: 'error',
                      message: `Failed to parse tool input JSON for "${tool.name}": ${jsonStr.slice(0, 120)}`,
                      retriable: false,
                    })
                  }
                }
                pending.push({ type: 'tool_use_stop', id: tool.id, finalInput })
              }
              // NOTE C: no `thinking_complete` event in the union; see file header.
              currentBlockType = null
              break
            }

            case 'message_delta': {
              stopReason = e.delta?.stop_reason ?? stopReason
              if (e.usage) {
                // SDK reports a RUNNING TOTAL per message_delta (assignment),
                // not an increment. Adversarial-review finding: `+=` here
                // double-counted whenever finalMessage() failed to overwrite,
                // shipping inflated billing. Use assignment to mirror SDK
                // semantics; fall back to current value when usage omits the
                // field so a partial delta doesn't reset us to zero.
                outputTokens = e.usage.output_tokens ?? outputTokens
              }
              break
            }

            // message_stop from the Anthropic SDK — we emit our own after finalMessage
            case 'message_stop':
              break

            default:
              break
          }

          // Flush buffered events. `anyYielded` tracks that the consumer has
          // seen SOMETHING this run; `anyCommittedContent` is the stricter gate
          // for retry safety — only text and tool_use events count, because
          // replaying those on a retry would duplicate visible/committed output.
          // thinking_delta / citation / server_tool pills do not, so a 429 that
          // strikes after only those is still safe to retry.
          for (const evt of pending) {
            anyYielded = true
            if (
              evt.type === 'text_delta' ||
              evt.type === 'tool_use_start' ||
              evt.type === 'tool_use_input_delta' ||
              evt.type === 'tool_use_stop'
            ) {
              anyCommittedContent = true
            }
            yield evt
          }
        }
        // Iteration completed without throwing — exit the retry loop.
        break retryLoop
      } catch (err) {
        // A user-initiated abort throws AbortError out of the for-await —
        // surface it as the same clean non-retriable abort the pre-stream
        // path emits, not a generic stream error (no spurious failure UI).
        if (abortSignal?.aborted || (err as Error)?.name === 'AbortError') {
          // If the signal is aborted but the thrown error is NOT itself an
          // abort, a real error raced the user's abort — surface it (still as a
          // clean abort to the consumer) so it isn't silently swallowed.
          const name = (err as Error)?.name
          if (abortSignal?.aborted && name !== 'AbortError' && name !== 'APIUserAbortError') {
            console.warn('[anthropic-adapter] error raced user abort (swallowed as clean abort):', err)
          }
          yield { type: 'error', message: 'Anthropic stream aborted', retriable: false }
          yield { type: 'message_stop', stopReason: 'error' }
          return
        }

        const { retriable, isRateLimit } = classifyStreamError(err)

        // Retry only if (i) it's a rate limit, (ii) we haven't shipped any
        // COMMITTED assistant content (text / tool_use) to the consumer yet,
        // and (iii) we have retries left. Anthropic's per-minute input-token
        // limit commonly 429s after message_start / thinking has streamed but
        // before any text or tool_use — that window is safe to retry because
        // only thinking/citation/server-tool pills were emitted, none of which
        // are replayed as authoritative output. We deliberately use
        // `!anyCommittedContent` rather than `!anyYielded`: the latter made
        // that common case fatal. Replaying after committed content would
        // duplicate visible output, so once it's emitted we propagate instead.
        if (isRateLimit && !anyCommittedContent && attempt < MAX_429_RETRIES) {
          yield* yieldRetryBackoff(err, attempt, MAX_429_RETRIES, abortSignal)
          continue retryLoop
        }

        yield {
          type: 'error',
          message: `Anthropic stream error: ${(err as Error).message}`,
          retriable,
        }
        yield { type: 'message_stop', stopReason: 'error' }
        return
      }
    }

    if (!stream) {
      // All retries exhausted on creation. Treat as a retriable failure so
      // the runner can decide whether to escalate to the user.
      yield { type: 'error', message: 'Anthropic stream creation failed after retries', retriable: true }
      yield { type: 'message_stop', stopReason: 'error' }
      return
    }

    // ── Prefer finalMessage().usage for accurate token counts ─────────────
    // Streaming deltas can undercount; finalMessage() is the source of truth.
    // We also keep the authoritative content blocks to pass through verbatim
    // (thinking signatures, etc.) via message_complete.
    let finalContent: unknown[] | null = null
    try {
      const finalMsg = await stream.finalMessage()
      if (finalMsg.usage && (finalMsg.usage.input_tokens > 0 || finalMsg.usage.output_tokens > 0)) {
        inputTokens = finalMsg.usage.input_tokens
        outputTokens = finalMsg.usage.output_tokens
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u = finalMsg.usage as any
        if (u.cache_creation_input_tokens != null) cacheCreationTokens = u.cache_creation_input_tokens
        if (u.cache_read_input_tokens != null) cacheReadTokens = u.cache_read_input_tokens
      }
      // Prefer stop_reason from finalMessage when available
      if (finalMsg.stop_reason) stopReason = finalMsg.stop_reason
      if (Array.isArray(finalMsg.content) && finalMsg.content.length > 0) {
        finalContent = finalMsg.content
      }
    } catch {
      // finalMessage() failed — streaming counts are the fallback (already accumulated above)
    }

    // ── Pass through authoritative content, then usage, then message_stop ──
    if (finalContent) {
      yield { type: 'message_complete', content: finalContent }
    }
    const usage: NormalizedUsage = {
      inputTokens,
      outputTokens,
      ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    }
    yield { type: 'usage_update', usage }
    yield { type: 'message_stop', stopReason: normalizeStopReason(stopReason) }
  },
}
