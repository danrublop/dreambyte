import * as fal from '@fal-ai/serverless-client'
import type { MusicProviderInterface, MusicResult } from '../types'
import { downloadToLocal } from '../download'

/**
 * fal Stable Audio — generative background music.
 *
 * Unlike the Pixabay/Freesound music providers (which SEARCH a royalty-free library),
 * Stable Audio compiles a text prompt into an original clip. Reuses FAL_KEY (the same key
 * the image/video/avatar fal models use), so no new credential. Mirrors the elevenlabs-sfx
 * provider shape: `search` is a thin alias over `generate` (the library has nothing to search),
 * and `generate` is the real entry point.
 */

const FAL_ENDPOINT = 'fal-ai/stable-audio'
const DEFAULT_SECONDS = 30

// fal.subscribe takes no timeout option, so race it against a rejecting deadline — a stalled
// fal queue would otherwise hang the agent turn. 120s for the generative call.
const FAL_SUBSCRIBE_TIMEOUT_MS = 120_000

function withFalTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error('fal Stable Audio generation timed out after 120s')),
      FAL_SUBSCRIBE_TIMEOUT_MS,
    )
  })
  // clearTimeout on the winning path so the 120s timer doesn't stay armed after
  // fal.subscribe resolves first.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function configureFal(): void {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY is not set')
  fal.config({ credentials: key })
}

async function generateMusic(prompt: string, duration?: number): Promise<MusicResult> {
  configureFal()
  const seconds = Math.min(Math.max(Math.round(duration ?? DEFAULT_SECONDS), 1), 47) // fal caps stable-audio at 47s

  const result = (await withFalTimeout(
    fal.subscribe(FAL_ENDPOINT, {
      input: {
        prompt,
        seconds_total: seconds,
      },
    }),
  )) as { audio_file?: { url?: string }; audio?: { url?: string } }

  const remoteUrl = result.audio_file?.url ?? result.audio?.url
  if (!remoteUrl) throw new Error('No audio returned from fal Stable Audio')

  // Download into the local audio dir so scene HTML (same-origin) + WVC export can play it.
  const localUrl = await downloadToLocal(remoteUrl, 'music')

  return {
    id: `stable-audio-${Date.now()}`,
    name: prompt.slice(0, 80),
    audioUrl: localUrl,
    duration: seconds,
    provider: 'stable-audio',
    previewUrl: localUrl,
  }
}

export const stableAudioMusic: MusicProviderInterface = {
  id: 'stable-audio',
  name: 'Stable Audio (FAL)',
  requiresKey: 'FAL_KEY',

  async search(_query: string, _limit?: number): Promise<MusicResult[]> {
    // Stable Audio is generative — but `search` must NOT generate. The `music.search` IPC is
    // UNGATED (it's a library lookup), so aliasing search → a paid fal call there would bypass
    // gateMediaSpend. The only paid music path is the gated `music.generate` IPC → generateMusic.
    throw new Error('Stable Audio is generative — use the music.generate path, not search.')
  },

  generate: generateMusic,
}
