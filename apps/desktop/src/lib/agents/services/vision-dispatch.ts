/**
 * Provider-agnostic single-image vision dispatch.
 *
 * The agent's vision sub-calls (frame self-QA, and any future structured
 * image check) used to hardcode Anthropic Haiku, so a non-Anthropic setup —
 * e.g. a DeepSeek-driven agent with only a Google or Qwen key — got a BLIND
 * agent that couldn't see its own rendered scenes. DeepSeek V4 is text-only
 * (the model can't see), but the agent CAN, by routing the vision call to any
 * available vision provider. This module is that router: given a resolved
 * engine id (from the media-understanding registry) + a caller-supplied
 * system/user prompt and one image, it calls the right backend and returns the
 * raw model text. The caller parses it.
 *
 * Engine ids match the registry's `listEngines`:
 *   cloud:anthropic | cloud:gemini | cloud:qwen | cloud:kimi | local:<tag>
 *
 * Never throws on a normal API error — returns null so the (cost-capped,
 * non-blocking) vision check degrades to "no data" exactly as before.
 */

import { providerForEngine, callOpenAICompatVision } from './intake-engines/openai-compat-vision'

export interface VisionPromptInput {
  /** Base64 image payload WITHOUT the data: prefix. */
  base64: string
  /** Image MIME type, e.g. 'image/jpeg'. */
  mimeType: string
  /** System / instruction prompt. Folded into the user turn for providers
   *  without a separate system role (OpenAI-compat, Ollama). */
  systemPrompt: string
  /** The per-call user text (the actual question). */
  userText: string
  maxTokens?: number
  timeoutMs?: number
  /** Ollama base endpoint for local engines. */
  ollamaEndpoint?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_TOKENS = 256

/** Cheap vision models per cloud engine — named so a bump is a one-line edit
 *  here rather than a hunt through the per-engine call sites. */
const VISION_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'
const VISION_MODEL_GEMINI = 'gemini-2.5-flash'

const SUPPORTED_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

/**
 * Run a one-image vision prompt against the resolved engine. Returns the raw
 * assistant text, or null on unsupported engine / unsupported media / error.
 */
export async function runVisionPrompt(engineId: string, input: VisionPromptInput): Promise<string | null> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    if (engineId === 'cloud:anthropic') {
      return await runAnthropic(input, maxTokens, timeoutMs)
    }
    if (engineId === 'cloud:gemini') {
      // The Google SDK has no per-call signal here, so guard the deadline with
      // a race — without it a hung Gemini call would block the run past the
      // intended timeout (the runner awaits the vision check synchronously).
      // Clear the timer once either branch settles so the won race doesn't
      // leave a pending timeout holding the event loop until timeoutMs.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          // The losing branch keeps running with no abort, so swallow a late
          // rejection — otherwise a Gemini error that resolves AFTER the timeout
          // wins becomes an unhandledRejection and crashes the Electron main
          // (no global handler). Same guard semantic-memory uses.
          runGemini(input, maxTokens).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    if (engineId.startsWith('cloud:')) {
      // OpenAI-compat vision provider (Qwen-VL / Kimi). One transport seam.
      const provider = providerForEngine(engineId)
      if (!provider) return null
      // These providers have no separate system role on the vision path —
      // fold the instruction into the prompt (same as the intake path).
      const prompt = `${input.systemPrompt}\n\n${input.userText}`
      return await callOpenAICompatVision(provider, [{ base64: input.base64, mimeType: input.mimeType }], prompt)
    }
    if (engineId.startsWith('local:')) {
      return await runOllama(engineId, input, maxTokens, timeoutMs)
    }
    return null
  } catch {
    return null
  }
}

async function runAnthropic(input: VisionPromptInput, maxTokens: number, timeoutMs: number): Promise<string | null> {
  const mediaType = input.mimeType as (typeof SUPPORTED_MEDIA)[number]
  if (!SUPPORTED_MEDIA.includes(mediaType)) return null
  const { getAnthropicClient } = await import('../providers')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: VISION_MODEL_ANTHROPIC,
        max_tokens: maxTokens,
        // System prompt is cached (ephemeral) — it's byte-identical across
        // checks, so Anthropic charges 0.1x input rate after the first.
        system: [{ type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: input.base64 } },
              { type: 'text', text: input.userText },
            ],
          },
        ],
      },
      { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' }, signal: controller.signal },
    )
    const block = response.content.find((b) => b.type === 'text')
    return block && block.type === 'text' ? block.text : null
  } finally {
    clearTimeout(timer)
  }
}

async function runGemini(input: VisionPromptInput, maxTokens: number): Promise<string | null> {
  const { getGoogleClient } = await import('../providers')
  const client = getGoogleClient()
  const response = await client.models.generateContent({
    model: VISION_MODEL_GEMINI,
    contents: [
      { inlineData: { mimeType: input.mimeType, data: input.base64 } },
      { text: input.userText },
    ] as never,
    config: { systemInstruction: input.systemPrompt, maxOutputTokens: maxTokens },
  })
  const text = (response as { text?: string }).text ?? ''
  return text || null
}

async function runOllama(
  engineId: string,
  input: VisionPromptInput,
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
  const modelTag = engineId.slice('local:'.length)
  if (!modelTag || modelTag === 'ollama') return null
  const endpoint = input.ollamaEndpoint ?? 'http://localhost:11434'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelTag,
        stream: false,
        format: 'json',
        options: { num_predict: maxTokens },
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userText, images: [input.base64] },
        ],
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { message?: { content?: string } }
    return body.message?.content ?? null
  } finally {
    clearTimeout(timer)
  }
}
