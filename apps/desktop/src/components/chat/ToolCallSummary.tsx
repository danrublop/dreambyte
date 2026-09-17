'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileSearch, Search, Pencil, Terminal, Wrench } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agents/types'
import { ToolCallItem } from './ToolCallItem'

/** Categorize Claude Code tool calls for compact display */
function categorizeCalls(calls: ToolCallRecord[]) {
  const cats = {
    reads: [] as ToolCallRecord[],
    searches: [] as ToolCallRecord[],
    edits: [] as ToolCallRecord[],
    commands: [] as ToolCallRecord[],
    other: [] as ToolCallRecord[],
  }
  for (const c of calls) {
    const name = c.toolName.toLowerCase()
    if (name === 'read' || name === 'glob') cats.reads.push(c)
    else if (name === 'grep') cats.searches.push(c)
    else if (name === 'edit' || name === 'write') cats.edits.push(c)
    else if (name === 'bash') cats.commands.push(c)
    else cats.other.push(c)
  }
  return cats
}

function buildSummaryParts(cats: ReturnType<typeof categorizeCalls>): string[] {
  const parts: string[] = []
  if (cats.reads.length) parts.push(`${cats.reads.length} file${cats.reads.length > 1 ? 's' : ''} read`)
  if (cats.searches.length) parts.push(`${cats.searches.length} search${cats.searches.length > 1 ? 'es' : ''}`)
  if (cats.edits.length) parts.push(`${cats.edits.length} edit${cats.edits.length > 1 ? 's' : ''}`)
  if (cats.commands.length) parts.push(`${cats.commands.length} command${cats.commands.length > 1 ? 's' : ''}`)
  if (cats.other.length) parts.push(`${cats.other.length} tool${cats.other.length > 1 ? 's' : ''}`)
  return parts
}

export interface ToolCallSummaryProps {
  calls: ToolCallRecord[]
}

export function ToolCallSummary({ calls }: ToolCallSummaryProps) {
  const [open, setOpen] = useState(false)

  if (calls.length === 0) return null
  if (calls.length === 1) return <ToolCallItem call={calls[0]} />

  const cats = categorizeCalls(calls)
  const parts = buildSummaryParts(cats)
  const totalMs = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
  const allSucceeded = calls.every((c) => c.output?.success !== false)

  return (
    <div className="mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden text-[12px]">
      <span
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-[var(--color-border)]/20 transition-colors cursor-pointer select-none"
      >
        {open ? (
          <ChevronDown size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 text-[var(--color-text-muted)]" />
        )}

        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          {cats.reads.length > 0 && <FileSearch size={11} className="text-[var(--color-text-muted)] flex-shrink-0" />}
          {cats.searches.length > 0 && <Search size={11} className="text-[var(--color-text-muted)] flex-shrink-0" />}
          {cats.edits.length > 0 && <Pencil size={11} className="text-[var(--color-text-muted)] flex-shrink-0" />}
          {cats.commands.length > 0 && <Terminal size={11} className="text-[var(--color-text-muted)] flex-shrink-0" />}
          {cats.other.length > 0 && <Wrench size={11} className="text-[var(--color-text-muted)] flex-shrink-0" />}
          <span className="text-[var(--color-text-primary)] truncate">{parts.join(', ')}</span>
        </span>

        <span className={`flex-shrink-0 text-[11px] ${allSucceeded ? 'text-emerald-400' : 'text-amber-400'}`}>
          {calls.length} steps
        </span>
        {totalMs > 0 && (
          <span className="flex-shrink-0 text-[var(--color-text-muted)] text-[11px]">
            {totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </span>

      {open && (
        <div className="px-2 pb-2 space-y-1 border-t border-[var(--color-border)]">
          {calls.map((call) => (
            <ToolCallItem key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}
