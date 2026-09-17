import type { SFXProviderInterface, SFXResult, SFXSearchOptions } from '../types'
import { isCommercialFriendlyFreesoundLicense } from '../sfx-license'

const API_BASE = 'https://freesound.org/apiv2'
const FETCH_TIMEOUT_MS = 60_000

function getApiKey(): string {
  const key = process.env.FREESOUND_API_KEY
  if (!key) throw new Error('FREESOUND_API_KEY is not set')
  return key
}

interface FreesoundResult {
  id: number
  name: string
  previews: {
    'preview-hq-mp3': string
    'preview-lq-mp3': string
    'preview-hq-ogg': string
    'preview-lq-ogg': string
  }
  duration: number
  license: string
}

interface FreesoundSearchResponse {
  count: number
  results: FreesoundResult[]
}

export const freesoundSFX: SFXProviderInterface = {
  id: 'freesound',
  name: 'Freesound',
  requiresKey: 'FREESOUND_API_KEY',

  async search(query: string, limit = 10, options?: SFXSearchOptions): Promise<SFXResult[]> {
    const apiKey = getApiKey()
    const commercialOnly = options?.commercialOnly ?? false
    const page = Math.max(1, options?.page ?? 1)
    // When filtering licenses, request a larger page and trim (Freesound mixes licenses in results)
    const pageSize = Math.min(150, Math.max(limit * (commercialOnly ? 4 : 1), limit))

    const params = new URLSearchParams({
      query,
      page: String(page),
      page_size: String(pageSize),
      fields: 'id,name,previews,duration,license',
      token: apiKey,
    })

    const response = await fetch(`${API_BASE}/search/text/?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Freesound search error (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as FreesoundSearchResponse

    let mapped: SFXResult[] = data.results.map((result) => ({
      id: String(result.id),
      name: result.name,
      audioUrl: result.previews['preview-hq-mp3'],
      duration: Math.round(result.duration * 10) / 10,
      provider: 'freesound' as const,
      previewUrl: result.previews['preview-hq-mp3'],
      license: result.license,
    }))

    if (commercialOnly) {
      mapped = mapped.filter((r) => isCommercialFriendlyFreesoundLicense(r.license))
    }

    return mapped.slice(0, limit)
  },
}
