import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { MusicProviderInterface, MusicResult } from '../types'
import { getAudioDir, audioUrlFor } from '../paths'

/**
 * Google Lyria — generative background music via the Gemini API.
 *
 * Clean alternative to fal Stable Audio / ElevenLabs Music: official Google API, reuses the
 * GOOGLE_AI_KEY we already hold for Veo (same generativelanguage.googleapis.com host), and is
 * Google-cleared + SynthID-watermarked (commercial-safe provenance).
 *
 * Uses lyria-3-clip-preview (a fixed 30s clip — looped/trimmed to scene length on the timeline).
 * Mirrors the other generative providers: `search` refuses to generate (the music.search IPC is
 * ungated), the only paid path is the gated music.generate IPC → `generate`. Lyria returns JSON;
 * the audio comes back EITHER inline (base64 inlineData) OR as a File-API fileUri for larger clips
 * (like Veo's video.uri), so we handle both.
 *
 * CAVEAT (honest): the request/response shape is best-effort against
 * https://ai.google.dev/gemini-api/docs/music-generation — it has NOT been exercised against a
 * live GOOGLE_AI_KEY. Lyria is a preview model and also exposes a RealTime (WebSocket) API; if the
 * REST :generateContent path differs in practice, smoke-test with a real key and adjust. Same
 * posture as the Veo provider's "best-effort" note.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const MODEL_ID = 'lyria-3-clip-preview'
const CLIP_SECONDS = 30 // lyria-3-clip is a fixed-length clip; duration arg is advisory only.
// Music gen runs tens of seconds; a hung request must not wedge the IPC / agent turn. Matches the
// 120s deadline the other generative providers use.
const LYRIA_TIMEOUT_MS = 120_000

function getApiKey(): string {
  const key = process.env.GOOGLE_AI_KEY
  if (!key) throw new Error('GOOGLE_AI_KEY is not set')
  return key
}

/** Download a Gemini File-API audio reference (returned for larger clips), authed with the same
 *  key. Mirrors veo3's download-the-uri step. Timed out so a stuck fetch can't hang the turn. */
async function downloadFileUri(fileUri: string, apiKey: string): Promise<Buffer> {
  const res = await fetch(fileUri, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(LYRIA_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Lyria audio download failed (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

async function generateMusic(prompt: string, _duration?: number): Promise<MusicResult> {
  const apiKey = getApiKey()
  if (!prompt || !prompt.trim()) throw new Error('A music prompt is required')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LYRIA_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${API_BASE}/models/${MODEL_ID}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // responseModalities is the documented audio-output switch. (An earlier draft also sent a
        // `responseFormat` object — removed: that is not a generateContent field and would 400.)
        generationConfig: {
          responseModalities: ['AUDIO', 'TEXT'],
        },
      }),
      signal: controller.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`Lyria music generation timed out after ${LYRIA_TIMEOUT_MS / 1000}s`, { cause: e })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Lyria music generation error (${response.status}): ${errorText}`)
  }

  // generateContent returns JSON. Audio is EITHER inline base64 (inlineData) OR a File-API
  // reference (fileData.fileUri) for larger clips — a 30s mp3 is ~0.5–1MB, so fileData is likely.
  const data = (await response.json().catch(() => null)) as {
    candidates?: {
      finishReason?: string
      content?: { parts?: { inlineData?: { data?: string }; fileData?: { fileUri?: string } }[] }
    }[]
    promptFeedback?: { blockReason?: string }
  } | null
  const candidate = data?.candidates?.[0]
  const parts = candidate?.content?.parts ?? []

  let audioBuffer: Buffer | null = null
  const inlineB64 = parts.find((p) => p.inlineData?.data)?.inlineData?.data
  const fileUri = parts.find((p) => p.fileData?.fileUri)?.fileData?.fileUri
  if (inlineB64) {
    audioBuffer = Buffer.from(inlineB64, 'base64')
  } else if (fileUri) {
    audioBuffer = await downloadFileUri(fileUri, apiKey)
  }
  if (!audioBuffer) {
    // No audio part — surface WHY (safety/recitation block) instead of an opaque "no audio".
    const why = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? 'no inlineData or fileData part'
    throw new Error(`Lyria returned no audio (${why}).`)
  }
  if (audioBuffer.length === 0) throw new Error('Lyria returned an empty audio stream')

  const audioDir = getAudioDir()
  await fs.mkdir(audioDir, { recursive: true })
  const filename = `music-lyria-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`
  await fs.writeFile(path.join(audioDir, filename), audioBuffer)

  const localUrl = audioUrlFor(filename)
  return {
    id: `lyria-${Date.now()}`,
    name: prompt.slice(0, 80),
    audioUrl: localUrl,
    duration: CLIP_SECONDS,
    provider: 'lyria',
    previewUrl: localUrl,
  }
}

export const lyriaMusic: MusicProviderInterface = {
  id: 'lyria',
  name: 'Google Lyria',
  requiresKey: 'GOOGLE_AI_KEY',

  async search(_query: string, _limit?: number): Promise<MusicResult[]> {
    // Generative — search must not generate (the music.search IPC is ungated). Use the gated
    // music.generate path → generate (matches the Stable Audio / ElevenLabs Music providers).
    throw new Error('Lyria is generative — use the music.generate path, not search.')
  },

  generate: generateMusic,
}
