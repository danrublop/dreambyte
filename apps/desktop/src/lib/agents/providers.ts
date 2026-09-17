/**
 * Lazy-init provider clients (Anthropic / OpenAI / Google / local Ollama).
 *
 * Why lazy: pre-SQLite the Anthropic client was created eagerly at module
 * load, which predates BYOK — desktop users push `ANTHROPIC_API_KEY` in from
 * the Settings panel after the runner module has already been imported.
 * Creating `new Anthropic()` eagerly would capture an empty-string key and
 * every subsequent request would 401. Lazy init + `resetProviderClients()`
 * gives the IPC handler a way to drop stale clients after a key change.
 *
 * The `__setProviderClientsForTesting` seam lets vitest fixtures swap in
 * mock clients without going through the real SDK constructor.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'

let _anthropicClient: Anthropic | null = null
let _openaiClient: OpenAI | null = null
let _googleClient: GoogleGenAI | null = null
let _deepseekClient: OpenAI | null = null
let _qwenClient: OpenAI | null = null
let _kimiClient: OpenAI | null = null
const _localClients = new Map<string, OpenAI>()

export function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) _anthropicClient = new Anthropic()
  return _anthropicClient
}

export function getOpenAIClient(): OpenAI {
  if (!_openaiClient) _openaiClient = new OpenAI()
  return _openaiClient
}

export function getGoogleClient(): GoogleGenAI {
  if (!_googleClient) _googleClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY })
  return _googleClient
}

/**
 * DeepSeek client — OpenAI-compatible API at api.deepseek.com.
 *
 * Reads `DEEPSEEK_API_KEY` from env; the OpenAI SDK throws a clear 401 if
 * unset rather than crashing module import. Same lazy-init pattern as the
 * other providers so BYOK key rotation propagates via `resetProviderClients`.
 */
export function getDeepseekClient(): OpenAI {
  if (!_deepseekClient) {
    _deepseekClient = new OpenAI({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    })
  }
  return _deepseekClient
}

/**
 * Qwen client — Alibaba DashScope's OpenAI-compatible endpoint (international /
 * Singapore region). Reads `DASHSCOPE_API_KEY` (the same key Qwen vision intake
 * uses, so one key serves both agent + media understanding). Base URL and the
 * model ids are env-overridable; see model-config for the model entries.
 */
export function getQwenClient(): OpenAI {
  if (!_qwenClient) {
    _qwenClient = new OpenAI({
      baseURL: process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKey: process.env.DASHSCOPE_API_KEY ?? '',
    })
  }
  return _qwenClient
}

/**
 * Kimi client — Moonshot's OpenAI-compatible endpoint. Reads `MOONSHOT_API_KEY`
 * (shared with Kimi vision intake). Same lazy-init + reset pattern.
 */
export function getKimiClient(): OpenAI {
  if (!_kimiClient) {
    _kimiClient = new OpenAI({
      baseURL: process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1',
      apiKey: process.env.MOONSHOT_API_KEY ?? '',
    })
  }
  return _kimiClient
}

export function getLocalClient(endpoint: string): OpenAI {
  if (!_localClients.has(endpoint)) {
    _localClients.set(endpoint, new OpenAI({ baseURL: `${endpoint}/v1`, apiKey: 'ollama' }))
  }
  return _localClients.get(endpoint)!
}

/**
 * Generic OpenAI-compatible client. DeepSeek, Kimi/Moonshot, and
 * Qwen/DashScope all expose an OpenAI-compatible `/chat/completions` with
 * `image_url` content blocks — so one factory + one adapter serves all of them
 * (and any future OpenAI-compat provider). Cached per baseURL. BYOK rotation
 * goes through `resetProviderClients()` like the others.
 */
const _openaiCompatClients = new Map<string, OpenAI>()
export function getOpenAICompatClient(baseURL: string, apiKey: string): OpenAI {
  if (!_openaiCompatClients.has(baseURL)) {
    _openaiCompatClients.set(baseURL, new OpenAI({ baseURL, apiKey: apiKey || 'missing' }))
  }
  return _openaiCompatClients.get(baseURL)!
}

/**
 * Drop every cached provider client so the next agent turn re-reads
 * `process.env.*` when instantiating. The desktop BYOK flow calls this from
 * the `dreambyte:settings.setProviderKey` IPC handler after updating env.
 */
export function resetProviderClients(): void {
  _anthropicClient = null
  _openaiClient = null
  _googleClient = null
  _deepseekClient = null
  _qwenClient = null
  _kimiClient = null
  _localClients.clear()
  _openaiCompatClients.clear()
}

/**
 * Test-only seam. Vitest fixtures inject mock clients here so the runner can
 * be exercised end-to-end without hitting the real provider APIs. Production
 * code MUST NOT call this. The `__` prefix and ForTesting suffix flag the intent
 * loud and clear; if you find yourself reaching for it from app code, you're
 * about to do something wrong — refactor instead.
 */
export function __setProviderClientsForTesting(overrides: {
  anthropic?: unknown
  openai?: unknown
  google?: unknown
}): void {
  if (overrides.anthropic !== undefined) _anthropicClient = overrides.anthropic as Anthropic
  if (overrides.openai !== undefined) _openaiClient = overrides.openai as OpenAI
  if (overrides.google !== undefined) _googleClient = overrides.google as GoogleGenAI
}
