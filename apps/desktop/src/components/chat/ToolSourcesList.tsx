'use client'

import type { ToolCallRecord } from '@/lib/agents/types'
import { stripMcpPrefix } from './tool-name'

interface WebSource {
  url: string
  title: string
}

function hostname(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

function faviconUrl(u: string): string | null {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(u).hostname}&sz=32`
  } catch {
    return null
  }
}

/** Pull the clickable web sources out of a `web_search` / `fetch_url_content`
 *  tool result so the DeepSeek/SearXNG/Kimi/local path shows real source links
 *  in the chat stream — not just a "N results" count. Native providers
 *  (Anthropic/OpenAI/Google) search server-side and surface via SourcesBlock
 *  instead, so those never reach this custom-tool path. Exported for tests. */
export function webSources(call: ToolCallRecord): WebSource[] {
  const data = call.output?.data as Record<string, unknown> | undefined
  if (!data) return []
  const bare = stripMcpPrefix(call.toolName)
  const raw: Array<{ url?: unknown; title?: unknown }> =
    bare === 'web_search' && Array.isArray(data.results)
      ? (data.results as Array<{ url?: unknown; title?: unknown }>)
      : bare === 'fetch_url_content' && typeof data.url === 'string'
        ? [{ url: data.url, title: data.title }]
        : []
  const seen = new Set<string>()
  const out: WebSource[] = []
  for (const r of raw) {
    if (typeof r.url !== 'string' || seen.has(r.url)) continue
    seen.add(r.url)
    out.push({ url: r.url, title: typeof r.title === 'string' && r.title ? r.title : hostname(r.url) })
    if (out.length >= 5) break
  }
  return out
}

/** Inline list of the web pages a search/fetch pulled. Renders nothing for
 *  other tools or empty results. Each row links to the source page. */
export function ToolSourcesList({ call }: { call: ToolCallRecord }) {
  const sources = webSources(call)
  if (sources.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5 px-2.5 pb-2 pt-0.5">
      {sources.map((s, i) => {
        const fav = faviconUrl(s.url)
        return (
          <a
            key={`${s.url}-${i}`}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {fav ? <img src={fav} alt="" width={12} height={12} className="rounded-sm opacity-80" /> : null}
            <span className="truncate">{s.title}</span>
            <span className="flex-none text-[var(--color-text-muted)]">· {hostname(s.url)}</span>
          </a>
        )
      })}
    </div>
  )
}
