import type { MusicProviderInterface, MusicResult } from '../types'

const API_BASE = 'https://pixabay.com/api/audio/'

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

export const pixabayMusic: MusicProviderInterface = {
  id: 'pixabay-music',
  name: 'Pixabay Music',
  requiresKey: 'PIXABAY_API_KEY',

  async search(query: string, limit?: number): Promise<MusicResult[]> {
    const apiKey = getApiKey()
    const perPage = limit || 10

    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      per_page: String(perPage),
      safesearch: 'true',
    })

    try {
      const response = await fetch(`${API_BASE}?${params}`)

      if (!response.ok) {
        if (response.status === 400 || response.status === 404) {
          return []
        }
        const errorText = await response.text()
        throw new Error(`Pixabay Music search error (${response.status}): ${errorText}`)
      }

      const data = (await response.json()) as PixabayAudioResponse

      return data.hits.map((hit) => ({
        id: String(hit.id),
        name: hit.title,
        audioUrl: hit.audio,
        duration: hit.duration,
        provider: 'pixabay-music' as const,
        previewUrl: hit.audio,
      }))
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch')) {
        return []
      }
      throw err
    }
  },
}
