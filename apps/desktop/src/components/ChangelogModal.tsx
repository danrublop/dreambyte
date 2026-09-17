'use client'

import { useEffect } from 'react'
import { X, Sparkles } from 'lucide-react'
import type { ChangelogEntry } from '@/lib/changelog'

/**
 * "What's new" overlay shown once per version after an update.
 * The once-per-version logic lives in src/lib/changelog.ts
 * (getPendingChangelog) + the persisted lastSeenVersion; this component only
 * renders an entry handed to it and reports dismissal.
 *
 * Reuses ShortcutsHelpModal conventions: z-[9999] scrim + z-[10000] panel,
 * Escape to close, CSS-var theming only (no hardcoded colors).
 */
export function ChangelogModal({ entry, onClose }: { entry: ChangelogEntry; onClose: () => void }) {
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
        aria-label="What's new"
        className="fixed top-1/2 left-1/2 z-[10000] flex max-h-[80vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
            <Sparkles size={14} className="text-[var(--color-accent)]" />
            What’s new
            <span className="text-[11px] font-normal text-[var(--color-text-muted)]">v{entry.version}</span>
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--color-border)]/40"
          >
            <X size={15} className="text-[var(--color-text-muted)]" />
          </button>
        </div>
        <div className="custom-scrollbar overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-5">
            {entry.sections.map((section) => (
              <section key={section.heading}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {section.heading}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {section.items.map((item, i) => (
                    <li key={i} className="flex gap-2 text-[13px] leading-snug text-[var(--color-text-primary)]">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-accent)]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
        <div className="flex justify-end border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="no-style rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </>
  )
}
