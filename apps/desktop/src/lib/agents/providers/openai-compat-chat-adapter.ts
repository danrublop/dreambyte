/**
 * OpenAI-compatible Chat Completions adapter factory.
 *
 * DeepSeek, Qwen (DashScope), and Kimi (Moonshot) all expose the OpenAI
 * `/chat/completions` streaming protocol — the same shape the `openaiAdapter`
 * already handles. Rather than copy that logic per provider (or risk the
 * battle-tested OpenAI adapter, which also carries the Responses-API + web-search
 * paths), this factory wraps ONLY the chat-completions streaming, parameterized
 * by the provider id + its client. One line registers a new provider as a
 * first-class agent model.
 *
 * Reuses `toOpenAIMessages` / `normalizeChatFinish` from openai-adapter (single
 * source of truth for the canonical↔OpenAI translation).
 */

import { randomUUID } from 'node:crypto'
import type OpenAI from 'openai'

import { adaptOpenAICitations } from '../research-citations'
import { STREAM_INACTIVITY_TIMEOUT_MS, withInactivityTimeout } from './stream-timeout'
import { authErrorMessage } from './retry'
import { toOpenAIMessages, normalizeChatFinish, parseToolArgs } from './openai-adapter'
import type { ModelProvider } from '../model-config'
import type { ProviderAdapter, NormalizedStreamEvent, NormalizedUsage, StreamChatOptions } from './adapter'

/**
 * Build a ProviderAdapter for an OpenAI-compatible chat provider.
 * @param id       the ModelProvider id (must match the model's `provider`)
 * @param getClient resolves the provider's OpenAI-SDK client (own baseURL + key)
 */
/**
 * Whether a failed request is worth retrying: rate limit (429), transient server
 * error (5xx), or a connection error with no HTTP status (ECONNRESET/DNS). A 4xx
 * other than 429 is a client error (bad key, bad request) — never retried.
 * Exported as the single retry policy for OpenAI-compat calls (the single-shot
 * codegen path in src/lib/generation/generate.ts reuses it).
 */
export function isRetriableStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500
}

/**
 * Map the app's thinkingMode to DeepSeek's request override. 'off' is a real
 * kill switch ({type:'disabled'}); every other mode rides the API's thinking
 * (no budget_tokens concept — binary). Lives here (not inline in the runner)
 * so the mapping is unit-testable next to the adapter that consumes it.
 */
export function deepseekThinkingOverride(thinkingMode: 'off' | 'adaptive' | 'deep' | undefined): {
  thinking: { type: 'enabled' | 'disabled' }
} {
  return deepseekThinkingParam(thinkingMode !== 'off')
}

/**
 * The DeepSeek thinking request param — a binary enable/disable (no budget_tokens
 * concept). Single source of truth for the shape so the agent adapter (keyed on
 * thinkingMode) and the single-shot codegen path in src/lib/generation/generate.ts
 * (keyed on model id) can't drift if DeepSeek ever renames the field.
 */
export function deepseekThinkingParam(enabled: boolean): { thinking: { type: 'enabled' | 'disabled' } } {
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
}

/**
 * Map the app's thinkingMode to Kimi K3's top-level `reasoning_effort`. K3 REMOVED
 * the K2.x `thinking` param — it always reasons and takes `low`|`high`|`max`
 * (default `max`). We set it explicitly so a long agent tool-loop (dozens of turns)
 * doesn't run at the slow `max` default: off→low (K3 can't fully disable reasoning),
 * adaptive→high, deep→max. See platform.kimi.ai/docs/guide/use-thinking-effort.
 * Tunable if K3 turns out too slow at high.
 */
export function kimiK3ReasoningEffort(thinkingMode: 'off' | 'adaptive' | 'deep' | undefined): 'low' | 'high' | 'max' {
  if (thinkingMode === 'off') return 'low'
  if (thinkingMode === 'deep') return 'max'
  return 'high'
}

export function createOpenAICompatChatAdapter(
  id: ModelProvider,
  /** Resolves the provider's client. Receives the call options so a per-call
   *  endpoint (local/Ollama, whose base URL comes from the model config) can be
   *  honored; the fixed-endpoint cloud providers ignore the argument. */
  getClient: (opts: StreamChatOptions) => OpenAI,
): ProviderAdapter {
  return {
    id,
    async *streamChat(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
      const { model, systemPrompt, messages, tools, maxTokens, abortSignal, providerOverrides } = opts
      const functionTools = (tools ?? []).filter((t) => !(t as { type?: string }).type)
      // Per-provider thinking control. All three compat reasoning providers
      // replay reasoning_content unconditionally (handled in message
      // serialization); the request-side thinking PARAMETER differs:
      //  - DeepSeek V4: defaults thinking ON; the runner maps thinkingMode to
      //    {thinking:{type:'enabled'|'disabled'}} ('off' is a real kill switch).
      //  - Kimi K2.6: thinking ON by default; multi-turn tool use needs
      //    {thinking:{type:'enabled',keep:'all'}} so historical reasoning is
      //    kept (Moonshot docs). Honor an explicit disable.
      //  - Qwen: qwen-plus/flash default thinking OFF, so no param needed; a
      //    qwen3-thinking model emits reasoning that the replay still handles.
      const overrideThinking = providerOverrides?.thinking as { type?: string } | undefined
      let thinkingOverride: Record<string, unknown> = {}
      if (id === 'deepseek' && overrideThinking !== undefined) {
        thinkingOverride = { thinking: overrideThinking }
      } else if (id === 'kimi') {
        if (/^kimi-k3/.test(model)) {
          // Kimi K3 removed the K2.x `thinking` param: it ALWAYS reasons and takes a
          // top-level `reasoning_effort` (low|high|max). Send that and do NOT send
          // `thinking` (K3 rejects/ignores it). Effort comes from the runner's
          // thinkingMode map (kimiK3ReasoningEffort); default high if unset.
          const eff = (providerOverrides?.reasoningEffort as 'low' | 'high' | 'max' | undefined) ?? 'high'
          thinkingOverride = { reasoning_effort: eff }
        } else {
          thinkingOverride =
            overrideThinking?.type === 'disabled'
              ? { thinking: { type: 'disabled' } }
              : { thinking: { type: 'enabled', keep: 'all' } }
        }
      }
      // Qwen (DashScope) native web search: the context-builder swaps web_search to a
      // `qwen_web_search` marker (typed, so it's excluded from functionTools above). When
      // present, flip on DashScope's enable_search. The compat endpoint grounds answers but
      // returns no citation sources. Gate on BOTH id === 'qwen' AND the marker so a stray
      // marker can never leak enable_search into a DeepSeek/Kimi request on this shared adapter.
      const hasQwenWebSearch =
        id === 'qwen' && (tools ?? []).some((t) => (t as { type?: string }).type === 'qwen_web_search')
      let inputTokens = 0
      let outputTokens = 0
      // Cache READ tokens: DeepSeek reports
      // prompt_cache_hit_tokens (Qwen/Kimi use OpenAI-style
      // prompt_tokens_details.cached_tokens) with prompt_tokens INCLUSIVE of
      // the cached share. Split it out so usage is additive (Anthropic
      // semantics) and calculateCost bills cache reads at the provider ratio
      // instead of full input price — without the split, long agent sessions
      // overstate DeepSeek spend up to ~50x on the cached share.
      let cacheReadTokens = 0
      let sawToolCall = false
      const citations: { url: string; title?: string }[] = []

      try {
        const client = getClient(opts)
        const requestBody = {
          model,
          max_tokens: maxTokens,
          // Pass the provider id so stored same-provider reasoning blocks are
          // re-serialized as `reasoning_content` on replay. DeepSeek REQUIRES
          // this in tool-call conversations (400 without it) — and the replay
          // is unconditional: disabling thinking via the override above must
          // not strip already-stored reasoning from history.
          messages: toOpenAIMessages(systemPrompt, messages, id),
          tools:
            functionTools.length > 0
              ? functionTools.map((t) => ({
                  type: 'function' as const,
                  function: { name: t.name, description: t.description, parameters: t.input_schema },
                }))
              : undefined,
          stream: true,
          stream_options: { include_usage: true },
          // DashScope extras (ignored by other compat providers since the marker is qwen-only):
          // search_strategy 'agent' lets the model decide whether/what to search.
          ...(hasQwenWebSearch ? { enable_search: true, search_options: { search_strategy: 'agent' } } : {}),
          ...thinkingOverride,
        }
        // Bounded retry across the WHOLE stream (open + consume). A transient failure
        // BEFORE any committed content (a text token or a tool call) is safely re-run:
        // the consumer resets its per-turn accumulators (thinking/citations) on the
        // retriable `error` signal (see adapter-stream-consumer's error case, built for
        // exactly this), so attempt N+1 re-streams cleanly. This recovers the common
        // `terminated`/ECONNRESET mid-stream drop that used to nuke the whole run (a 25-36s
        // DeepSeek turn that gets its socket closed). ONCE committed content has streamed,
        // a drop is terminal — a partial answer / tool call can't be replayed.
        const RETRY_DELAYS_MS = [1000, 4000]
        const backoffMs = (ms: number) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms)
            abortSignal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t)
                resolve()
              },
              { once: true },
            )
          })
        const abortedError = function* (): Generator<NormalizedStreamEvent> {
          yield { type: 'error', message: `${id} stream aborted`, retriable: false }
          yield { type: 'message_stop', stopReason: 'error' }
        }
        let committedContent = false
        streamRetry: for (let attempt = 0; ; attempt++) {
          // Per-attempt reset — a retry re-streams everything from scratch (the consumer
          // resets thinking/citations to match; text/tool are only committed on success).
          inputTokens = 0
          outputTokens = 0
          cacheReadTokens = 0
          sawToolCall = false
          citations.length = 0
          const toolByIndex: Record<number, { id: string; started: boolean; args: string }> = {}
          let finishReason: string | null = null

          // 1) Open the stream (retriable on 429 / transient 5xx / no-status conn error).
          let stream: AsyncIterable<Record<string, any>>
          try {
            stream = (await client.chat.completions.create(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              requestBody as any,
              abortSignal ? { signal: abortSignal } : undefined,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            )) as unknown as AsyncIterable<Record<string, any>>
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const status: number | undefined = (e as any)?.status ?? (e as any)?.response?.status
            if (abortSignal?.aborted || !isRetriableStatus(status) || attempt >= RETRY_DELAYS_MS.length) {
              yield {
                type: 'error',
                message: authErrorMessage(e, id) ?? `${id} stream error: ${(e as Error).message}`,
                retriable: isRetriableStatus(status),
              }
              yield { type: 'message_stop', stopReason: 'error' }
              return
            }
            await backoffMs(RETRY_DELAYS_MS[attempt])
            if (abortSignal?.aborted) return yield* abortedError()
            continue streamRetry
          }

          // 2) Consume the stream. A mid-stream throw retries iff nothing committed yet.
          try {
            for await (const chunk of withInactivityTimeout(stream!, STREAM_INACTIVITY_TIMEOUT_MS, `${id} stream`)) {
              if (chunk.usage) {
                // Provider-trust hardening (review): coerce to finite numbers (a
                // malformed value would otherwise ride NaN into calculateCost and
                // spend caps), clamp cached ≤ prompt (Qwen/Kimi cached_tokens
                // inclusiveness isn't guaranteed), and use last-wins assignment —
                // usage arrives as a cumulative snapshot on the final chunk
                // (stream_options.include_usage), so assignment can't double-count
                // a provider that repeats cumulative usage mid-stream.
                const u = chunk.usage as Record<string, any>
                const prompt = Math.max(0, Number(u.prompt_tokens) || 0)
                const cachedRaw = Math.max(
                  0,
                  Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0,
                )
                const cached = Math.min(cachedRaw, prompt)
                inputTokens = prompt - cached
                cacheReadTokens = cached
                outputTokens = Math.max(0, Number(u.completion_tokens) || 0)
              }
              const choice = chunk.choices?.[0]
              const delta = choice?.delta
              if (!delta) {
                if (choice?.finish_reason) finishReason = choice.finish_reason
                continue
              }
              // DeepSeek reasoner / Qwen3 + Kimi thinking modes stream their chain of
              // thought in `reasoning_content` (non-standard OpenAI field) before the
              // answer. Surface it as thinking so a reasoning model doesn't look hung;
              // dropping it would show dead air until the final answer arrives.
              const reasoning = (delta as { reasoning_content?: unknown }).reasoning_content
              if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking_delta', text: reasoning }
              if (delta.content) {
                committedContent = true // past this point a mid-stream drop is terminal (can't replay a partial answer)
                yield { type: 'text_delta', text: delta.content as string }
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index as number
                  if (!toolByIndex[idx])
                    toolByIndex[idx] = { id: (tc.id as string) || randomUUID(), started: false, args: '' }
                  const rec = toolByIndex[idx]
                  if (!rec.started && tc.function?.name) {
                    rec.started = true
                    sawToolCall = true
                    // Do NOT commit here: a bare tool_use_start (name, no args yet) is
                    // safely re-emittable after the consumer resets on a retriable error.
                    // Committing on the name made a socket drop in the name→args window
                    // (DeepSeek's `terminated`/ECONNRESET) non-retriable → whole run crash.
                    // Commit only once actual arg bytes have streamed (below).
                    yield { type: 'tool_use_start', id: rec.id, name: tc.function.name as string }
                  }
                  if (tc.function?.arguments) {
                    committedContent = true // arg bytes streamed — past here a partial replay isn't safe
                    // Accumulate authoritatively AND stream for the UI. Some compat
                    // servers stream `arguments` in a chunk BEFORE `name`, so the
                    // input_delta fires before tool_use_start and the consumer drops
                    // it (unmapped id) → empty input → finalInput:{} → the tool runs
                    // with {} and dead-ends on stuck_invalid_args. Keeping our own
                    // accumulator lets tool_use_stop carry the parsed args regardless.
                    rec.args += tc.function.arguments as string
                    yield { type: 'tool_use_input_delta', id: rec.id, partialJson: tc.function.arguments as string }
                  }
                }
              }
              const annotations = (delta as { annotations?: unknown }).annotations
              if (Array.isArray(annotations)) for (const src of adaptOpenAICitations(annotations)) citations.push(src)
              if (choice?.finish_reason) finishReason = choice.finish_reason
            }
            for (const rec of Object.values(toolByIndex))
              yield { type: 'tool_use_stop', id: rec.id, finalInput: parseToolArgs(rec.args) }
            for (const src of citations) yield { type: 'citation', sourceUri: src.url, title: src.title }
            yield {
              type: 'usage_update',
              usage: {
                inputTokens,
                outputTokens,
                ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
              } as NormalizedUsage,
            }
            yield { type: 'message_stop', stopReason: normalizeChatFinish(finishReason, sawToolCall) }
            return
          } catch (streamErr) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const status: number | undefined = (streamErr as any)?.status ?? (streamErr as any)?.response?.status
            const retriable = isRetriableStatus(status)
            if (retriable && !committedContent && attempt < RETRY_DELAYS_MS.length && !abortSignal?.aborted) {
              // Retriable drop before any committed content → tell the consumer to reset its
              // per-turn accumulators (thinking/citations), back off, and re-stream the turn.
              yield {
                type: 'error',
                message: `${id} stream error (retrying): ${(streamErr as Error).message}`,
                retriable: true,
              }
              await backoffMs(RETRY_DELAYS_MS[attempt])
              if (abortSignal?.aborted) return yield* abortedError()
              continue streamRetry
            }
            yield {
              type: 'error',
              message: authErrorMessage(streamErr, id) ?? `${id} stream error: ${(streamErr as Error).message}`,
              retriable,
            }
            yield { type: 'message_stop', stopReason: 'error' }
            return
          }
        }
      } catch (err) {
        // Safety net: an error OUTSIDE the per-attempt stream handling (e.g. building the
        // request). The in-loop catches own every stream open/consume failure + retry.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = err as any
        const status: number | undefined = e?.status ?? e?.response?.status
        yield {
          type: 'error',
          message: authErrorMessage(err, id) ?? `${id} stream error: ${(err as Error).message}`,
          retriable: isRetriableStatus(status),
        }
        yield { type: 'message_stop', stopReason: 'error' }
      }
    },
  }
}
