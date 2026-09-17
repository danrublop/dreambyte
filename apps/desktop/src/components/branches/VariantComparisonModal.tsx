'use client'

/**
 * Variant Comparison Modal (v0.3.9).
 *
 * Opens from the GitBranchesPanel after a multi-variant spawn completes.
 * Renders a CSS grid of BranchPreviewPlayer tiles — one per variant
 * branch — so the user can scrub and compare the takes side by side.
 * Clicking "Use this" on a tile switches the editor to that branch
 * (via the existing switchProjectBranch action) and closes the modal.
 *
 * v1 keeps each tile independent — no synced transport. Each player
 * has its own play/pause + scrubber. Synced playback is a v0.3.10+
 * surface (would require lifting BranchPreviewPlayer's playback state
 * to a controlled mode).
 *
 * Layout: auto-fit CSS grid with min tile width — adapts cleanly from
 * 2 variants (side by side) to 4 (2x2) without per-count special cases.
 *
 * The modal follows the NewProjectModal pattern: fixed overlay with
 * click-outside-to-dismiss, centered inner panel, z-index 9999.
 */

import { useEffect, useMemo, useState } from 'react'
import { X, ArrowRight } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import BranchPreviewPlayer from './BranchPreviewPlayer'
import type { BranchRecord } from '@/types/dreambyte-api'

export default function VariantComparisonModal() {
  const isOpen = useVideoStore((s) => s.isVariantComparisonOpen)
  const close = useVideoStore((s) => s.closeVariantComparison)
  const spawn = useVideoStore((s) => s.lastVariantsSpawn)
  const projectId = useVideoStore((s) => s.project?.id)
  const switchProjectBranch = useVideoStore((s) => s.switchProjectBranch)
  const setLastVariantsSpawn = useVideoStore((s) => s.setLastVariantsSpawn)
  const promoteBranch = useVideoStore((s) => s.promoteBranch)

  const [branchRecords, setBranchRecords] = useState<Map<string, BranchRecord>>(new Map())
  const [switching, setSwitching] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)

  // Lazy-load branch metadata so we can show names on each tile. The
  // BranchPreviewPlayer already loads scenes via IPC; we just need the
  // branch record for the display name.
  useEffect(() => {
    if (!isOpen || !projectId || !spawn) return
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
    if (!ipc) return
    let cancelled = false
    ;(async () => {
      try {
        const { branches } = await ipc.list({ projectId })
        if (cancelled) return
        const map = new Map<string, BranchRecord>()
        for (const b of branches as BranchRecord[]) map.set(b.id, b)
        setBranchRecords(map)
      } catch {
        // Non-fatal — tiles fall back to displaying the id substring.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen, projectId, spawn])

  // Stable branch id list — avoids re-rendering the players on every
  // unrelated store update.
  const branchIds = useMemo(() => spawn?.branchIds ?? [], [spawn])

  if (!isOpen) return null
  // Defensive: project unloaded mid-session, modal stranded. Close so the
  // user can recover by re-opening from the (now-empty) branch selector.
  if (!projectId) {
    close()
    return null
  }
  if (!spawn || branchIds.length === 0) {
    // Modal opened but no variants present — render a placeholder so
    // the user doesn't see a flash of nothing. They can dismiss to
    // recover.
    return (
      <Overlay onDismiss={close}>
        <Panel onClose={close} title="Compare variants">
          <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-text-muted)]">
            No recent variant spawn to compare. Run an agent with the variants picker set to 2 or more.
          </div>
        </Panel>
      </Overlay>
    )
  }

  async function handleUseThisBranch(branchId: string) {
    if (switching) return
    setSwitching(branchId)
    try {
      await switchProjectBranch(branchId)
      // switchProjectBranch can silently return without switching if a
      // branch operation is already in flight. Verify the active branch
      // actually changed before clearing the spawn — otherwise the user
      // would think they picked a winner but the editor stays on the
      // source branch with no comparison context to recover.
      const switched = useVideoStore.getState().projectActiveBranchId === branchId
      if (switched) {
        setLastVariantsSpawn(null)
        close()
      }
      // If the switch was rejected, leave the modal open and the spawn
      // intact so the user can retry. The "Switching..." label clears
      // via the finally below.
    } finally {
      setSwitching(null)
    }
  }

  // Promote a winner onto main: clones its content onto the default
  // branch via an inverse-able action and discards the other variants. The store
  // clears the spawn + closes the comparison on success.
  async function handlePromote(branchId: string) {
    if (promoting || switching) return
    setPromoting(branchId)
    try {
      // Discard the WHOLE variant set after promoting: the winner's content now
      // lives on main, so its own branch is a redundant duplicate too. promoteBranch
      // reads the winner's scenes before discarding and never deletes the target.
      await promoteBranch(branchId, null, { discardBranchIds: branchIds })
      if (useVideoStore.getState().isVariantComparisonOpen) close()
    } finally {
      setPromoting(null)
    }
  }

  return (
    <Overlay onDismiss={close}>
      <Panel
        onClose={close}
        title={`Compare ${branchIds.length} variants`}
        subtitle="Use this = switch the editor to that variant (keeps all branches). Promote to main = make it the winner: replace main's content with this take and discard the others (undoable with Cmd+Z)."
      >
        <div
          className="grid gap-3 p-3"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
            gridAutoRows: 'minmax(320px, 1fr)',
            height: 'calc(100% - 0px)',
            overflow: 'auto',
          }}
        >
          {branchIds.map((branchId) => {
            const branch = branchRecords.get(branchId)
            const displayName = branch?.name ?? branchId.slice(0, 8)
            const isSwitching = switching === branchId
            return (
              <div
                key={branchId}
                className="relative flex flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]"
              >
                <div className="min-h-0 flex-1">
                  <BranchPreviewPlayer projectId={projectId!} branchId={branchId} branch={branch} />
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                  <span
                    className="truncate text-[12px] font-medium text-[var(--color-text-primary)]"
                    title={displayName}
                  >
                    {displayName}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleUseThisBranch(branchId)}
                      disabled={!!switching || !!promoting}
                      title="Switch the editor to this variant's branch (keeps all branches)"
                      className="no-style flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSwitching ? 'Switching...' : 'Use this'}
                      {!isSwitching && <ArrowRight size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePromote(branchId)}
                      disabled={!!switching || !!promoting}
                      title="Make this the winner: replace main's content with this take and discard the others (undoable)"
                      className="no-style flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {promoting === branchId ? 'Promoting...' : 'Promote to main'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Panel>
    </Overlay>
  )
}

function Overlay({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4 py-6" onClick={onDismiss}>
      {children}
    </div>
  )
}

function Panel({
  children,
  onClose,
  title,
  subtitle,
}: {
  children: React.ReactNode
  onClose: () => void
  title: string
  subtitle?: string
}) {
  return (
    <div
      className="flex h-full max-h-[92vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
          {subtitle && <span className="text-[11px] text-[var(--color-text-muted)]">{subtitle}</span>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="no-style rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.05]"
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
