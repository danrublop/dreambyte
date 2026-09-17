/**
 * OpenAI adapter.
 *
 * Ports the streaming half of the runner's OpenAI branch (runner.ts ~2184-2475)
 * into the ProviderAdapter interface. Supports both transport shapes:
 *  - Chat Completions streaming (the default path): incremental tool-call args,
 *    usage via stream_options, url_citation annotations.
 *  - Responses API streaming (web search): type-tagged events, hosted
 *    web_search_preview tool, output_text deltas, completion usage.
 *
 * The runner picks the path and any model rerouting (search-preview sibling)
 * BEFORE calling the adapter, then signals the choice via providerOverrides:
 *   { useResponsesApi?: boolean, webSearchOptions?: boolean }
 * A web-search marker tool (type 'openai_web_search') in `tools` tells the
 * adapter to attach the hosted search tool.
 *
 * SCOPE: cloud OpenAI only. Local/Ollama (OpenAI-compatible) stays on the
 * legacy runner branch — it needs a per-endpoint client the adapter interface
 * doesn't carry. NOT yet wired into the runner.
 */

import { randomUUID } from 'node:crypto'
import type OpenAI from 'openai'
import { getOpenAIClient } from '../providers'
import { adaptOpenAICitations } from '../research-citations'
import { STREAM_INACTIVITY_TIMEOUT_MS, withInactivityTimeout } from './stream-timeout'
import { MAX_STREAM_RETRIES, classifyStreamError, yieldRetryBackoff, authErrorMessage } from './retry'
import { extractRawToolResult, messagesCanCarryImages } from '../canonical-messages'
import type {
  ProviderAdapter,
  NormalizedStreamEvent,
  NormalizedUsage,
  StreamChatOptions,
  CanonicalMessage,
} from './adapter'
import type { ModelProvider } from '../model-config'

type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'other'

/** CanonicalMessage[] → OpenAI Chat Completions messages. Tool results become
 *  separate role:'tool' messages (OpenAI's shape); assistant tool_use blocks
 *  become tool_calls.
 *
 *  provider_raw blocks: FOREIGN reasoning blocks (e.g. Anthropic thinking)
 *  have no OpenAI equivalent and are dropped. Same-provider OpenAI-compat
 *  reasoning (`compat_reasoning` blocks for DeepSeek/Qwen/Kimi, matched via
 *  `forProvider`) is re-serialized as the assistant message's
 *  `reasoning_content` — these APIs REQUIRE it replayed on every subsequent
 *  turn of a tool-call conversation and 400 without it (the bug that got
 *  v4-pro misdiagnosed as not supporting tools; same rule for Qwen3-thinking
 *  and Kimi K2.6). */
export function toOpenAIMessages(
  systemPrompt: string,
  messages: CanonicalMessage[],
  forProvider?: ModelProvider,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }]
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
      continue
    }

    // Tool results → one role:'tool' message each. Collect both canonical
    // tool_results and foreign provider_raw tool_results (degraded to text), so
    // every tool_call_id gets an answer (otherwise OpenAI rejects the request).
    // Images inside a tool_result (the capture_frame path) can't ride on a
    // role:'tool' message — the Chat Completions schema takes a string there —
    // so on a VISION-capable provider they follow as a role:'user' turn instead
    // of being flattened to "[image omitted]". Text-only providers (deepseek,
    // local) keep the placeholder; see messagesCanCarryImages.
    const dropImages = !messagesCanCarryImages(forProvider ?? 'openai')
    const toolResultMsgs: Array<{ tool_call_id: string; content: string }> = []
    const toolResultImages: Array<{ mimeType: string; dataBase64: string }> = []
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        toolResultMsgs.push({ tool_call_id: b.toolUseId, content: b.content })
      } else if (b.type === 'provider_raw') {
        const tr = extractRawToolResult(b.block, dropImages)
        if (tr) {
          toolResultMsgs.push({ tool_call_id: tr.toolUseId, content: tr.text })
          toolResultImages.push(...tr.images)
        }
      }
    }
    if (toolResultMsgs.length > 0) {
      for (const tr of toolResultMsgs) {
        out.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content })
      }
      const leftover = m.content.filter((b) => b.type === 'text')
      const leftoverText = leftover.map((b) => (b as { text: string }).text).join('\n')
      if (toolResultImages.length > 0) {
        out.push({
          role: 'user',
          content: [
            ...(leftoverText ? [{ type: 'text' as const, text: leftoverText }] : []),
            ...toolResultImages.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
            })),
          ],
        })
      } else if (leftover.length > 0) {
        out.push({ role: 'user', content: leftoverText })
      }
      continue
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const tu = b as { id: string; name: string; input: Record<string, unknown> }
          return {
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          }
        })
      // Same-provider reasoning replay (DeepSeek/Qwen/Kimi): collect stored
      // compat_reasoning raw blocks for THIS provider. Foreign blocks
      // (anthropic thinking, a different compat provider's reasoning) stay
      // dropped — the provider tag must match the request's provider.
      const reasoning = forProvider
        ? m.content
            .filter(
              (b) =>
                b.type === 'provider_raw' &&
                b.provider === forProvider &&
                (b.block as { type?: string } | null)?.type === 'compat_reasoning',
            )
            .map((b) => String((b as { block: { reasoning_content?: unknown } }).block.reasoning_content ?? ''))
            .join('')
        : ''
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      } as OpenAI.ChatCompletionMessageParam)
      continue
    }

    // user turn: image blocks become content parts; otherwise join text.
    const hasImage = m.content.some((b) => b.type === 'image')
    if (hasImage) {
      const parts = m.content
        .map((b) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          if (b.type === 'image')
            return { type: 'image_url' as const, image_url: { url: `data:${b.mimeType};base64,${b.dataBase64}` } }
          return null
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
      out.push({ role: 'user', content: parts })
    } else {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
      out.push({ role: 'user', content: text })
    }
  }
  return out
}

/**
 * Parse a tool-call's accumulated `arguments` string into an object. OpenAI /
 * compat chat servers stream args as JSON-string fragments; accumulate them and
 * parse authoritatively at tool_use_stop so finalInput is never a blind {} when
 * the input deltas never reached the consumer (e.g. args streamed before the
 * tool name). Empty or malformed args yield {} (the runner surfaces the error).
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const s = (raw ?? '').trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function normalizeChatFinish(reason: string | null, sawToolCall: boolean): StopReason {
  if (reason === 'tool_calls' || sawToolCall) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'stop' || reason == null) return 'end_turn'
  return 'other'
}

/**
 * One streaming attempt. Errors PROPAGATE (no error-event emission) so the
 * retry wrapper in streamChat can decide whether to retry or surface them.
 */
async function* streamOnceOpenAI(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
  {
    const { model, systemPrompt, messages, tools, maxTokens, abortSignal, providerOverrides } = opts
    const useResponsesApi = providerOverrides?.useResponsesApi === true
    const webSearchOptions = providerOverrides?.webSearchOptions === true
    const hasWebSearchMarker = (tools ?? []).some((t) => (t as { type?: string }).type === 'openai_web_search')
    const functionTools = (tools ?? []).filter((t) => !(t as { type?: string }).type)

    let inputTokens = 0
    let outputTokens = 0
    // Cache READ tokens: OpenAI's prompt counts INCLUDE the cached
    // portion; we split it out so usage fields are additive (Anthropic
    // semantics) and calculateCost can bill cached reads at the provider rate.
    let cacheReadTokens = 0
    let sawToolCall = false
    const citations: { url: string; title?: string }[] = []
    // Responses-API stop reason (set on response.incomplete). The Responses tail
    // falls back to tool_use/end_turn when this stays undefined.
    let responsesStop: StopReason | undefined

    {
      const client = getOpenAIClient()

      if (useResponsesApi) {
        // ── Responses API (web search) ──────────────────────────────────────
        const stream = (await client.responses.create(
          {
            model,
            max_output_tokens: maxTokens,
            input: toOpenAIMessages(systemPrompt, messages) as unknown,
            tools: [
              ...(hasWebSearchMarker ? [{ type: 'web_search_preview' }] : []),
              ...functionTools.map((t) => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              })),
            ],
            stream: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          // Forward abort so a disconnect cancels the in-flight request.
          abortSignal ? { signal: abortSignal } : undefined,
        )) as unknown as AsyncIterable<Record<string, any>>

        const argsById: Record<string, { id: string }> = {}
        for await (const event of withInactivityTimeout(
          stream,
          STREAM_INACTIVITY_TIMEOUT_MS,
          'OpenAI Responses stream',
        )) {
          const et = event?.type as string | undefined
          if (et === 'response.output_text.delta' && event.delta) {
            yield { type: 'text_delta', text: event.delta as string }
          } else if (et === 'response.output_item.added') {
            const item = event.item as { type?: string; id?: string; name?: string; call_id?: string } | undefined
            if (item?.type === 'function_call' && item.name) {
              const id = item.call_id ?? item.id ?? randomUUID()
              argsById[(event.item?.id ?? id) as string] = { id }
              sawToolCall = true
              yield { type: 'tool_use_start', id, name: item.name }
            } else if (item?.type === 'web_search_call') {
              // Hosted web search running server-side — surface as a UI pill (the
              // legacy path did the same). Not an executable tool call.
              yield { type: 'server_tool', name: 'web_search', phase: 'start' }
            }
          } else if (et === 'response.output_item.done') {
            const item = event.item as { type?: string } | undefined
            if (item?.type === 'web_search_call') {
              yield { type: 'server_tool', name: 'web_search', phase: 'stop' }
            }
          } else if (et === 'response.function_call_arguments.delta') {
            const key = (event.item_id ?? event.id) as string | undefined
            const rec = key ? argsById[key] : undefined
            if (rec && event.delta)
              yield { type: 'tool_use_input_delta', id: rec.id, partialJson: event.delta as string }
          } else if (et === 'response.completed' || et === 'response.incomplete') {
            const usage = event.response?.usage
            if (usage) {
              // Assign, don't accumulate: the Responses API reports cumulative
              // totals on response.completed/incomplete. `+=` double-counted when
              // both fire (or usage appeared earlier), inflating cost.
              // Cache normalization: OpenAI's input_tokens INCLUDES the
              // cached portion (input_tokens_details.cached_tokens) — split it
              // out so the fields are ADDITIVE like Anthropic's, which is what
              // calculateCost expects.
              const cached =
                (usage as { input_tokens_details?: { cached_tokens?: number } }).input_tokens_details?.cached_tokens ??
                0
              if (cached > 0) {
                cacheReadTokens = cached
                inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cached)
              } else {
                inputTokens = usage.input_tokens ?? inputTokens
              }
              outputTokens = usage.output_tokens ?? outputTokens
            }
            // Truncation: the Responses API ends with `response.incomplete` and an
            // incomplete_details.reason of "max_output_tokens" when the cap is hit.
            // Report it as max_tokens (the Chat Completions path already maps
            // finish_reason 'length' → 'max_tokens'; this gives Responses parity).
            if (et === 'response.incomplete') {
              const reason = event.response?.incomplete_details?.reason as string | undefined
              responsesStop = reason === 'max_output_tokens' ? 'max_tokens' : 'other'
            }
            const output = event.response?.output
            if (Array.isArray(output)) {
              for (const it of output) {
                if (it?.type === 'message' && Array.isArray(it.content)) {
                  for (const c of it.content) {
                    if (Array.isArray(c?.annotations)) {
                      for (const src of adaptOpenAICitations(c.annotations)) citations.push(src)
                    }
                  }
                }
              }
            }
          }
        }
        // Responses API delivers complete function-call args; if any tool never
        // got an explicit stop, the consumer already accumulated its deltas.
      } else {
        // ── Chat Completions (default) ──────────────────────────────────────
        // o-series reasoning models (o1/o3/o4-mini…) reject `max_tokens` on the
        // Chat Completions path — they require `max_completion_tokens`. o1 is
        // shielded upstream but o3-mini is not, so gate on the id here. Non-o
        // models keep `max_tokens`. `temperature` is already omitted for all
        // (never sent), which these models also require.
        const isOSeries = /^o\d/.test(model)
        const stream = (await client.chat.completions.create(
          {
            model,
            ...(isOSeries ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
            messages: toOpenAIMessages(systemPrompt, messages),
            tools:
              functionTools.length > 0
                ? functionTools.map((t) => ({
                    type: 'function' as const,
                    function: { name: t.name, description: t.description, parameters: t.input_schema },
                  }))
                : undefined,
            stream: true,
            stream_options: { include_usage: true },
            ...(webSearchOptions ? { web_search_options: {} } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          abortSignal ? { signal: abortSignal } : undefined,
        )) as unknown as AsyncIterable<Record<string, any>>

        const toolByIndex: Record<number, { id: string; started: boolean; args: string }> = {}
        let finishReason: string | null = null
        for await (const chunk of withInactivityTimeout(stream, STREAM_INACTIVITY_TIMEOUT_MS, 'OpenAI stream')) {
          if (chunk.usage) {
            // Cache normalization: prompt_tokens INCLUDES cached tokens
            // (prompt_tokens_details.cached_tokens) — split them out so the
            // fields are additive (Anthropic semantics) for calculateCost.
            const cached =
              (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details
                ?.cached_tokens ?? 0
            inputTokens += Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached)
            cacheReadTokens += cached
            outputTokens += chunk.usage.completion_tokens ?? 0
          }
          const choice = chunk.choices?.[0]
          const delta = choice?.delta
          if (!delta) {
            if (choice?.finish_reason) finishReason = choice.finish_reason
            continue
          }
          if (delta.content) {
            yield { type: 'text_delta', text: delta.content as string }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index as number
              if (!toolByIndex[idx]) {
                const id = (tc.id as string) || randomUUID()
                toolByIndex[idx] = { id, started: false, args: '' }
              }
              const rec = toolByIndex[idx]
              if (!rec.started && tc.function?.name) {
                rec.started = true
                sawToolCall = true
                yield { type: 'tool_use_start', id: rec.id, name: tc.function.name as string }
              }
              if (tc.function?.arguments) {
                // Accumulate authoritatively AND stream for the UI — see parseToolArgs.
                rec.args += tc.function.arguments as string
                yield { type: 'tool_use_input_delta', id: rec.id, partialJson: tc.function.arguments as string }
              }
            }
          }
          const annotations = (delta as { annotations?: unknown }).annotations
          if (Array.isArray(annotations)) {
            for (const src of adaptOpenAICitations(annotations)) citations.push(src)
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
        }
        // Emit a tool_use_stop per accumulated tool so the consumer can finalize.
        for (const rec of Object.values(toolByIndex)) {
          yield { type: 'tool_use_stop', id: rec.id, finalInput: parseToolArgs(rec.args) }
        }
        for (const src of citations) yield { type: 'citation', sourceUri: src.url, title: src.title }
        yield {
          type: 'usage_update',
          usage: { inputTokens, outputTokens, ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}) } as NormalizedUsage,
        }
        yield { type: 'message_stop', stopReason: normalizeChatFinish(finishReason, sawToolCall) }
        return
      }
    }

    // Responses-API tail (Chat Completions path returned above).
    for (const src of citations) yield { type: 'citation', sourceUri: src.url, title: src.title }
    yield {
      type: 'usage_update',
      usage: { inputTokens, outputTokens, ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}) },
    }
    yield { type: 'message_stop', stopReason: responsesStop ?? (sawToolCall ? 'tool_use' : 'end_turn') }
  }
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',

  async *streamChat(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
    // Retry wrapper around streamOnceOpenAI. Retries only transient rate limits,
    // and only before any event has been yielded — a partially-streamed turn
    // can't be cleanly re-run (mirrors the Anthropic adapter's anyYielded guard).
    let anyYielded = false
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      try {
        for await (const ev of streamOnceOpenAI(opts)) {
          anyYielded = true
          yield ev
        }
        return
      } catch (err) {
        // Don't retry an aborted request — the AbortError would classify as
        // retriable and spin the loop. Let the runner's abort handling take over.
        if (opts.abortSignal?.aborted) {
          yield { type: 'error', message: 'OpenAI stream aborted', retriable: false }
          yield { type: 'message_stop', stopReason: 'error' }
          return
        }
        const { retriable, isRateLimit } = classifyStreamError(err)
        if (isRateLimit && !anyYielded && attempt < MAX_STREAM_RETRIES) {
          yield* yieldRetryBackoff(err, attempt, MAX_STREAM_RETRIES, opts.abortSignal)
          continue
        }
        yield {
          type: 'error',
          message: authErrorMessage(err, 'OpenAI') ?? `OpenAI stream error: ${(err as Error).message}`,
          retriable,
        }
        yield { type: 'message_stop', stopReason: 'error' }
        return
      }
    }
  },
}
