'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import type { ResearchSource } from '@/lib/agents/types'

const PROVIDER_LABEL: Record<ResearchSource['provider'], string> = {
  anthropic: 'Claude web search',
  openai: 'OpenAI web search',
  google: 'Google grounding',
}

function faviconUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl)
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
  } catch {
    return null
  }
}

function hostname(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '')
  } catch {
    return pageUrl
  }
}

export function SourcesBlock({ sources }: { sources: ResearchSource[] }) {
  const [expanded, setExpanded] = useState(false)
  const unique = useMemo(() => {
    const seen = new Set<string>()
    const out: ResearchSource[] = []
    for (const s of sources) {
      if (!s?.url || seen.has(s.url)) continue
      seen.add(s.url)
      out.push(s)
    }
    return out
  }, [sources])

  if (unique.length === 0) return null

  const provider = unique[0]?.provider
  const providerLabel = provider ? PROVIDER_LABEL[provider] : 'Sources'

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-[12px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      >
        <span className="flex items-center gap-2">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>
            {unique.length} source{unique.length === 1 ? '' : 's'}
          </span>
          <span className="text-[var(--color-text-muted)]">· {providerLabel}</span>
        </span>
      </button>
      {expanded && (
        <ul className="flex flex-col divide-y divide-[var(--color-border-subtle)] border-t border-[var(--color-border-subtle)]">
          {unique.map((s, i) => {
            const fav = faviconUrl(s.url)
            return (
              <li key={`${s.url}-${i}`}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group flex items-start gap-2 px-3 py-2 hover:bg-[var(--color-bg-tertiary)]"
                >
                  {fav ? (
                    <img src={fav} alt="" width={14} height={14} className="mt-[2px] rounded-sm opacity-80" />
                  ) : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-[var(--color-text-primary)]">
                      {s.title || hostname(s.url)}
                    </span>
                    <span className="truncate text-[var(--color-text-muted)]">{hostname(s.url)}</span>
                    {s.snippet ? (
                      <span className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text-secondary)]">
                        {s.snippet}
                      </span>
                    ) : null}
                  </span>
                  <ExternalLink
                    size={12}
                    className="mt-[3px] flex-none text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
