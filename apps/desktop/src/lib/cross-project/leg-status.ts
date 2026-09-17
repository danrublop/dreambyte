/**
 * Pure leg-status logic for the cross-project run view. Kept free of React AND
 * of any server/orchestration import (no agent-runner / DB deps) so the renderer
 * can use it and it stays unit-testable — the tricky cases (fast-fail legs stuck
 * "Running…", error-then-stream-end) are covered by tests here.
 */

export type LegStatus = 'running' | 'done' | 'error'
export interface LegState {
  status: LegStatus
  error?: string
}

/** A leg outcome as returned by dispatchProjects (the authoritative initial set). */
export interface LegOutcome {
  targetProjectId: string
  status: string // 'started' | 'unreadable' | 'slot-busy' | 'aborted'
}

/**
 * Seed per-leg UI state from the dispatch outcomes. A 'started' leg is running
 * (live events will move it to done/error); anything else (slot-busy / unreadable
 * / aborted) failed before/at dispatch and emits no further events, so it must
 * start as error — otherwise it shows "Running…" forever (the events that would
 * mark it fire before the run view subscribes).
 */
export function seedLegStatuses(outcomes: LegOutcome[]): Record<string, LegState> {
  return Object.fromEntries(
    outcomes.map((o) => [
      o.targetProjectId,
      o.status === 'started' ? { status: 'running' as LegStatus } : { status: 'error' as LegStatus, error: o.status },
    ]),
  )
}

/**
 * Fold a tagged leg event into the status map. `__stream_end__` → done (unless an
 * error already marked it); `error` → error. Anything else is ignored (transcript
 * tokens etc.). Returns the same reference when nothing changes.
 */
export function applyLegEvent(
  prev: Record<string, LegState>,
  targetProjectId: string,
  eventType: string | undefined,
  error?: string,
): Record<string, LegState> {
  const cur = prev[targetProjectId] ?? { status: 'running' as LegStatus }
  if (eventType === '__stream_end__') {
    return { ...prev, [targetProjectId]: { ...cur, status: cur.status === 'error' ? 'error' : 'done' } }
  }
  if (eventType === 'error') {
    return { ...prev, [targetProjectId]: { status: 'error', error } }
  }
  return prev
}
