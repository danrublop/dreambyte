import type { IpcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { eq, and, lt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projects, projectBranches, projectAssets, scenes } from '@/lib/db/schema'
import { getUploadsDir } from '@/lib/uploads/paths'
import { copyBranchScenes, createBranch, getBranch, type SceneIdPair } from '@/lib/db/queries/branches'
import { rewriteAssetRefs, rewriteAssetRefsInString, type ForkRefRewrite } from '@/lib/db/queries/fork-refs'
import { flushAllPendingVersions } from '@/lib/db/queries/scene-versions'
import { withBranchLock, BranchLockedError, anyLiveLockForOperation } from '@/lib/db/queries/branch-locks'
import { resolveScenesDir } from '@/lib/scene-html-paths'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError, IpcNotFoundError } from './_helpers'
import { createLogger } from '@/lib/logger'

const log = createLogger('electron.ipc.fork')

// A fork is "in progress" while status='forking'. A crashed fork leaves that row
// behind; the sweep below reclaims it. A LIVE fork heartbeats the forking row's
// updatedAt while it copies (see FORK_HEARTBEAT_MS), so the sweep only reclaims
// rows whose updatedAt is older than this threshold — a still-running multi-GB
// copy in another window keeps a fresh updatedAt and is never reclaimed. The
// threshold is the crash-recovery backstop (heartbeat stopped → reclaim after).
const FORK_ORPHAN_THRESHOLD_MS = 30 * 60 * 1000

// While a fork copies, it touches the forking project's updatedAt on this
// cadence so the sweep's "updatedAt older than the threshold" check spares a
// live (even multi-GB, multi-minute) fork. Well under the orphan threshold.
const FORK_HEARTBEAT_MS = 10_000

/**
 * Copy every asset (DB row + files on disk) from one project to another, giving
 * each a fresh id and its own files under the destination project's upload dir.
 * Returns the old→new maps for reference rewriting plus the list of files
 * written (the rollback manifest).
 */
async function copyProjectAssets(
  srcProjectId: string,
  dstProjectId: string,
  // Caller-owned so already-copied files are recorded for rollback even if this
  // throws partway through the copy.
  manifestFiles: string[],
): Promise<{ rewrite: ForkRefRewrite; assetCount: number }> {
  const assetIdMap = new Map<string, string>()
  const urlMap = new Map<string, string>()

  const assets = await db.select().from(projectAssets).where(eq(projectAssets.projectId, srcProjectId))
  const rewrite: ForkRefRewrite = { srcProjectId, dstProjectId, assetIdMap, urlMap }
  if (assets.length === 0) return { rewrite, assetCount: 0 }

  // Map every asset id up front so the file-tree copy can rename by id.
  for (const a of assets) assetIdMap.set(a.id, randomUUID())

  const uploads = getUploadsDir()
  const srcDir = path.join(uploads, 'projects', srcProjectId)
  const dstDir = path.join(uploads, 'projects', dstProjectId)
  await fs.mkdir(dstDir, { recursive: true })

  // Copy the whole project upload tree — files live both at the top level
  // (<id>_name, <id>_thumb.jpg) AND in subdirs (ingested/<id>.ext for URL/yt-dlp
  // media), so a flat readdir would silently miss the subdir assets. Rename any
  // file whose basename starts with a source asset id (UUIDs are 36 chars).
  await copyUploadTree(srcDir, dstDir, assetIdMap, manifestFiles)

  // Swap the project segment and the basename's leading asset id in a url/path,
  // preserving any subdirectory (e.g. .../ingested/...).
  const swapBasenameId = (p: string, oldId: string, newId: string) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(path.sep))
    const dir = i >= 0 ? p.slice(0, i + 1) : ''
    const base = i >= 0 ? p.slice(i + 1) : p
    return dir + (base.startsWith(oldId) ? newId + base.slice(oldId.length) : base)
  }
  const remapUrl = (u: string, oldId: string, newId: string) =>
    swapBasenameId(u.split(`/projects/${srcProjectId}/`).join(`/projects/${dstProjectId}/`), oldId, newId)

  const newRows: (typeof assets)[number][] = []
  for (const a of assets) {
    const newId = assetIdMap.get(a.id)!
    const newPublicUrl = a.publicUrl ? remapUrl(a.publicUrl, a.id, newId) : a.publicUrl
    const newThumb = a.thumbnailUrl ? remapUrl(a.thumbnailUrl, a.id, newId) : a.thumbnailUrl
    // storagePath is an absolute fs path under srcDir → rebase onto dstDir.
    // Containment requires the separator: bare startsWith(srcDir) accepted a
    // prefix-sibling like `<srcDir>-evil`, after which path.relative emits
    // `..` segments and the rebase escapes dstDir.
    let newStoragePath = a.storagePath
    if (a.storagePath && a.storagePath.startsWith(srcDir + path.sep)) {
      newStoragePath = swapBasenameId(path.join(dstDir, path.relative(srcDir, a.storagePath)), a.id, newId)
    }
    if (a.publicUrl && newPublicUrl) urlMap.set(a.publicUrl, newPublicUrl)
    if (a.thumbnailUrl && newThumb) urlMap.set(a.thumbnailUrl, newThumb)

    newRows.push({
      ...a,
      id: newId,
      projectId: dstProjectId,
      storagePath: newStoragePath,
      publicUrl: newPublicUrl,
      thumbnailUrl: newThumb,
      // Provenance ids point at other assets in THIS project — remap if copied.
      parentAssetId: a.parentAssetId ? (assetIdMap.get(a.parentAssetId) ?? a.parentAssetId) : a.parentAssetId,
      createdAt: new Date(),
    })
  }

  if (newRows.length > 0) await db.insert(projectAssets).values(newRows)
  return { rewrite, assetCount: newRows.length }
}

/** Recursively copy a project's upload dir, renaming files whose basename starts
 *  with a source asset id. Records every written path for rollback. */
async function copyUploadTree(
  srcRoot: string,
  dstRoot: string,
  idMap: Map<string, string>,
  manifest: string[],
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(srcRoot, { withFileTypes: true })
  } catch {
    return // dir doesn't exist (remote-only assets) — nothing to copy
  }
  for (const e of entries) {
    const from = path.join(srcRoot, e.name)
    // Never follow symlinks: uploads are app-written regular files/dirs, so a
    // symlinked entry is never legitimate — and readdir's Dirent reports a
    // symlink as isSymbolicLink() (NOT isDirectory), which would otherwise fall
    // into the copyFile branch below, where copyFile FOLLOWS the link and
    // pulls content from outside the project's upload tree into the fork.
    if (e.isSymbolicLink()) {
      log.warn('fork: skipping symlink in upload tree', { extra: { from } })
      continue
    }
    if (e.isDirectory()) {
      const dstSub = path.join(dstRoot, e.name)
      await fs.mkdir(dstSub, { recursive: true })
      await copyUploadTree(from, dstSub, idMap, manifest)
    } else if (e.isFile()) {
      const newId = idMap.get(e.name.slice(0, 36)) // UUID length
      const newName = newId ? newId + e.name.slice(36) : e.name
      const to = path.join(dstRoot, newName)
      // Re-check at copy time: the Dirent's type is a readdir-time snapshot
      // and copyFile re-resolves the path AND follows symlinks — without
      // this, a file swapped for a symlink between readdir and copy would
      // smuggle out-of-tree content into the fork (TOCTOU on the B7 guard).
      const st = await fs.lstat(from).catch(() => null)
      if (!st || !st.isFile()) {
        log.warn('fork: upload entry changed type between readdir and copy — skipping', { extra: { from } })
        continue
      }
      await fs.copyFile(from, to)
      manifest.push(to)
    }
    // Other entry kinds (sockets, FIFOs, devices) are silently skipped — none
    // belong in an upload tree.
  }
}

/**
 * Copy each source scene's HTML file to its cloned scene id, REWRITING embedded
 * asset references to the fork's own project/asset ids as it goes. The plain
 * intra-project clone can raw-copy HTML (it shares the source's assets), but a
 * fork gets its own asset copies — so a raw copy would leave the forked scene's
 * HTML pointing at `/projects/<sourceProjectId>/...`, which breaks the moment the
 * source is deleted. Rewriting makes the fork truly standalone.
 *
 * Unlike the best-effort clone copy, a fork copy failure is FATAL: it returns
 * the failed dst ids so the caller fails the fork (a fork with missing/stale
 * scene HTML is not the standalone artifact the user asked for). Returns the
 * written dst ids for the rollback manifest.
 */
async function copyAndRewriteSceneHtmlForFork(
  idMap: SceneIdPair[],
  rewrite: ForkRefRewrite,
): Promise<{ writtenDstIds: string[]; failures: { dstId: string; error: unknown }[] }> {
  const writtenDstIds: string[] = []
  const failures: { dstId: string; error: unknown }[] = []
  if (idMap.length === 0) return { writtenDstIds, failures }
  const scenesDir = resolveScenesDir()
  for (const { srcId, dstId } of idMap) {
    try {
      const srcHtml = await fs.readFile(path.join(scenesDir, `${srcId}.html`), 'utf-8')
      const rewritten = rewriteAssetRefsInString(srcHtml, rewrite)
      // Path-escape guard (dstId is a fresh UUID, but defend in depth).
      const destPath = path.resolve(path.join(scenesDir, `${dstId}.html`))
      if (!destPath.startsWith(scenesDir + path.sep)) throw new Error('invalid dst scene id path')
      await fs.writeFile(destPath, rewritten, 'utf-8')
      writtenDstIds.push(dstId)
    } catch (err) {
      // ENOENT on the source is tolerated: a scene that never rendered has no
      // HTML file, and the forked scene regenerates it on first save. Any other
      // error (read/write/disk) fails the fork.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        log.warn('fork: source scene HTML missing, skipping (will regenerate on save)', {
          extra: { srcId, dstId },
        })
        continue
      }
      failures.push({ dstId, error: err })
    }
  }
  return { writtenDstIds, failures }
}

/** Undo a partial fork: remove rows for the new project + every file written. */
async function rollbackFork(newProjectId: string, manifestFiles: string[]): Promise<void> {
  try {
    // FK enforcement is off per-connection, so delete children explicitly.
    const branchRows = await db
      .select({ id: projectBranches.id })
      .from(projectBranches)
      .where(eq(projectBranches.projectId, newProjectId))
    await db.delete(scenes).where(eq(scenes.projectId, newProjectId))
    await db.delete(projectAssets).where(eq(projectAssets.projectId, newProjectId))
    for (const b of branchRows) await db.delete(projectBranches).where(eq(projectBranches.id, b.id))
    await db.delete(projects).where(eq(projects.id, newProjectId))
  } catch (err) {
    log.warn('fork rollback: row cleanup failed', { extra: { newProjectId }, error: err })
  }
  // Delete only the files we recorded — never a blind directory wipe.
  await Promise.allSettled(manifestFiles.map((f) => fs.unlink(f).catch(() => {})))
}

/**
 * Fork a branch into a brand-new, fully standalone project: copies project
 * config, the branch's scenes (+ HTML), and every referenced asset (files +
 * rows), rewriting all asset references to the new project. The new project is
 * created status='forking' and only flipped to 'ready' once everything is in
 * place, so a half-built fork is never openable. Any failure rolls back rows +
 * files. Holds the source branch lock for the duration so a concurrent
 * delete/restore can't pull the rug out.
 */
export async function forkBranchToProject(args: {
  sourceProjectId: string
  sourceBranchId: string
  name?: string
}): Promise<{ projectId: string; sceneCount: number; assetCount: number }> {
  assertValidUuid(args.sourceProjectId, 'sourceProjectId')
  assertValidUuid(args.sourceBranchId, 'sourceBranchId')
  await loadProjectOrThrow(args.sourceProjectId)

  const [srcProject] = await db.select().from(projects).where(eq(projects.id, args.sourceProjectId)).limit(1)
  if (!srcProject) throw new IpcNotFoundError(`Project ${args.sourceProjectId} not found`)
  const srcBranch = await getBranch(args.sourceBranchId)
  if (!srcBranch || srcBranch.projectId !== args.sourceProjectId) {
    throw new IpcValidationError('Branch does not belong to this project')
  }

  try {
    return await withBranchLock(
      { branchId: args.sourceBranchId, projectId: args.sourceProjectId, operation: 'fork' },
      async () => {
        // Re-validate inside the lock: between the pre-lock check and acquiring
        // the lock, another window could have deleted the branch. Without this
        // we'd fork a stale id into an empty 'ready' project.
        const liveBranch = await getBranch(args.sourceBranchId)
        if (!liveBranch || liveBranch.projectId !== args.sourceProjectId) {
          throw new IpcValidationError('Branch no longer exists')
        }
        // Flush this process's pending autosaves so the fork reads a settled branch.
        await flushAllPendingVersions()

        const newProjectId = randomUUID()
        const manifestFiles: string[] = []
        // Heartbeat the forking project's updatedAt while the (possibly multi-GB,
        // multi-minute) copy runs. The orphan sweep spares any 'forking' row with
        // a recent updatedAt, so this keeps a LIVE fork from being reclaimed
        // mid-copy. Also keeps the source branch lock fresh on the same cadence.
        let forkHeartbeat: ReturnType<typeof setInterval> | undefined
        try {
          // 1. New project, marked in-progress, carrying the source's render config.
          await db.insert(projects).values({
            id: newProjectId,
            userId: srcProject.userId,
            workspaceId: srcProject.workspaceId,
            name: (args.name?.trim() || `${srcProject.name} (fork)`).slice(0, 255),
            status: 'forking',
            outputMode: srcProject.outputMode,
            storageMode: srcProject.storageMode,
            globalStyle: srcProject.globalStyle,
            mp4Settings: srcProject.mp4Settings,
            interactiveSettings: srcProject.interactiveSettings,
            audioSettings: srcProject.audioSettings,
            audioProviderEnabled: srcProject.audioProviderEnabled,
            mediaGenEnabled: srcProject.mediaGenEnabled,
            agentConfig: srcProject.agentConfig,
            // Spend/approval state does NOT carry over — a new project starts clean.
            apiPermissions: {},
          })

          // Start the liveness heartbeat now that the forking row exists. (The
          // source branch lock is independently heartbeated by withBranchLock.)
          forkHeartbeat = setInterval(() => {
            void db
              .update(projects)
              .set({ updatedAt: new Date() })
              .where(eq(projects.id, newProjectId))
              .catch((e) => log.warn('fork: project heartbeat failed', { extra: { newProjectId }, error: e }))
          }, FORK_HEARTBEAT_MS)
          if (typeof forkHeartbeat.unref === 'function') forkHeartbeat.unref()

          // 2. Default branch for the new project.
          const branch = await createBranch({ projectId: newProjectId, name: 'main', isDefault: true })

          // 3. Copy assets (files + rows) and build the rewrite maps. Files are
          //    pushed into manifestFiles as they're copied, so a mid-copy failure
          //    still leaves a complete rollback manifest.
          const { rewrite, assetCount } = await copyProjectAssets(args.sourceProjectId, newProjectId, manifestFiles)

          // 4. Remap watermark/brandKit asset references on the project row.
          await db
            .update(projects)
            .set({
              watermark: rewriteAssetRefs(srcProject.watermark, rewrite),
              brandKit: rewriteAssetRefs(srcProject.brandKit, rewrite),
            })
            .where(eq(projects.id, newProjectId))

          // 5. Copy the branch's scenes (rows + embedded id rewrite via the helper).
          const sceneIdMap: SceneIdPair[] = await db.transaction((tx) =>
            copyBranchScenes(tx, {
              sourceProjectId: args.sourceProjectId,
              sourceBranchId: args.sourceBranchId,
              targetBranchId: branch.id,
              targetProjectId: newProjectId,
            }),
          )

          // 6. Rewrite asset references inside each cloned scene (sceneBlob +
          //    the video/audio layer columns the spread carried over).
          for (const pair of sceneIdMap) {
            const [row] = await db.select().from(scenes).where(eq(scenes.id, pair.dstId)).limit(1)
            if (!row) continue
            await db
              .update(scenes)
              .set({
                sceneBlob: rewriteAssetRefs(row.sceneBlob, rewrite),
                videoLayer: rewriteAssetRefs(row.videoLayer, rewrite),
                audioLayer: rewriteAssetRefs(row.audioLayer, rewrite),
              })
              .where(eq(scenes.id, pair.dstId))
          }

          // 7. Copy scene HTML files (global dir, keyed by the new scene ids),
          //    rewriting embedded asset refs to the fork's own project/assets so
          //    the fork is standalone. A copy failure (other than a missing
          //    source) is FATAL — record written files first so rollback cleans
          //    them, then throw.
          const { writtenDstIds, failures } = await copyAndRewriteSceneHtmlForFork(sceneIdMap, rewrite)
          const scenesDir = resolveScenesDir()
          manifestFiles.push(...writtenDstIds.map((id) => path.join(scenesDir, `${id}.html`)))
          if (failures.length > 0) {
            const first = failures[0]
            throw new Error(
              `fork failed copying scene HTML (${failures.length} scene${failures.length > 1 ? 's' : ''}): ${
                first.error instanceof Error ? first.error.message : String(first.error)
              }`,
            )
          }

          // 8. Done — make it openable.
          await db.update(projects).set({ status: 'ready', updatedAt: new Date() }).where(eq(projects.id, newProjectId))

          return { projectId: newProjectId, sceneCount: sceneIdMap.length, assetCount }
        } catch (err) {
          await rollbackFork(newProjectId, manifestFiles)
          throw err
        } finally {
          if (forkHeartbeat) clearInterval(forkHeartbeat)
        }
      },
    )
  } catch (err) {
    if (err instanceof BranchLockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

/** Remove a project's files when its rollback manifest is gone (crash recovery):
 *  the whole upload dir + every scene HTML file for the project. Best-effort. */
async function removeProjectFiles(projectId: string): Promise<void> {
  try {
    const sceneRows = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.projectId, projectId))
    const scenesDir = resolveScenesDir()
    await Promise.allSettled(sceneRows.map((s) => fs.unlink(path.join(scenesDir, `${s.id}.html`)).catch(() => {})))
  } catch (err) {
    log.warn('sweep: scene HTML cleanup failed', { extra: { projectId }, error: err })
  }
  await fs
    .rm(path.join(getUploadsDir(), 'projects', projectId), { recursive: true, force: true })
    .catch(() => {})
}

/**
 * Reclaim projects left in 'forking' by a crashed fork. Conservative: only
 * sweeps rows older than the orphan threshold, so a slow fork still running in
 * another window (recent updatedAt) is never deleted. Removes the orphan's files
 * (upload dir + scene HTML) before its rows, since a crash leaves no manifest.
 */
export async function sweepOrphanForks(now: number = Date.now()): Promise<number> {
  // Defer the whole cycle while any fork lock is live. The heartbeat on
  // updatedAt already spares a live fork, but if that heartbeat ever stalls
  // (event-loop starvation during a huge copy step) the lock's own heartbeat
  // is the second witness. Dest rows carry no lineage to the source lock, so
  // this is deliberately global — the sweep re-runs at the next app boot
  // (its only trigger today; there is no interval timer).
  if (await anyLiveLockForOperation('fork')) {
    log.info('orphan-fork sweep deferred: a fork lock is live')
    return 0
  }
  const cutoff = new Date(now - FORK_ORPHAN_THRESHOLD_MS)
  const orphans = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.status, 'forking'), lt(projects.updatedAt, cutoff)))
  for (const o of orphans) {
    await removeProjectFiles(o.id) // query scene ids BEFORE rollback deletes them
    await rollbackFork(o.id, [])
  }
  if (orphans.length > 0) log.info('swept orphaned forks', { extra: { count: orphans.length } })
  return orphans.length
}

async function forkHandler(args: { sourceProjectId: string; sourceBranchId: string; name?: string }) {
  return forkBranchToProject(args)
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:branches.fork', (_e, args) => forkHandler(args))
  // Best-effort orphan sweep at registration (app boot). Never blocks startup.
  void sweepOrphanForks().catch((err) => log.warn('fork sweep on boot failed', { error: err }))
}
