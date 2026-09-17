import type { StockVideo, StockVideoFile, StockVideoSearchOptions, StockVideoSearchResponse } from '../types'

const PEXELS_VIDEO_ENDPOINT = 'https://api.pexels.com/videos/search'
const FETCH_TIMEOUT_MS = 60_000

interface PexelsVideoFile {
  id: number
  quality: string
  file_type: string
  width: number | null
  height: number | null
  link: string
}

interface PexelsVideoPicture {
  id: number
  picture: string
  nr: number
}

interface PexelsVideoUser {
  id: number
  name: string
  url: string
}

interface PexelsVideo {
  id: number
  width: number
  height: number
  duration: number
  url: string
  image: string
  user: PexelsVideoUser
  video_files: PexelsVideoFile[]
  video_pictures?: PexelsVideoPicture[]
}

interface PexelsSearchResponse {
  page: number
  per_page: number
  total_results: number
  videos: PexelsVideo[]
}

export async function pexelsVideoSearch(opts: StockVideoSearchOptions): Promise<StockVideoSearchResponse> {
  const apiKey = process.env.PEXELS_API_KEY
  if (!apiKey) throw new Error('PEXELS_API_KEY is not set')

  const count = Math.min(Math.max(opts.count ?? 10, 1), 30)
  const params = new URLSearchParams({
    query: opts.query,
    per_page: String(count),
  })
  if (opts.orientation) params.set('orientation', opts.orientation)
  if (opts.minWidth && opts.minWidth >= 1920) params.set('size', 'large')
  else if (opts.minWidth && opts.minWidth >= 1280) params.set('size', 'medium')

  const response = await fetch(`${PEXELS_VIDEO_ENDPOINT}?${params.toString()}`, {
    headers: {
      Authorization: apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Pexels video search failed: ${response.status} ${text.slice(0, 200)}`)
  }

  const data = (await response.json()) as PexelsSearchResponse

  const results: StockVideo[] = data.videos
    .map((v) => {
      const files: StockVideoFile[] = v.video_files
        .filter((f) => !!f.link && f.file_type === 'video/mp4' && f.width && f.height)
        .map((f) => ({
          url: f.link,
          width: f.width as number,
          height: f.height as number,
          quality: f.quality,
          fileType: f.file_type,
        }))
        .sort((a, b) => b.width - a.width)
      return {
        id: String(v.id),
        source: 'pexels' as const,
        sourceUrl: v.url,
        thumbnailUrl: v.image,
        previewUrl: v.video_pictures?.[0]?.picture ?? v.image,
        width: v.width,
        height: v.height,
        durationSec: v.duration,
        files,
        author: v.user.name,
        authorUrl: v.user.url,
        license: 'Pexels License (free, attribution appreciated)',
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
    provider: 'pexels',
    totalFound: data.total_results,
  }
}
