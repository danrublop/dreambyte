'use client'

import { useState } from 'react'
import { Ban, ChevronDown, ChevronRight, XCircle } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agents/types'
import { prettyToolLabel } from './tool-name'
import { ToolSourcesList } from './ToolSourcesList'

/**
 * Compact tool-call row used in the agent transcript (both completed messages
 * and the live StreamingMessage leaf). Collapsed by default: one-line label +
 * optional error/duration; expands on click to show input/output JSON.
 *
 * Distinct from `ToolCallItem` in this folder, which adds a Done badge and a
 * summary line — this is the leaner variant AgentChat has always used.
 */
export function CompactToolCall({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false)
  // A user Stop is not an error — render aborted tools as a neutral
  // "Cancelled" instead of the red crash badge (trust UX: Stop should never
  // look like things broke).
  const isAborted = !!call.output && !call.output.success && call.output.aborted === true
  const isError = !!call.output && !call.output.success && !isAborted
  const displayName = prettyToolLabel(call.toolName)

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      <span
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] transition-colors cursor-pointer select-none"
      >
        <span className="text-[var(--color-text-primary)] flex-1 truncate">{displayName}</span>
        {isAborted && (
          <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
            <Ban size={10} />
            <span className="text-[11px]">Cancelled</span>
          </span>
        )}
        {isError && (
          <span className="flex items-center gap-1 text-red-400">
            <XCircle size={10} />
            <span className="text-[11px]">Error</span>
          </span>
        )}
        {call.durationMs !== undefined && (
          <span className="text-[var(--color-text-muted)] text-[11px]">
            {call.durationMs > 1000 ? `${(call.durationMs / 1000).toFixed(1)}s` : `${call.durationMs}ms`}
          </span>
        )}
        {open ? (
          <ChevronDown size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        )}
      </span>
      {/* Collapsed error reason. The header badge said only "Error"
          with no WHY — a user had to expand every failed tool to learn what broke.
          Fold the one-line reason (output.error) in when collapsed, mirroring
          ToolCallItem's summary line. */}
      {!open && isError && call.output?.error && (
        <div className="px-2.5 pb-1.5 -mt-0.5 text-[11px] text-red-400/80 truncate">{call.output.error}</div>
      )}
      {/* Pulled media is surfaced at the activity-segment level (always visible
          even when this card is collapsed) — see ActivitySegment. */}
      {/* Pulled web sources (DeepSeek/SearXNG/local search + url fetch). */}
      <ToolSourcesList call={call} />
      {open && (
        <div className="px-2.5 pb-2 space-y-1.5 border-t border-[var(--color-border)]">
          {call.codeDiff && (
            <div>
              <div className="text-[var(--color-text-muted)] text-[10px] mb-0.5 mt-1.5 uppercase tracking-wide flex items-center gap-2">
                <span>Diff · {call.codeDiff.label}</span>
                <span className="normal-case tracking-normal">
                  <span className="text-emerald-400/80">+{call.codeDiff.added}</span>{' '}
                  <span className="text-red-400/80">−{call.codeDiff.removed}</span>
                </span>
              </div>
              {/* div container, not <pre>: block children inside <pre> are invalid HTML */}
              {call.codeDiff.lines.length > 0 ? (
                <div className="text-[11px] whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto bg-[var(--color-panel)] rounded p-1.5">
                  {call.codeDiff.lines.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.type === 'add'
                          ? 'text-emerald-400/90 bg-emerald-400/10'
                          : l.type === 'del'
                            ? 'text-red-400/90 bg-red-400/10'
                            : 'text-[var(--color-text-muted)]'
                      }
                    >
                      {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : l.type === 'gap' ? '' : '  '}
                      {l.text}
                    </div>
                  ))}
                  {call.codeDiff.truncated && (
                    <div className="text-[var(--color-text-muted)] italic">… diff truncated</div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)] italic bg-[var(--color-panel)] rounded p-1.5">
                  Rewrote {call.codeDiff.label} ({call.codeDiff.removed} → {call.codeDiff.added} lines)
                </div>
              )}
            </div>
          )}
          <div>
            <div className="text-[var(--color-text-muted)] text-[10px] mb-0.5 mt-1.5 uppercase tracking-wide">
              Input
            </div>
            <pre className="text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono overflow-x-auto max-h-28 bg-[var(--color-panel)] rounded p-1.5">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {call.output && (
            <div>
              <div className="text-[var(--color-text-muted)] text-[10px] mb-0.5 uppercase tracking-wide">Output</div>
              <pre
                className={`text-[11px] whitespace-pre-wrap font-mono overflow-x-auto max-h-28 bg-[var(--color-panel)] rounded p-1.5 ${
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
