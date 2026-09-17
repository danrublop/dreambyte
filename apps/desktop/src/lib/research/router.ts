import { RESEARCH_PROVIDERS, isResearchProviderReady } from './provider-registry'
import { TTLCache, withCache, normalizeKey, hasResults } from './cache'
import { createLogger } from '../logger'

const log = createLogger('research.router')
import type {
  FetchedURLContent,
  FetchURLOptions,
  StockVideoSearchOptions,
  StockVideoSearchResponse,
  StockImageSearchOptions,
  StockImageSearchResponse,
  ArchivalSearchOptions,
  ArchivalSearchResponse,
  ArchivalItem,
  WebSearchOptions,
  WebSearchResponse,
} from './types'

// General web search is Tavily-backed (model-agnostic) so ANY agent model can
// research — see runWebSearch. Native provider-side search (Anthropic/OpenAI/
// Gemini/Qwen) is still preferred when available (handled in the runner/adapter);
// Tavily covers the models without it (Kimi/DeepSeek/budget/local). The rest of
// the router fans out our own media APIs (URL fetch, stock video/image, archival).

// In-session read caches. Page content is stable → long TTL;
// search results drift → short TTL. Both survive across runs while the app is open.
const urlFetchCache = new TTLCache<FetchedURLContent>(24 * 60 * 60 * 1000)
const webSearchCache = new TTLCache<WebSearchResponse>(60 * 60 * 1000)
// Media searches were UN-cached, so a repeated (often identical) archival/stock
// query re-fanned-out to every provider each time — the "7 near-identical
// find_archival_footage calls" cost. Same 1h TTL as web search; media drifts slowly.
const archivalCache = new TTLCache<ArchivalSearchResponse>(60 * 60 * 1000)
const stockImageCache = new TTLCache<StockImageSearchResponse>(60 * 60 * 1000)
const stockVideoCache = new TTLCache<StockVideoSearchResponse>(60 * 60 * 1000)

export async function runUrlFetch(opts: FetchURLOptions): Promise<FetchedURLContent> {
  return withCache(urlFetchCache, normalizeKey(opts.url), async () => {
    const { fetchUrlContent } = await import('./providers/url-fetch')
    return fetchUrlContent(opts)
  })
}

/**
 * General web search. Backend preference, best → floor:
 *   1. SearXNG (SEARXNG_URL) when it's actually reachable — free, self-hosted,
 *      private; the quality option for anyone who runs it.
 *   2. Tavily (TAVILY_API_KEY) when configured — reliable, generous free tier.
 *   3. Keyless in-process meta-search (Mojeek → DuckDuckGo → Brave, scraped
 *      directly) — the always-on $0 FLOOR so research works with NO Docker, NO
 *      server, NO key. Best-effort: the engines rate-limit/bot-check under load
 *      (no number of engines beats IP-level rate-limiting), so it can fail;
 *      when it does, the error tells the user to add a key or use a native-search
 *      model. This is the universal path for non-native-search models
 *      (Kimi/DeepSeek/local); native providers (Anthropic/OpenAI/Gemini/Qwen)
 *      search on their side and never reach here.
 */
export async function runWebSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
  const key = `${normalizeKey(opts.query ?? '')}|${opts.count ?? ''}|${opts.recency ?? ''}|${opts.site ?? ''}`
  return withCache(
    webSearchCache,
    key,
    async () => {
      const { isSearxngReady, searxngWebSearch } = await import('./providers/searxng')
      const { isTavilyReady, tavilyWebSearch } = await import('./providers/tavily')
      const { keylessWebSearch } = await import('./providers/keyless')

      // 1. SearXNG when it's SET — but isSearxngReady only checks the URL is set, not
      //    that anything answers. A dead instance must fall through, not black-hole.
      if (isSearxngReady()) {
        try {
          return await searxngWebSearch(opts)
        } catch (e) {
          // Diagnosable, not silent: a configured-but-unreachable SearXNG shouldn't
          // invisibly degrade research to the scraped floor.
          log.warn('SearXNG search failed — falling back', { error: e })
        }
      }
      // 2. Tavily when configured.
      if (isTavilyReady()) {
        try {
          return await tavilyWebSearch(opts)
        } catch (e) {
          log.warn('Tavily search failed (key rate-limited/invalid?) — falling back to keyless', { error: e })
          /* fall through to the keyless floor */
        }
      }
      // 3. Keyless floor — always available, no config. Throws a clear "add a key /
      //    use native search" error if every engine is blocked, which the tool surfaces.
      return keylessWebSearch(opts)
    },
    hasResults,
  )
}

/**
 * Picks the first enabled + configured + implemented stock-video provider and runs the query.
 * No silent fallback — if the picked provider fails, the error propagates to the caller.
 * Preference order: explicit `source` option → Pexels → Pixabay.
 */
export async function runStockVideoSearch(
  opts: StockVideoSearchOptions & { source?: 'pexels' | 'pixabay' },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<StockVideoSearchResponse> {
  const key = `${normalizeKey(opts.query ?? '')}|${opts.orientation ?? ''}|${opts.minDurationSec ?? ''}|${opts.maxDurationSec ?? ''}|${opts.minWidth ?? ''}|${opts.source ?? ''}`
  return withCache(stockVideoCache, key, () => runStockVideoSearchUncached(opts, researchProviderEnabled), hasResults)
}

async function runStockVideoSearchUncached(
  opts: StockVideoSearchOptions & { source?: 'pexels' | 'pixabay' },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<StockVideoSearchResponse> {
  const pick = opts.source
    ? opts.source === 'pexels'
      ? 'pexels-video'
      : opts.source === 'pixabay'
        ? 'pixabay-video'
        : null
    : pickStockVideoProvider(researchProviderEnabled)

  if (!pick) {
    throw new Error(
      'No stock-video provider is configured and enabled. Set PEXELS_API_KEY or PIXABAY_API_KEY and enable the provider in Settings.',
    )
  }

  if (pick === 'pexels-video') {
    const { pexelsVideoSearch } = await import('./providers/pexels')
    return pexelsVideoSearch(opts)
  }
  if (pick === 'pixabay-video') {
    const { pixabayVideoSearch } = await import('./providers/pixabay')
    return pixabayVideoSearch(opts)
  }
  throw new Error(`Unknown stock-video provider: ${pick}`)
}

export function pickStockVideoProvider(researchProviderEnabled?: Record<string, boolean>): string | null {
  const stockProviders = RESEARCH_PROVIDERS.filter((p) => p.category === 'stock-video')
  for (const p of stockProviders) {
    const enabled = researchProviderEnabled?.[p.id] ?? p.defaultEnabled
    if (enabled && isResearchProviderReady(p)) return p.id
  }
  return null
}

/**
 * Stock image search. Currently one provider (Unsplash); Pexels Images and
 * Pixabay Images can slot in later. No silent fallback.
 */
export async function runStockImageSearch(
  opts: StockImageSearchOptions & { source?: 'unsplash' },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<StockImageSearchResponse> {
  const key = `${normalizeKey(opts.query ?? '')}|${opts.orientation ?? ''}|${opts.minWidth ?? ''}|${opts.source ?? ''}`
  return withCache(stockImageCache, key, () => runStockImageSearchUncached(opts, researchProviderEnabled), hasResults)
}

async function runStockImageSearchUncached(
  opts: StockImageSearchOptions & { source?: 'unsplash' },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<StockImageSearchResponse> {
  const pick = opts.source ?? pickStockImageProvider(researchProviderEnabled)
  if (pick === 'unsplash') {
    const { unsplashImageSearch } = await import('./providers/unsplash')
    return unsplashImageSearch(opts)
  }
  // No keyed stock provider → keyless floor, $0, no config:
  //   1. SearXNG image search when the user runs an instance (arbitrary web photos), else
  //   2. Openverse — ~800M openly-licensed images via a keyless JSON API (the image
  //      equivalent of the keyless web-search floor; works on the pure free path).
  if (!pick) {
    const { isSearxngReady, searxngImageSearch } = await import('./providers/searxng')
    if (isSearxngReady()) {
      try {
        return await searxngImageSearch(opts)
      } catch {
        /* fall through to Openverse */
      }
    }
    const { openverseImageSearch } = await import('./providers/openverse')
    return openverseImageSearch(opts)
  }
  throw new Error(`Unknown stock-image provider: ${pick}`)
}

export function pickStockImageProvider(researchProviderEnabled?: Record<string, boolean>): string | null {
  const stockImages = RESEARCH_PROVIDERS.filter((p) => p.category === 'stock-image')
  for (const p of stockImages) {
    const enabled = researchProviderEnabled?.[p.id] ?? p.defaultEnabled
    if (enabled && isResearchProviderReady(p)) return p.id
  }
  return null
}

/**
 * Archival media search — fans out across Archive.org, NASA, and Wikimedia in
 * parallel, merges results. This is the one router entry that DOES merge
 * across providers, because archival sources are complementary (not alternate
 * options for the same corpus) and the agent benefits from hitting all three
 * at once. Individual provider failures are silenced so one bad day doesn't
 * nuke the whole query.
 */
export async function runArchivalSearch(
  opts: ArchivalSearchOptions & { sources?: Array<'archive-org' | 'nasa' | 'wikimedia'> },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<ArchivalSearchResponse> {
  const key = `${normalizeKey(opts.query ?? '')}|${opts.mediaType ?? ''}|${opts.count ?? ''}|${opts.yearFrom ?? ''}|${opts.yearTo ?? ''}|${(opts.sources ?? []).join(',')}`
  return withCache(archivalCache, key, () => runArchivalSearchUncached(opts, researchProviderEnabled), hasResults)
}

async function runArchivalSearchUncached(
  opts: ArchivalSearchOptions & { sources?: Array<'archive-org' | 'nasa' | 'wikimedia'> },
  researchProviderEnabled?: Record<string, boolean>,
): Promise<ArchivalSearchResponse> {
  const enabledProviders = (['archive-org', 'nasa', 'wikimedia'] as const).filter((id) => {
    if (opts.sources && !opts.sources.includes(id)) return false
    const p = RESEARCH_PROVIDERS.find((x) => x.id === id)
    if (!p) return false
    if (!isResearchProviderReady(p)) return false
    const enabled = researchProviderEnabled?.[id] ?? p.defaultEnabled
    return enabled
  })

  if (enabledProviders.length === 0) {
    throw new Error('No archival provider is enabled. Enable Archive.org, NASA, or Wikimedia in Settings.')
  }

  // Split count across providers, floor 3 per provider.
  const perProvider = Math.max(3, Math.floor((opts.count ?? 12) / enabledProviders.length))
  const perOpts = { ...opts, count: perProvider }

  const hits = await Promise.allSettled(
    enabledProviders.map(async (id) => {
      if (id === 'archive-org') {
        const { archiveOrgSearch } = await import('./providers/archive-org')
        return archiveOrgSearch(perOpts)
      }
      if (id === 'nasa') {
        const { nasaSearch } = await import('./providers/nasa')
        return nasaSearch(perOpts)
      }
      const { wikimediaCommonsSearch } = await import('./providers/wikimedia-commons')
      return wikimediaCommonsSearch(perOpts)
    }),
  )

  const all: ArchivalItem[] = []
  let totalFound = 0
  for (const h of hits) {
    if (h.status === 'fulfilled') {
      all.push(...h.value.results)
      totalFound += h.value.totalFound ?? h.value.results.length
    }
  }

  // Interleave by source so top-K isn't dominated by one provider.
  const merged = interleaveBySource(all)

  // Return everything we fetched. The per-provider floor over-fetches
  // (≥3 × providers); slicing back to a small `count` would discard those
  // results (count=3 fetches ~9), looking thin and triggering a re-query.
  // Never return FEWER than we fetched.
  return {
    results: merged.slice(0, Math.max(opts.count ?? 12, merged.length)),
    query: opts.query,
    provider: enabledProviders.join('+'),
    totalFound,
  }
}

function interleaveBySource(items: ArchivalItem[]): ArchivalItem[] {
  const buckets = new Map<string, ArchivalItem[]>()
  for (const i of items) {
    const arr = buckets.get(i.source) ?? []
    arr.push(i)
    buckets.set(i.source, arr)
  }
  const out: ArchivalItem[] = []
  let added = true
  while (added) {
    added = false
    for (const arr of buckets.values()) {
      const next = arr.shift()
      if (next) {
        out.push(next)
        added = true
      }
    }
  }
  return out
}
