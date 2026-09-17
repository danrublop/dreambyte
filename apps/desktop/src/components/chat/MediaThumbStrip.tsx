'use client'

import type { ToolCallRecord } from '@/lib/agents/types'
import { stripMcpPrefix } from './tool-name'

export interface MediaThumb {
  thumb: string
  href: string
  title?: string
}

const MEDIA_SEARCH_TOOLS = new Set(['find_media'])

/** Pull thumbnail + source link out of a media-search tool result so the pulled
 *  images/clips render inline in the chat stream (not just a "3 photos" count).
 *  All three tools' result items carry `thumbnailUrl` + `sourceUrl`; archival
 *  thumbnails are optional, so those items are dropped. Exported for tests. */
export function mediaThumbs(call: ToolCallRecord): MediaThumb[] {
  const data = call.output?.data as { results?: unknown } | undefined
  if (!data || !Array.isArray(data.results)) return []
  if (!MEDIA_SEARCH_TOOLS.has(stripMcpPrefix(call.toolName))) return []
  const out: MediaThumb[] = []
  for (const r of data.results as Array<Record<string, unknown>>) {
    const thumb = typeof r.thumbnailUrl === 'string' ? r.thumbnailUrl : ''
    if (!thumb) continue
    const href = typeof r.sourceUrl === 'string' ? r.sourceUrl : thumb
    const title = typeof r.title === 'string' ? r.title : typeof r.alt === 'string' ? r.alt : undefined
    out.push({ thumb, href, title })
    if (out.length >= 8) break
  }
  return out
}

/** Presentational thumbnail strip. Renders nothing for an empty list. Each thumb
 *  links to its source page (external images/links already load in the renderer —
 *  cf. favicons). Shared by the per-call strip and the segment-level strip. */
export function MediaThumbs({ thumbs }: { thumbs: MediaThumb[] }) {
  if (thumbs.length === 0) return null
  return (
    <div className="flex gap-1.5 overflow-x-auto px-2.5 pb-2 pt-0.5">
      {thumbs.map((t, i) => (
        <a
          key={`${t.thumb}-${i}`}
          href={t.href}
          target="_blank"
          rel="noreferrer noopener"
          title={t.title}
          className="flex-none overflow-hidden rounded border border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
        >
          <img src={t.thumb} alt={t.title ?? ''} loading="lazy" className="h-14 w-20 object-cover" />
        </a>
      ))}
    </div>
  )
}

/** Inline thumbnail strip of the media a single research search pulled. */
export function MediaThumbStrip({ call }: { call: ToolCallRecord }) {
  return <MediaThumbs thumbs={mediaThumbs(call)} />
}
