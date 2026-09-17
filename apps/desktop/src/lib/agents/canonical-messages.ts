/**
 * Lossless conversion between the runner's Anthropic-format message array and
 * the provider-agnostic CanonicalMessage[] the ProviderAdapter consumes.
 *
 * Why this has to be lossless: the runner accumulates assistant turns verbatim
 * (incl. Anthropic `thinking` blocks with `signature`s, and `tool_result`s that
 * carry image blocks from the capture flow). To drive the adapter we convert
 * those to CanonicalMessage[]; if that conversion dropped or mangled any block,
 * the NEXT API call would be rejected (missing thinking signature) or lose
 * context (dropped capture image). So anything the typed canonical primitives
 * (text/image/tool_use/string tool_result) can't represent exactly is carried
 * through a `provider_raw` opaque block and reconstructed verbatim.
 *
 * The Anthropic round-trip `toCanonical(toAnthropic(x)) ≡ x` is enforced by
 * canonical-messages.test.ts.
 */

import type { CanonicalMessage } from './providers/adapter'

/**
 * Render a provider tool_result's `content` (string or block array) to plain
 * text. Image blocks are noted, not embedded — used when a foreign-provider
 * tool_result must answer a function call on an adapter that can't carry the
 * original block shape.
 */
/**
 * Can a tool_result IMAGE survive serialization for this provider?
 *
 * The Anthropic message shape carries image blocks natively. The other
 * VISION-CAPABLE providers get the pixels re-attached alongside the tool answer
 * (OpenAI/Qwen/Kimi as a follow-up `user` content part, Gemini as an `inlineData`
 * part in the same turn) — neither API accepts an image *inside* a tool/function
 * response, so it rides next to it.
 *
 * The placeholder text `[image omitted]` therefore survives for exactly two
 * providers, both genuinely required:
 *  - `deepseek` — the cloud DeepSeek chat models are text/reasoning only
 *    (vision is deepseek-vl2, open-weights, not this endpoint). It relies on
 *    the separate vision engine instead.
 *  - `local` — an arbitrary Ollama tag; most are text-only and an unexpected
 *    image part is a hard 400 on llama.cpp servers. Opt in per model if needed.
 *
 * This is NOT a statement about whether the model can see. Text-only runs route
 * captured frames to a SEPARATE vision engine (`runVisualQualityCheck`) and get its
 * findings back as text — that is deliberate, and DeepSeek relies on it entirely.
 * Use this only to answer "would attaching the image to the tool_result do anything".
 */
export function messagesCanCarryImages(provider: string): boolean {
  return provider !== 'deepseek' && provider !== 'local'
}

/** Text blocks of a provider tool_result `content`, images excluded (they are
 *  returned separately by extractRawToolResult so the caller can attach or drop
 *  them per provider). */
function rawContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const x = c as { type?: string; text?: string }
        return x?.type === 'text' ? (x.text ?? '') : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

export interface RawToolResult {
  toolUseId: string
  /** Text rendering. Carries a `[image omitted]` line only when `images` is
   *  non-empty AND the caller asked for the placeholder (text-only provider). */
  text: string
  /** Image blocks lifted out of the tool_result (the capture_frame path). */
  images: Array<{ mimeType: string; dataBase64: string }>
}

/**
 * If a `provider_raw` block wraps a tool_result (e.g. an Anthropic array-content
 * tool_result the typed canonical form can't hold), extract its tool_use_id, a
 * text rendering, and any image blocks so a NON-origin adapter (OpenAI/Gemini)
 * can still answer the function call instead of leaving an unmatched
 * tool_call_id. Returns null for raw blocks that aren't tool_results (those have
 * no equivalent and are dropped).
 *
 * `omitImages` (text-only providers — see messagesCanCarryImages) drops the
 * pixels and says so in the text rather than pretending nothing was captured.
 */
export function extractRawToolResult(raw: unknown, omitImages = false): RawToolResult | null {
  const b = raw as { type?: string; tool_use_id?: string; content?: unknown } | null
  if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') return null
  const images: RawToolResult['images'] = []
  if (Array.isArray(b.content)) {
    for (const c of b.content) {
      const x = c as { type?: string; source?: { type?: string; media_type?: string; data?: string } }
      if (x?.type !== 'image') continue
      const s = x.source
      if (s?.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
        images.push({ mimeType: s.media_type, dataBase64: s.data })
      }
    }
  }
  let text = rawContentToText(b.content)
  if (images.length > 0 && omitImages) text = [text, '[image omitted]'].filter(Boolean).join('\n')
  return { toolUseId: b.tool_use_id, text, images: omitImages ? [] : images }
}

// The runner's messages are loosely typed Anthropic MessageParams. We keep the
// block typing loose here and switch on `.type` strings, matching how the
// runner and the Anthropic SDK already operate.
type AnyBlock = Record<string, unknown> & { type?: string }
type AnyMessage = { role: 'user' | 'assistant' | 'tool'; content: string | AnyBlock[] }

/**
 * Strip OpenAI-compat reasoning blocks from an Anthropic-format message. Used
 * by the runner's LEGACY (adapters-off) Anthropic branch, which sends history
 * verbatim: a leftover `compat_reasoning` block (DeepSeek/Qwen/Kimi) after a
 * mid-chat switch to Claude would be rejected by the Anthropic API — or worse,
 * crash `toAnthropicContent` (which assumes text/image shapes) if the message
 * also carries an image. Must run BEFORE any image conversion. The adapter
 * path doesn't need this — provider tagging in toCanonicalMessages handles it.
 */
export function stripCompatReasoningBlocks<M extends { content: unknown }>(message: M): M {
  if (!Array.isArray(message.content)) return message
  const blocks = message.content as AnyBlock[]
  // Also match the pre-rename `deepseek_reasoning` type — no longer produced, but a
  // legacy persisted block must not reach the Anthropic API after a mid-chat
  // switch and crash toAnthropicContent.
  const isReasoning = (t?: string) => t === 'compat_reasoning' || t === 'deepseek_reasoning'
  if (!blocks.some((c) => isReasoning(c?.type))) return message
  return { ...message, content: blocks.filter((c) => !isReasoning(c?.type)) }
}

/** Anthropic message content → CanonicalMessage content. */
export function toCanonicalMessages(messages: AnyMessage[]): CanonicalMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content }
    }
    const content = m.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text' as const, text: String(block.text ?? '') }
        case 'image': {
          // Only base64 sources map to the typed canonical image; anything else
          // (URL sources, future shapes) passes through opaquely.
          const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
          if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
            return { type: 'image' as const, mimeType: source.media_type, dataBase64: source.data }
          }
          return { type: 'provider_raw' as const, provider: 'anthropic' as const, block }
        }
        case 'tool_use':
          return {
            type: 'tool_use' as const,
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            input: (block.input as Record<string, unknown>) ?? {},
          }
        case 'tool_result': {
          // Only string content maps to the typed canonical tool_result. Array
          // content (e.g. capture-flow image blocks) must round-trip verbatim,
          // so it goes through provider_raw.
          if (typeof block.content === 'string') {
            return {
              type: 'tool_result' as const,
              toolUseId: String(block.tool_use_id ?? ''),
              content: block.content,
              ...(typeof block.is_error === 'boolean' ? { isError: block.is_error } : {}),
            }
          }
          return { type: 'provider_raw' as const, provider: 'anthropic' as const, block }
        }
        case 'compat_reasoning': {
          // OpenAI-compat reasoning (DeepSeek/Qwen/Kimi) stored by the
          // adapter-stream consumer (reconstructContent). Tagged with its real
          // embedded provider so toAnthropicMessages skips it (an unsigned
          // thinking-like block would 400 an Anthropic request after a mid-chat
          // model switch) and toOpenAIMessages replays it as `reasoning_content`
          // for that SAME provider only (the API 400s in tool-call
          // conversations without the replay).
          const prov = (block as { provider?: string }).provider
          return {
            type: 'provider_raw' as const,
            provider: (prov ?? 'deepseek') as 'deepseek' | 'qwen' | 'kimi',
            block,
          }
        }
        default:
          // thinking, redacted_thinking, server_tool_use, web_search_tool_result, …
          // History is Anthropic-format by contract (see file docstring), so
          // anthropic is the correct tag for every block without its own case.
          return { type: 'provider_raw' as const, provider: 'anthropic' as const, block }
      }
    })
    return { role: m.role, content }
  })
}

/**
 * Drop an Anthropic native `server_tool_use` (web_search) block that has no paired
 * `web_search_tool_result` in the same content array — and any orphaned result.
 * Anthropic 400s with "server_tool_use … without a corresponding web_search_tool_result
 * block" when a paused/truncated web-search turn is replayed with only the call. This is
 * the final chokepoint: every Anthropic request goes through toAnthropicMessages, so no
 * orphan can reach the wire regardless of how it entered history.
 */
function stripOrphanServerTools(content: unknown[]): unknown[] {
  const isBlock = (b: unknown): b is { type?: string; id?: string; tool_use_id?: string } =>
    !!b && typeof b === 'object'
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const b of content) {
    if (!isBlock(b)) continue
    if (b.type === 'server_tool_use' && typeof b.id === 'string') callIds.add(b.id)
    if (b.type === 'web_search_tool_result' && typeof b.tool_use_id === 'string') resultIds.add(b.tool_use_id)
  }
  if (callIds.size === 0 && resultIds.size === 0) return content
  return content.filter((b) => {
    if (!isBlock(b)) return true
    if (b.type === 'server_tool_use') return typeof b.id === 'string' && resultIds.has(b.id)
    if (b.type === 'web_search_tool_result') return typeof b.tool_use_id === 'string' && callIds.has(b.tool_use_id)
    return true
  })
}

/**
 * Block types Anthropic accepts a `cache_control` marker on. Stamping anything
 * else (a `thinking` block on a trailing assistant turn, say) is a 400.
 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document'])

/**
 * Put a cache breakpoint on the tail of the conversation.
 *
 * Without this only the system prefix is cached and the whole message history
 * is re-billed at full price every turn — which is the actual bill on a long
 * run, not the prefix (a real run hit ~150k tokens of uncached history by turn
 * five against a cached ~29k prefix). Render order is tools → system →
 * messages, so a breakpoint here covers all three.
 *
 * One breakpoint that moves forward each turn is enough: the API matches the
 * longest cached prefix, so this turn's marker writes an entry that next turn
 * reads, and the read costs ~0.1x vs the 1.25x write.
 *
 * Single moving breakpoint. The API only scans back ~20 content
 * blocks from a marker, so one turn appending more than that (~10 parallel tool
 * calls) misses silently. Two of the four breakpoints are still free — add an
 * older second one if `cache_read_input_tokens` shows the miss.
 *
 * Never mutates: `provider_raw` blocks are re-emitted by reference out of
 * stored history, so stamping one in place would leave a `cache_control` behind
 * that returns on every later turn and overruns the four-breakpoint limit.
 *
 * Also never RESHAPES. A string `content` has no block to carry the marker, and
 * promoting it to `[{type:'text'}]` would be a wire-format change: mid-run
 * steers are specified to land as plain-string user turns, and an
 * earlier draft of this broke that contract. Such a turn is simply left
 * unstamped — the tool_result turns that dominate an agentic loop are arrays,
 * so this costs one turn of caching in an uncommon case and changes nothing
 * about what is sent.
 */
export function markConversationCache<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  if (!Array.isArray(last.content) || last.content.length === 0) return messages

  const blocks = [...(last.content as unknown[])]
  const tail = blocks[blocks.length - 1]
  if (!tail || typeof tail !== 'object') return messages
  if (!CACHEABLE_BLOCK_TYPES.has((tail as { type?: string }).type ?? '')) return messages

  blocks[blocks.length - 1] = { ...(tail as object), cache_control: { type: 'ephemeral' as const } }
  const out = [...messages]
  out[lastIdx] = { ...last, content: blocks }
  return out
}

/** CanonicalMessage content → Anthropic message params. Inverse of the above. */
export function toAnthropicMessages(
  messages: CanonicalMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return messages.map((m) => {
    // Anthropic has no 'tool' role — tool results ride on a 'user' turn.
    const role = m.role === 'tool' ? ('user' as const) : m.role
    if (typeof m.content === 'string') {
      return { role, content: m.content }
    }
    const content: unknown[] = []
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'text', text: block.text })
          break
        case 'image':
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: block.mimeType, data: block.dataBase64 },
          })
          break
        case 'tool_use':
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
          break
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError !== undefined ? { is_error: block.isError } : {}),
          })
          break
        case 'provider_raw':
          // Reconstruct verbatim for the originating provider; skip foreign
          // provider blocks (they have no meaning in an Anthropic request).
          if (block.provider === 'anthropic') content.push(block.block)
          break
      }
    }
    return { role, content: stripOrphanServerTools(content) }
  })
}
