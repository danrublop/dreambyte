/**
 * Snapshot scheduler.
 *
 * Counts dispatched actions per (project, branch) and fires a snapshot
 * callback every `threshold` dispatches. Decoupled from the actual
 * state computation — the callback is the layer that knows how to
 * project the action_log into a JSON state blob.
 *
 * The scheduler is intentionally in-memory only. We deliberately
 * trade a counter that resets across process restarts for code
 * simplicity: missing a snapshot for a few hundred actions after a
 * crash is fine because cold load can still replay from the last
 * snapshot + the WAL replay tail. Persisting the counter would be
 * over-engineered for that benefit.
 *
 * Pure — no I/O. Tests inject `onTrigger` and assert the call pattern.
 */

const DEFAULT_THRESHOLD = 500

export interface ScheduleSnapshotArgs {
  /** Default 500 (per locked decision: snapshot every 500 actions). */
  threshold?: number
  onTrigger: (info: { projectId: string; branchId: string | null; actionId: string; count: number }) => void
}

export interface SnapshotScheduler {
  /** Called for every successful dispatch. */
  recordAction(args: { projectId: string; branchId?: string | null; actionId: string }): void
  /** Reset the counter for a (project, branch) — used after a manual snapshot. */
  reset(projectId: string, branchId?: string | null): void
  /** Returns the current count for inspection / tests. */
  getCount(projectId: string, branchId?: string | null): number
}

function key(projectId: string, branchId: string | null | undefined): string {
  return `${projectId}::${branchId ?? ''}`
}

export function createSnapshotScheduler(args: ScheduleSnapshotArgs): SnapshotScheduler {
  const threshold = args.threshold ?? DEFAULT_THRESHOLD
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`threshold must be a positive number, got ${threshold}`)
  }
  const counts = new Map<string, number>()

  return {
    recordAction({ projectId, branchId, actionId }) {
      const k = key(projectId, branchId)
      const next = (counts.get(k) ?? 0) + 1
      counts.set(k, next)
      if (next >= threshold) {
        counts.set(k, 0) // reset for the next epoch
        try {
          args.onTrigger({ projectId, branchId: branchId ?? null, actionId, count: next })
        } catch {
          // Snapshot writers fail-silently; the counter is reset either
          // way so we don't pile up triggers if the writer is broken.
        }
      }
    },
    reset(projectId, branchId) {
      counts.set(key(projectId, branchId), 0)
    },
    getCount(projectId, branchId) {
      return counts.get(key(projectId, branchId)) ?? 0
    },
  }
}
