import type { ArchivalItem, ArchivalSearchOptions, ArchivalSearchResponse } from '../types'

const NASA_SEARCH_ENDPOINT = 'https://images-api.nasa.gov/search'

interface NasaSearchData {
  nasa_id: string
  title: string
  description?: string
  description_508?: string
  date_created?: string
  photographer?: string
  keywords?: string[]
  media_type: 'image' | 'video' | 'audio'
  center?: string
}

interface NasaSearchLink {
  href: string
  rel?: string
  render?: 'image'
}

interface NasaSearchItem {
  data: NasaSearchData[]
  href: string
  links?: NasaSearchLink[]
}

interface NasaSearchResponse {
  collection: {
    items: NasaSearchItem[]
    metadata: { total_hits: number }
  }
}

interface NasaAssetCollection {
  collection: {
    items: Array<{ href: string }>
  }
}

/**
 * NASA Image & Video Library. Two-phase: search returns collection links, then
 * per-hit we fetch the asset index to find the actual high-quality media URL.
 * Uses the `media_type` filter to map our 'image'/'video'/'audio' intent.
 */
export async function nasaSearch(opts: ArchivalSearchOptions): Promise<ArchivalSearchResponse> {
  const count = Math.min(Math.max(opts.count ?? 10, 1), 25)

  const params = new URLSearchParams({ q: opts.query, page_size: String(count), page: '1' })
  const mt = opts.mediaType ?? 'video'
  if (mt !== 'any') params.set('media_type', mt)
  if (opts.yearFrom) params.set('year_start', String(opts.yearFrom))
  if (opts.yearTo) params.set('year_end', String(opts.yearTo))

  const searchRes = await fetch(`${NASA_SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  })
  if (!searchRes.ok) throw new Error(`NASA search failed: ${searchRes.status}`)
  const searchData = (await searchRes.json()) as NasaSearchResponse
  const items = searchData.collection?.items ?? []

  const resolved = await Promise.all(
    items.map(async (item): Promise<ArchivalItem | null> => {
      const d = item.data?.[0]
      if (!d) return null

      // Thumbnail link from search response (link with render: 'image')
      const thumbnailUrl = item.links?.find((l) => l.render === 'image')?.href ?? item.links?.[0]?.href ?? undefined

      // Fetch the asset-collection to pick the best-quality URL.
      let mediaUrl: string | undefined
      try {
        const assetRes = await fetch(item.href, { headers: { Accept: 'application/json' } })
        if (assetRes.ok) {
          const assets = (await assetRes.json()) as NasaAssetCollection
          const hrefs = (assets.collection?.items ?? []).map((x) => x.href)
          mediaUrl = pickBestNasaUrl(hrefs, d.media_type)
        }
      } catch {
        /* fall through — mediaUrl stays undefined */
      }
      // Fallback: for images, the thumbnail href pattern has a 'thumb.jpg' suffix; the raw
      // "~orig.jpg" lives in the asset-collection but if the fetch failed we can try to guess.
      if (!mediaUrl && thumbnailUrl && d.media_type === 'image') {
        mediaUrl = thumbnailUrl.replace(/~thumb\.jpg$/, '~orig.jpg')
      }
      if (!mediaUrl) return null

      return {
        id: d.nasa_id,
        source: 'nasa',
        sourceUrl: `https://images.nasa.gov/details-${encodeURIComponent(d.nasa_id)}`,
        title: d.title,
        description: d.description_508 ?? d.description,
        mediaType: d.media_type,
        mediaUrl,
        thumbnailUrl,
        publishedAt: d.date_created,
        author: d.photographer ?? d.center,
        license: 'NASA Media Usage Guidelines (generally public domain for non-commercial & commercial)',
        tags: d.keywords,
      }
    }),
  )

  return {
    results: resolved.filter((i): i is ArchivalItem => i !== null),
    query: opts.query,
    provider: 'nasa',
    totalFound: searchData.collection?.metadata?.total_hits,
  }
}

function pickBestNasaUrl(hrefs: string[], mediaType: 'image' | 'video' | 'audio'): string | undefined {
  if (mediaType === 'video') {
    return (
      hrefs.find((h) => /~orig\.mp4$/.test(h)) ||
      hrefs.find((h) => /\.mp4$/.test(h)) ||
      hrefs.find((h) => /~large\.mp4$/.test(h))
    )
  }
  if (mediaType === 'image') {
    return (
      hrefs.find((h) => /~orig\.(jpg|png|tiff)$/.test(h)) ||
      hrefs.find((h) => /~large\.(jpg|png)$/.test(h)) ||
      hrefs.find((h) => /\.(jpg|png)$/.test(h))
    )
  }
  return hrefs.find((h) => /\.(mp3|m4a|wav)$/.test(h))
}
