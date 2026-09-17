'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agents/types'
import { ThinkingBlock } from '../ThinkingBlock'
import { ToolCluster, type RenderChunk } from './ToolCluster'
import { MediaThumbs, mediaThumbs, type MediaThumb } from './MediaThumbStrip'
import { stripMcpPrefix } from './tool-name'
import { renderMarkdown } from './render-markdown'

/** A text block, or an "activity" — a run of consecutive reasoning + tool-call chunks. */
export type Activity = { type: 'text'; text: string } | { type: 'activity'; chunks: RenderChunk[] }

/**
 * Fold rendered chunks (groupSegments output) one level up: consecutive
 * reasoning/tool chunks become ONE activity; a text reply breaks the run
 * (narrate → act → reply cadence). The trailing activity is the segment the
 * agent is currently working — the caller renders that one live.
 */
export function groupActivities(chunks: RenderChunk[]): Activity[] {
  // Only the FINAL reply — text that comes AFTER the last tool/reasoning chunk — stays
  // standalone prose. Intra-run narration (text BETWEEN tool batches) folds INTO the
  // activity, so a chatty narrate→act→confirm agent on a 119-call run collapses to ONE
  // scrolling viewport (live) / ONE summary line (done), not one box + one paragraph per
  // narration line (the flood the compact viewport was supposed to prevent).
  const lastActIdx = chunks.reduce((acc, c, i) => (c.type === 'text' ? acc : i), -1)
  const out: Activity[] = []
  chunks.forEach((c, i) => {
    if (c.type === 'text' && i > lastActIdx) {
      out.push({ type: 'text', text: c.text })
      return
    }
    const last = out[out.length - 1]
    if (last && last.type === 'activity') last.chunks.push(c)
    else out.push({ type: 'activity', chunks: [c] })
  })
  return out
}

function activityCalls(chunks: RenderChunk[]): ToolCallRecord[] {
  return chunks.flatMap((c) => (c.type === 'tools' ? c.calls : []))
}

/**
 * One-line summary of a completed activity: reasoning presence + total tool-call
 * count + a couple of notable tool counts (web searches, generated images) —
 * e.g. "Reasoned · 27 tool calls · 12 web searches". Pure — see
 * ActivitySegment.test.ts.
 */
export function summarizeActivity(chunks: RenderChunk[]): string {
  const calls = activityCalls(chunks)
  const parts: string[] = []
  if (chunks.some((c) => c.type === 'thinking')) parts.push('Reasoned')
  if (calls.length) parts.push(`${calls.length} tool call${calls.length === 1 ? '' : 's'}`)
  const count = (bare: string) => calls.filter((c) => stripMcpPrefix(c.toolName) === bare).length
  const web = count('web_search')
  if (web) parts.push(`${web} web search${web === 1 ? '' : 'es'}`)
  const imgs = count('generate_image')
  if (imgs) parts.push(`${imgs} image${imgs === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'Working'
}

/** Thumbnails of every image/clip pulled anywhere in the activity (deduped, capped). */
function activityThumbs(chunks: RenderChunk[]): MediaThumb[] {
  const seen = new Set<string>()
  const out: MediaThumb[] = []
  for (const call of activityCalls(chunks)) {
    for (const t of mediaThumbs(call)) {
      if (seen.has(t.thumb)) continue
      seen.add(t.thumb)
      out.push(t)
      if (out.length >= 12) return out
    }
  }
  return out
}

function ChunkList({ chunks }: { chunks: RenderChunk[] }) {
  return (
    <>
      {chunks.map((c, i) =>
        c.type === 'thinking' ? (
          <ThinkingBlock key={`c-${i}`} thinking={c.text} />
        ) : c.type === 'tools' ? (
          <ToolCluster key={`c-${i}`} calls={c.calls} />
        ) : c.type === 'text' ? (
          // Intra-run narration folded into the activity (the final reply stays standalone).
          <div key={`c-${i}`} className="text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap">
            {renderMarkdown(c.text)}
          </div>
        ) : null,
      )}
    </>
  )
}

/**
 * One reasoning+tools activity in the transcript.
 *  - `live` (the segment the agent is currently working): a fixed-height
 *    (max-h ~220px) auto-scroll viewport that pins to the bottom as tool cards
 *    and reasoning stream in, so the run never floods the chat.
 *  - done: collapses to one summary line ("Reasoned · 27 tool calls · 12 web
 *    searches"), click-to-expand back to the full reasoning + ToolClusters.
 * Pulled/generated media renders ABOVE either state so it's always visible even
 * when the tool cards are collapsed (Task 3).
 */
export function ActivitySegment({ chunks, live }: { chunks: RenderChunk[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const thumbs = activityThumbs(chunks)
  const failed = activityCalls(chunks).filter(
    (c) => !!c.output && !c.output.success && c.output.aborted !== true,
  ).length

  // Pin the live viewport to the bottom as new content streams in. Runs every
  // render (content changes come from a parent re-render), which is exactly when
  // we want to re-pin; cheap on a 220px box.
  useEffect(() => {
    if (!live) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  if (live) {
    return (
      <div className="space-y-1.5">
        <MediaThumbs thumbs={thumbs} />
        <div
          ref={viewportRef}
          className="max-h-[220px] overflow-y-auto scrollbar-hide rounded-lg border border-[var(--color-border)] px-2 py-1.5 space-y-1.5"
        >
          <ChunkList chunks={chunks} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <MediaThumbs thumbs={thumbs} />
      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden text-[12px]">
        <span
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] transition-colors cursor-pointer select-none"
        >
          {open ? (
            <ChevronDown size={12} className="text-[var(--color-text-muted)] flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-[var(--color-text-muted)] flex-shrink-0" />
          )}
          <span className="text-[var(--color-text-primary)] flex-1 truncate">{summarizeActivity(chunks)}</span>
          {failed > 0 && (
            <span className="flex items-center gap-1 text-red-400 flex-shrink-0">
              <XCircle size={11} strokeWidth={2.25} />
              {failed}
            </span>
          )}
        </span>
        {open && (
          <div className="px-2 pb-1.5 pt-0.5 space-y-1.5 border-t border-[var(--color-border)]">
            <ChunkList chunks={chunks} />
          </div>
        )}
      </div>
    </div>
  )
}
