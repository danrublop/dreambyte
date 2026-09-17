/**
 * Video intake engine.
 *   - `cloud:gemini`   → Gemini native video (inline base64 for short clips,
 *     File API upload + poll for larger). One call → scene + events.
 *   - `local:<model>` / `cloud:anthropic` → frame-vision via the
 *     VideoUnderstander seam (ffmpeg keyframes + multi-frame VLM + Whisper).
 *
 * Never throws — degrades to `{ error }`.
 */

import type { MediaAnalysis, ReferenceMedia } from '../../types'
import { resolveMedia } from './media-source'
import { parseFramesJson } from './frames-vision'
import { providerForEngine } from './openai-compat-vision'
import { getVideoUnderstander, getMarlinUnderstander } from '../../../services/video-understander'

/** Gemini inline request cap (~20MB total); larger videos go via the File API. */
const VIDEO_INLINE_CAP_BYTES = 18 * 1024 * 1024
const FILE_ACTIVE_POLL_MS = 1000
const FILE_ACTIVE_MAX_WAITS = 30

const VIDEO_PROMPT = `Analyze this video. Return ONLY a JSON object, no prose:
{
  "scene": "<one paragraph describing the video overall>",
  "events": [{ "start": <seconds>, "end": <seconds>, "description": "<what happens>" }]
}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Raw bytes + mime — the in-memory video input (no disk path). Used by callers
 *  that already hold the encoded MP4 (e.g. motion-review's exported scene clip). */
export interface VideoBytesInput {
  bytes: Uint8Array
  mimeType: string
}

/** Either an in-memory clip (`{bytes,mimeType}`) or a reference-media URI to resolve. */
export type VideoAnalysisInput = VideoBytesInput | ReferenceMedia

function isReferenceMedia(input: VideoAnalysisInput): input is ReferenceMedia {
  return typeof (input as ReferenceMedia).uri === 'string'
}

/**
 * Prompt-generic, bytes-accepting native-video seam. Sends a video —
 * raw bytes OR a `ReferenceMedia` URI — to Gemini with an ARBITRARY prompt and
 * returns the model's raw text. The caller supplies the prompt and parses the
 * result. Inline base64 for clips ≤18MB; the File API (upload + poll until ACTIVE)
 * for larger ReferenceMedia. Bytes-only input above the inline cap throws — there
 * is no local path to upload, so callers that send a clip keep it small
 * (motion-review exports a low-res clip well under the cap).
 *
 * Currently Gemini-only on purpose: it is the one mainstream API that ingests
 * native video AND its audio track while honoring a custom prompt (Claude is
 * frames-only). Throws for any other engine so a caller can degrade explicitly
 * rather than silently mis-route. `analyzeVideo`'s Gemini branch and motion-review
 * both call this, each with its own prompt + parser (mirrors how `frames-vision`
 * exposes `sendFramesToVision`).
 */
export async function analyzeVideoWithPrompt(
  input: VideoAnalysisInput,
  engineId: string,
  prompt: string,
  opts: { model?: string } = {},
): Promise<string> {
  if (engineId !== 'cloud:gemini') {
    throw new Error(`analyzeVideoWithPrompt: unsupported native-video engine "${engineId}" (Gemini only)`)
  }

  let bytes: Uint8Array
  let mimeType: string
  let localPath: string | undefined
  if (isReferenceMedia(input)) {
    const resolved = await resolveMedia(input.uri, input.mimeType)
    bytes = resolved.bytes
    mimeType = resolved.mimeType
    localPath = resolved.localPath
  } else {
    bytes = input.bytes
    mimeType = input.mimeType
  }

  const { getGoogleClient } = await import('../../providers')
  const client = getGoogleClient()

  const filesApi = client.files as unknown as {
    upload: (a: {
      file: string
      config?: { mimeType?: string }
    }) => Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }>
    get: (a: { name: string }) => Promise<{ uri?: string; mimeType?: string; state?: string }>
    delete?: (a: { name: string }) => Promise<unknown>
  }
  let uploadedName: string | undefined

  try {
    let videoPart: unknown
    if (bytes.byteLength <= VIDEO_INLINE_CAP_BYTES) {
      videoPart = { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } }
    } else if (localPath) {
      // File API: upload, then poll until the file is ACTIVE before referencing it.
      const uploaded = await filesApi.upload({ file: localPath, config: { mimeType } })
      uploadedName = uploaded.name
      let info = uploaded
      let waits = 0
      while (info.state === 'PROCESSING' && waits < FILE_ACTIVE_MAX_WAITS) {
        await sleep(FILE_ACTIVE_POLL_MS)
        info = await filesApi.get({ name: uploaded.name! })
        waits++
      }
      if (info.state !== 'ACTIVE' || !info.uri) {
        throw new Error(`Gemini file not ready (state=${info.state})`)
      }
      videoPart = { fileData: { fileUri: info.uri, mimeType: info.mimeType ?? mimeType } }
    } else {
      // In-memory clip over the inline cap with no disk path to upload.
      throw new Error(
        `video exceeds Gemini inline cap (${bytes.byteLength} > ${VIDEO_INLINE_CAP_BYTES} bytes) and has no local path to upload`,
      )
    }

    const response = await client.models.generateContent({
      model: opts.model ?? 'gemini-2.5-flash',
      contents: [videoPart, { text: prompt }] as never,
    })
    return (response as { text?: string }).text ?? ''
  } finally {
    // Don't leave the user's reference video on Google's servers (else it lingers
    // ~48h). Best-effort delete; ignore failures + missing delete() on the SDK.
    if (uploadedName && filesApi.delete) {
      await filesApi.delete({ name: uploadedName }).catch(() => {})
    }
  }
}

async function analyzeViaGemini(media: ReferenceMedia): Promise<MediaAnalysis> {
  // Intake keeps its {scene,events} prompt but now runs through the shared seam.
  const text = await analyzeVideoWithPrompt(media, 'cloud:gemini', VIDEO_PROMPT)
  const { scene, events } = parseFramesJson(text)
  if (!scene && events.length === 0) {
    return { mediaId: media.id, kind: 'video', backend: 'cloud:gemini', error: 'no parseable result' }
  }
  return {
    mediaId: media.id,
    kind: 'video',
    backend: 'cloud:gemini',
    caption: scene,
    events: events.length ? events : undefined,
  }
}

async function analyzeViaFrameVision(
  media: ReferenceMedia,
  engineId: string,
  ollamaEndpoint?: string,
): Promise<MediaAnalysis> {
  const result = await getVideoUnderstander().understand(media.uri, { visionEngineId: engineId, ollamaEndpoint })
  return {
    mediaId: media.id,
    kind: 'video',
    backend: result.backend,
    caption: result.scene,
    transcript: result.transcript,
    events: result.events.length ? result.events : undefined,
  }
}

async function analyzeViaMarlin(media: ReferenceMedia): Promise<MediaAnalysis> {
  const result = await getMarlinUnderstander().understand(media.uri)
  return {
    mediaId: media.id,
    kind: 'video',
    backend: result.backend,
    caption: result.scene,
    transcript: result.transcript,
    events: result.events.length ? result.events : undefined,
  }
}

export async function analyzeVideo(
  media: ReferenceMedia,
  engineId: string,
  ollamaEndpoint?: string,
): Promise<MediaAnalysis> {
  try {
    if (engineId === 'cloud:gemini') return await analyzeViaGemini(media)
    if (engineId === 'premium:marlin') return await analyzeViaMarlin(media)
    // local Ollama, cloud Anthropic, and the OpenAI-compat cheap providers
    // (qwen/kimi/deepseek) all go through frame-vision: ffmpeg keyframes →
    // multi-frame VLM. analyzeFramesVision dispatches the provider internally.
    if (engineId.startsWith('local:') || engineId === 'cloud:anthropic' || providerForEngine(engineId)) {
      return await analyzeViaFrameVision(media, engineId, ollamaEndpoint)
    }
    return { mediaId: media.id, kind: 'video', backend: engineId, error: `unknown video engine ${engineId}` }
  } catch (err) {
    return {
      mediaId: media.id,
      kind: 'video',
      backend: engineId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
