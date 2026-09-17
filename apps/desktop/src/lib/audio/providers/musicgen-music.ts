import fs from 'fs/promises'
import path from 'path'
import type { MusicProviderInterface, MusicResult } from '../types'
import { safeAudioFilename } from '../sanitize'
import { getAudioDir, audioUrlFor } from '../paths'

/**
 * MusicGen sidecar — local, $0, text-prompt -> music. The neural counterpart to
 * compose_music (which is template + instrument knobs); this takes a free-text
 * description ("warm lo-fi piano with vinyl crackle") and generates audio.
 *
 * Mirrors the pocket-tts pattern: a self-managed local server (the agent/user
 * starts it; weights are fetched locally, never shipped) reached via MUSICGEN_URL.
 * The heavy ML runtime stays OUT of Electron. POST /generate {prompt, duration}
 * -> WAV bytes. Generation is slow (~0.2x realtime on CPU), so the timeout is
 * generous and the agent surfaces it as a background job.
 */

// ~0.25x realtime on CPU + model warmup → allow up to ~30s of audio at a safe margin.
const FETCH_TIMEOUT_MS = 8 * 60_000

function getBaseUrl(): string {
  return process.env.MUSICGEN_URL || 'http://localhost:8090'
}

export const musicgenMusic: MusicProviderInterface = {
  id: 'musicgen',
  name: 'MusicGen (local)',
  requiresKey: null,

  // Generate-only — there is no library to search. add_background_music covers search.
  async search(): Promise<MusicResult[]> {
    throw new Error('MusicGen is a generative provider — use generate(), not search().')
  },

  async generate(prompt: string, duration?: number): Promise<MusicResult> {
    const baseUrl = getBaseUrl()
    const seconds = typeof duration === 'number' && duration > 0 ? Math.min(duration, 30) : 10

    let response: Response
    try {
      response = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, duration: seconds }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (e: any) {
      const hint =
        e?.name === 'TimeoutError'
          ? `MusicGen timed out after ${FETCH_TIMEOUT_MS / 1000}s (generation is slow on CPU — try a shorter duration).`
          : `Could not reach the MusicGen sidecar at ${baseUrl}. Start it with: npm run music-sidecar:start (or set MUSICGEN_URL).`
      throw new Error(hint, { cause: e })
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`MusicGen error (${response.status}): ${body.slice(0, 200)}`)
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    const audioDir = getAudioDir()
    await fs.mkdir(audioDir, { recursive: true })
    const filename = safeAudioFilename('music', `musicgen-${Date.now()}`, 'wav')
    const filePath = path.join(audioDir, filename)
    await fs.writeFile(filePath, audioBuffer)

    // The server reports the exact duration; fall back to a 16-bit-mono byte estimate.
    const headerDuration = Number(response.headers.get('x-duration'))
    const sr = Number(response.headers.get('x-sample-rate')) || 32000
    const clipDuration =
      Number.isFinite(headerDuration) && headerDuration > 0
        ? headerDuration
        : Math.max(0, audioBuffer.length - 44) / (sr * 2)

    return {
      id: `musicgen-${Date.now()}`,
      name: prompt.slice(0, 60),
      audioUrl: audioUrlFor(filename),
      duration: Math.round(clipDuration * 10) / 10,
      provider: 'musicgen',
    }
  },
}
