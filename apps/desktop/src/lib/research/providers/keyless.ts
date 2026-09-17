/**
 * Keyless in-process web search — SearXNG's job, done directly in Node.
 *
 * SearXNG is not a search engine; it's a META-scraper: it fans a query out to
 * public engines (DuckDuckGo, Brave, Bing…), parses their result pages, and
 * merges. There's no proprietary index. So we don't need to RUN SearXNG (a
 * Python app, Docker or a heavy bundled runtime) — we do the same fan-out here,
 * in-process. No Docker, no Python, no server, no API key. This is the always-on
 * $0 FLOOR so research works out of the box on any model.
 *
 * It is BEST-EFFORT by nature: the engines it scrapes intermittently serve
 * bot-checks and change their markup, so we try Mojeek (an independent, scraper-
 * tolerant index) first, then RACE DuckDuckGo Lite + Brave as fallbacks. For
 * reliability prefer a native-search model or a Tavily key; this floor just
 * guarantees *something* rather than nothing. (SearXNG survives the same
 * bot-checks by running server-side with rotating engines/proxies — a luxury an
 * in-process client doesn't have. Three engines + tolerant regex parse;
 * swap to a real HTML parser only if the markup churn proves too costly.)
 */
import type { WebSearchOptions, WebSearchResponse, WebSearchResult } from '../types'

const TIMEOUT_MS = 7_000
// A real browser UA — the lite/HTML endpoints serve a bot-check to obvious bots.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/** Always available — no config, no key, no external service. */
export function isKeylessReady(): boolean {
  return true
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      // Guard the Unicode range — String.fromCodePoint throws RangeError past 0x10FFFF,
      // which would zero out an otherwise-good engine on one bad entity.
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole
  })
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // Fuller browser headers reduce (don't eliminate) bot-checks — the endpoints
    // fingerprint on more than UA.
    const res = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Mojeek — an independent index (not a Google/Bing proxy) that is genuinely
 *  scraper-tolerant, so it's the reliable PRIMARY: most searches resolve here and
 *  the flakier DDG/Brave engines stay unused (fresh) as fallbacks. Result blocks
 *  sit between <!--rs--> / <!--re-->; the title link is <a class="title" href>,
 *  the snippet is <p class="s"> — all semantic, stable classes. */
async function mojeek(query: string, count: number): Promise<WebSearchResult[]> {
  const html = await fetchText(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`)
  // Anchor on Mojeek's actual challenge chrome, not bare words — "captcha"/"blocked"
  // appear in legitimate result titles/snippets and would false-discard a good SERP.
  if (/are you human|g-recaptcha|\/challenge/i.test(html)) throw new Error('mojeek bot-check')
  const results: WebSearchResult[] = []
  for (const raw of html.split('<!--rs-->').slice(1)) {
    if (results.length >= count) break
    const block = raw.split('<!--re-->')[0]
    const tm = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!tm) continue
    const url = decodeEntities(tm[1])
    const title = stripTags(tm[2])
    if (!/^https?:\/\//i.test(url) || !title) continue
    const sm = /<p class="s">([\s\S]*?)<\/p>/i.exec(block)
    results.push({ title, url, content: sm ? stripTags(sm[1]) : '' })
  }
  return results
}

/** DuckDuckGo Lite — GET bot-checks, but a form POST returns real results. The
 *  result anchors carry class="result-link"; the href is either direct or a
 *  //duckduckgo.com/l/?uddg=<encoded> redirect we unwrap. Snippets live in the
 *  following `result-snippet` cell. */
async function ddgLite(query: string, count: number): Promise<WebSearchResult[]> {
  const body = new URLSearchParams({ q: query }).toString()
  const html = await fetchText('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (/anomaly-modal|challenge-form/i.test(html)) throw new Error('ddg bot-check')

  const results: WebSearchResult[] = []
  // Split on result rows and pull the link + the snippet that follows it.
  const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]))

  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) && results.length < count) {
    const url = unwrapDdgHref(m[1])
    const title = stripTags(m[2])
    if (!url || !/^https?:\/\//i.test(url) || !title) continue
    // Pair the Nth accepted result with the Nth snippet (index by accepted count,
    // not raw anchor count — a skipped non-http anchor mustn't consume a snippet slot).
    results.push({ title, url, content: snippets[results.length] ?? '' })
  }
  return results
}

function unwrapDdgHref(href: string): string {
  const h = href.startsWith('//') ? `https:${href}` : href
  try {
    // searchParams.get already percent-decodes — decoding again corrupts URLs with a
    // literal % (throws) and double-unescapes, so use the value as-is.
    return new URL(h).searchParams.get('uddg') ?? h
  } catch {
    return h
  }
}

/** Brave HTML SERP — GET works keyless. The primary result anchor carries a
 *  class ending in " l1"; its text is the title. Brave's markup uses hashed
 *  Svelte classes, so we anchor on the stable ` l1` suffix + href only. */
async function brave(query: string, count: number): Promise<WebSearchResult[]> {
  const html = await fetchText(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`)
  if (/g-recaptcha|captcha-container|\/challenge/i.test(html)) throw new Error('brave bot-check')
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bl1"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && results.length < count) {
    const url = decodeEntities(m[1])
    const title = stripTags(m[2])
    if (!title || url.includes('search.brave.com') || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, content: '' })
  }
  return results
}

/**
 * Run a keyless search: try engines in order, first non-empty result set wins.
 * Throws only when every engine failed or returned nothing — the tool surfaces it.
 */
export async function keylessWebSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
  const baseQuery = (opts.query ?? '').trim()
  if (!baseQuery) throw new Error('query is required')
  const query = opts.site ? `${baseQuery} site:${opts.site}` : baseQuery
  const count = Math.min(Math.max(opts.count ?? 5, 1), 10)

  const errors: string[] = []
  const attempt = (id: string, run: () => Promise<WebSearchResult[]>): Promise<WebSearchResponse> =>
    run()
      .then((results) => {
        if (!results.length) throw new Error('no results')
        return { query, provider: `keyless:${id}`, results }
      })
      .catch((e) => {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      })

  // 1. Reliable independent primary ALONE — one request when it works, and it keeps
  //    the flakier scrapers unused/fresh for when it doesn't.
  try {
    return await attempt('mojeek', () => mojeek(query, count))
  } catch {
    /* fall through */
  }
  // 2. Primary down → RACE the two fallbacks (first non-empty wins) so the worst case
  //    is one timeout, not three in series.
  try {
    return await Promise.any([
      attempt('duckduckgo', () => ddgLite(query, count)),
      attempt('brave', () => brave(query, count)),
    ])
  } catch {
    /* AggregateError — both fallbacks failed */
  }
  throw new Error(
    `Keyless web search returned no results (${errors.join('; ') || 'all engines empty'}). ` +
      'Add TAVILY_API_KEY or use a model with native search for reliable results.',
  )
}
