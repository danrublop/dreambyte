'use client'

/**
 * Cross-Project Run View — the SEPARATE CONSUMER. It subscribes to
 * the dedicated `dreambyte:agent.crossProjectEvent` channel (NOT `dreambyte:agent.event`)
 * and renders per-leg status. It NEVER feeds these events into the active
 * project's store — that isolation is the whole point: a leg targeting project B
 * must not mutate the active project A. Results land in each target project; the
 * user opens one to inspect.
 *
 * v1 shows per-leg status (running / done / error) + an Open button. A richer
 * per-leg transcript replay is a follow-up.
 */

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { applyLegEvent, seedLegStatuses, type LegState, type LegStatus } from '@/lib/cross-project/leg-status'

export default function CrossProjectRunView() {
  const run = useVideoStore((s) => s.crossProjectRun)
  const setRun = useVideoStore((s) => s.setCrossProjectRun)
  const projectList = useVideoStore((s) => s.projectList)
  const loadProject = useVideoStore((s) => s.loadProject)

  const [legs, setLegs] = useState<Record<string, LegState>>({})

  useEffect(() => {
    if (!run) return
    // Seed from the authoritative dispatch outcomes (pure helper, unit-tested):
    // fast-failed legs (slot-busy/unreadable/aborted) emit their status before we
    // subscribe, so live events alone would leave them "Running…" forever.
    setLegs(seedLegStatuses(run.outcomes))
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.agent : undefined
    if (!ipc?.subscribeCrossProject) return
    const unsub = ipc.subscribeCrossProject(run.groupId, (msg) => {
      const ev = msg.event as { type?: string; error?: string }
      setLegs((prev) => applyLegEvent(prev, msg.targetProjectId, ev?.type, ev?.error))
    })
    return unsub
  }, [run])

  if (!run) return null

  const nameFor = (id: string) => (projectList ?? []).find((p) => p.id === id)?.name ?? id.slice(0, 8)

  const abortAll = () => {
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.agent : undefined
    ipc?.abortCrossProject?.(run.groupId)
  }

  return (
    <Overlay onDismiss={() => setRun(null)}>
      <Panel
        onClose={() => setRun(null)}
        title="Cross-project dispatch"
        subtitle={`Applying “${run.instruction.slice(0, 100)}” to ${run.outcomes.length} project${run.outcomes.length === 1 ? '' : 's'}. Each runs in its own project — open one to see results.`}
      >
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ul className="flex flex-col gap-1">
            {run.outcomes.map((o) => {
              const id = o.targetProjectId
              const leg = legs[id] ?? { status: 'running' as LegStatus }
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] px-3 py-2"
                >
                  <span className="truncate text-[13px] text-[var(--color-text-primary)]" title={nameFor(id)}>
                    {nameFor(id)}
                  </span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={leg.status} error={leg.error} />
                    {leg.status === 'done' && (
                      <button
                        type="button"
                        onClick={() => loadProject?.(id)}
                        className="no-style rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)] hover:bg-white/[0.05]"
                      >
                        Open
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-2">
          <button
            type="button"
            onClick={abortAll}
            className="no-style rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-muted)] hover:bg-white/[0.05]"
          >
            Stop all
          </button>
          <button
            type="button"
            onClick={() => setRun(null)}
            className="no-style rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </Panel>
    </Overlay>
  )
}

function StatusBadge({ status, error }: { status: LegStatus; error?: string }) {
  const label = status === 'done' ? 'Done' : status === 'error' ? 'Error' : 'Running…'
  const color =
    status === 'done' ? 'text-green-400' : status === 'error' ? 'text-red-400' : 'text-[var(--color-text-muted)]'
  return (
    <span className={`text-[11px] ${color}`} title={error}>
      {label}
    </span>
  )
}

function Overlay({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 px-4 py-6" onClick={onDismiss}>
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
