'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts'

/**
 * Keyboard shortcuts help sheet. Opened by the `?` key and the
 * "Keyboard shortcuts" command-palette entry. The list is the static
 * src/lib/keyboard-shortcuts.ts module (shared with its unit test), so the sheet
 * can never advertise a shortcut that isn't actually wired.
 *
 * Reuses the CommandPalette/BranchPickerModal modal conventions: a z-[9999]
 * click-through scrim + a z-[10000] panel, Escape to close, existing CSS-var
 * theming only (no new colors — Lane 5 owns theme work).
 */
export function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-[9999] bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="fixed top-1/2 left-1/2 z-[10000] flex max-h-[80vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--color-border)]/40"
          >
            <X size={15} className="text-[var(--color-text-muted)]" />
          </button>
        </div>
        <div className="custom-scrollbar overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            {KEYBOARD_SHORTCUTS.map((group) => (
              <section key={group.area}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {group.area}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {group.shortcuts.map((sc) => (
                    <li key={sc.label} className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-[var(--color-text-primary)]">{sc.label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {sc.keys.map((k, i) => (
                          <kbd
                            key={i}
                            className="min-w-[20px] rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-center text-[11px] font-medium text-[var(--color-text-muted)]"
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
