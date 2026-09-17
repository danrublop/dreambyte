/**
 * Image intake engine. Produces a `MediaAnalysis` from a reference
 * image via one of the resolved engines:
 *   - `local:<model>`  → Ollama native `/api/chat` (images field; NOT the `/v1`
 *      image_url path, which 500s on some vision models — Ollama bug, Apr 2026).
 *   - `cloud:gemini`   → existing `getGoogleClient()` (inline base64).
 *   - `cloud:anthropic`→ existing `getAnthropicClient()` (Haiku vision).
 *
 * All backends are asked for the SAME compact JSON so the orchestrator gets a
 * consistent shape. Any failure degrades to `{ error }` — never throws.
 */

import type { MediaAnalysis, ReferenceMedia } from '../../types'
import { resolveMedia } from './media-source'
import { parseFencedJson } from './parse-json'
import { providerForEngine, analyzeImageOpenAICompat } from './openai-compat-vision'

const VISION_TIMEOUT_MS = 30_000

/** MIME types the cloud vision APIs (Anthropic/Gemini) accept. */
const SUPPORTED_VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** The shared instruction + JSON contract for describing a reference image. */
const IMAGE_PROMPT = `You are helping a video creator understand a reference image.
Return ONLY a JSON object, no prose or markdown, with exactly these fields:
{
  "caption": "<one or two sentences describing the image>",
  "visibleText": "<any text visible in the image, verbatim; empty string if none>",
  "mood": "<short phrase: the visual mood/tone>",
  "subjects": ["<key subject>", "..."],
  "palette": ["#rrggbb", "..."]
}`

interface ImageJson {
  caption?: string
  visibleText?: string
  mood?: string
  subjects?: string[]
  palette?: string[]
}

/** Strip code fences / stray prose and parse the first JSON object found. */
export function parseImageJson(raw: string): ImageJson | null {
  return parseFencedJson<ImageJson>(raw)
}

export interface ImageEngineDeps {
  /** Ollama base endpoint for local engines (default http://localhost:11434). */
  ollamaEndpoint?: string
  /** Injectable fetch (tests / local call). */
  fetchImpl?: typeof fetch
  /** Best-effort dominant-color palette extractor (Sharp in prod). */
  extractPalette?: (bytes: Uint8Array) => Promise<string[]>
}

function jsonToAnalysis(
  media: ReferenceMedia,
  backend: string,
  j: ImageJson | null,
  palette?: string[],
): MediaAnalysis {
  return {
    mediaId: media.id,
    kind: 'image',
    backend,
    caption: j?.caption?.trim() || undefined,
    ocrText: j?.visibleText?.trim() || undefined,
    palette: (palette && palette.length ? palette : j?.palette) || undefined,
    mood: j?.mood?.trim() || undefined,
    subjects: j?.subjects?.filter(Boolean) || undefined,
  }
}

// ── Local: Ollama native /api/chat ───────────────────────────────────────────

async function analyzeViaOllama(
  media: ReferenceMedia,
  modelTag: string,
  base64NoPrefix: string,
  deps: ImageEngineDeps,
): Promise<ImageJson | null> {
  const endpoint = deps.ollamaEndpoint ?? 'http://localhost:11434'
  const doFetch = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS)
  try {
    const res = await doFetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelTag,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: IMAGE_PROMPT, images: [base64NoPrefix] }],
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { message?: { content?: string } }
    return parseImageJson(body.message?.content ?? '')
  } finally {
    clearTimeout(timer)
  }
}

// ── Cloud: Gemini ─────────────────────────────────────────────────────────────

async function analyzeViaGemini(base64NoPrefix: string, mimeType: string): Promise<ImageJson | null> {
  const { getGoogleClient } = await import('../../providers')
  const client = getGoogleClient()
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ inlineData: { mimeType, data: base64NoPrefix } }, { text: IMAGE_PROMPT }] as never,
  })
  const text = (response as { text?: string }).text ?? ''
  return parseImageJson(text)
}

// ── Cloud: Anthropic (Haiku vision) ──────────────────────────────────────────

async function analyzeViaAnthropic(base64NoPrefix: string, mimeType: string): Promise<ImageJson | null> {
  const { getAnthropicClient } = await import('../../providers')
  const client = getAnthropicClient()
  const mediaType = mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64NoPrefix } },
          { type: 'text', text: IMAGE_PROMPT },
        ],
      },
    ],
  })
  const block = response.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? parseImageJson(block.text) : null
}

/**
 * Analyze a reference image with the chosen engine. Never throws — returns a
 * `MediaAnalysis` with `error` set on failure so the run continues.
 */
export async function analyzeImage(
  media: ReferenceMedia,
  engineId: string,
  deps: ImageEngineDeps = {},
): Promise<MediaAnalysis> {
  try {
    const { bytes, mimeType } = await resolveMedia(media.uri, media.mimeType)
    const base64 = Buffer.from(bytes).toString('base64')

    let palette: string[] | undefined
    if (deps.extractPalette) {
      palette = await deps.extractPalette(bytes).catch(() => undefined)
    }

    let json: ImageJson | null = null
    const backend = engineId
    if (engineId.startsWith('local:')) {
      const modelTag = engineId.slice('local:'.length)
      json = await analyzeViaOllama(media, modelTag === 'ollama' ? 'qwen2.5vl' : modelTag, base64, deps)
    } else {
      const compatProvider = providerForEngine(engineId) // cloud:qwen / kimi / deepseek
      const isNativeCloud = engineId === 'cloud:gemini' || engineId === 'cloud:anthropic'
      if (!isNativeCloud && !compatProvider) {
        return { mediaId: media.id, kind: 'image', backend: engineId, error: `unknown image engine ${engineId}` }
      }
      // Cloud vision APIs reject unsupported types (svg/bmp/tiff/octet-stream) —
      // fail with a clear per-media note instead of a raw API rejection.
      if (!SUPPORTED_VISION_MIME.has(mimeType)) {
        return {
          mediaId: media.id,
          kind: 'image',
          backend: engineId,
          palette,
          error: `unsupported image type for cloud vision: ${mimeType}`,
        }
      }
      if (engineId === 'cloud:gemini') json = await analyzeViaGemini(base64, mimeType)
      else if (engineId === 'cloud:anthropic') json = await analyzeViaAnthropic(base64, mimeType)
      else json = await analyzeImageOpenAICompat<ImageJson>(compatProvider!, base64, mimeType, IMAGE_PROMPT)
    }

    if (!json) {
      return { mediaId: media.id, kind: 'image', backend, palette, error: 'engine returned no parseable result' }
    }
    return jsonToAnalysis(media, backend, json, palette)
  } catch (err) {
    return {
      mediaId: media.id,
      kind: 'image',
      backend: engineId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
