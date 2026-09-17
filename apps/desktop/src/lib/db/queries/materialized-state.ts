/**
 * Materialized state queries.
 *
 * Stores a periodic snapshot of the project's reduced state so cold load
 * doesn't replay every action from the beginning. The reducer is
 * orchestrated elsewhere (`snapshot-scheduler.ts` fires the write; the
 * actual `Action[] → State` function lives outside this file). This
 * module just persists/retrieves the JSON blob keyed on (project, branch).
 *
 * SQLite quirk: a composite PK that includes a nullable column allows
 * multiple rows where the nullable column is NULL. To keep the
 * upsert/read paths deterministic we coerce a null branchId into the
 * empty-string sentinel `''` before hitting the table. Branches with
 * non-empty UUIDs never collide with that sentinel.
 */

import { db } from '../index'
import { materializedState } from '../schema'
import { and, eq } from 'drizzle-orm'

const NO_BRANCH = ''

function normaliseBranchId(branchId: string | null | undefined): string {
  return branchId == null ? NO_BRANCH : branchId
}

export interface MaterializedSnapshot {
  projectId: string
  branchId: string | null
  /** The action_log id of the last action included in this snapshot. */
  lastActionId: string | null
  state: Record<string, unknown>
  /** ms since epoch. */
  createdAt: number
}

/**
 * Upsert the snapshot for (projectId, branchId). When called repeatedly
 * the existing row is replaced — we only ever keep the latest snapshot
 * per (project, branch) since older snapshots have no value once a newer
 * one exists.
 */
export async function writeSnapshot(args: {
  projectId: string
  branchId?: string | null
  lastActionId: string | null
  state: Record<string, unknown>
  createdAt?: number
}): Promise<void> {
  const branchId = normaliseBranchId(args.branchId)
  const createdAt = args.createdAt ?? Date.now()
  await db
    .insert(materializedState)
    .values({
      projectId: args.projectId,
      branchId,
      lastActionId: args.lastActionId,
      state: args.state,
      createdAt,
    })
    .onConflictDoUpdate({
      target: [materializedState.projectId, materializedState.branchId],
      set: { lastActionId: args.lastActionId, state: args.state, createdAt },
    })
}

/** Latest snapshot for the (project, branch) tuple, or null. */
export async function readLatestSnapshot(
  projectId: string,
  branchId: string | null = null,
): Promise<MaterializedSnapshot | null> {
  const row = await db.query.materializedState.findFirst({
    where: and(eq(materializedState.projectId, projectId), eq(materializedState.branchId, normaliseBranchId(branchId))),
  })
  if (!row) return null
  return {
    projectId: row.projectId,
    branchId: row.branchId === NO_BRANCH ? null : row.branchId,
    lastActionId: row.lastActionId ?? null,
    state: row.state,
    createdAt: row.createdAt,
  }
}
