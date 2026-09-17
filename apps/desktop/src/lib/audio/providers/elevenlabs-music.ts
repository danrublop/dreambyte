import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { MusicProviderInterface, MusicResult } from '../types'
import { getAudioDir, audioUrlFor } from '../paths'

/**
 * ElevenLabs Music — generative background music (text prompt → original song/instrumental).
 *
 * Why this over the other generative option (fal Stable Audio): ElevenLabs Music is the only
 * music API with a clean broad-commercial licensing path (paid plans are cleared for commercial
 * distribution), whereas Suno/Udio carry active label litigation and have no official API. We
 * already hold ELEVENLABS_API_KEY for TTS / SFX / voice-clone, so no new credential.
 *
 * Mirrors the Stable Audio provider shape: `search` must NOT generate (the `music.search` IPC is
 * ungated; the only paid path is the gated `music.generate` IPC → generate), and `generate` is the
 * real entry point. API verified against https://elevenlabs.io/docs (POST /v1/music, binary mp3).
 *
 * Licensing note: broad commercial use requires a paid plan; film/TV/large-game/ads or enterprise
 * distribution may need an additional ElevenLabs license. The spend gate (apiName 'elevenLabs')
 * controls usage; per-asset license-string capture is a follow-up (MusicResult carries no license
 * field today, and no other provider records one).
 */

const API_BASE = 'https://api.elevenlabs.io/v1'
const DEFAULT_SECONDS = 30
// ElevenLabs Music bounds music_length_ms to 3s..10min.
const MIN_MS = 3_000
const MAX_MS = 600_000
const MODEL_ID = 'music_v1'
// Music gen runs tens of seconds; a hung connection must not wedge the music.generate IPC / agent
// turn forever. Mirrors the 120s deadline the Stable Audio provider races fal.subscribe against.
const MUSIC_TIMEOUT_MS = 120_000

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

async function generateMusic(prompt: string, duration?: number): Promise<MusicResult> {
  const apiKey = getApiKey()
  if (!prompt || !prompt.trim()) throw new Error('A music prompt is required')

  const seconds = Math.round(duration ?? DEFAULT_SECONDS)
  const musicLengthMs = Math.min(Math.max(seconds * 1000, MIN_MS), MAX_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MUSIC_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${API_BASE}/music?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        music_length_ms: musicLengthMs,
        model_id: MODEL_ID,
      }),
      signal: controller.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`ElevenLabs Music generation timed out after ${MUSIC_TIMEOUT_MS / 1000}s`, { cause: e })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`ElevenLabs Music generation error (${response.status}): ${errorText}`)
  }

  // The endpoint returns binary audio. If it ever returns JSON/text instead (an error envelope or
  // an async-job stub), arrayBuffer() would be non-empty and the empty-check below would pass —
  // silently writing unplayable bytes to a .mp3 as a fake success. Guard on content-type.
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('json') || contentType.startsWith('text/')) {
    const body = await response.text().catch(() => '')
    throw new Error(`ElevenLabs Music returned a non-audio response (${contentType}): ${body.slice(0, 200)}`)
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer())
  if (audioBuffer.length === 0) throw new Error('ElevenLabs Music returned an empty audio stream')

  const audioDir = getAudioDir()
  await fs.mkdir(audioDir, { recursive: true })
  const filename = `music-elevenlabs-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`
  await fs.writeFile(path.join(audioDir, filename), audioBuffer)

  const localUrl = audioUrlFor(filename)
  return {
    id: `elevenlabs-music-${Date.now()}`,
    name: prompt.slice(0, 80),
    audioUrl: localUrl,
    // Reported as the REQUESTED length (matches the Stable Audio provider). The model composes to
    // phrase boundaries so the delivered clip can differ by a second or two; timeline placement
    // tolerates that (music loops/trims to scene length). Measuring the real mp3 duration is a
    // follow-up shared with the other generative providers.
    duration: Math.round(musicLengthMs / 1000),
    provider: 'elevenlabs-music',
    previewUrl: localUrl,
  }
}

export const elevenlabsMusic: MusicProviderInterface = {
  id: 'elevenlabs-music',
  name: 'ElevenLabs Music',
  requiresKey: 'ELEVENLABS_API_KEY',

  async search(_query: string, _limit?: number): Promise<MusicResult[]> {
    // Generative — search must not generate. The music.search IPC is ungated, so aliasing
    // search → a paid /v1/music call would bypass the spend gate. Use the gated music.generate
    // path → generate (matches the Stable Audio provider).
    throw new Error('ElevenLabs Music is generative — use the music.generate path, not search.')
  },

  generate: generateMusic,
}
