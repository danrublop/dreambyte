const HEYGEN_BASE = 'https://api.heygen.com/v2'
// HeyGen exposes the video status poll ONLY at v1 (`/v1/video_status.get`); there is no
// `/v2/video_status.get` (it 404s). Generate is on v2 above — only
// the status poll uses this v1 base. See getVideoStatus below.
const HEYGEN_V1_BASE = 'https://api.heygen.com/v1'
const HEYGEN_KEY = () => process.env.HEYGEN_API_KEY

// Cap every HeyGen call so a stalled provider can't hang the agent turn — 60s for the JSON
// API calls (heygenFetch), 120s for the video download.
const FETCH_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000

async function heygenFetch(path: string, options: RequestInit = {}): Promise<any> {
  // Pre-flight the key so we fail clearly instead of sending `X-Api-Key: undefined` → opaque 401.
  const key = HEYGEN_KEY()
  if (!key) throw new Error('HeyGen needs HEYGEN_API_KEY — set it in Settings')
  const response = await fetch(`${HEYGEN_BASE}${path}`, {
    ...options,
    headers: {
      'X-Api-Key': key,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const data = await response.json()
  if (!response.ok || data.error) {
    throw new Error(data.error?.message ?? data.message ?? `HeyGen API error: ${response.status}`)
  }
  return data.data ?? data
}

// ── Generate avatar video ───────────────────────────────────────────────────

export async function generateAvatarVideo(opts: {
  avatarId: string
  voiceId: string
  script: string
  width?: number
  height?: number
  bgColor?: string
}): Promise<{ videoId: string; estimatedSeconds: number }> {
  const data = await heygenFetch('/video/generate', {
    method: 'POST',
    body: JSON.stringify({
      video_inputs: [
        {
          character: {
            type: 'avatar',
            avatar_id: opts.avatarId,
            avatar_style: 'normal',
          },
          voice: {
            type: 'text',
            input_text: opts.script,
            voice_id: opts.voiceId,
          },
          background: {
            type: 'color',
            value: opts.bgColor ?? '#00FF00', // green for chroma key
          },
        },
      ],
      dimension: {
        width: opts.width ?? 512,
        height: opts.height ?? 512,
      },
    }),
  })

  // Estimate duration from script length (~150 words per minute)
  const wordCount = opts.script.split(/\s+/).length
  const estimatedSeconds = Math.ceil((wordCount / 150) * 60)

  return {
    videoId: data.video_id,
    estimatedSeconds,
  }
}

// ── Poll video status ───────────────────────────────────────────────────────

export async function getVideoStatus(videoId: string): Promise<{
  status: 'pending' | 'processing' | 'completed' | 'failed'
  videoUrl?: string
  thumbnailUrl?: string
  /** Rendered video length in seconds (HeyGen returns it on completion). */
  durationSeconds?: number
  error?: string
}> {
  // NEEDS A LIVE-KEY SMOKE TEST (maintainer-run): HeyGen serves the status poll ONLY at v1.
  // The prior code hit `/v2/video_status.get`, which does not exist (404) — so every avatar
  // billed at generate time, then the poll threw, holding the layer 'processing' to the 15-min
  // deadline (paid, no avatar). v1 `video_status.get` returns
  //   { code, data: { id, status, video_url, thumbnail_url, duration, error }, message }
  // so we unwrap `.data` (mirrors heygenFetch's `data.data ?? data`).
  const key = HEYGEN_KEY()
  if (!key) throw new Error('HeyGen needs HEYGEN_API_KEY — set it in Settings')
  const response = await fetch(`${HEYGEN_V1_BASE}/video_status.get?video_id=${videoId}`, {
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const body = await response.json()
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? body.message ?? `HeyGen API error: ${response.status}`)
  }
  const data = body.data ?? body

  // HeyGen documents `duration` in seconds. Bound it to a plausible range so a
  // contract change (e.g. milliseconds) can't drive a runaway scene/export length;
  // an out-of-range value falls back to the word-count estimate (undefined).
  const durationSeconds =
    typeof data.duration === 'number' && data.duration > 0 && data.duration <= 3600 ? data.duration : undefined
  // v1 emits a `waiting` state before `pending`/`processing`; fold it into 'pending' so the
  // caller's poll loop keeps waiting rather than mis-reading an unknown status.
  const rawStatus = data.status as string | undefined
  const status = (rawStatus === 'waiting' ? 'pending' : rawStatus) as 'pending' | 'processing' | 'completed' | 'failed'
  // v1 carries the failure detail under `data.error` (object with .message, or a string).
  const errorDetail =
    typeof data.error === 'object' && data.error ? (data.error.message ?? JSON.stringify(data.error)) : data.error
  return {
    status,
    videoUrl: data.video_url,
    thumbnailUrl: data.thumbnail_url,
    durationSeconds,
    error: errorDetail,
  }
}

// ── Download video ──────────────────────────────────────────────────────────

export async function downloadVideo(videoUrl: string): Promise<Buffer> {
  const response = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Failed to download HeyGen video: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
