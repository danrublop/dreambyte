import type { SFXProviderInterface, SFXResult, SFXSearchOptions } from '../types'
import { PIXABAY_SFX_LICENSE_NOTE } from '../sfx-license'

const API_BASE = 'https://pixabay.com/api/audio/'
const FETCH_TIMEOUT_MS = 60_000

function getApiKey(): string {
  const key = process.env.PIXABAY_API_KEY
  if (!key) throw new Error('PIXABAY_API_KEY is not set')
  return key
}

interface PixabayAudioHit {
  id: number
  title: string
  audio: string
  duration: number
  tags: string
  type: string
}

interface PixabayAudioResponse {
  total: number
  totalHits: number
  hits: PixabayAudioHit[]
}

export const pixabaySFX: SFXProviderInterface = {
  id: 'pixabay',
  name: 'Pixabay SFX',
  requiresKey: 'PIXABAY_API_KEY',

  async search(query: string, limit = 10, options?: SFXSearchOptions): Promise<SFXResult[]> {
    const apiKey = getApiKey()
    const perPage = Math.min(200, limit || 10)
    const page = Math.max(1, options?.page ?? 1)

    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      per_page: String(perPage),
      page: String(page),
      safesearch: 'true',
      audio_type: 'sfx',
    })

    try {
      const response = await fetch(`${API_BASE}?${params}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        // Pixabay audio API may not be available; return empty gracefully
        if (response.status === 400 || response.status === 404) {
          return []
        }
        const errorText = await response.text()
        throw new Error(`Pixabay SFX search error (${response.status}): ${errorText}`)
      }

      const data = (await response.json()) as PixabayAudioResponse

      return data.hits.map((hit) => ({
        id: String(hit.id),
        name: hit.title,
        audioUrl: hit.audio,
        duration: hit.duration,
        provider: 'pixabay' as const,
        previewUrl: hit.audio,
        license: PIXABAY_SFX_LICENSE_NOTE,
      }))
    } catch (err) {
      // If the audio API endpoint doesn't exist, return empty results
      if (err instanceof TypeError && err.message.includes('fetch')) {
        return []
      }
      throw err
    }
  },
}
