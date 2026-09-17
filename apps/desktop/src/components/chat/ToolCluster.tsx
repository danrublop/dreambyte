'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agents/types'
import { CompactToolCall } from './CompactToolCall'
import { prettyToolLabel } from './tool-name'

/**
 * Collapses a RUN of consecutive tool calls into a single one-line row so the
 * transcript isn't flooded — same idea as the reasoning dropdown. Collapsed by
 * default: "N steps · <last tool>" + an error badge if any failed; expands to the
 * individual CompactToolCall rows. A single tool renders bare (no cluster needed).
 * Errors stay visible on the collapsed header so a failure is never hidden.
 */
export function ToolCluster({ calls }: { calls: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false)
  if (calls.length === 0) return null
  if (calls.length === 1) return <CompactToolCall call={calls[0]} />

  const failed = calls.filter((c) => !!c.output && !c.output.success && c.output.aborted !== true).length
  const last = prettyToolLabel(calls[calls.length - 1].toolName)

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent overflow-hidden text-[12px]">
      <span
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] transition-colors cursor-pointer select-none"
      >
        {open ? (
          <ChevronDown size={12} className="text-[var(--color-text-muted)] flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-[var(--color-text-muted)] flex-shrink-0" />
        )}
        <span className="text-[var(--color-text-primary)] flex-1 truncate">
          {calls.length} steps
          {!open && <span className="text-[var(--color-text-muted)]"> · {last}</span>}
        </span>
        {failed > 0 && (
          <span className="flex items-center gap-1 text-red-400 flex-shrink-0">
            <XCircle size={11} strokeWidth={2.25} />
            {failed}
          </span>
        )}
      </span>
      {open && (
        <div className="px-2 pb-1.5 space-y-1">
          {calls.map((c, i) => (
            <CompactToolCall key={c.id ?? `tc-${i}`} call={c} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A rendered transcript chunk: a text block, a reasoning block, or a run of tool calls. */
export type RenderChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tools'; calls: ToolCallRecord[] }

/**
 * Fold an ordered list of (text | thinking | toolCall) items into chunks where
 * consecutive tool calls are grouped. A text OR thinking item breaks the tool
 * run, so a reasoning block renders inline between the tool clusters it happened
 * between. Permission-paused tools (output.permissionNeeded) are dropped — they
 * render as a permission card elsewhere. Shared by the live StreamingMessage and
 * the committed transcript so both group identically.
 */
export function groupSegments(items: Array<{ text?: string; thinking?: string; call?: ToolCallRecord }>): RenderChunk[] {
  const chunks: RenderChunk[] = []
  for (const item of items) {
    if (item.text != null) {
      chunks.push({ type: 'text', text: item.text })
      continue
    }
    if (item.thinking != null) {
      chunks.push({ type: 'thinking', text: item.thinking })
      continue
    }
    const call = item.call
    if (!call || call.output?.permissionNeeded) continue
    const last = chunks[chunks.length - 1]
    if (last && last.type === 'tools') last.calls.push(call)
    else chunks.push({ type: 'tools', calls: [call] })
  }
  return chunks
}
