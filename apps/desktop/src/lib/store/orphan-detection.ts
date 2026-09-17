/**
 * Orphan classification for streaming chat rows.
 *
 * On conversation load a row left in `status='streaming'` is either still being
 * produced by a live run, or it was abandoned (a crash/quit/abort that never
 * wrote `complete`/`aborted`). With `messages.run_id` now persisted (migration
 * 0025) we can classify precisely:
 *
 *   - runId present + in activeRunIds()  → NOT orphaned (its run is live).
 *   - runId present + NOT in activeRunIds() → orphaned (its run is gone).
 *   - runId NULL (legacy rows, or writes that predate this column) → fall back
 *     to the conservative behavior: orphaned only when there is no active
 *     run AND the row is past the recency grace, so a freshly-started message in
 *     an active run isn't false-positively reclassified.
 *
 * Pure + framework-free so the decision is unit-testable in isolation. The store
 * (switchConversation) supplies the inputs and wires the DB side effects.
 */

export interface OrphanRowInput {
  status?: string | null
  /** The run that produced this row, when known (migration 0025). */
  runId?: string | null
  /** Row creation time in ms epoch (for the legacy recency grace). 0/undefined = unknown. */
  createdAtMs?: number | null
}

export interface OrphanContext {
  /** runIds the main process reports as currently in flight. */
  activeRunIds: Set<string>
  /** Whether ANY run is active — the legacy fallback signal for NULL-runId rows. */
  hasAnyActiveRun: boolean
  /** Recency window for the legacy fallback (ms). */
  graceMs?: number
  /** Reference "now" in ms (injectable for tests). Defaults to Date.now(). */
  nowMs?: number
}

/** Default recency grace for legacy (NULL-runId) rows. */
export const ORPHAN_GRACE_MS = 30_000

/**
 * Decide whether a single streaming row is orphaned. Non-streaming rows are
 * never orphaned by this function.
 */
export function isStreamingRowOrphaned(row: OrphanRowInput, ctx: OrphanContext): boolean {
  if (row.status !== 'streaming') return false

  // Precise path: the row knows which run owns it.
  if (row.runId) {
    return !ctx.activeRunIds.has(row.runId)
  }

  // Legacy path (NULL runId): conservative any-active-run + recency grace.
  const graceMs = ctx.graceMs ?? ORPHAN_GRACE_MS
  const now = ctx.nowMs ?? Date.now()
  const createdAt = row.createdAtMs ?? 0
  const isRecent = createdAt > 0 && now - createdAt < graceMs
  return !ctx.hasAnyActiveRun || !isRecent
}
