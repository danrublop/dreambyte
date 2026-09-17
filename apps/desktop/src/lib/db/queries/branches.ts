import { db } from '../index'
import {
  projectBranches,
  scenes,
  snapshots,
  conversations,
  sceneVersions,
  branchProposals,
  branchLocks,
} from '../schema'
import { eq, and, isNull, inArray, sql } from 'drizzle-orm'

export type Branch = typeof projectBranches.$inferSelect

/** Explicit old→new scene id mapping produced when cloning a branch's scenes.
 *  Callers copy the matching HTML files / assets by this map rather than by row
 *  order, which is what makes both intra-project clone and cross-project fork
 *  pair content to the correct destination scene. */
export interface SceneIdPair {
  srcId: string
  dstId: string
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Clone every scene row from one branch into another, assigning fresh scene ids.
 * Returns the explicit old→new id map. Pass `targetProjectId` to clone across
 * projects (fork); omit it to clone within the same project (branch clone).
 *
 * This is the single source of truth for "copy a branch's scene rows" — the
 * fork path (src/electron/ipc/fork.ts) reuses it so the two copy flows can never
 * drift. It does NOT touch the filesystem; the caller copies HTML/assets using
 * the returned map (see copySceneHtmlFiles in src/electron/ipc/branch-content.ts).
 */
export async function copyBranchScenes(
  tx: Tx,
  args: { sourceProjectId: string; sourceBranchId: string; targetBranchId: string; targetProjectId?: string },
): Promise<SceneIdPair[]> {
  const sourceScenes = await tx
    .select()
    .from(scenes)
    .where(and(eq(scenes.projectId, args.sourceProjectId), eq(scenes.branchId, args.sourceBranchId)))
  if (sourceScenes.length === 0) return []

  const { randomUUID } = await import('node:crypto')
  const paired = sourceScenes.map((src) => ({ src, dstId: randomUUID() }))
  const now = new Date()
  const targetProjectId = args.targetProjectId
  await tx.insert(scenes).values(
    paired.map(({ src, dstId }) => {
      // The full Scene is stored in sceneBlob and is the AUTHORITATIVE source on
      // load (project-scene-table.ts returns sceneBlob verbatim, ids and all).
      // If we only change the row id and leave sceneBlob's embedded id pointing
      // at the source scene, the cloned scene loads with the source id and the
      // next save upserts onto the SOURCE row — moving scenes off the source
      // branch. So rewrite the embedded id/branchId (and projectId for a
      // cross-project fork) to match the new row.
      const blob = src.sceneBlob
      const rewrittenBlob =
        blob && typeof blob === 'object'
          ? {
              ...(blob as Record<string, unknown>),
              id: dstId,
              branchId: args.targetBranchId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
            }
          : blob
      return {
        ...src,
        id: dstId,
        projectId: targetProjectId ?? src.projectId,
        branchId: args.targetBranchId,
        sceneBlob: rewrittenBlob,
        createdAt: now,
        updatedAt: now,
      }
    }),
  )
  return paired.map(({ src, dstId }) => ({ srcId: src.id, dstId }))
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getBranches(projectId: string): Promise<Branch[]> {
  return db
    .select()
    .from(projectBranches)
    .where(eq(projectBranches.projectId, projectId))
    .orderBy(projectBranches.createdAt)
}

export async function getBranch(branchId: string): Promise<Branch | null> {
  const [row] = await db.select().from(projectBranches).where(eq(projectBranches.id, branchId)).limit(1)
  return row ?? null
}

export async function getDefaultBranch(projectId: string): Promise<Branch | null> {
  const [row] = await db
    .select()
    .from(projectBranches)
    .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.isDefault, true)))
    .limit(1)
  return row ?? null
}

/** Returns the default branch id, creating the `main` branch if it doesn't exist yet. */
export async function getOrCreateDefaultBranch(projectId: string): Promise<Branch> {
  return db.transaction(async (tx) => {
    // Fast-path: branch already exists (common case — no insert attempt)
    const rows = await tx
      .select()
      .from(projectBranches)
      .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.isDefault, true)))
      .limit(1)
    if (rows[0]) return rows[0]

    // Slow-path: insert with conflict guard — two concurrent callers both race
    // past the read; only one insert wins; second gets onConflictDoNothing → null.
    const inserted = await tx
      .insert(projectBranches)
      .values({ projectId, name: 'main', isDefault: true })
      .onConflictDoNothing()
      .returning()
    if (inserted[0]) return inserted[0]

    // If conflict was hit, re-read to get the winner's row.
    const winner = await tx
      .select()
      .from(projectBranches)
      .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.isDefault, true)))
      .limit(1)
    if (!winner[0]) throw new Error(`[branches] Failed to create or find default branch for project ${projectId}`)
    return winner[0]
  })
}

// ── Write ────────────────────────────────────────────────────────────────────

export interface CreateBranchData {
  projectId: string
  name: string
  isDefault?: boolean
  description?: string
  sourceBranchId?: string
}

/**
 * Create a branch and (when `sourceBranchId` is set) clone its scenes, returning
 * the new branch plus the old→new scene id map. The IPC layer uses the map to
 * copy each source scene's HTML file to the correct cloned scene — pairing by
 * id, never by row order.
 */
export async function createBranchWithMap(
  data: CreateBranchData,
): Promise<{ branch: Branch; sceneIdMap: SceneIdPair[] }> {
  return db.transaction(async (tx) => {
    const [branch] = await tx
      .insert(projectBranches)
      .values({
        projectId: data.projectId,
        name: data.name,
        isDefault: data.isDefault ?? false,
        description: data.description ?? null,
      })
      .returning()

    if (!data.sourceBranchId) return { branch, sceneIdMap: [] }

    // Clone scenes from the source branch — new IDs so edits on the new branch
    // don't touch source rows. The map drives the HTML/asset copy downstream.
    const sceneIdMap = await copyBranchScenes(tx, {
      sourceProjectId: data.projectId,
      sourceBranchId: data.sourceBranchId,
      targetBranchId: branch.id,
    })
    return { branch, sceneIdMap }
  })
}

/** Back-compat thin wrapper: create a branch, discard the scene id map. */
export async function createBranch(data: CreateBranchData): Promise<Branch> {
  const { branch } = await createBranchWithMap(data)
  return branch
}

export async function renameBranch(branchId: string, name: string): Promise<Branch> {
  const [row] = await db
    .update(projectBranches)
    .set({ name, updatedAt: new Date() })
    .where(eq(projectBranches.id, branchId))
    .returning()
  if (!row) throw new Error(`Branch ${branchId} not found`)
  return row
}

/**
 * Make `branchId` the project's default branch, atomically clearing the old
 * default in the same transaction so there's never zero or two defaults. No-op
 * (returns the row) if it's already the default.
 */
export async function setDefaultBranch(projectId: string, branchId: string): Promise<Branch> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(projectBranches)
      .where(and(eq(projectBranches.id, branchId), eq(projectBranches.projectId, projectId)))
      .limit(1)
    if (!target) throw new Error(`Branch ${branchId} not found in project ${projectId}`)
    if (target.isDefault) return target

    await tx
      .update(projectBranches)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.isDefault, true)))
    const [updated] = await tx
      .update(projectBranches)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(projectBranches.id, branchId))
      .returning()
    // Guard the (rare) interleaved-delete case: if the target vanished between
    // the read and this update, the tx would otherwise leave zero defaults.
    if (!updated) throw new Error(`Branch ${branchId} no longer exists`)
    return updated
  })
}

export async function deleteBranch(
  branchId: string,
): Promise<{ deletedSceneCount: number; deletedSceneIds: string[] }> {
  const branch = await getBranch(branchId)
  if (!branch) throw new Error(`Branch ${branchId} not found`)
  if (branch.isDefault) throw new Error('Cannot delete the default branch')

  return db.transaction(async (tx) => {
    // Explicit cascade — SQLite FK enforcement is opt-in per-connection and not
    // enabled globally, so we delete child rows manually.
    const deleted = await tx.delete(scenes).where(eq(scenes.branchId, branchId)).returning({ id: scenes.id })
    const deletedIds = deleted.map((r) => r.id)
    if (deletedIds.length > 0) {
      await tx.delete(sceneVersions).where(inArray(sceneVersions.sceneId, deletedIds))
    }
    // Conversations and snapshots are not FK-cascaded on branchId — delete them explicitly.
    await tx.delete(conversations).where(eq(conversations.branchId, branchId))
    await tx.delete(snapshots).where(eq(snapshots.branchId, branchId))
    // branch_proposals (0015) carries an ON DELETE CASCADE FK, but SQLite FK
    // enforcement is off per-connection (see above), so delete it explicitly too.
    await tx.delete(branchProposals).where(eq(branchProposals.branchId, branchId))
    // branch_locks likewise FK-cascades on paper only. The IPC delete handler
    // holds this branch's lock while we run, so this also releases it — its
    // finally-release then no-ops, which is fine for a branch that no longer
    // exists. Without this, deleted branches leak permanent lock rows.
    await tx.delete(branchLocks).where(eq(branchLocks.branchId, branchId))
    await tx.delete(projectBranches).where(eq(projectBranches.id, branchId))
    return { deletedSceneCount: deletedIds.length, deletedSceneIds: deletedIds }
  })
}

// ── Migration helper ─────────────────────────────────────────────────────────

/**
 * Back-fills branch_id on scenes/snapshots/conversations for a project.
 * Safe to call multiple times (no-ops if already populated).
 * Called once per project on first launch after the migration.
 */
export async function backfillProjectBranch(projectId: string): Promise<void> {
  const defaultBranch = await getOrCreateDefaultBranch(projectId)
  const branchId = defaultBranch.id

  await db.transaction(async (tx) => {
    await tx
      .update(scenes)
      .set({ branchId })
      .where(and(eq(scenes.projectId, projectId), isNull(scenes.branchId)))

    await tx
      .update(snapshots)
      .set({ branchId })
      .where(and(eq(snapshots.projectId, projectId), isNull(snapshots.branchId)))

    await tx
      .update(conversations)
      .set({ branchId })
      .where(and(eq(conversations.projectId, projectId), isNull(conversations.branchId)))
  })
}
