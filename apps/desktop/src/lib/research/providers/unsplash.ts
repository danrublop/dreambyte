import type { StockImage, StockImageSearchOptions, StockImageSearchResponse } from '../types'

const UNSPLASH_SEARCH_ENDPOINT = 'https://api.unsplash.com/search/photos'
const FETCH_TIMEOUT_MS = 60_000

interface UnsplashPhoto {
  id: string
  description: string | null
  alt_description: string | null
  width: number
  height: number
  urls: {
    raw: string
    full: string
    regular: string
    small: string
    thumb: string
  }
  links: {
    html: string
    download_location: string
  }
  user: {
    name: string
    username: string
    links: { html: string }
  }
  tags?: Array<{ title: string }>
}

interface UnsplashSearchResponse {
  total: number
  total_pages: number
  results: UnsplashPhoto[]
}

export async function unsplashImageSearch(opts: StockImageSearchOptions): Promise<StockImageSearchResponse> {
  const apiKey = process.env.UNSPLASH_ACCESS_KEY
  if (!apiKey) throw new Error('UNSPLASH_ACCESS_KEY is not set')

  const count = Math.min(Math.max(opts.count ?? 10, 1), 30)
  const params = new URLSearchParams({
    query: opts.query,
    per_page: String(count),
    content_filter: 'high',
  })
  if (opts.orientation) params.set('orientation', opts.orientation === 'square' ? 'squarish' : opts.orientation)

  const response = await fetch(`${UNSPLASH_SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: {
      Authorization: `Client-ID ${apiKey}`,
      Accept: 'application/json',
      'Accept-Version': 'v1',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Unsplash search failed: ${response.status} ${text.slice(0, 200)}`)
  }

  const data = (await response.json()) as UnsplashSearchResponse

  const results: StockImage[] = data.results
    .filter((p) => !opts.minWidth || p.width >= opts.minWidth)
    .map((p) => ({
      id: p.id,
      source: 'unsplash' as const,
      sourceUrl: p.links.html,
      url: p.urls.full,
      thumbnailUrl: p.urls.small,
      width: p.width,
      height: p.height,
      alt: p.alt_description ?? p.description ?? undefined,
      author: p.user.name,
      authorUrl: p.user.links.html,
      license: 'Unsplash License (free, attribution appreciated)',
      tags: p.tags?.map((t) => t.title),
    }))

  return {
    results,
    query: opts.query,
    provider: 'unsplash',
    totalFound: data.total,
  }
}
