/**
 * Generic OpenAI-compatible vision adapter.
 *
 * DeepSeek, Kimi (Moonshot), and Qwen (DashScope) all speak the OpenAI
 * `/chat/completions` protocol with `image_url` content blocks — so ONE adapter
 * drives all of them (and any future OpenAI-compat provider) instead of a
 * bespoke branch each. They are vision-capable and ~10x cheaper than GPT-4-class.
 * Gemini and Anthropic keep their native SDK paths; local Ollama keeps native
 * `/api/chat` (the `/v1` image_url 500 bug). Engine id form: `cloud:<providerKey>`.
 *
 * Model ids and base URLs are overridable via env so they can be corrected
 * without a code change (the exact vision model names move quickly). Anything
 * that fails degrades to null — the caller turns that into a per-media error.
 */

import { parseFencedJson } from './parse-json'

const VISION_TIMEOUT_MS = 30_000

export interface OpenAICompatProvider {
  /** Engine id suffix → `cloud:<key>`. */
  key: string
  label: string
  /** OpenAI-compatible base URL (no trailing /chat/completions). */
  baseUrl: string
  /** Env var holding the API key; provider is "available" only when it's set. */
  keyEnv: string
  /** Default vision model id (override via `<KEY_PREFIX>_VISION_MODEL`). */
  defaultModel: string
  /** Env var to override the model id. */
  modelEnv: string
}

/**
 * Registry of OpenAI-compatible vision providers. Base URLs are stable; model
 * ids are best-known defaults (verify against current docs — the vision model
 * names churn) and overridable via the listed env var.
 */
export const OPENAI_COMPAT_VISION_PROVIDERS: Record<string, OpenAICompatProvider> = {
  qwen: {
    key: 'qwen',
    label: 'Qwen-VL (DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-vl-max',
    modelEnv: 'QWEN_VISION_MODEL',
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: 'MOONSHOT_API_KEY',
    // K2.6 is Moonshot's current multimodal model (vision + text). The legacy
    // moonshot-v1-*-vision-preview family is EOL (2026/05/25), so don't default
    // to it. Override via KIMI_VISION_MODEL if needed.
    defaultModel: 'kimi-k2.6',
    modelEnv: 'KIMI_VISION_MODEL',
  },
  // NOTE: DeepSeek is intentionally NOT here. The DeepSeek API (api.deepseek.com)
  // is text/reasoning only — it has no vision endpoint (DeepSeek-VL2 is
  // open-weights, not served on the API). DeepSeek is wired as an AGENT model
  // instead (src/lib/agents/providers/index.ts + model-config.ts).
}

/** Look up the provider for an engine id like `cloud:qwen`. */
export function providerForEngine(engineId: string): OpenAICompatProvider | null {
  if (!engineId.startsWith('cloud:')) return null
  return OPENAI_COMPAT_VISION_PROVIDERS[engineId.slice('cloud:'.length)] ?? null
}

/** Resolve {model, apiKey} for a provider from env. */
function resolveProviderConfig(p: OpenAICompatProvider, env: Record<string, string | undefined>) {
  return { model: env[p.modelEnv] || p.defaultModel, apiKey: env[p.keyEnv] || '' }
}

/**
 * Run a vision request (one or more images + a prompt) against an OpenAI-compat
 * provider, returning the raw assistant text. Caller parses it. Never throws on
 * a normal API error path — the SDK call is wrapped by the caller's try/catch.
 *
 * Exported as the prompt-generic, raw-text multi-image transport seam: both the
 * intake frames pass (`analyzeFramesVision`) and the cut-review pass route their
 * own prompts through `sendFramesToVision` → here for compat providers.
 */
export async function callOpenAICompatVision(
  provider: OpenAICompatProvider,
  images: { base64: string; mimeType: string }[],
  prompt: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { getOpenAICompatClient } = await import('../../providers')
  const { model, apiKey } = resolveProviderConfig(provider, env)
  const client = getOpenAICompatClient(provider.baseUrl, apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS)
  try {
    const response = await client.chat.completions.create(
      {
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
              })),
              { type: 'text' as const, text: prompt },
            ],
          },
        ],
      },
      { signal: controller.signal },
    )
    // Most providers return a string; some return content blocks ([{type,text}]).
    // Coerce to a string so the JSON parser never sees a non-string.
    const content = response.choices[0]?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return (content as Array<{ text?: string }>).map((b) => b?.text ?? '').join('')
    }
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** Single-image vision for an OpenAI-compat provider. Returns parsed JSON or null. */
export async function analyzeImageOpenAICompat<T = unknown>(
  provider: OpenAICompatProvider,
  base64: string,
  mimeType: string,
  prompt: string,
  env?: Record<string, string | undefined>,
): Promise<T | null> {
  const text = await callOpenAICompatVision(provider, [{ base64, mimeType }], prompt, env)
  return parseFencedJson<T>(text)
}
