/**
 * SearXNG web-search provider — the free, self-hosted search backend.
 *
 * SearXNG is a self-hosted metasearch engine (https://searxng.org): you run it
 * locally (Docker) and it aggregates Google/Bing/DDG/etc behind one JSON API,
 * with NO API key and NO per-query fee. This is the $0 alternative to Tavily for
 * a local deep-research loop — point SEARXNG_URL at your instance and every
 * search the agent runs costs nothing.
 *
 * Shape matches tavily.ts so runWebSearch can prefer whichever is configured.
 * Never trusts the network blindly: bounded timeout, shape-validated results.
 */
import type {
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResult,
  StockImageSearchOptions,
  StockImageSearchResponse,
  StockImage,
} from '../types'

const SEARXNG_TIMEOUT_MS = 15_000

/** Base URL of the self-hosted SearXNG instance, e.g. http://localhost:8888. */
function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SEARXNG_URL?.trim()
  if (!raw) return undefined
  return raw.replace(/\/+$/, '') // strip trailing slash
}

/** True when a SearXNG instance is configured. */
export function isSearxngReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getBaseUrl(env))
}

const VALID_TIME_RANGES: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year'])

function toTimeRange(recency: WebSearchOptions['recency']): string | undefined {
  if (!recency || !VALID_TIME_RANGES.has(recency)) return undefined
  return recency
}

export async function searxngWebSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
  const base = getBaseUrl()
  if (!base) throw new Error('SEARXNG_URL is not set — add it in Settings to use SearXNG web search.')

  const baseQuery = (opts.query ?? '').trim()
  if (!baseQuery) throw new Error('query is required')
  const query = opts.site ? `${baseQuery} site:${opts.site}` : baseQuery

  const params = new URLSearchParams({ q: query, format: 'json' })
  const tr = toTimeRange(opts.recency)
  if (tr) params.set('time_range', tr)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // A 403 here almost always means the instance hasn't enabled the JSON
      // format in settings.yml (`search.formats: [html, json]`). Say so.
      const hint = res.status === 403 ? ' — enable `json` under search.formats in your SearXNG settings.yml' : ''
      throw new Error(`SearXNG search failed (${res.status})${hint}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const json = (await res.json()) as {
      results?: Array<{ title?: unknown; url?: unknown; content?: unknown; score?: unknown }>
      answers?: unknown[]
    }
    const max = Math.min(Math.max(opts.count ?? 5, 1), 10)
    const results: WebSearchResult[] = Array.isArray(json.results)
      ? json.results
          .filter((r) => typeof r?.url === 'string')
          .slice(0, max)
          .map((r) => ({
            title: typeof r.title === 'string' ? r.title : '',
            url: r.url as string,
            content: typeof r.content === 'string' ? r.content : '',
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
          }))
      : []
    // SearXNG has no synthesized answer like Tavily; surface its instant-answer
    // strings (Wikipedia/calculator/etc) as `answer` when present.
    const answer = Array.isArray(json.answers)
      ? json.answers.filter((a): a is string => typeof a === 'string' && a.length > 0).join(' ')
      : ''
    return {
      query,
      provider: 'searxng',
      results,
      ...(answer ? { answer } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * SearXNG IMAGE search — the keyless, $0 way to pull real photos from the web
 * (the Perplexity-style path). Uses the same instance as web search with
 * `categories=images`. Returns arbitrary web images, so `license` is honestly
 * marked "web — rights unverified": these are NOT cleared for commercial reuse
 * the way the archival (public-domain/CC) path is. Good for reference/personal
 * builds; the caller/UI should surface the license.
 */
export async function searxngImageSearch(opts: StockImageSearchOptions): Promise<StockImageSearchResponse> {
  const base = getBaseUrl()
  if (!base) throw new Error('SEARXNG_URL is not set — add it in Settings to use SearXNG image search.')
  const query = (opts.query ?? '').trim()
  if (!query) throw new Error('query is required')

  const params = new URLSearchParams({ q: query, format: 'json', categories: 'images' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const hint = res.status === 403 ? ' — enable `json` under search.formats in your SearXNG settings.yml' : ''
      throw new Error(`SearXNG image search failed (${res.status})${hint}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const json = (await res.json()) as {
      results?: Array<{
        img_src?: unknown
        thumbnail_src?: unknown
        url?: unknown
        title?: unknown
        resolution?: unknown
        source?: unknown
      }>
    }
    const parseDim = (r: string | undefined, i: number): number => {
      const m = typeof r === 'string' ? /(\d+)\s*[x×]\s*(\d+)/.exec(r) : null
      return m ? Number(m[i]) : 0
    }
    const max = Math.min(Math.max(opts.count ?? 10, 1), 20)
    const results: StockImage[] = Array.isArray(json.results)
      ? json.results
          .filter((r) => typeof r?.img_src === 'string' && (r.img_src as string).startsWith('http'))
          .slice(0, max)
          .map((r, i) => {
            const imgSrc = r.img_src as string
            const resolution = typeof r.resolution === 'string' ? r.resolution : undefined
            return {
              id: `searxng-${i}-${imgSrc.slice(-24)}`,
              source: 'searxng' as const,
              sourceUrl: typeof r.url === 'string' ? r.url : imgSrc,
              url: imgSrc,
              thumbnailUrl:
                typeof r.thumbnail_src === 'string' && r.thumbnail_src ? (r.thumbnail_src as string) : imgSrc,
              width: parseDim(resolution, 1),
              height: parseDim(resolution, 2),
              alt: typeof r.title === 'string' ? r.title : undefined,
              license: 'web — rights unverified',
            }
          })
      : []
    return { results, query, provider: 'searxng' }
  } finally {
    clearTimeout(timer)
  }
}
