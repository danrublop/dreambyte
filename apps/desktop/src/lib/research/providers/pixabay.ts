import type { StockVideo, StockVideoFile, StockVideoSearchOptions, StockVideoSearchResponse } from '../types'

const PIXABAY_VIDEO_ENDPOINT = 'https://pixabay.com/api/videos/'
const FETCH_TIMEOUT_MS = 60_000

interface PixabayVideoVariant {
  url: string
  width: number
  height: number
  size: number
  thumbnail?: string
}

interface PixabayVideoHit {
  id: number
  pageURL: string
  type: string
  tags: string
  duration: number
  picture_id?: string
  videos: {
    large?: PixabayVideoVariant
    medium?: PixabayVideoVariant
    small?: PixabayVideoVariant
    tiny?: PixabayVideoVariant
  }
  views: number
  downloads: number
  user_id: number
  user: string
}

interface PixabaySearchResponse {
  total: number
  totalHits: number
  hits: PixabayVideoHit[]
}

export async function pixabayVideoSearch(opts: StockVideoSearchOptions): Promise<StockVideoSearchResponse> {
  const apiKey = process.env.PIXABAY_API_KEY
  if (!apiKey) throw new Error('PIXABAY_API_KEY is not set')

  const count = Math.min(Math.max(opts.count ?? 10, 3), 30)
  const params = new URLSearchParams({
    key: apiKey,
    q: opts.query,
    per_page: String(count),
    safesearch: 'true',
  })
  if (opts.orientation === 'landscape') params.set('video_type', 'film')
  if (opts.minWidth && opts.minWidth >= 1920) params.set('min_width', '1920')
  else if (opts.minWidth) params.set('min_width', String(opts.minWidth))

  const response = await fetch(`${PIXABAY_VIDEO_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Pixabay video search failed: ${response.status} ${text.slice(0, 200)}`)
  }

  const data = (await response.json()) as PixabaySearchResponse

  const results: StockVideo[] = data.hits
    .map((h) => {
      const variants: Array<[string, PixabayVideoVariant | undefined]> = [
        ['large', h.videos.large],
        ['medium', h.videos.medium],
        ['small', h.videos.small],
        ['tiny', h.videos.tiny],
      ]
      const files: StockVideoFile[] = variants
        .filter((v): v is [string, PixabayVideoVariant] => !!v[1]?.url && v[1].width > 0)
        .map(([quality, v]) => ({
          url: v.url,
          width: v.width,
          height: v.height,
          quality,
        }))
      const largest = files[0]
      const thumbId = h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : ''
      return {
        id: String(h.id),
        source: 'pixabay' as const,
        sourceUrl: h.pageURL,
        thumbnailUrl: h.videos.tiny?.thumbnail ?? thumbId,
        previewUrl: h.videos.small?.url,
        width: largest?.width ?? 0,
        height: largest?.height ?? 0,
        durationSec: h.duration,
        files,
        author: h.user,
        authorUrl: `https://pixabay.com/users/${h.user}-${h.user_id}/`,
        license: 'Pixabay Content License (free, attribution appreciated)',
        tags: h.tags ? h.tags.split(',').map((t) => t.trim()) : undefined,
      }
    })
    .filter((v) => v.files.length > 0)
    .filter((v) => {
      if (opts.minDurationSec !== undefined && v.durationSec < opts.minDurationSec) return false
      if (opts.maxDurationSec !== undefined && v.durationSec > opts.maxDurationSec) return false
      return true
    })

  return {
    results,
    query: opts.query,
    provider: 'pixabay',
    totalFound: data.totalHits,
  }
}
