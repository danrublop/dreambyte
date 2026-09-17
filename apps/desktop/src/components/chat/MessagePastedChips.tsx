'use client'

import { useState } from 'react'
import { FileText } from 'lucide-react'
import { PastedTextModal } from './PastedTextModal'
import type { PastedChip } from '@/lib/agents/pasted-text'

/**
 * Read-only chips for the pasted blocks of a SENT user message. The big paste
 * was inlined into the message content (so the model + persistence keep it) and
 * split back out for display by splitPastedContent — this renders each block as
 * a "Pasted text · N chars" chip; clicking opens a view-only modal. Mirrors the
 * composer's pending-paste chip so a sent paste looks the same as a pending one.
 */
export function MessagePastedChips({ chips }: { chips: PastedChip[] }) {
  const [viewing, setViewing] = useState<PastedChip | null>(null)
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 justify-end">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          title="Pasted text — click to view"
          onClick={() => setViewing(c)}
          className="flex items-center gap-1.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md pl-1.5 pr-2 py-1 shrink-0 hover:border-[var(--color-text-muted)] transition-colors"
        >
          <FileText size={11} className="text-[var(--color-text-muted)] shrink-0" />
          <span className="text-[11px] text-[var(--color-text-primary)]">
            Pasted text
            <span className="text-[var(--color-text-muted)]"> · {c.text.length.toLocaleString()} chars</span>
          </span>
        </button>
      ))}
      {viewing && <PastedTextModal text={viewing.text} readOnly onClose={() => setViewing(null)} />}
    </div>
  )
}
