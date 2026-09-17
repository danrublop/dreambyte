'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Scissors, X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { computeSurvivingCuts } from '@/lib/agents/structural-cuts'
import type { StructuralCut } from '@/lib/agents/types'

/**
 * Structural-cuts review card (Gap 3.1).
 *
 * The post-build cut review proposes whole-scene-redundancy cuts; this card lets
 * the user approve a subset. The agent RECOMMENDS, the user disposes — nothing
 * is pre-selected, and Apply is a deliberate, modifier-gated action.
 *
 * Clones ScenePlanReviewCard's visual idiom (rounded-xl cards on dark tokens,
 * spans-not-buttons inline icons, Cancel + glowing-primary actions row).
 *
 * Decisions encoded here:
 *  - Live re-read: impact + survivors are computed from LIVE world.scenes,
 *    so a cut whose scene already changed is dropped before the user can act on
 *    a stale snapshot.
 *  - Opt-in selection: nothing checked by default; Apply disabled until >=1.
 *  - Persisted project-scoped: survives reload; cleared on apply/dismiss.
 *  - Cascade impact: each row shows how many timeline clips the cut also removes,
 *    styled as a caution when > 0 (the cascade is legible BEFORE approval).
 */

export default function StructuralCutsReviewCard() {
  const proposed = useVideoStore((s) => s.structuralCutsProposed)
  const setProposed = useVideoStore((s) => s.setStructuralCutsProposed)
  const scenes = useVideoStore((s) => s.scenes)
  const timeline = useVideoStore((s) => s.project.timeline)
  const projectId = useVideoStore((s) => s.project.id)
  const deleteScene = useVideoStore((s) => s.deleteScene)
  const saveProjectToDb = useVideoStore((s) => s.saveProjectToDb)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Live re-read: keep only cuts whose scene still exists, and compute impact
  // from the live scene + timeline. Recomputes whenever scenes/timeline change,
  // so a scene the user deleted elsewhere drops out of the card. (Edits that keep
  // the id aren't detected — no revision field; see computeSurvivingCuts.)
  const survivors = useMemo(() => computeSurvivingCuts(proposed, scenes, timeline), [proposed, scenes, timeline])

  // Prune selections that no longer point at a survivor (a selected scene
  // vanished between render and now).
  useEffect(() => {
    setSelectedIds((prev) => {
      const live = new Set(survivors.map((s) => s.cut.sceneId))
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [survivors])

  const persist = useCallback(
    (cuts: StructuralCut[] | null) => {
      if (!projectId) return
      // 0015: structuralCutsProposed is branch-scoped — persist to the active
      // branch's branch_proposals row, not the (removed) projects column.
      void useVideoStore.getState().persistBranchProposalField('structuralCutsProposed', cuts)
    },
    [projectId],
  )

  const dismiss = useCallback(() => {
    setProposed(null)
    persist(null)
  }, [setProposed, persist])

  const selectedCount = selectedIds.size
  const allSelected = survivors.length > 0 && selectedCount === survivors.length

  const apply = useCallback(async () => {
    if (selectedCount === 0) return
    // Live re-read at apply: only delete scenes that still exist right now.
    const liveIds = new Set(scenes.map((s) => s.id))
    const toCut = survivors.filter((s) => selectedIds.has(s.cut.sceneId) && liveIds.has(s.cut.sceneId))
    if (toCut.length === 0) return
    for (const s of toCut) deleteScene(s.cut.sceneId)
    // FLUSH the scene deletions to the DB *before* clearing the persisted
    // proposal. deleteScene only schedules a debounced (500ms) save, but the
    // clear below is an immediate write — without this flush, a reload inside
    // that window lands with the proposal cleared but the scenes NOT deleted,
    // reverting the cut and losing the card. Awaiting the direct save orders
    // them: deletions persist, then the clear.
    try {
      await saveProjectToDb()
    } catch {
      // Best-effort — the debounced save still fires; worst case is the
      // graceful all-vanished card on reload.
    }
    // Cut applied — clear the proposal (card unmounts) and the persisted copy.
    setProposed(null)
    persist(null)
  }, [selectedCount, scenes, survivors, selectedIds, deleteScene, saveProjectToDb, setProposed, persist])

  const toggle = useCallback((sceneId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sceneId)) next.delete(sceneId)
      else next.add(sceneId)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === survivors.length ? new Set() : new Set(survivors.map((s) => s.cut.sceneId)),
    )
  }, [survivors])

  // Keyboard: Esc / Cmd+. dismiss; Cmd+Enter apply selected. Plain Enter does
  // NOT apply — a destructive action requires the modifier.
  useEffect(() => {
    if (!proposed) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        // Don't fire a destructive cut when the user is typing in a text field
        // (e.g. Cmd+Enter to SEND a chat message). This is a window-level
        // listener, and the chat composer's Cmd+Enter doesn't stop propagation.
        const t = e.target as HTMLElement | null
        const inTextField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
        if (inTextField) return
        e.preventDefault()
        apply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [proposed, dismiss, apply])

  if (!proposed || proposed.length === 0) return null

  const modKey =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ? '⌘' : 'Ctrl'

  // State (c): every proposed scene already changed/vanished. Show a graceful
  // note, not an empty card with a live Apply button.
  if (survivors.length === 0) {
    return (
      <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent text-[12px]">
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--color-border)] rounded-t-lg text-[var(--color-text-primary)]">
          <Scissors size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
          <span className="flex-1 truncate font-medium">Suggested cuts</span>
          <button
            type="button"
            onClick={dismiss}
            title={`Dismiss (Esc or ${modKey}+.)`}
            className="no-style !min-h-0 !h-auto !p-1 !rounded-md !bg-transparent !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] inline-flex items-center transition-colors"
          >
            <X size={13} />
          </button>
        </div>
        <div className="p-2.5">
          <span className="text-[11px] text-[var(--color-text-muted)]">
            These scenes already changed — nothing to cut.
          </span>
        </div>
      </div>
    )
  }

  const ghostBtn =
    'no-style !min-h-0 !h-auto !py-1 !px-2 !rounded-md !text-[11px] !font-medium !border !border-[var(--color-border)] !bg-transparent !text-[var(--color-text-muted)] hover:!text-[var(--color-text-primary)] hover:!bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] inline-flex items-center gap-1 transition-colors'

  return (
    <div className="mt-1 rounded-lg border border-[var(--color-border)] bg-transparent text-[12px]">
      {/* Compact header — matches the generation-card aesthetic: light white
       *  outline, transparent fill, small type. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--color-border)] rounded-t-lg text-[var(--color-text-primary)]">
        <Scissors size={11} className="text-[var(--color-text-muted)] flex-shrink-0" strokeWidth={2.25} />
        <span className="flex-1 truncate font-medium">Suggested cuts</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {survivors.length} {survivors.length === 1 ? 'scene' : 'scenes'}
        </span>
      </div>

      <div className="p-2.5 space-y-2 bg-transparent">
        {/* Per-cut rows — borderless, subtle white highlight when selected. */}
        <div className="space-y-1">
          {survivors.map(({ cut, scene, position, clipImpact }) => {
            const checked = selectedIds.has(cut.sceneId)
            const name = scene.name || cut.sceneName || cut.sceneId
            // Describe what the scene IS (its own metadata), not why it was
            // flagged — the summary, else the prompt it was generated from.
            const desc = (scene.summary || scene.prompt || '').trim()
            return (
              <div
                key={cut.sceneId}
                onClick={() => toggle(cut.sceneId)}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                  checked
                    ? 'bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)]'
                    : 'hover:bg-[color-mix(in_srgb,var(--color-text-primary)_4%,transparent)]'
                }`}
              >
                <span className="cut-checkbox mt-0.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    id={`cut-cb-${cut.sceneId}`}
                    checked={checked}
                    onChange={() => toggle(cut.sceneId)}
                  />
                  <label htmlFor={`cut-cb-${cut.sceneId}`} aria-label={`Select ${name}`} />
                  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 10 10 L 90 90" strokeDasharray="113" strokeDashoffset="113" />
                    <path d="M 90 10 L 10 90" strokeDasharray="113" strokeDashoffset="113" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">{position}</span>
                    <span className="text-[12px] font-medium text-[var(--color-text-primary)] truncate">{name}</span>
                  </div>
                  {desc && (
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 break-words line-clamp-2">
                      {desc}
                    </div>
                  )}
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5">
                    <span className="text-[var(--color-text-muted)] tabular-nums">{Math.round(scene.duration)}s</span>
                    {clipImpact > 0 && (
                      <>
                        <span className="text-[var(--color-text-muted)]/40">·</span>
                        <span className="text-amber-400/80">
                          also removes {clipImpact} timeline {clipImpact === 1 ? 'clip' : 'clips'}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer — Select all on the left; Cancel (ghost) + destructive Cut
         *  primary on the right, compact like the generation card's footer. */}
        <div className="flex items-center gap-1.5 pt-1">
          <button type="button" onClick={toggleAll} className={ghostBtn}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <div className="flex-1" />
          <button type="button" onClick={dismiss} title={`Cancel (Esc or ${modKey}+.)`} className={ghostBtn}>
            Cancel
            <span className="opacity-70 text-[10px]">Esc</span>
          </button>
          {/* Intentional theme-invariant palette: this destructive CTA is a
              self-contained surface — dusty-red fill (#c27676) + near-black text
              (#1a1212) form their own legible pair regardless of page theme, so
              they are NOT swapped to --danger (a brighter, lighter-text token). */}
          <button
            type="button"
            disabled={selectedCount === 0}
            onClick={apply}
            title={`Cut selected (${modKey}+↵)`}
            className="no-style !min-h-0 !h-auto !py-1 !px-2.5 !rounded-md !text-[11px] !font-semibold !border !border-[#d99b9b]/40 !bg-[#c27676] !text-[#1a1212] hover:!bg-[#b86b6b] disabled:!cursor-not-allowed disabled:!opacity-40 inline-flex items-center gap-1.5 transition-colors"
          >
            {selectedCount === 0 ? 'Cut scenes' : `Cut ${selectedCount} ${selectedCount === 1 ? 'scene' : 'scenes'}`}
            <span
              className="inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-[#1a1212]/80"
              aria-hidden
            >
              <span>{modKey}</span>
              <span>↵</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
