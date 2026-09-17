/**
 * Multi-frame vision. Sends a set of timestamped keyframes to a VLM
 * in ONE call. Backs the frame-vision VideoUnderstander (local Ollama / cloud
 * Anthropic / OpenAI-compat). Gemini video uses its native path (video-engine.ts).
 *
 * Two layers:
 *  - `sendFramesToVision(frames, prompt, engineId)` — the prompt-generic,
 *    raw-text transport. Dispatches the provider, returns the model's raw text.
 *    Reused by the intake frames pass here AND the cut-review pass (Gap 2), each
 *    passing its OWN prompt + parsing its own schema. Failures propagate (the
 *    caller decides how to degrade).
 *  - `analyzeFramesVision(...)` — the intake consumer: asks for a scene
 *    description + timestamped events, never throws (returns `{ events: [] }` on
 *    failure so the run continues).
 */

import type { KeyframeImage } from '../../../services/video-understander'
import { parseFencedJson } from './parse-json'
import { providerForEngine, callOpenAICompatVision } from './openai-compat-vision'

const FRAMES_TIMEOUT_MS = 45_000

function framesPrompt(times: number[]): string {
  const list = times.map((t, i) => `frame ${i + 1} @ ${t.toFixed(1)}s`).join(', ')
  return `You are analyzing a video via ${times.length} sampled frames (${list}).
Return ONLY a JSON object, no prose or markdown:
{
  "scene": "<one paragraph describing the video overall>",
  "events": [{ "start": <seconds>, "end": <seconds>, "description": "<what happens>" }]
}
Use the frame timestamps to place events in time. Keep events in chronological order.`
}

export interface FramesVisionResult {
  scene?: string
  events: { start: number; end: number; description: string }[]
}

interface RawFrames {
  scene?: string
  events?: { start?: number; end?: number; description?: string }[]
}

/** Map the raw model object → FramesVisionResult. Shared by text-parse + adapter paths. */
function rawFramesToResult(parsed: RawFrames | null): FramesVisionResult {
  if (!parsed) return { events: [] }
  const events = (parsed.events ?? [])
    .filter((e) => typeof e.description === 'string')
    .map((e) => ({ start: Number(e.start) || 0, end: Number(e.end) || 0, description: String(e.description) }))
  return { scene: parsed.scene?.trim() || undefined, events }
}

export function parseFramesJson(raw: string): FramesVisionResult {
  return rawFramesToResult(parseFencedJson<RawFrames>(raw))
}

export interface FramesVisionDeps {
  ollamaEndpoint?: string
  fetchImpl?: typeof fetch
  /** Ollama-only: request strict JSON output (`format: 'json'`). Default true —
   *  both the intake pass and cut-review want JSON. Set false for a prose-expecting
   *  caller. No-op for Anthropic/OpenAI-compat (they rely on the prompt). */
  jsonMode?: boolean
}

/** Raw-text Ollama sender. Returns the model's raw response text; throws on a
 *  non-OK HTTP status so the caller's try/catch can degrade. */
async function viaOllama(
  frames: KeyframeImage[],
  prompt: string,
  modelTag: string,
  deps: FramesVisionDeps,
): Promise<string> {
  const endpoint = deps.ollamaEndpoint ?? 'http://localhost:11434'
  const doFetch = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FRAMES_TIMEOUT_MS)
  try {
    const res = await doFetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelTag,
        stream: false,
        // Omit `format` entirely when jsonMode is off (JSON.stringify drops undefined keys).
        ...((deps.jsonMode ?? true) ? { format: 'json' } : {}),
        messages: [
          {
            role: 'user',
            content: prompt,
            images: frames.map((f) => Buffer.from(f.bytes).toString('base64')),
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Ollama vision HTTP ${res.status}`)
    const body = (await res.json()) as { message?: { content?: string } }
    return body.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

/** Raw-text Anthropic sender. Returns the first text block's content (or ''). */
async function viaAnthropic(frames: KeyframeImage[], prompt: string): Promise<string> {
  const { getAnthropicClient } = await import('../../providers')
  const content = [
    ...frames.map((f) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: f.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: Buffer.from(f.bytes).toString('base64'),
      },
    })),
    { type: 'text' as const, text: prompt },
  ]
  const response = await getAnthropicClient().messages.create(
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    },
    // Parity with viaOllama/compat: cap a hung call so it can't hold the encoded
    // frame buffers in memory indefinitely.
    { timeout: FRAMES_TIMEOUT_MS },
  )
  const block = response.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : ''
}

/**
 * Prompt-generic, raw-text multi-image transport. Dispatches the provider for
 * `engineId` and returns the model's raw response text — the caller supplies the
 * prompt and parses the result. Empty frames → ''. Provider/transport failures
 * propagate (so a cut-review caller can surface them rather than silently pass);
 * `analyzeFramesVision` wraps this in a try/catch to keep its never-throw contract.
 */
export async function sendFramesToVision(
  frames: KeyframeImage[],
  prompt: string,
  engineId: string,
  deps: FramesVisionDeps = {},
): Promise<string> {
  if (frames.length === 0) return ''
  if (engineId.startsWith('local:')) {
    const tag = engineId.slice('local:'.length)
    return viaOllama(frames, prompt, tag === 'ollama' ? 'qwen2.5vl' : tag, deps)
  }
  if (engineId === 'cloud:anthropic') return viaAnthropic(frames, prompt)
  const compat = providerForEngine(engineId) // cloud:qwen / kimi / deepseek
  if (compat) {
    const payload = frames.map((f) => ({ base64: Buffer.from(f.bytes).toString('base64'), mimeType: f.mimeType }))
    return callOpenAICompatVision(compat, payload, prompt)
  }
  // cloud:gemini uses the native-video path; anything else has no frame transport.
  // Throw (not '') so a direct caller like cut-review surfaces "unsupported engine"
  // rather than mistaking an empty string for a clean/empty model response.
  // analyzeFramesVision's try/catch turns this back into {events:[]} for intake.
  throw new Error(`No multi-frame vision transport for engine "${engineId}"`)
}

/** Whether `sendFramesToVision` has a real multi-frame transport for this engine.
 *  cloud:gemini is a valid single-image engine but uses the NATIVE video path (no
 *  multi-frame transport here), so it must NOT be picked for a frame-based review. */
export function supportsFrameVision(engineId: string): boolean {
  return engineId.startsWith('local:') || engineId === 'cloud:anthropic' || providerForEngine(engineId) !== null
}

/** Run the intake multi-frame vision pass. Returns `{events:[]}` on any failure. */
export async function analyzeFramesVision(
  frames: KeyframeImage[],
  engineId: string,
  deps: FramesVisionDeps = {},
): Promise<FramesVisionResult> {
  if (frames.length === 0) return { events: [] }
  try {
    const raw = await sendFramesToVision(frames, framesPrompt(frames.map((f) => f.timeSec)), engineId, deps)
    return parseFramesJson(raw)
  } catch {
    return { events: [] }
  }
}
