const VEO3_BASE = 'https://generativelanguage.googleapis.com/v1beta'
// Send the key via the x-goog-api-key header, not a ?key= query param — query
// strings get captured by proxy/access logs. Guard against an
// unset key so we fail loudly instead of sending `key=undefined`.
function googleApiKey(): string {
  const k = process.env.GOOGLE_AI_KEY
  if (!k) throw new Error('GOOGLE_AI_KEY is not set — configure a Google AI key to use Veo 3.')
  return k
}

// Cap every external call so a stalled Veo/GCS socket fails loud (clean err()) instead of
// hanging the agent turn. 60s for submit/status JSON calls, 120s for the video download.
const FETCH_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export const VEO3_COST_ESTIMATE = 1.0 // rough estimate per clip

// ── Generate video ──────────────────────────────────────────────────────────

export async function generateVeo3Video(opts: {
  prompt: string
  negativePrompt?: string
  aspectRatio: '16:9' | '9:16' | '1:1'
  durationSeconds: 5 | 8
  /** image-to-video: a conditioning still as base64 bytes + mime. Veo animates this image when set.
   *  Request shape is best-effort against the Gemini Veo API — verify with a live GOOGLE_AI_KEY. */
  image?: { imageBytes: string; mimeType: string }
}): Promise<{ operationName: string }> {
  const response = await fetch(`${VEO3_BASE}/models/veo-3.0-generate-preview:generateVideo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': googleApiKey() },
    body: JSON.stringify({
      prompt: { text: opts.prompt },
      negativePrompt: opts.negativePrompt ? { text: opts.negativePrompt } : undefined,
      image: opts.image ? { imageBytes: opts.image.imageBytes, mimeType: opts.image.mimeType } : undefined,
      generationConfig: {
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        aspectRatio: opts.aspectRatio,
        durationSeconds: opts.durationSeconds,
      },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `Veo 3 is not available (${response.status}). You may need waitlist access. ` +
        'Consider using Canvas2D animations or existing video assets instead.',
    )
  }

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Veo 3 error: ${response.status}`)
  }

  return { operationName: data.name }
}

// ── Poll status ─────────────────────────────────────────────────────────────

export async function getVeo3Status(operationName: string): Promise<{
  done: boolean
  videoUri?: string
  error?: string
}> {
  const response = await fetch(`${VEO3_BASE}/${operationName}`, {
    headers: { 'x-goog-api-key': googleApiKey() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Veo 3 status error: ${response.status}`)
  }

  if (data.done) {
    // Extract video from response
    const video = data.response?.generatedSamples?.[0]
    if (video?.video?.uri) {
      return { done: true, videoUri: video.video.uri }
    }
    if (data.error) {
      return { done: true, error: data.error.message }
    }
  }

  return { done: false }
}

// ── Download video from GCS ─────────────────────────────────────────────────

export async function downloadVeo3Video(uri: string): Promise<Buffer> {
  // GCS URI format: gs://bucket/path or direct HTTPS URL
  const url = uri.startsWith('gs://') ? `https://storage.googleapis.com/${uri.slice(5)}` : uri

  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Failed to download Veo 3 video: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// Prompt enhancement moved to src/lib/media/enhance.ts — one prompt-brain
// across all media, on a cheap cached model. The veo3 provider adapter calls enhance()
// with modality 'video'. Do not re-add a local enhancer here.
