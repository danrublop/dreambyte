/**
 * action_log queries.
 *
 * Action persistence is async-from-the-renderer's-POV: dispatch returns once
 * the WAL is durable + the in-memory state is up-to-date; writing the row
 * to action_log happens on a microtask so we don't block undo / redo.
 *
 * The `replay` helper is used by:
 *   - boot recovery (replay any WAL entries newer than the last action_log row)
 *   - branch fork (replay the source branch's actions onto a new branch_id)
 *   - in tests (deterministic state reconstruction).
 */

import { db } from '../index'
import { actionLog } from '../schema'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'

import type { Action } from '@/lib/actions'

/** Insert one action row. Idempotent: safe to call twice with same id. */
export async function appendActionRow(
  projectId: string,
  action: Action,
  branchId: string | null = null,
): Promise<void> {
  await db
    .insert(actionLog)
    .values({
      id: action.id,
      projectId,
      branchId,
      type: action.type,
      source: action.source,
      runId: action.runId ?? null,
      version: action.version,
      params: action.params as unknown as Record<string, unknown>,
      // Inverse is generated on demand from the reducer; we don't persist it
      // here unless the reducer flagged it nondeterministic.
      inverseParams: null,
      resultBlobHash: action.resultBlobHash ?? null,
      nondeterministic: action.nondeterministic === true,
      timestamp: action.timestamp,
    })
    .onConflictDoNothing({ target: actionLog.id })
}

/**
 * Bulk insert. Used by WAL recovery + branch fork. Skips rows whose id
 * already exists (idempotent replay).
 */
export async function appendActionRows(
  projectId: string,
  actions: Action[],
  branchId: string | null = null,
): Promise<void> {
  if (actions.length === 0) return
  // Filter out rows that already exist so we don't pay the conflict-detect
  // tax for every row. action_log.id is uuid-collision-safe.
  const ids = actions.map((a) => a.id)
  const existing = await db
    .select({ id: actionLog.id })
    .from(actionLog)
    .where(and(eq(actionLog.projectId, projectId), inArray(actionLog.id, ids)))
  const have = new Set(existing.map((r) => r.id))
  const missing = actions.filter((a) => !have.has(a.id))
  if (missing.length === 0) return

  // Batch in groups of 100 to stay under the libsql parameter limit.
  for (let i = 0; i < missing.length; i += 100) {
    const slice = missing.slice(i, i + 100)
    await db.insert(actionLog).values(
      slice.map((a) => ({
        id: a.id,
        projectId,
        branchId,
        type: a.type,
        source: a.source,
        runId: a.runId ?? null,
        version: a.version,
        params: a.params as unknown as Record<string, unknown>,
        inverseParams: null,
        resultBlobHash: a.resultBlobHash ?? null,
        nondeterministic: a.nondeterministic === true,
        timestamp: a.timestamp,
      })),
    )
  }
}

/**
 * List actions for a project (and optionally a branch), ordered by timestamp.
 *
 * branchId semantics — matches how rows are stored:
 *   - `undefined` (omitted) → no branch filter (all branches in the project)
 *   - `null`             → only main-branch rows (where `branch_id IS NULL`)
 *   - `'<id>'`           → only that branch's rows
 */
export async function listActions(
  projectId: string,
  options: { branchId?: string | null; sinceTimestamp?: number; limit?: number } = {},
): Promise<Action[]> {
  const branchFilter =
    options.branchId === undefined
      ? undefined
      : options.branchId === null
        ? isNull(actionLog.branchId)
        : eq(actionLog.branchId, options.branchId)
  const where = branchFilter
    ? and(eq(actionLog.projectId, projectId), branchFilter)
    : eq(actionLog.projectId, projectId)

  const rows = await db
    .select()
    .from(actionLog)
    .where(options.sinceTimestamp !== undefined ? and(where, gt(actionLog.timestamp, options.sinceTimestamp)) : where)
    .orderBy(asc(actionLog.timestamp))
    .limit(options.limit ?? 100000)

  return rows.map(rowToAction)
}

/**
 * Most recent action timestamp for a project (or null if no actions yet).
 *
 * branchId semantics — matches `listActions`:
 *   - `undefined` (omitted) → no branch filter (all branches in the project)
 *   - `null`             → only main-branch rows (`branch_id IS NULL`)
 *   - `'<id>'`           → only that branch's rows
 */
/**
 * Look up an action's timestamp by its id. Used by snapshot-orchestrator
 * to compute the correct `sinceTimestamp` filter without falling for the
 * "action_log INSERT lands after the snapshot's createdAt but with a
 * timestamp earlier than createdAt" race.
 */
export async function getActionTimestamp(projectId: string, actionId: string): Promise<number | null> {
  const [row] = await db
    .select({ timestamp: actionLog.timestamp })
    .from(actionLog)
    .where(and(eq(actionLog.projectId, projectId), eq(actionLog.id, actionId)))
    .limit(1)
  return row?.timestamp ?? null
}

function rowToAction(row: typeof actionLog.$inferSelect): Action {
  return {
    id: row.id,
    type: row.type,
    source: row.source as Action['source'],
    runId: row.runId,
    version: row.version,
    params: row.params,
    timestamp: row.timestamp,
    resultBlobHash: row.resultBlobHash ?? null,
    nondeterministic: row.nondeterministic === true,
  } as unknown as Action
}

// ── Commit-SHA plumbing ─────────────────────────────────────────

/**
 * Stamp every pending action (commit_sha IS NULL) for a project with the
 * given SHA. Called from the commit hook after a successful `git_commit`.
 * Returns the count of rows updated so the caller can surface "12 actions
 * grouped into this commit" in the UI.
 */
export async function markPendingActionsWithCommit(projectId: string, sha: string): Promise<number> {
  if (!projectId || !sha) return 0
  const updated = await db
    .update(actionLog)
    .set({ commitSha: sha })
    .where(and(eq(actionLog.projectId, projectId), isNull(actionLog.commitSha)))
    .returning({ id: actionLog.id })
  return updated.length
}

/**
 * All actions stamped with a commit in the provided list (use the commits
 * walk between two refs from `gitLog`). Ordered by timestamp asc. The
 * caller may include the sentinel `null` in `shas` to also include
 * uncommitted actions ("HEAD..workdir").
 */
export async function listActionsByCommitShas(
  projectId: string,
  shas: ReadonlyArray<string | null>,
): Promise<Action[]> {
  if (shas.length === 0) return []
  const named = shas.filter((s): s is string => typeof s === 'string')
  const includeUncommitted = shas.some((s) => s === null)
  const baseFilter = eq(actionLog.projectId, projectId)
  let whereExpr
  if (named.length > 0 && includeUncommitted) {
    // SQL OR can't be easily composed from drizzle's and()/eq() helpers
    // without `or()` import; we already have inArray + isNull, which we
    // combine via two queries + merge. Cheap because the result sets are
    // disjoint (commit_sha is exactly one value per row).
    const [committedRows, pendingRows] = await Promise.all([
      db
        .select()
        .from(actionLog)
        .where(and(baseFilter, inArray(actionLog.commitSha, named))),
      db
        .select()
        .from(actionLog)
        .where(and(baseFilter, isNull(actionLog.commitSha))),
    ])
    return [...committedRows, ...pendingRows].sort((a, b) => a.timestamp - b.timestamp).map(rowToAction)
  }
  if (named.length > 0) {
    whereExpr = and(baseFilter, inArray(actionLog.commitSha, named))
  } else {
    whereExpr = and(baseFilter, isNull(actionLog.commitSha))
  }
  const rows = await db.select().from(actionLog).where(whereExpr).orderBy(asc(actionLog.timestamp))
  return rows.map(rowToAction)
}
