import { db } from '../index'
import { sceneVersions, scenes } from '../schema'
import { eq, and, desc, sql, inArray } from 'drizzle-orm'

const MAX_VERSIONS_PER_SCENE = 200

// Penpot-style 20-second transaction window: rapid autosaves within the window
// collapse to a single version row. Tldraw-style diff check: skip the insert if
// content hasn't actually changed since the last committed version.
const SCHEDULE_DELAY_MS = 20_000

export type SceneVersionSource = 'autosave' | 'agent' | 'user' | 'restore' | 'branch-init'

export type SceneVersionMeta = Omit<typeof sceneVersions.$inferSelect, 'layerSnapshot'>
export type SceneVersionFull = typeof sceneVersions.$inferSelect

// ── Pending version timer registry ───────────────────────────────────────────
// Lives in main-process memory. Each entry holds the latest snapshot data for
// a (sceneId, branchId) pair; the timer fires and writes it after SCHEDULE_DELAY_MS
// of inactivity. Replaced on each call within the window so only the last save wins.

type PendingEntry = {
  timer: ReturnType<typeof setTimeout>
  data: CreateVersionData
}
const pending = new Map<string, PendingEntry>()

type CreateVersionData = {
  sceneId: string
  branchId: string
  layerSnapshot: Record<string, unknown>
  operation?: string
  label?: string
  source: SceneVersionSource
  /** Shared id grouping every scene-version written by one logical operation.
   *  Branch history restores by this boundary, not by raw timestamp. Omit for
   *  single-scene autosaves (each becomes its own singleton batch). */
  batchId?: string
}

/**
 * Returns a stable content signature for change detection.
 * Excludes volatile metadata fields (timestamps, ids) so that a save which only
 * touches metadata doesn't trigger a version insert.
 */
function contentSignature(snapshot: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, createdAt, updatedAt, branchId, projectId, thumbnailUrl, ...rest } = snapshot as Record<string, unknown>
  // Sort keys so that objects built in different insertion orders produce the same signature.
  const sortedKeys = Object.keys(rest).sort()
  return JSON.stringify(rest, sortedKeys)
}

/**
 * Schedule a version write for a scene, collapsing rapid saves within a 20-second
 * window into a single DB row (Penpot transaction-timer pattern).
 * Call this instead of createSceneVersion from the autosave path.
 */
export function scheduleSceneVersion(data: CreateVersionData, delayMs = SCHEDULE_DELAY_MS): void {
  const key = `${data.sceneId}:${data.branchId}`
  const existing = pending.get(key)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    pending.delete(key)
    writeSceneVersionIfChanged(data).catch(() => {
      /* non-fatal */
    })
  }, delayMs)

  pending.set(key, { timer, data })
}

/**
 * Flush all pending version timers immediately (write their snapshots now).
 * Call before branch switch, branch delete, agent run start, and app quit.
 */
export async function flushAllPendingVersions(): Promise<void> {
  const entries = [...pending.entries()]
  pending.clear()
  for (const [, entry] of entries) clearTimeout(entry.timer)
  await Promise.allSettled(entries.map(([, entry]) => writeSceneVersionIfChanged(entry.data)))
}

/**
 * Cancel pending timers for specific scenes WITHOUT writing them.
 * Call before deleting scenes (e.g., branch delete) so we don't write orphaned rows.
 */
export function cancelPendingVersionsForScenes(sceneIds: string[], branchId: string): void {
  for (const sceneId of sceneIds) {
    const key = `${sceneId}:${branchId}`
    const entry = pending.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(key)
    }
  }
}

/**
 * Write a version row only if the content has changed since the last committed version.
 * Tldraw PendingDiff pattern: skip the insert when the diff is empty.
 */
async function writeSceneVersionIfChanged(data: CreateVersionData): Promise<void> {
  await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ snapshot: sceneVersions.layerSnapshot })
      .from(sceneVersions)
      .where(and(eq(sceneVersions.sceneId, data.sceneId), eq(sceneVersions.branchId, data.branchId)))
      .orderBy(desc(sceneVersions.versionNumber))
      .limit(1)

    if (last && contentSignature(last.snapshot) === contentSignature(data.layerSnapshot)) return
    await createSceneVersion(tx, data)
  })
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** Returns version metadata (no layerSnapshot) ordered newest-first. */
export async function getSceneVersions(
  sceneId: string,
  branchId: string,
  opts: { all?: boolean; limit?: number } = {},
): Promise<SceneVersionMeta[]> {
  return db
    .select({
      id: sceneVersions.id,
      sceneId: sceneVersions.sceneId,
      branchId: sceneVersions.branchId,
      versionNumber: sceneVersions.versionNumber,
      operation: sceneVersions.operation,
      label: sceneVersions.label,
      batchId: sceneVersions.batchId,
      source: sceneVersions.source,
      createdAt: sceneVersions.createdAt,
    })
    .from(sceneVersions)
    .where(and(eq(sceneVersions.sceneId, sceneId), eq(sceneVersions.branchId, branchId)))
    .orderBy(desc(sceneVersions.versionNumber))
    .limit(opts.all ? MAX_VERSIONS_PER_SCENE : (opts.limit ?? 50))
}

/** Returns a single version with full layerSnapshot. */
export async function getSceneVersion(versionId: string): Promise<SceneVersionFull | null> {
  const [row] = await db.select().from(sceneVersions).where(eq(sceneVersions.id, versionId)).limit(1)
  return row ?? null
}

/** One entry in the branch-wide history timeline: a single logical operation
 *  (one batch) that touched one or more scenes. */
export interface BranchHistoryEntry {
  /** Stable restore handle: the batchId, or the row id for legacy null-batch rows. */
  key: string
  batchId: string | null
  operation: string | null
  label: string | null
  source: SceneVersionSource
  /** Time of the operation (latest write in the batch). */
  createdAt: Date
  /** How many distinct scenes this operation changed. */
  sceneCount: number
}

/**
 * Branch-wide history timeline: every logical operation on the branch, newest
 * first, collapsed by batchId so a multi-scene agent run is ONE row (not one
 * per scene). Legacy versions written before batchId each surface as their own
 * singleton entry (coalesce(batch_id, id)). Single indexed scan over
 * scene_versions(branch_id, created_at). Paginate with `before` + `beforeKey`.
 *
 * PAGINATION (hotlist item 2): a compound (created_at, key) keyset cursor.
 * created_at is second-resolution unixepoch, so entries routinely share a
 * second — a bare `< before` cursor silently dropped the overflow when more
 * than `limit` groups shared the boundary second. Two requirements the old
 * code missed:
 *  - the cursor must compare against the GROUP's aggregate (HAVING on
 *    max(created_at)), not raw rows — a row-level WHERE truncates a batch
 *    whose rows straddle the boundary, re-surfacing it on page 2 with an
 *    earlier timestamp and a wrong sceneCount;
 *  - ordering must be deterministic: (max(created_at) DESC, key DESC), with
 *    the tie broken the same way the cursor compares.
 * Callers page by passing the LAST entry's `createdAt` as `before` and its
 * `key` as `beforeKey`. A bare `before` (legacy callers) keeps the old
 * row-level semantics unchanged.
 */
export async function getBranchHistory(
  branchId: string,
  opts: { limit?: number; before?: Date; beforeKey?: string } = {},
): Promise<BranchHistoryEntry[]> {
  const limit = opts.limit ?? 50
  const keyExpr = sql<string>`coalesce(${sceneVersions.batchId}, ${sceneVersions.id})`
  const compound = opts.before != null && opts.beforeKey != null
  const where =
    opts.before && !compound
      ? and(
          eq(sceneVersions.branchId, branchId),
          sql`${sceneVersions.createdAt} < ${Math.floor(opts.before.getTime() / 1000)}`,
        )
      : eq(sceneVersions.branchId, branchId)

  let query = db
    .select({
      key: keyExpr,
      batchId: sceneVersions.batchId,
      operation: sql<string | null>`max(${sceneVersions.operation})`,
      label: sql<string | null>`max(${sceneVersions.label})`,
      source: sql<string>`max(${sceneVersions.source})`,
      // created_at is stored as unixepoch seconds; max() returns the raw integer.
      createdAtSec: sql<number>`max(${sceneVersions.createdAt})`,
      sceneCount: sql<number>`count(distinct ${sceneVersions.sceneId})`,
    })
    .from(sceneVersions)
    .where(where)
    .groupBy(keyExpr)
    .$dynamic()

  if (compound) {
    const cursorSec = Math.floor((opts.before as Date).getTime() / 1000)
    query = query.having(
      sql`max(${sceneVersions.createdAt}) < ${cursorSec} OR (max(${sceneVersions.createdAt}) = ${cursorSec} AND ${keyExpr} < ${opts.beforeKey})`,
    )
  }

  const rows = await query.orderBy(desc(sql`max(${sceneVersions.createdAt})`), desc(keyExpr)).limit(limit)

  return rows.map((r) => ({
    key: r.key,
    batchId: r.batchId ?? null,
    operation: r.operation,
    label: r.label,
    source: r.source as SceneVersionSource,
    createdAt: new Date(Number(r.createdAtSec) * 1000),
    sceneCount: Number(r.sceneCount),
  }))
}

export interface RestoreBranchResult {
  /** Scenes whose content was reverted to their as-of-cursor snapshot. */
  restored: { sceneId: string; layerSnapshot: Record<string, unknown>; newVersionNumber: number }[]
  /** Live scenes that did NOT exist at the restore point (created after it) and
   *  were removed from the branch so the restore matches the real past state. */
  removedSceneIds: string[]
}

/**
 * Restore a branch to the point in history marked by `batchKey` (one operation).
 *
 * "To the point" means the whole branch as it was at that moment, not just the
 * scenes that operation touched: for EVERY scene on the branch, restore its
 * latest version at or before the cursor. Without this, a scene edited in a
 * later operation would keep its future state and the branch would land in a
 * configuration that never existed (the exact splice this feature avoids). The
 * whole restore is stamped with one shared batchId so it's a single undoable
 * history entry.
 *
 * Cursor precision: the boundary is the batch's MAX sqlite `rowid` — a strictly
 * monotonic, per-insert sequence — NOT the second-resolution `created_at`.
 * created_at collides when several operations land in the same wall-clock second
 * (rapid autosave + agent run), which would splice half of one operation with
 * half of another. rowid is unique and ordered by insert, so "at or before the
 * batch" is exact even sub-second.
 *
 * Scene add/delete across the cursor:
 *  - A scene CREATED after the cursor (its earliest version's rowid > the cursor)
 *    did not exist then → it is REMOVED from the live branch (returned in
 *    removedSceneIds) so the restored branch matches the real past.
 *  - A scene that existed at the cursor but was DELETED later still has a version
 *    at/before the cursor → it is restored (re-materialized) like any other.
 */
export async function restoreBranchToBatch(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  branchId: string,
  batchKey: string,
): Promise<RestoreBranchResult> {
  // The cursor is the batch's latest insert. rowid is sqlite's implicit
  // monotonic insertion sequence (the table has a text PK, not WITHOUT ROWID,
  // so rowid exists and increases with every insert).
  const [cursorRow] = await tx
    .select({ maxRowid: sql<number>`max(${sceneVersions}.rowid)` })
    .from(sceneVersions)
    .where(
      and(
        eq(sceneVersions.branchId, branchId),
        sql`coalesce(${sceneVersions.batchId}, ${sceneVersions.id}) = ${batchKey}`,
      ),
    )
  if (cursorRow?.maxRowid == null) throw new Error(`No history entry ${batchKey} on branch ${branchId}`)
  const cursor = Number(cursorRow.maxRowid)

  // Every version on the branch at or before the cursor; keep the latest per
  // scene (highest rowid) so each scene is restored to its as-of-cursor state.
  const candidates = await tx
    .select({
      rowid: sql<number>`${sceneVersions}.rowid`,
      sceneId: sceneVersions.sceneId,
      versionNumber: sceneVersions.versionNumber,
      layerSnapshot: sceneVersions.layerSnapshot,
    })
    .from(sceneVersions)
    .where(and(eq(sceneVersions.branchId, branchId), sql`${sceneVersions}.rowid <= ${cursor}`))
  const latestByScene = new Map<string, (typeof candidates)[number]>()
  for (const r of candidates) {
    const prev = latestByScene.get(r.sceneId)
    if (!prev || Number(r.rowid) > Number(prev.rowid)) latestByScene.set(r.sceneId, r)
  }

  const { randomUUID } = await import('node:crypto')
  const restoreBatchId = randomUUID()
  const restored: RestoreBranchResult['restored'] = []
  for (const v of latestByScene.values()) {
    const res = await createSceneVersion(tx, {
      sceneId: v.sceneId,
      branchId,
      layerSnapshot: v.layerSnapshot,
      operation: 'restore',
      label: `Restored to ${batchKey.slice(0, 8)}`,
      source: 'restore',
      batchId: restoreBatchId,
    })
    restored.push({ sceneId: v.sceneId, layerSnapshot: v.layerSnapshot, newVersionNumber: res.versionNumber })
  }

  // Scenes live on the branch NOW that have no version at/before the cursor were
  // created after the restore point — remove them so the branch matches the past.
  const liveScenes = await tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.branchId, branchId))
  const restoredIds = new Set(latestByScene.keys())
  const removedSceneIds = liveScenes.map((s) => s.id).filter((id) => !restoredIds.has(id))
  if (removedSceneIds.length > 0) {
    // Drop the scene rows (and their version history on this branch) for scenes
    // that didn't exist at the cursor. The caller removes their HTML files.
    await tx.delete(sceneVersions).where(inArray(sceneVersions.sceneId, removedSceneIds))
    await tx.delete(scenes).where(inArray(scenes.id, removedSceneIds))
  }

  return { restored, removedSceneIds }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Inserts a new version for the scene and trims to keep at most 200.
 * Trim deletes the smallest version_number(s) when the count exceeds the cap.
 * Must be called inside a transaction that also writes the scene row, so the
 * snapshot and the scene state are always in sync.
 */
export async function createSceneVersion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  data: CreateVersionData,
): Promise<SceneVersionFull> {
  const [maxRow] = await tx
    .select({ max: sql<number>`coalesce(max(${sceneVersions.versionNumber}), 0)` })
    .from(sceneVersions)
    .where(and(eq(sceneVersions.sceneId, data.sceneId), eq(sceneVersions.branchId, data.branchId)))
  const nextVersion = Number(maxRow?.max ?? 0) + 1

  const [row] = await tx
    .insert(sceneVersions)
    .values({
      sceneId: data.sceneId,
      branchId: data.branchId,
      versionNumber: nextVersion,
      layerSnapshot: data.layerSnapshot,
      operation: data.operation ?? null,
      label: data.label ?? null,
      batchId: data.batchId ?? null,
      source: data.source,
    })
    .returning()

  // Trim: skip the subquery when under cap (common case) — Tldraw optimization.
  const [countRow] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(sceneVersions)
    .where(and(eq(sceneVersions.sceneId, data.sceneId), eq(sceneVersions.branchId, data.branchId)))

  if (Number(countRow?.n ?? 0) > MAX_VERSIONS_PER_SCENE) {
    await tx.delete(sceneVersions).where(
      and(
        eq(sceneVersions.sceneId, data.sceneId),
        eq(sceneVersions.branchId, data.branchId),
        sql`${sceneVersions.versionNumber} < (
          SELECT ${sceneVersions.versionNumber}
          FROM ${sceneVersions}
          WHERE ${sceneVersions.sceneId} = ${data.sceneId}
            AND ${sceneVersions.branchId} = ${data.branchId}
          ORDER BY ${sceneVersions.versionNumber} DESC
          LIMIT 1 OFFSET ${MAX_VERSIONS_PER_SCENE - 1}
        )`,
      ),
    )
  }

  return row
}

/**
 * Restores a scene to the state captured in a version.
 * Append-only: writes a new version record after restore rather than
 * mutating or removing history. Returns the new version number.
 */
export async function restoreSceneVersion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  versionId: string,
): Promise<{ newVersionNumber: number; layerSnapshot: Record<string, unknown> }> {
  const [version] = await tx.select().from(sceneVersions).where(eq(sceneVersions.id, versionId)).limit(1)
  if (!version) throw new Error(`Scene version ${versionId} not found`)

  const restored = await createSceneVersion(tx, {
    sceneId: version.sceneId,
    branchId: version.branchId,
    layerSnapshot: version.layerSnapshot,
    operation: 'restore',
    label: `Restored from v${version.versionNumber}`,
    source: 'restore',
  })

  return { newVersionNumber: restored.versionNumber, layerSnapshot: version.layerSnapshot }
}
