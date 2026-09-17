'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Confirm dialog for the conversation-rewind actions. Edit and
 * Regenerate both remove every message after a point; this states the
 * conversation-only contract explicitly:
 *
 *   - messages after this point will be removed
 *   - project changes those messages made are KEPT
 *   - the agent reruns against CURRENT project state
 *
 * The "Create a branch first" secondary action snapshots project state onto a
 * new branch (the existing branch-create flow) and then proceeds.
 *
 * Checkpoint-coupled rewind: when a pre-run project snapshot exists for the
 * run being removed (`canRestore`), an opt-in checkbox rolls the project back to
 * its state BEFORE that run, so the rerun acts on the pre-run state — a true
 * rewind, not just a transcript trim. `onConfirm` carries the checkbox state.
 */
export function RewindConfirmDialog({
  kind,
  canRestore = false,
  onConfirm,
  onCreateBranchFirst,
  onCancel,
}: {
  kind: 'edit' | 'regenerate'
  canRestore?: boolean
  onConfirm: (opts: { restore: boolean }) => void
  onCreateBranchFirst: () => Promise<void> | void
  onCancel: () => void
}) {
  const [branching, setBranching] = useState(false)
  const [restore, setRestore] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const title = kind === 'edit' ? 'Revert to this point and rerun?' : 'Regenerate from here?'

  // Keyboard parity with the sibling modals (CommandPalette, ShortcutsHelpModal):
  // Escape cancels (unless the branch-create is in flight), and initial focus
  // lands on the safest action so focus isn't stranded behind the scrim.
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !branching) {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [branching, onCancel])

  const handleBranchFirst = async () => {
    setBranching(true)
    try {
      await onCreateBranchFirst()
      onConfirm({ restore })
    } finally {
      setBranching(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">{title}</h2>
        {restore ? (
          <p className="mb-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Messages after this point will be removed and the project will be{' '}
            <span className="text-[var(--color-text-primary)]">rolled back</span> to its state before that run — the
            agent reruns against the restored state.
          </p>
        ) : (
          <p className="mb-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Messages after this point will be removed. Project changes those messages made are{' '}
            <span className="text-[var(--color-text-primary)]">kept</span> — the agent reruns against the current
            project state.
          </p>
        )}
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          To preserve the current state, create a branch first.
        </p>
        {canRestore && (
          <label className="mb-4 flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={restore}
              disabled={branching}
              onChange={(e) => setRestore(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span>
              Also restore the project to its state before this point (undoes the scene changes the removed run made;
              reversible with undo).
            </span>
          </label>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={branching}
            className="rounded px-2.5 py-1 text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleBranchFirst}
            disabled={branching}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-border)]/30 disabled:opacity-50"
          >
            {branching ? 'Creating branch…' : 'Create a branch first'}
          </button>
          <button
            onClick={() => onConfirm({ restore })}
            disabled={branching}
            className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-[12px] text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {restore
              ? kind === 'edit'
                ? 'Edit, restore and rerun'
                : 'Restore and regenerate'
              : kind === 'edit'
                ? 'Edit and rerun'
                : 'Regenerate'}
          </button>
        </div>
      </div>
    </div>
  )
}
