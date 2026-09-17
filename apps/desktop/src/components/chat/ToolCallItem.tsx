'use client'

import { useState } from 'react'
import { Ban, ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agents/types'
import { stripMcpPrefix, prettyToolLabel } from './tool-name'
import { MediaThumbStrip } from './MediaThumbStrip'
import { ToolSourcesList } from './ToolSourcesList'

/** Extract a human-readable one-line summary from tool output */
function summarizeOutput(call: ToolCallRecord): string | null {
  const output = call.output
  if (!output) return null

  const changes = output.changes
  if (changes && Array.isArray(changes) && changes.length > 0) {
    return changes
      .map((c: { description?: string }) => c.description)
      .filter(Boolean)
      .join('; ')
  }

  if (output.error) return output.error

  // For specific tools, extract key details from the data field.
  // stripMcpPrefix normalizes `mcp__dreambyte__foo` → `foo` so CC + API
  // paths share the same dispatch.
  const data = output.data as Record<string, unknown> | undefined
  if (!data) return null
  const bare = stripMcpPrefix(call.toolName)

  if (bare === 'verify_scene' && data.checks) {
    const issues = (data.issues as unknown[])?.length ?? 0
    return issues > 0 ? `${issues} issue(s) found` : 'All checks passed'
  }

  if (bare === 'plan_scenes' && data.sceneCount) {
    return `Planned ${data.sceneCount} scene(s)`
  }

  if (bare === 'web_search' && Array.isArray(data.results)) {
    const n = data.results.length
    const q = typeof data.query === 'string' ? ` "${data.query}"` : ''
    return `${n} result${n === 1 ? '' : 's'}${q}`
  }

  if (bare === 'fetch_url_content') {
    const title = typeof data.title === 'string' ? data.title : ''
    const words = typeof data.wordCount === 'number' ? data.wordCount : 0
    if (title) return `${title.slice(0, 70)}${title.length > 70 ? '…' : ''} · ${words} words`
    if (words > 0) return `${words} words`
  }

  // find_media(kind) replaced the three find_stock_* / find_archival_footage tools; the
  // result shapes stayed distinct, so the summary still varies by kind.
  if (bare === 'find_media' && Array.isArray(data.results)) {
    const n = data.results.length
    const kind = typeof data.kind === 'string' ? data.kind : ''
    const prov = typeof data.provider === 'string' ? data.provider : ''
    if (kind === 'archival' || prov.includes('+')) {
      const sources = prov ? ` · ${prov.split('+').length} sources` : ''
      return `${n} item${n === 1 ? '' : 's'}${sources}`
    }
    const noun = kind === 'video' ? 'clip' : 'photo'
    return `${n} ${noun}${n === 1 ? '' : 's'}${prov ? ` · ${prov}` : ''}`
  }

  return null
}

export interface ToolCallItemProps {
  call: ToolCallRecord
}

export function ToolCallItem({ call }: ToolCallItemProps) {
  const [open, setOpen] = useState(false)
  const displayName = prettyToolLabel(call.toolName)
  const isSuccess = call.output?.success
  // A user Stop renders as neutral "Cancelled", not a red error (trust UX).
  const isAborted = !!call.output && !call.output.success && call.output.aborted === true
  const isError = !!call.output && !call.output.success && !isAborted
  const summary = summarizeOutput(call)

  return (
    <div className="mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden text-[12px]">
      <span
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-[var(--color-border)]/20 transition-colors cursor-pointer select-none"
      >
        <span className="text-[var(--color-text-primary)] flex-1 truncate">{displayName}</span>
        {isSuccess && (
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle2 size={11} />
            <span className="text-[11px]">Done</span>
          </span>
        )}
        {isAborted && (
          <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
            <Ban size={11} />
            <span className="text-[11px]">Cancelled</span>
          </span>
        )}
        {isError && (
          <span className="flex items-center gap-1 text-red-400">
            <XCircle size={11} />
            <span className="text-[11px]">Error</span>
          </span>
        )}
        {call.durationMs !== undefined && (
          <span className="text-[var(--color-text-muted)] text-[11px]">{call.durationMs}ms</span>
        )}
        {open ? (
          <ChevronDown size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        )}
      </span>

      {/* One-line summary (shown when collapsed) */}
      {!open && summary && (
        <div className="px-2.5 pb-1.5 -mt-0.5 text-[11px] text-[var(--color-text-muted)] truncate">{summary}</div>
      )}

      {/* Pulled media — thumbnails of the images/clips this search found, shown
          inline in the chat stream. Each links to its source page. */}
      <MediaThumbStrip call={call} />
      {/* Pulled web sources (DeepSeek/SearXNG/local search + url fetch). */}
      <ToolSourcesList call={call} />

      {open && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-[var(--color-border)]">
          <div>
            <div className="text-[var(--color-text-muted)] text-[11px] mb-0.5 mt-1.5 uppercase tracking-wide">
              Input
            </div>
            <pre className="text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono overflow-x-auto max-h-32 bg-[var(--color-panel)] rounded p-1.5">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {call.output && (
            <div>
              <div className="text-[var(--color-text-muted)] text-[11px] mb-0.5 uppercase tracking-wide">Output</div>
              <pre
                className={`text-[11px] whitespace-pre-wrap font-mono overflow-x-auto max-h-32 bg-[var(--color-panel)] rounded p-1.5 ${
                  call.output.success ? 'text-emerald-400/80' : 'text-red-400/80'
                }`}
              >
                {call.output.error
                  ? call.output.error
                  : JSON.stringify({ success: call.output.success, changes: call.output.changes }, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
