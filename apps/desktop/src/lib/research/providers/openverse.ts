/**
 * Openverse image provider — the KEYLESS stock-image floor.
 *
 * Openverse (https://openverse.org, a WordPress/CC project) aggregates ~800M
 * openly-licensed images behind one JSON API with NO key required. This is what
 * makes `find_stock_images` work on the free path (no Unsplash key, no SearXNG) —
 * the image equivalent of the keyless web-search floor. Anonymous access is
 * rate-limited but generous; results carry real CC license metadata.
 *
 * Never trusts the network blindly: bounded timeout, shape-validated results.
 */
import type { StockImage, StockImageSearchOptions, StockImageSearchResponse } from '../types'

const ENDPOINT = 'https://api.openverse.org/v1/images/'
const TIMEOUT_MS = 12_000

/** Keyless — always available. */
export function isOpenverseReady(): boolean {
  return true
}

function toAspectRatio(o: StockImageSearchOptions['orientation']): string | undefined {
  if (o === 'landscape') return 'wide'
  if (o === 'portrait') return 'tall'
  if (o === 'square') return 'square'
  return undefined
}

export async function openverseImageSearch(opts: StockImageSearchOptions): Promise<StockImageSearchResponse> {
  const query = (opts.query ?? '').trim()
  if (!query) throw new Error('query is required')

  const params = new URLSearchParams({
    q: query,
    page_size: String(Math.min(Math.max(opts.count ?? 10, 1), 20)),
    // Restrict to images that are safe in a video that might ship commercially AND be
    // edited — CC0 / BY / BY-SA / PDM. Keeps NC/ND (non-commercial / no-derivatives)
    // images out of the default floor, since exported videos may be used commercially.
    license_type: 'commercial,modification',
  })
  const ar = toAspectRatio(opts.orientation)
  if (ar) params.set('aspect_ratio', ar)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Openverse image search failed (${res.status})`)
    const json = (await res.json()) as {
      results?: Array<{
        id?: unknown
        title?: unknown
        url?: unknown
        thumbnail?: unknown
        foreign_landing_url?: unknown
        creator?: unknown
        creator_url?: unknown
        license?: unknown
        license_version?: unknown
        width?: unknown
        height?: unknown
      }>
    }
    const minW = opts.minWidth ?? 0
    const results: StockImage[] = Array.isArray(json.results)
      ? json.results
          .filter((r) => typeof r?.url === 'string' && (r.url as string).startsWith('http'))
          .map((r) => {
            const width = typeof r.width === 'number' ? r.width : 0
            const height = typeof r.height === 'number' ? r.height : 0
            const lic = typeof r.license === 'string' ? r.license.toUpperCase() : ''
            const ver = typeof r.license_version === 'string' ? ` ${r.license_version}` : ''
            return {
              id: `openverse-${typeof r.id === 'string' ? r.id : (r.url as string).slice(-24)}`,
              source: 'openverse' as const,
              sourceUrl: typeof r.foreign_landing_url === 'string' ? r.foreign_landing_url : (r.url as string),
              url: r.url as string,
              thumbnailUrl: typeof r.thumbnail === 'string' && r.thumbnail ? (r.thumbnail as string) : (r.url as string),
              width,
              height,
              alt: typeof r.title === 'string' ? r.title : undefined,
              author: typeof r.creator === 'string' ? r.creator : undefined,
              authorUrl: typeof r.creator_url === 'string' ? r.creator_url : undefined,
              license: lic ? `${lic}${ver} (Openverse)` : 'CC (Openverse)',
            }
          })
          .filter((img) => img.width === 0 || img.width >= minW)
      : []
    return { results, query, provider: 'openverse' }
  } finally {
    clearTimeout(timer)
  }
}
