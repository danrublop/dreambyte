'use client'

/**
 * Cross-Project Picker. Opens when an agent run ends by calling
 * dispatch_to_projects (AgentChat stashes the instruction + origin body and calls
 * openCrossProjectPicker). The user picks WHICH of their other projects the
 * instruction applies to — cross-project edits modify other projects, so the user
 * confirms targets — then we fire dreambyte:agent.dispatchProjects and open the run
 * view. Each target runs fully isolated under its own settings (the main-process
 * orchestration resolves each leg from the target's own row).
 */

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'

export default function CrossProjectPickerModal() {
  const picker = useVideoStore((s) => s.crossProjectPicker)
  const close = useVideoStore((s) => s.closeCrossProjectPicker)
  const setCrossProjectRun = useVideoStore((s) => s.setCrossProjectRun)
  const projectList = useVideoStore((s) => s.projectList)
  const fetchProjectList = useVideoStore((s) => s.fetchProjectList)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!picker) return
    setSelected(new Set())
    setError(null)
    fetchProjectList?.()
  }, [picker, fetchProjectList])

  const originProjectId =
    typeof picker?.originBody?.projectId === 'string' ? (picker.originBody.projectId as string) : null

  // Targets = the user's other projects (never the origin — that's the identity
  // case the orchestrator drops anyway).
  const targets = useMemo(
    () => (projectList ?? []).filter((p) => p.id !== originProjectId),
    [projectList, originProjectId],
  )

  if (!picker) return null

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function dispatch() {
    if (dispatching || selected.size === 0 || !picker) return
    setDispatching(true)
    setError(null)
    try {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.agent : undefined
      if (!ipc?.dispatchProjects) throw new Error('Cross-project dispatch is unavailable in this build.')
      const res = await ipc.dispatchProjects({
        originBody: picker.originBody,
        targets: [...selected],
        instruction: picker.instruction,
        // Split the group's run budget across the legs (matches the branch
        // fan-out path). Without this each leg keeps the origin's full
        // runBudgetUsd, so N targets cost N× — up to MAX_DISPATCH_TARGETS×, or
        // unbounded when the user's run budget is null.
        groupBudgetUsd: useVideoStore.getState().runBudgetUsd ?? null,
      })
      // Seed the run view from the authoritative outcomes (post dedupe +
      // exclude-origin) — a leg that fails fast (slot-busy/unreadable) emits its
      // error before the run view subscribes, so live events alone aren't enough.
      setCrossProjectRun({ groupId: res.groupId, instruction: picker.instruction, outcomes: res.outcomes })
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  return (
    <Overlay onDismiss={close}>
      <Panel
        onClose={close}
        title="Apply across projects"
        subtitle={`“${picker.instruction.slice(0, 120)}” — pick the projects to apply this to. Each runs independently under its own settings.`}
      >
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {targets.length === 0 ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-text-muted)]">
              No other projects to dispatch to.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {targets.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="truncate text-[13px] text-[var(--color-text-primary)]" title={p.name || p.id}>
                      {p.name || p.id.slice(0, 8)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && <div className="px-4 py-2 text-[12px] text-red-400">{error}</div>}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2">
          <button
            type="button"
            onClick={close}
            className="no-style rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={dispatch}
            disabled={dispatching || selected.size === 0}
            className="no-style rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dispatching ? 'Dispatching…' : `Dispatch to ${selected.size} project${selected.size === 1 ? '' : 's'}`}
          </button>
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
      className="flex h-full max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
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
      {children}
    </div>
  )
}
