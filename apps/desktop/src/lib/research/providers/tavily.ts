/**
 * Tavily web-search provider — the universal search backend.
 *
 * Tavily is purpose-built for AI agents: it returns LLM-shaped passages (title,
 * url, content snippet) plus an optional synthesized `answer`, so the agent can
 * cite sources without parsing a SERP. One key (TAVILY_API_KEY); generous free
 * tier (~1000 searches/mo, no card). This is what lets a Kimi / DeepSeek /
 * budget agent research — the app searches, the model reads the results, same
 * architecture Cursor/Cline/Windsurf use (they use Brave; we use Tavily).
 *
 * Never trusts the network blindly: bounded timeout, shape-validated results,
 * throws a clear error the agent tool surfaces.
 */
import type { WebSearchOptions, WebSearchResponse, WebSearchResult } from '../types'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const TAVILY_TIMEOUT_MS = 15_000

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error('TAVILY_API_KEY is not set — add it in Settings to enable web search.')
  return key
}

/** True when web search is usable (Tavily key configured). */
export function isTavilyReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TAVILY_API_KEY)
}

/** Recency values Tavily accepts as `time_range`. */
const VALID_TIME_RANGES: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year'])

/** Map our recency hint to Tavily's `time_range`. `recency` is model-supplied, so
 *  allow-list it rather than passing an arbitrary string into the outbound body —
 *  unrecognized values (incl. 'any') drop to undefined. */
function toTimeRange(recency: WebSearchOptions['recency']): string | undefined {
  if (!recency || !VALID_TIME_RANGES.has(recency)) return undefined
  return recency
}

export async function tavilyWebSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
  const apiKey = getApiKey()
  // Validate the base query BEFORE folding in `site:` — otherwise an empty query
  // with a site set yields a bare "site:docs.x.com" search (passes the guard,
  // wastes a credit, returns noise).
  const baseQuery = (opts.query ?? '').trim()
  if (!baseQuery) throw new Error('query is required')
  const query = opts.site ? `${baseQuery} site:${opts.site}` : baseQuery

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS)
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(opts.count ?? 5, 1), 10),
        search_depth: 'basic', // 1 credit; 'advanced' is 2 — keep cost minimal
        include_answer: true,
        ...(toTimeRange(opts.recency) ? { time_range: toTimeRange(opts.recency) } : {}),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Tavily search failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const json = (await res.json()) as {
      answer?: unknown
      results?: Array<{ title?: unknown; url?: unknown; content?: unknown; score?: unknown }>
    }
    const results: WebSearchResult[] = Array.isArray(json.results)
      ? json.results
          .filter((r) => typeof r?.url === 'string')
          .map((r) => ({
            title: typeof r.title === 'string' ? r.title : '',
            url: r.url as string,
            content: typeof r.content === 'string' ? r.content : '',
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
          }))
      : []
    return {
      query,
      provider: 'tavily',
      results,
      ...(typeof json.answer === 'string' && json.answer ? { answer: json.answer } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}
