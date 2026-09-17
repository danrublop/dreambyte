/**
 * Draft-sweep classifier.
 *
 * Drafts get a real DB row (status='draft') at creation. This module decides,
 * at startup, which of those drafts are provably untouched empties that should
 * be SOFT-hidden, and which already-hidden rows are old enough to hard-purge.
 *
 * Iron rules (the failure-mode contract in the plan):
 *   - SOFT-hide only a draft that is provably untouched: zero scenes AND zero
 *     messages AND a default "Untitled Project N" name AND never renamed AND
 *     never reopened. A named or scened or messaged project is NEVER swept.
 *   - HARD-purge only a row already in status='hidden' whose hiddenAt is older
 *     than the retention window (7 days). The sweep itself NEVER hard-deletes a
 *     draft directly — hiding is reversible for the whole window.
 *
 * Pure / DB-free so it is exhaustively unit-testable; the IPC layer feeds it
 * rows and applies the returned id lists.
 */

/** Default "Untitled Project N" — the auto-generated name a draft starts with.
 *  Any other name means the user renamed it (a touch). */
export const DEFAULT_PROJECT_NAME_RE = /^Untitled Project \d+$/

/** Soft-hidden drafts are purged after this long. */
export const DRAFT_PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface DraftSweepRow {
  id: string
  /** 'draft' | 'hidden' | 'ready' | 'forking' — only draft/hidden are considered. */
  status: string
  name: string
  sceneCount: number
  messageCount: number
  /** ms epoch when the row was first created. */
  createdAt: number
  /** ms epoch the project was last opened, or null/0 if never reopened. */
  lastOpenedAt: number | null
  /** ms epoch when this row was soft-hidden, or null if not hidden. */
  hiddenAt: number | null
}

export interface DraftSweepPlan {
  /** Draft ids to soft-hide (status -> 'hidden', stamp hiddenAt = now). */
  toHide: string[]
  /** Hidden ids to hard-purge (older than the retention window). */
  toPurge: string[]
}

/** Reopen grace (ms): lastOpenedAt within this of createdAt counts as the
 *  initial create-open, not a deliberate reopen. The create flow stamps
 *  lastOpenedAt == createdAt, but clock skew / rounding can nudge it a touch. */
const REOPEN_GRACE_MS = 5_000

/**
 * Is this draft a provably-untouched empty? All four conditions must hold.
 * Exported so tests (and callers) can assert the exact predicate.
 */
export function isUntouchedEmptyDraft(row: DraftSweepRow): boolean {
  if (row.status !== 'draft') return false
  if (row.sceneCount > 0) return false
  if (row.messageCount > 0) return false
  if (!DEFAULT_PROJECT_NAME_RE.test(row.name)) return false // renamed → touched
  const reopened = (row.lastOpenedAt ?? 0) - row.createdAt > REOPEN_GRACE_MS
  if (reopened) return false // deliberately reopened → touched
  return true
}

/**
 * Classify a batch of draft/hidden rows into soft-hide + hard-purge actions.
 * `now` is injectable for deterministic tests.
 */
export function planDraftSweep(rows: DraftSweepRow[], now: number = Date.now()): DraftSweepPlan {
  const toHide: string[] = []
  const toPurge: string[] = []
  for (const row of rows) {
    if (row.status === 'hidden') {
      // Hard-purge only after the full retention window has elapsed.
      if (row.hiddenAt != null && now - row.hiddenAt > DRAFT_PURGE_AFTER_MS) {
        toPurge.push(row.id)
      }
      continue
    }
    if (isUntouchedEmptyDraft(row)) {
      toHide.push(row.id)
    }
  }
  return { toHide, toPurge }
}
