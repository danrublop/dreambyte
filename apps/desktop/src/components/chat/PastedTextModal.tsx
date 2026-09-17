'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Preview + edit a pasted-text chip's content (Claude-style: a big paste becomes
 * a chip instead of flooding the composer; click it to read/edit the full text).
 * A plain centered overlay with a textarea — Save writes back to the chip, Cancel
 * discards edits. Esc cancels, ⌘/Ctrl+Enter saves.
 */
export function PastedTextModal({
  text,
  onSave,
  onClose,
  readOnly = false,
}: {
  text: string
  onSave?: (next: string) => void
  onClose: () => void
  /** View-only mode for an already-sent message: no editing, no Save button. */
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState(text)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const save = () => onSave?.(draft)

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        if (!readOnly && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
      }}
    >
      <div
        className="flex w-full max-w-2xl max-h-[80vh] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            Pasted text <span className="text-[var(--color-text-muted)]">· {draft.length.toLocaleString()} chars</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          className="flex-1 min-h-[40vh] resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-text-primary)] focus:outline-none scrollbar-hide whitespace-pre-wrap break-words"
        />
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-[#141820] hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
