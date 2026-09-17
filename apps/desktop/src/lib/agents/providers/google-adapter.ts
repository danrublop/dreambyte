/**
 * Google Gemini adapter.
 *
 * Ports the streaming half of the runner's Gemini branch (runner.ts ~1865-1974)
 * into the ProviderAdapter interface: translate canonical messages + tools into
 * Gemini's `contents` / `functionDeclarations` shape, stream
 * `generateContentStream`, and normalize each chunk into NormalizedStreamEvent.
 *
 * Gemini specifics handled here so the consumer stays provider-agnostic:
 *  - Function calls arrive complete in a chunk (no incremental arg deltas), so
 *    we emit tool_use_start + tool_use_stop back-to-back with the parsed args.
 *  - usageMetadata is CUMULATIVE per stream call, so we emit a single
 *    usage_update with the latest totals (matches the usage_update contract).
 *  - groundingMetadata → citation events.
 *  - No signed thinking blocks, so no message_complete is emitted; the consumer
 *    reconstructs assistant content from the deltas.
 *
 * NOT yet wired into the runner: the runner's Gemini branch is a complete
 * bespoke loop (own tool execution + Gemini-format history). Converging it onto
 * the shared tail is a separate, larger change; until then this adapter is
 * exercised through its own tests and behind runConfig.useProviderAdapters.
 */

import { randomUUID } from 'node:crypto'
import { getGoogleClient } from '../providers'
import { adaptGeminiCitations } from '../research-citations'
import { STREAM_INACTIVITY_TIMEOUT_MS, withInactivityTimeout } from './stream-timeout'
import { MAX_STREAM_RETRIES, classifyStreamError, yieldRetryBackoff, authErrorMessage } from './retry'
import { extractRawToolResult } from '../canonical-messages'
import type {
  ProviderAdapter,
  NormalizedStreamEvent,
  NormalizedUsage,
  StreamChatOptions,
  CanonicalMessage,
} from './adapter'

type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'other'
type GeminiPart = { text?: string; inlineData?: unknown; functionCall?: unknown; functionResponse?: unknown }
type GeminiContent = { role: string; parts: GeminiPart[] }

/**
 * Build the tool_use id → function NAME map for a conversation.
 *
 * Gemini pairs a `functionResponse` to its `functionCall` BY NAME — there is no
 * id field in the pairing (https://ai.google.dev/gemini-api/docs/function-calling).
 * Our canonical `toolUseId` is a `randomUUID()` minted per streamed call, so
 * sending it as the response `name` produced an unmatchable response on EVERY
 * tool turn after the first. The name has to survive the round trip, and the
 * only place it exists is the assistant `tool_use` block that opened the call.
 *
 * Exported for the round-trip test.
 */
export function toolNamesByUseId(messages: CanonicalMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        names.set(block.id, block.name)
      } else if (block.type === 'provider_raw') {
        // An Anthropic-format tool_use carried opaquely (mid-chat model switch).
        const b = block.block as { type?: string; id?: unknown; name?: unknown } | null
        if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') names.set(b.id, b.name)
      }
    }
  }
  return names
}

/** CanonicalMessage[] → Gemini `contents`. */
function toGeminiContents(messages: CanonicalMessage[]): GeminiContent[] {
  const out: GeminiContent[] = []
  const names = toolNamesByUseId(messages)
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    if (typeof m.content === 'string') {
      out.push({ role, parts: [{ text: m.content }] })
      continue
    }
    const parts: GeminiPart[] = []
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: block.mimeType, data: block.dataBase64 } })
          break
        case 'tool_use':
          parts.push({ functionCall: { name: block.name, args: block.input } })
          break
        case 'tool_result':
          parts.push({
            functionResponse: {
              name: names.get(block.toolUseId) ?? block.toolUseId,
              response: { result: block.content },
            },
          })
          break
        case 'provider_raw':
          // A Gemini-native block round-trips verbatim. Foreign reasoning blocks
          // (e.g. Anthropic thinking) have no meaning here and are skipped — but a
          // foreign tool_result must still answer its functionCall, so degrade it
          // to a text functionResponse rather than dropping it.
          if (block.provider === 'google') {
            parts.push(block.block as GeminiPart)
          } else {
            const tr = extractRawToolResult(block.block)
            if (tr) {
              parts.push({
                functionResponse: {
                  name: names.get(tr.toolUseId) ?? tr.toolUseId,
                  response: { result: tr.text },
                },
              })
              // Gemini is vision-capable but has no image slot INSIDE a
              // functionResponse — an inlineData part in the same user turn is
              // the documented way to hand it the pixels a tool produced.
              for (const img of tr.images) {
                parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } })
              }
            }
          }
          break
      }
    }
    if (parts.length > 0) out.push({ role, parts })
  }
  return out
}

/** Map a Gemini finishReason to the normalized stop reason. A turn with any
 *  function call is reported as tool_use regardless of finishReason (Gemini
 *  uses STOP even when it emitted a functionCall). */
function normalizeStopReason(reason: string | null | undefined, sawToolCall: boolean): StopReason {
  if (sawToolCall) return 'tool_use'
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  if (reason === 'STOP' || reason == null) return 'end_turn'
  return 'other'
}

/**
 * One streaming attempt. Errors PROPAGATE (no error-event emission) so the
 * retry wrapper in streamChat can decide whether to retry or surface them.
 */
async function* streamOnceGoogle(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
  {
    const { model, systemPrompt, messages, tools, maxTokens, abortSignal } = opts

    // Tools: custom tools become functionDeclarations; a google_search marker
    // (a server tool, carries a `type`) becomes a separate googleSearch entry.
    const hasGoogleSearch = (tools ?? []).some((t) => (t as { type?: string }).type === 'google_search')
    const functionTools = (tools ?? []).filter((t) => !(t as { type?: string }).type)
    const toolEntries: unknown[] = []
    if (functionTools.length > 0) {
      toolEntries.push({
        functionDeclarations: functionTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      })
    }
    if (hasGoogleSearch) {
      const isGemini15 = /gemini-1\.5/i.test(String(model))
      toolEntries.push(isGemini15 ? { googleSearchRetrieval: {} } : { googleSearch: {} })
    }

    const contents = toGeminiContents(messages)
    let inputTokens = 0
    let outputTokens = 0
    // Implicit-caching reads — split out of promptTokenCount below.
    let cacheReadTokens = 0
    let sawToolCall = false
    let finishReason: string | null = null

    {
      const google = getGoogleClient()
      const response = await google.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: maxTokens,
          ...(toolEntries.length > 0 ? { tools: toolEntries } : {}),
          ...(abortSignal ? { abortSignal } : {}),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const guarded = withInactivityTimeout<Record<string, any>>(
        response as AsyncIterable<Record<string, any>>,
        STREAM_INACTIVITY_TIMEOUT_MS,
        'Gemini stream',
      )
      for await (const chunk of guarded) {
        if (chunk.text) {
          yield { type: 'text_delta', text: chunk.text }
        }
        const parts = chunk.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part?.functionCall) {
              sawToolCall = true
              const id = randomUUID()
              const name: string = part.functionCall.name ?? ''
              const args = (part.functionCall.args as Record<string, unknown>) ?? {}
              yield { type: 'tool_use_start', id, name }
              yield { type: 'tool_use_stop', id, finalInput: args }
            }
          }
        }
        const grounding = chunk.candidates?.[0]?.groundingMetadata
        if (grounding) {
          for (const src of adaptGeminiCitations(grounding)) {
            yield { type: 'citation', sourceUri: src.url, title: src.title }
          }
        }
        // Gemini reports cumulative usage per call — keep the latest.
        // Cache normalization: promptTokenCount INCLUDES the implicit-
        // caching portion (cachedContentTokenCount) — split it out so usage
        // fields are additive (Anthropic semantics) and calculateCost bills
        // cached reads at Gemini's rate instead of full input price.
        if (chunk.usageMetadata) {
          const cached = (chunk.usageMetadata as { cachedContentTokenCount?: number }).cachedContentTokenCount ?? 0
          const prompt = chunk.usageMetadata.promptTokenCount
          if (typeof prompt === 'number') {
            inputTokens = Math.max(0, prompt - cached)
            cacheReadTokens = cached
          }
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
        }
        const fr = chunk.candidates?.[0]?.finishReason
        if (fr) finishReason = fr
      }
    }

    const usage: NormalizedUsage = {
      inputTokens,
      outputTokens,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    }
    yield { type: 'usage_update', usage }
    yield { type: 'message_stop', stopReason: normalizeStopReason(finishReason, sawToolCall) }
  }
}

export const googleAdapter: ProviderAdapter = {
  id: 'google',

  async *streamChat(opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
    // Retry wrapper around streamOnceGoogle. Retries only transient rate limits,
    // and only before any event has been yielded (mirrors the other adapters).
    let anyYielded = false
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      try {
        for await (const ev of streamOnceGoogle(opts)) {
          anyYielded = true
          yield ev
        }
        return
      } catch (err) {
        // Don't retry an aborted request — the AbortError would classify as
        // retriable and spin the loop. Let the runner's abort handling take over.
        if (opts.abortSignal?.aborted) {
          yield { type: 'error', message: 'Gemini stream aborted', retriable: false }
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
          message: authErrorMessage(err, 'Gemini') ?? `Gemini stream error: ${(err as Error).message}`,
          retriable,
        }
        yield { type: 'message_stop', stopReason: 'error' }
        return
      }
    }
  },
}
