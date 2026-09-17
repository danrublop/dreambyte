import type { IpcMain } from 'electron'
import {
  getBranches,
  getBranch,
  createBranchWithMap,
  renameBranch,
  deleteBranch,
  getOrCreateDefaultBranch,
  backfillProjectBranch,
  setDefaultBranch,
} from '@/lib/db/queries/branches'
import { copySceneHtmlFiles } from './branch-content'
import { withBranchLock, BranchLockedError, projectLockKey } from '@/lib/db/queries/branch-locks'
import { getBranchProposals, setProposalField, type ProposalField } from '@/lib/db/queries/branch-proposals'
import { getProjectScenesByBranch } from '@/lib/db/queries/scenes'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'
import {
  getSceneVersions,
  getSceneVersion,
  restoreSceneVersion,
  flushAllPendingVersions,
  cancelPendingVersionsForScenes,
  getBranchHistory,
  restoreBranchToBatch,
} from '@/lib/db/queries/scene-versions'
import { db } from '@/lib/db'
import { scenes } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError, IpcNotFoundError } from './_helpers'
import { generateSceneHTML } from '@/lib/sceneTemplate'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { resolveScenesDir } from '@/lib/scene-html-paths'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createLogger } from '@/lib/logger'

const log = createLogger('electron.ipc.branches')

// One-time backfill tracker — avoids re-running 4 DB queries on every branches.list call.
// The backfill is idempotent but still hits the DB each time; this Set prevents that.
// Cleared on process restart, which is fine — the no-op run is cheap once per session.
const _backfilledProjects = new Set<string>()

/**
 * Category: branches
 *
 * Covers:
 *   GET    branches?projectId=X       → branches.list({projectId})
 *   POST   branches                   → branches.create({projectId, name, sourceBranchId?})
 *   PATCH  branches/:id               → branches.rename({id, name})
 *   DELETE branches/:id               → branches.delete({id})
 *   GET    branches/:id/scene-versions → branches.listVersions({sceneId, branchId})
 *   POST   branches/restore-version   → branches.restoreVersion({versionId})
 */

async function list(args: { projectId: string }) {
  assertValidUuid(args.projectId, 'projectId')
  await loadProjectOrThrow(args.projectId)
  if (!_backfilledProjects.has(args.projectId)) {
    await backfillProjectBranch(args.projectId)
    _backfilledProjects.add(args.projectId)
  }
  const branchList = await getBranches(args.projectId)
  return { branches: branchList }
}

/**
 * UNIQUE-violation detection that survives drizzle's error wrapping: the
 * thrown DrizzleQueryError's own message is just "Failed query: …" — the
 * "UNIQUE constraint failed" detail lives on the CAUSE (LibsqlError). A
 * top-level `msg.includes('UNIQUE')` check therefore never fires and users
 * saw the raw failed-query dump instead of the friendly duplicate-name
 * message (caught by branches.test.ts on first contact, B8).
 *
 * Matches SQLite's exact uppercase "UNIQUE constraint failed" wording only —
 * free-text substring matching is the thing _helpers.ts' IpcConflictError doc
 * warns against, so keep the match as narrow as the driver allows. Depth-
 * capped so a (theoretical) cyclic cause chain can't hang the main process.
 * Local to its only consumer; lift to _helpers.ts if a second handler needs it.
 *
 * @internal exported for unit tests
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 16; e = (e as { cause?: unknown }).cause, depth++) {
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
    if (msg.includes('UNIQUE')) return true
  }
  return false
}

/**
 * Load a branch and enforce it belongs to the caller's project (B13 — was
 * hand-rolled at five call sites in two drift-prone shapes). NotFound when the
 * id doesn't exist; the friendly Validation message when it's another
 * project's branch.
 */
async function loadBranchInProjectOrThrow(branchId: string, projectId: string) {
  const branch = await getBranch(branchId)
  if (!branch) throw new IpcNotFoundError(`Branch ${branchId} not found`)
  if (branch.projectId !== projectId) throw new IpcValidationError('Branch does not belong to this project')
  return branch
}

/**
 * Enforce a scene belongs to the caller's project. `subject` names what
 * the caller is really validating ('Scene' for direct lookups, 'Version' when
 * the scene was reached through a version row) so error messages stay specific.
 */
async function assertSceneInProject(
  sceneId: string,
  projectId: string,
  subject: 'Scene' | 'Version' = 'Scene',
): Promise<void> {
  const [ownerScene] = await db
    .select({ projectId: scenes.projectId })
    .from(scenes)
    .where(eq(scenes.id, sceneId))
    .limit(1)
  if (!ownerScene || ownerScene.projectId !== projectId) {
    throw new IpcValidationError(`${subject} does not belong to this project`)
  }
}

async function create(args: { projectId: string; name: string; sourceBranchId?: string }) {
  assertValidUuid(args.projectId, 'projectId')
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new IpcValidationError('Branch name is required')
  }
  if (args.name.length > 100) {
    throw new IpcValidationError('Branch name must be 100 characters or less')
  }
  if (args.sourceBranchId) assertValidUuid(args.sourceBranchId, 'sourceBranchId')
  await loadProjectOrThrow(args.projectId)

  // The lock's DB row (branch_locks.branch_id) is a real FK to projectBranches,
  // so anchor it to an existing branch: the source branch when cloning, else the
  // project's default branch when creating from scratch.
  const lockAnchorBranchId = args.sourceBranchId ?? (await getOrCreateDefaultBranch(args.projectId)).id

  try {
    // PROJECT-scoped lock for the whole clone (row clone + HTML copy): a
    // per-branch lock can't serialize a create against a concurrent default-swap
    // or another create on the same project. The lock covers reading the source
    // branch's scenes and writing the new branch's HTML so neither can be raced.
    return await withBranchLock(
      {
        branchId: lockAnchorBranchId,
        projectId: args.projectId,
        operation: 'fork',
        lockKey: projectLockKey(args.projectId),
      },
      async () => {
        let branch
        let sceneIdMap
        try {
          ;({ branch, sceneIdMap } = await createBranchWithMap({
            projectId: args.projectId,
            name: args.name.trim(),
            sourceBranchId: args.sourceBranchId,
          }))
        } catch (err: unknown) {
          if (isUniqueViolation(err)) {
            throw new IpcValidationError(`A branch named "${args.name}" already exists in this project`)
          }
          throw err
        }

        // Copy each source scene's HTML file to its cloned scene id.
        // createBranchWithMap cloned the scene DB rows with new UUIDs and returned
        // the explicit old→new id map; without copying the HTML the cloned scenes
        // can't render. Pairing by the map (not by row order) keeps every HTML
        // file matched to the correct scene.
        if (sceneIdMap.length > 0) {
          await copySceneHtmlFiles(sceneIdMap)
        }

        return { branch }
      },
    )
  } catch (err: unknown) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

async function rename(args: { projectId: string; id: string; name: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.id, 'id')
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new IpcValidationError('Branch name is required')
  }
  if (args.name.length > 100) {
    throw new IpcValidationError('Branch name must be 100 characters or less')
  }

  await loadBranchInProjectOrThrow(args.id, args.projectId)

  try {
    const updated = await renameBranch(args.id, args.name.trim())
    return { branch: updated }
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new IpcValidationError(`A branch named "${args.name}" already exists in this project`)
    }
    throw err
  }
}

/** Make a branch the project's default ('main'), atomically swapping the old one. */
async function setDefault(args: { projectId: string; id: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.id, 'id')
  await loadProjectOrThrow(args.projectId)
  await loadBranchInProjectOrThrow(args.id, args.projectId)

  try {
    // PROJECT-scoped lock: the default-pointer swap touches TWO branches (the old
    // default and the new one), so a per-branch lock can't serialize two
    // concurrent swaps. Serializing on the project also blocks a swap from racing
    // a delete that could otherwise leave the project with no default branch.
    return await withBranchLock(
      { branchId: args.id, projectId: args.projectId, operation: 'promote', lockKey: projectLockKey(args.projectId) },
      async () => {
        // Re-check inside the lock: the branch could have been deleted between the
        // pre-lock fetch and acquiring the lock.
        const live = await getBranch(args.id)
        if (!live || live.projectId !== args.projectId) throw new IpcValidationError('Branch no longer exists')
        const updated = await setDefaultBranch(args.projectId, args.id)
        return { branch: updated }
      },
    )
  } catch (err: unknown) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

async function deleteHandler(args: { projectId: string; id: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.id, 'id')

  const branch = await loadBranchInProjectOrThrow(args.id, args.projectId)
  // Server-side guard: the default branch is never deletable. Enforced here (not
  // only in the disabled UI row) so a tool call / second window can't bypass it.
  if (branch.isDefault) throw new IpcValidationError('Cannot delete the default branch')

  try {
    // PROJECT-scoped lock for the whole delete: a per-branch lock can't serialize
    // a delete against a concurrent default-swap (promote) on the same project —
    // that interleave could promote this branch to default and then delete it,
    // leaving the project with NO default branch. Serializing both ops on the
    // project key closes that race; it also stops another window forking/
    // restoring/deleting the same branch mid-cascade.
    return await withBranchLock(
      {
        branchId: args.id,
        projectId: args.projectId,
        operation: 'delete',
        lockKey: projectLockKey(args.projectId),
      },
      async () => {
        // Re-validate INSIDE the lock: a promote that ran just before us could
        // have made this branch the default. deleteBranch guards isDefault too,
        // but checking here yields the friendly validation error and avoids the
        // cascade work entirely.
        const live = await getBranch(args.id)
        if (!live || live.projectId !== args.projectId) throw new IpcNotFoundError(`Branch ${args.id} not found`)
        if (live.isDefault) throw new IpcValidationError('Cannot delete the default branch')

        // Cancel (not flush) pending autosave timers for scenes on this branch
        // before the cascade delete so we don't write orphaned version rows.
        const branchSceneRows = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.branchId, args.id))
        const sceneIds = branchSceneRows.map((r) => r.id)
        cancelPendingVersionsForScenes(sceneIds, args.id)

        const { deletedSceneCount } = await deleteBranch(args.id)

        // Best-effort cleanup of scene HTML files. Non-fatal — orphaned files are
        // inert (they can't be loaded once the scene row is gone) and small.
        if (sceneIds.length > 0) {
          const scenesDir = resolveScenesDir()
          await Promise.allSettled(sceneIds.map((id) => fs.unlink(path.join(scenesDir, `${id}.html`)).catch(() => {})))
        }

        return { success: true, deletedSceneCount }
      },
    )
  } catch (err: unknown) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Cannot delete the default branch')) {
      throw new IpcValidationError('Cannot delete the default branch')
    }
    throw err
  }
}

async function listVersions(args: { projectId: string; sceneId: string; branchId: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.sceneId, 'sceneId')
  assertValidUuid(args.branchId, 'branchId')
  await assertSceneInProject(args.sceneId, args.projectId)
  // Fetch all versions so the drawer's "Showing N of M" count is accurate.
  const versions = await getSceneVersions(args.sceneId, args.branchId, { all: true })
  return { versions }
}

async function restoreVersion(args: { projectId: string; versionId: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.versionId, 'versionId')

  const version = await getSceneVersion(args.versionId)
  if (!version) throw new IpcNotFoundError(`Version ${args.versionId} not found`)

  // Ownership check: the version must belong to a scene in the caller's project.
  await assertSceneInProject(version.sceneId, args.projectId, 'Version')

  // Hold the branch lock across the entire single-version restore (DB row +
  // HTML regen) so a concurrent agent run / fork / delete / whole-branch restore
  // in another window can't interleave with it — same gating as restoreToPoint.
  try {
    const { newVersionNumber } = await withBranchLock(
      { branchId: version.branchId, projectId: args.projectId, operation: 'restore' },
      async () => {
        const result = await db.transaction(async (tx) => {
          // Append a new version record (history is never mutated).
          const r = await restoreSceneVersion(tx, args.versionId)

          // Update the live scene row so the editor loads the restored state.
          // Without this the version history grows but the editor stays on stale code.
          await tx
            .update(scenes)
            .set({ sceneBlob: r.layerSnapshot, updatedAt: new Date() })
            .where(eq(scenes.id, version.sceneId))

          return r
        })

        // Regenerate the HTML file from the restored snapshot so the preview
        // reflects the restore immediately. Still inside the lock so the HTML
        // write can't race a concurrent destructive op on the same branch.
        await regenerateSceneHtml(version.sceneId, result.layerSnapshot)
        return result
      },
    )

    // Return sceneId so the client can reload the scene after restore.
    return { success: true, newVersionNumber, sceneId: version.sceneId }
  } catch (err: unknown) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

/**
 * Rewrite a scene's HTML file from a restored snapshot so the preview reflects
 * the restore immediately. Shared by single-version restore and batch (branch
 * history) restore. Best-effort: a failed regen leaves DB state restored and
 * only the on-disk preview stale, so it never throws.
 */
async function regenerateSceneHtml(sceneId: string, layerSnapshot: Record<string, unknown>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sceneObj = layerSnapshot as any
    const html = generateSceneHTML(
      sceneObj,
      sceneObj.globalStyle ?? undefined,
      undefined,
      undefined,
      resolveProjectDimensions(sceneObj.aspectRatio, sceneObj.resolution),
    )
    const scenesDir = resolveScenesDir()
    await fs.mkdir(scenesDir, { recursive: true })
    const destPath = path.resolve(path.join(scenesDir, `${sceneId}.html`))
    if (!destPath.startsWith(scenesDir + path.sep)) throw new Error('invalid sceneId path')
    await fs.writeFile(destPath, html, 'utf-8')
  } catch (htmlErr) {
    log.warn('HTML regeneration failed (preview may be stale)', {
      extra: { sceneId },
      error: htmlErr,
    })
  }
}

/** Branch-wide history timeline (operations collapsed by batch), newest first. */
async function history(args: {
  projectId: string
  branchId: string
  limit?: number
  before?: number
  beforeKey?: string
}) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)
  // B13 NOTE: an unknown branchId now yields NotFound (was a combined check
  // that mislabeled it 'does not belong to this project') — more accurate.
  await loadBranchInProjectOrThrow(args.branchId, args.projectId)
  const entries = await getBranchHistory(args.branchId, {
    limit: typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 200) : 50,
    before: typeof args.before === 'number' ? new Date(args.before) : undefined,
    // Compound keyset cursor (hotlist item 2): pass the LAST entry's key with
    // its createdAt so same-second overflow pages correctly instead of being
    // silently dropped.
    beforeKey: typeof args.beforeKey === 'string' && args.beforeKey ? args.beforeKey : undefined,
  })
  return { entries }
}

/**
 * Restore the whole branch to one history entry (batch boundary). Reverts every
 * scene to its as-of-cursor snapshot, removes scenes created after the cursor,
 * all in one new 'restore' batch, then regenerates/cleans each scene's HTML.
 * Restoring by a monotonic batch cursor (not raw timestamp) guarantees a state
 * that actually existed.
 */
/** @internal exported for tests (restore-order regression pin) */
export async function restoreToPoint(args: { projectId: string; branchId: string; key: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.branchId, 'branchId')
  if (!args.key || typeof args.key !== 'string') {
    throw new IpcValidationError('history key is required')
  }
  await loadProjectOrThrow(args.projectId)
  // B13 NOTE: an unknown branchId now yields NotFound (was a combined check
  // that mislabeled it 'does not belong to this project') — more accurate.
  await loadBranchInProjectOrThrow(args.branchId, args.projectId)
  try {
    // Hold the branch lock across the restore so a concurrent agent run / fork /
    // delete in another window can't interleave with the multi-scene revert.
    const { restored, removedSceneIds } = await withBranchLock(
      { branchId: args.branchId, projectId: args.projectId, operation: 'restore' },
      async () => {
        // Flush pending autosave timers INSIDE the lock: flushed-then-locked
        // left a gap where a late same-process autosave could land between
        // the flush and the lock acquisition and be silently reverted
        // Other windows' saves are
        // held off by the writer gate while we hold the lock.
        await flushAllPendingVersions()
        return db.transaction(async (tx) => {
          const result = await restoreBranchToBatch(tx, args.branchId, args.key)
          // Update each live scene row so the editor loads the restored state.
          // (Scenes created after the cursor were already deleted in-tx.)
          for (const s of result.restored) {
            await tx
              .update(scenes)
              .set({ sceneBlob: s.layerSnapshot, updatedAt: new Date() })
              .where(eq(scenes.id, s.sceneId))
          }
          return result
        })
      },
    )

    for (const s of restored) await regenerateSceneHtml(s.sceneId, s.layerSnapshot)
    // Remove HTML files for scenes that didn't exist at the restore point.
    // Best-effort: an orphaned HTML file is inert once its scene row is gone.
    if (removedSceneIds.length > 0) {
      const scenesDir = resolveScenesDir()
      await Promise.allSettled(
        removedSceneIds.map((id) =>
          fs.unlink(path.join(scenesDir, `${id}.html`)).catch((unlinkErr) => {
            // ENOENT is fine (scene never rendered); log anything else.
            if ((unlinkErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              log.warn('restore: failed to remove HTML for scene created after cursor', {
                extra: { sceneId: id },
                error: unlinkErr,
              })
            }
          }),
        ),
      )
    }
    return { success: true, restoredSceneIds: restored.map((s) => s.sceneId), removedSceneIds }
  } catch (err: unknown) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

/** Full scene data (with layers/code) for loading a branch into the editor. */
async function loadEditorScenes(args: { projectId: string; branchId: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)
  // VS Code checkout pattern: flush any pending autosave version timers before
  // switching branches so the current branch's history is complete before unload.
  await flushAllPendingVersions()
  const result = await readProjectScenesFromTables(args.projectId, args.branchId)
  return { scenes: result?.scenes ?? [], sceneGraph: result?.sceneGraph ?? null }
}

async function listScenes(args: { projectId: string; branchId: string }) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)
  const sceneList = await getProjectScenesByBranch(args.projectId, args.branchId)
  return { scenes: sceneList }
}

// ── Branch-scoped agent proposals (0015) ──────────────────────────────────────

const PROPOSAL_FIELDS: ReadonlySet<ProposalField> = new Set<ProposalField>([
  'structuralCutsProposed',
  'pausedAgentRun',
  'runCheckpoint',
])

/** Read the full proposal row for (projectId, branchId). branchId null = default. */
async function getProposals(args: { projectId: string; branchId: string | null }) {
  assertValidUuid(args.projectId, 'projectId')
  // A non-null branchId must be a valid UUID (null = default branch, resolved
  // server-side). Mirrors validation on every other branch IPC method and
  // rejects malformed/cross-project ids before they reach branch_proposals.
  if (args.branchId != null) assertValidUuid(args.branchId, 'branchId')
  await loadProjectOrThrow(args.projectId)
  const proposals = await getBranchProposals(args.projectId, args.branchId ?? null)
  return { proposals }
}

/** Set (or clear, value=null) one proposal field. Returns the post-write version. */
async function setProposal(args: {
  projectId: string
  branchId: string | null
  field: ProposalField
  value: unknown
}) {
  assertValidUuid(args.projectId, 'projectId')
  if (args.branchId != null) assertValidUuid(args.branchId, 'branchId')
  if (!PROPOSAL_FIELDS.has(args.field)) {
    throw new IpcValidationError(`invalid proposal field: ${String(args.field)}`)
  }
  await loadProjectOrThrow(args.projectId)
  const version = await setProposalField(args.projectId, args.branchId ?? null, args.field, args.value ?? null)
  return { version }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:branches.list', (_e, args) => list(args))
  ipcMain.handle('dreambyte:branches.create', (_e, args) => create(args))
  ipcMain.handle('dreambyte:branches.rename', (_e, args) => rename(args))
  ipcMain.handle('dreambyte:branches.delete', (_e, args) => deleteHandler(args))
  ipcMain.handle('dreambyte:branches.setDefault', (_e, args) => setDefault(args))
  ipcMain.handle('dreambyte:branches.listVersions', (_e, args) => listVersions(args))
  ipcMain.handle('dreambyte:branches.restoreVersion', (_e, args) => restoreVersion(args))
  ipcMain.handle('dreambyte:branches.history', (_e, args) => history(args))
  ipcMain.handle('dreambyte:branches.restoreToPoint', (_e, args) => restoreToPoint(args))
  ipcMain.handle('dreambyte:branches.loadEditorScenes', (_e, args) => loadEditorScenes(args))
  ipcMain.handle('dreambyte:branches.listScenes', (_e, args) => listScenes(args))
  ipcMain.handle('dreambyte:branches.getProposals', (_e, args) => getProposals(args))
  ipcMain.handle('dreambyte:branches.setProposal', (_e, args) => setProposal(args))
}
