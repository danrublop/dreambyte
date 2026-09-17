import type { IpcMain } from 'electron'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { db } from '@/lib/db'
import { projects, projectAssets, scenes } from '@/lib/db/schema'
import { desc, eq, ne, isNull, lt, and, inArray, sql, SQL } from 'drizzle-orm'
import type { BrandKit } from '@/lib/types/media'
import { normalizeScenesForPersistence } from '@/lib/charts/normalize-scenes'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'
import {
  readProjectScenesFromTables,
  writeProjectScenesToTables,
  writeProjectScenesToTablesTx,
} from '@/lib/db/project-scene-table'
import { backfillProjectBranch, getOrCreateDefaultBranch, getBranch } from '@/lib/db/queries/branches'
import { scheduleSceneVersion } from '@/lib/db/queries/scene-versions'
import { withWriterGate, BranchWriterBlockedError } from '@/lib/db/queries/branch-locks'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError, IpcNotFoundError, IpcConflictError } from './_helpers'
import {
  patchAsset as svcPatchAsset,
  deleteAsset as svcDeleteAsset,
  regenerateAsset as svcRegenerateAsset,
  AssetValidationError,
  AssetNotFoundError,
} from '@/lib/services/assets'
import { uploadAsset as svcUploadAsset, UploadAssetValidationError } from '@/lib/services/upload-asset'
import { promoteDraftToReady, touchProject } from '@/lib/db/queries/projects'
import { resolveScenesDir } from '@/lib/scene-html-paths'

/**
 * M2 — strip `storagePath` from any asset row before it crosses the IPC
 * boundary. The renderer never needs the absolute filesystem path; it
 * works exclusively with the protocol-rewritten `publicUrl`. Keeping the
 * raw path on the renderer side leaks the user's home directory layout
 * and gives any future scene-iframe escape an absolute file path to abuse.
 */
type AssetRow = typeof projectAssets.$inferSelect
function stripStoragePath<T extends Partial<AssetRow>>(asset: T): Omit<T, 'storagePath'> {
  const { storagePath: _stripped, ...safe } = asset
  void _stripped
  return safe
}

/**
 * Category: projects
 *
 * Project CRUD, brand kit, and project-asset operations. Assets cross the
 * bridge as `ArrayBuffer + filename + mime` (or an on-disk path) — File/FormData
 * don't serialize through Electron IPC.
 */

const MAX_PROJECTS_PER_PAGE = 100
const MAX_SCENES = 200
const MAX_LOGO_ASSET_IDS = 32
const MAX_GLOBAL_STYLE_SIZE = 16 * 1024
const MAX_SETTINGS_SIZE = 16 * 1024
const SCRYPT_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/i

const DEFAULT_BRAND_KIT: BrandKit = {
  brandName: null,
  logoAssetIds: [],
  palette: [],
  fontPrimary: null,
  fontSecondary: null,
  guidelines: null,
}

type ListArgs = { limit?: number; cursor?: string; workspaceId?: string | 'none' }

async function list(args: ListArgs = {}) {
  const paginated = args.limit !== undefined || args.cursor !== undefined
  const limit = Math.min(Math.max(args.limit ?? 50, 1), MAX_PROJECTS_PER_PAGE)

  // Single-user desktop: no userId filter. List everything.
  const conditions: (SQL | undefined)[] = []
  // Hide projects mid-fork — their rows exist but assets may still be copying,
  // so they aren't openable yet (flipped to 'ready' when the fork completes) —
  // and soft-hidden drafts the startup sweep parked. Drafts proper
  // ('draft') stay listed: they are real, openable, just sweepable until first
  // activity promotes them to 'ready'.
  conditions.push(and(ne(projects.status, 'forking'), ne(projects.status, 'hidden')))
  if (args.workspaceId === 'none') {
    conditions.push(isNull(projects.workspaceId))
  } else if (args.workspaceId) {
    assertValidUuid(args.workspaceId, 'workspaceId')
    conditions.push(eq(projects.workspaceId, args.workspaceId))
  }
  if (args.cursor) {
    const cursorDate = new Date(args.cursor)
    if (!isNaN(cursorDate.getTime())) {
      conditions.push(lt(projects.updatedAt, cursorDate))
    }
  }

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      outputMode: projects.outputMode,
      thumbnailUrl: projects.thumbnailUrl,
      workspaceId: projects.workspaceId,
      updatedAt: projects.updatedAt,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(projects.updatedAt))
    .limit(paginated ? limit + 1 : limit)

  if (!paginated) return rows

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? (items[items.length - 1].updatedAt?.toISOString() ?? null) : null
  return { items, nextCursor }
}

type CreateArgs = {
  id?: string
  name?: string
  /** Lifecycle status at creation. Defaults to 'ready'; the
   *  zero-friction entry path passes 'draft' so untouched empties can be swept. */
  status?: 'ready' | 'draft'
  outputMode?: 'mp4' | 'interactive'
  globalStyle?: unknown
  mp4Settings?: unknown
  interactiveSettings?: unknown
  scenes?: unknown[]
  sceneGraph?: { nodes?: unknown[]; edges?: unknown[]; startSceneId?: string | null }
  apiPermissions?: unknown
  audioSettings?: unknown
  audioProviderEnabled?: unknown
  mediaGenEnabled?: unknown
  timeline?: unknown
  workspaceId?: string | null
}

async function create(args: CreateArgs) {
  if (args.id) assertValidUuid(args.id, 'id')
  if (args.workspaceId) assertValidUuid(args.workspaceId, 'workspaceId')
  if (args.outputMode && !['mp4', 'interactive'].includes(args.outputMode)) {
    throw new IpcValidationError(`Invalid outputMode: ${args.outputMode}`)
  }
  if (args.scenes && !Array.isArray(args.scenes)) {
    throw new IpcValidationError('scenes must be an array')
  }
  if (args.scenes && args.scenes.length > MAX_SCENES) {
    throw new IpcValidationError(`scenes array exceeds ${MAX_SCENES} item limit`)
  }
  if (Array.isArray(args.sceneGraph?.nodes) && args.sceneGraph.nodes.length > MAX_SCENES) {
    throw new IpcValidationError(`sceneGraph.nodes exceeds ${MAX_SCENES} item limit`)
  }
  // Mirror the size caps applied in `update`. Without these, a renderer
  // can ship 1 GB of junk here and OOM the main process before Postgres
  // ever sees the payload.
  if (args.globalStyle !== undefined && JSON.stringify(args.globalStyle).length > MAX_GLOBAL_STYLE_SIZE) {
    throw new IpcValidationError('globalStyle exceeds size limit')
  }
  if (args.mp4Settings !== undefined && JSON.stringify(args.mp4Settings).length > MAX_SETTINGS_SIZE) {
    throw new IpcValidationError('mp4Settings exceeds size limit')
  }
  if (args.interactiveSettings !== undefined && JSON.stringify(args.interactiveSettings).length > MAX_SETTINGS_SIZE) {
    throw new IpcValidationError('interactiveSettings exceeds size limit')
  }

  const [project] = await db
    .insert(projects)
    .values({
      ...(args.id ? { id: args.id } : {}),
      userId: null,
      workspaceId: args.workspaceId || null,
      name: (args.name || 'Untitled Project').slice(0, 255),
      status: args.status === 'draft' ? 'draft' : 'ready',
      outputMode: args.outputMode || 'mp4',
      globalStyle: (args.globalStyle as never) || {
        presetId: null,
        paletteOverride: null,
        bgColorOverride: null,
        fontOverride: null,
        bodyFontOverride: null,
        strokeColorOverride: null,
      },
      mp4Settings: (args.mp4Settings as never) || undefined,
      interactiveSettings: (args.interactiveSettings as never) || undefined,
      apiPermissions: (args.apiPermissions as never) || {},
      audioSettings: (args.audioSettings as never) || undefined,
      audioProviderEnabled: (args.audioProviderEnabled as never) || {},
      mediaGenEnabled: (args.mediaGenEnabled as never) || {},
      description: JSON.stringify({
        scenes: args.scenes || [],
        sceneGraph: args.sceneGraph || null,
        timeline: args.timeline || null,
      }),
    })
    .returning()
  return project
}

/**
 * ONE rule for both the read (get) and write (update) paths:
 * a caller-supplied branchId must be a uuid AND belong to the project, else
 * IpcNotFoundError. Read side: a foreign branch must not leak its scenes
 * (and an empty-list fallback would read as "everything deleted" to the
 * save-conflict merge). Write side: without this, a save racing a branch
 * deletion stamps scenes onto a dead/foreign branchId and reports 'saved'
 * — silent data loss.
 */
async function assertBranchInProject(projectId: string, branchId: string): Promise<void> {
  assertValidUuid(branchId, 'branchId')
  const requested = await getBranch(branchId)
  if (!requested || requested.projectId !== projectId) {
    throw new IpcNotFoundError(`Branch ${branchId} not found in project`)
  }
}

async function get(projectId: string, branchId?: string) {
  const project = await loadProjectOrThrow(projectId)

  // Validate branchId BEFORE any side effects fire: the
  // touch/promote/backfill below mutate rows — a malformed or foreign
  // branchId must be rejected without moving lastOpenedAt, un-hiding a
  // swept draft, or running the branch backfill.
  if (branchId !== undefined) {
    await assertBranchInProject(projectId, branchId)
  }

  // Record the open: the draft sweep's "never reopened" exclusion
  // reads lastOpenedAt — without this touch the column never moves past its
  // creation default and a deliberately-revisited (but still empty) draft
  // would be swept. Fire-and-forget; an open must not fail on a touch error.
  void touchProject(projectId).catch(() => {})
  // Reopen IS first real activity (promoteDraftToReady's documented contract):
  // promote drafts — and un-hide swept ones — on open. Without this, a
  // soft-hidden project stays invisible to list() forever even while the
  // user actively works in it, which strands the renderer in
  // localStorage-only mode on the next boot (and ITS saves then clobber the
  // DB timeline, e.g. audio clips vanishing on restart).
  void promoteDraftToReady(projectId).catch(() => {})

  const blobBacked = readProjectSceneBlob(project.description)

  // Blob → table migration for legacy projects (runs at most once per project)
  const unfiltered = await readProjectScenesFromTables(projectId)
  if (!unfiltered && blobBacked.scenes.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeProjectScenesToTables(projectId, blobBacked.scenes as any, blobBacked.sceneGraph as any)
    } catch (e) {
      console.error('[projects.get] lazy table backfill failed:', e)
    }
  }

  // Ensure all scenes have a branchId, then load only one branch's scenes.
  // This prevents scenes from other branches (clones) from appearing in the main editor.
  await backfillProjectBranch(projectId)
  const defaultBranch = await getOrCreateDefaultBranch(projectId)

  // Branch-aware read: the renderer's save-conflict
  // retry must compare against the scenes of the branch it WRITES to — the
  // default branch's scenes are a different document when the editor is on a
  // non-default branch, and merging against them resurrects/clobbers scenes.
  // No branchId keeps the historical default-branch behavior for every other
  // caller (loadProject, agent runs). branchId was validated at the top.
  const sceneBranchId = branchId ?? defaultBranch.id
  const tableBacked = await readProjectScenesFromTables(projectId, sceneBranchId)

  return {
    ...project,
    scenes: tableBacked?.scenes ?? blobBacked.scenes,
    sceneGraph: tableBacked?.sceneGraph ?? blobBacked.sceneGraph,
    zdogLibrary: blobBacked.zdogLibrary,
    timeline: blobBacked.timeline,
    defaultBranchId: defaultBranch.id,
  }
}

type UpdateArgs = { projectId: string; updates: Record<string, unknown> }

async function update({ projectId, updates }: UpdateArgs) {
  assertValidUuid(projectId, 'projectId')

  // Cap scenes/sceneGraph BEFORE any normalization runs — otherwise a
  // malicious caller can OOM the main process with a 10k-entry array
  // just by virtue of `normalizeScenesForPersistence` iterating it.
  if (updates.scenes !== undefined) {
    if (!Array.isArray(updates.scenes)) {
      throw new IpcValidationError('scenes must be an array')
    }
    if (updates.scenes.length > MAX_SCENES) {
      throw new IpcValidationError(`scenes array exceeds ${MAX_SCENES} item limit`)
    }
  }
  if (
    updates.sceneGraph !== undefined &&
    Array.isArray((updates.sceneGraph as { nodes?: unknown[] })?.nodes) &&
    ((updates.sceneGraph as { nodes: unknown[] }).nodes.length ?? 0) > MAX_SCENES
  ) {
    throw new IpcValidationError(`sceneGraph.nodes exceeds ${MAX_SCENES} item limit`)
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() }

  if (updates.workspaceId !== undefined) updateData.workspaceId = updates.workspaceId || null
  if (updates.name !== undefined) updateData.name = updates.name
  if (updates.outputMode !== undefined) {
    if (!['mp4', 'interactive'].includes(String(updates.outputMode))) {
      throw new IpcValidationError(`Invalid outputMode: ${updates.outputMode}`)
    }
    updateData.outputMode = updates.outputMode
  }
  if (updates.globalStyle !== undefined) {
    if (JSON.stringify(updates.globalStyle).length > MAX_GLOBAL_STYLE_SIZE) {
      throw new IpcValidationError('globalStyle exceeds size limit')
    }
    updateData.globalStyle = updates.globalStyle
  }
  if (updates.mp4Settings !== undefined) {
    if (JSON.stringify(updates.mp4Settings).length > MAX_SETTINGS_SIZE) {
      throw new IpcValidationError('mp4Settings exceeds size limit')
    }
    updateData.mp4Settings = updates.mp4Settings
  }
  if (updates.interactiveSettings !== undefined) {
    const settings = updates.interactiveSettings as { password?: string }
    if (settings?.password && !SCRYPT_HASH_RE.test(settings.password)) {
      const { hashPassword } = await import('@/lib/crypto')
      settings.password = hashPassword(settings.password)
    }
    updateData.interactiveSettings = settings
  }
  for (const key of [
    'apiPermissions',
    'audioSettings',
    'audioProviderEnabled',
    'mediaGenEnabled',
    'thumbnailUrl',
    'watermark',
    'brandKit',
    'structuralCutsProposed',
    'pausedAgentRun',
    'runCheckpoint',
  ] as const) {
    if (updates[key] !== undefined) updateData[key] = updates[key]
  }

  // Optimistic locking. `updates.baseVersion` is the version the CALLER last
  // observed — the only baseline that means anything. Reading the row's own
  // version here and then CAS-ing against it is not optimistic concurrency at
  // all: it re-reads whatever is current, so the write always matches and the
  // last writer wins. That is what let a renderer autosave (30s poll,
  // visibilitychange → Cmd+Tab/Cmd+Q) flush its PRE-RUN scene array over 20
  // scenes an agent had just written, and report success.
  //
  // Scene-bearing writes therefore MUST supply `baseVersion`; a stale one
  // fails the CAS and surfaces as IpcConflictError, which the renderer's save
  // path already handles by re-fetching and merging per-scene. Non-scene
  // updates (workspace move, thumbnail, brand kit) keep the old contract.
  if (updates.scenes !== undefined && typeof updates.baseVersion !== 'number') {
    throw new IpcValidationError('baseVersion is required when writing scenes')
  }
  const [existing] = await db
    .select({
      description: projects.description,
      version: projects.version,
      status: projects.status,
      name: projects.name,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
  if (!existing) throw new IpcNotFoundError(`Project ${projectId} not found`)

  const currentVersion = existing.version ?? 1
  // The CAS baseline: the caller's if it supplied one, else the row's own
  // (legacy behaviour, kept for the non-scene updates above).
  const casVersion = typeof updates.baseVersion === 'number' ? updates.baseVersion : currentVersion

  // Draft promotion: a draft (or a soft-hidden draft) becomes a
  // real 'ready' project on the first save that carries scene content or a
  // non-default name. Together with the message-activity promotion in the
  // conversations IPC, this is where first-activity flows through — it kills the
  // old lazy persist activity-detection whack-a-mole. A bare reopen (no save,
  // no message) keeps status='draft' but the sweep's reopen-detection
  // (lastOpenedAt) still excludes it from hiding.
  if (existing.status === 'draft' || existing.status === 'hidden') {
    const sceneHasContent = Array.isArray(updates.scenes)
      ? (updates.scenes as Array<Record<string, unknown>>).some(
          (s) => !!(s?.sceneHTML || s?.svgContent || s?.canvasCode || s?.sceneCode || s?.reactCode || s?.lottieSource),
        )
      : false
    const nextName = typeof updates.name === 'string' ? updates.name : existing.name
    const renamed = typeof nextName === 'string' && !/^Untitled Project \d+$/.test(nextName)
    if (sceneHasContent || renamed) {
      updateData.status = 'ready'
      updateData.hiddenAt = null
    }
  }

  // Normalize scenes ONCE and reuse for both the blob write and the
  // downstream table sync. The previous implementation walked the array
  // twice, doubling CPU cost on 200-scene saves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let normalizedScenes: any[] | null = null
  if (updates.scenes !== undefined || updates.sceneGraph !== undefined || updates.timeline !== undefined) {
    normalizedScenes =
      updates.scenes !== undefined
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (normalizeScenesForPersistence(updates.scenes as any) as any[])
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (readProjectSceneBlob(existing.description).scenes as any[])
    updateData.description = writeProjectSceneBlob(existing.description, {
      scenes: normalizedScenes as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sceneGraph: updates.sceneGraph !== undefined ? (updates.sceneGraph as any) : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      timeline: updates.timeline !== undefined ? (updates.timeline as any) : undefined,
    })
  }

  updateData.version = casVersion + 1

  // Content-bearing autosaves promote drafts (scene saves are "first real
  // activity" — see promoteDraftToReady). Keeps the startup sweep from ever
  // classifying an actively-edited project as a provably-empty draft. Fired
  // AFTER the write commits: it is a fire-and-forget statement on the shared
  // libsql connection, and one issued before the write lands mid-transaction —
  // "cannot commit transaction, SQL statements in progress". A save that
  // conflicts shouldn't promote anything anyway.
  const timelineHasClips =
    updates.timeline != null &&
    Array.isArray((updates.timeline as { tracks?: Array<{ clips?: unknown[] }> }).tracks) &&
    (updates.timeline as { tracks: Array<{ clips?: unknown[] }> }).tracks.some((t) => (t.clips?.length ?? 0) > 0)
  const shouldPromoteDraft = (normalizedScenes && normalizedScenes.length > 0) || timelineHasClips

  const writesScenes = (updates.scenes !== undefined || updates.sceneGraph !== undefined) && !!normalizedScenes
  let writerBranchId = typeof updates.branchId === 'string' ? updates.branchId : null
  // The write path gets the SAME branch validation as the
  // read path. A deleted/foreign branchId must fail the save loudly — not
  // stamp scene rows onto a branch that no longer exists while the renderer
  // reports 'saved'.
  if (writerBranchId) {
    await assertBranchInProject(projectId, writerBranchId)
  } else if (writesScenes) {
    // A scene write with NO branch is the cross-branch wipe: every delete in
    // writeProjectScenesToTables degrades to project-wide when `branchId` is
    // null, so one autosave from a renderer that hadn't resolved its branch
    // deleted EVERY other branch's scenes (plus their scene_nodes /
    // scene_edges, which the null-branch path also clears project-wide).
    // `intentionalClear` never gated that — it only guards the empty-input
    // case, not the `notInArray` delete.
    //
    // mcp-handler.ts closed this for the MCP path by always passing a branch;
    // resolve the same default the READ path uses (`get`) so the UI path can
    // never issue a project-wide delete either.
    writerBranchId = (await getOrCreateDefaultBranch(projectId)).id
  }

  // The actual project-row update + scene-table sync + version scheduling. When
  // this autosave carries scene content for a known branch, run it behind the
  // writer gate so it queues behind (never interleaves with) a concurrent
  // fork/restore/delete on that branch — otherwise a debounced autosave could
  // clobber a just-restored branch state. Fails loud if a destructive op holds
  // the branch past the bounded wait, so the save surfaces instead of racing.
  //
  // The project row and the scene tables are ONE write. `get()` reads the mirror
  // FIRST (`tableBacked?.scenes ?? blobBacked.scenes`), so as two writes a
  // SQLITE_BUSY past the 5s timeout would commit the new blob, leave the stale
  // mirror serving every read, and make the user's edit unreachable. Atomic beats loud here:
  // one transaction means the two can't disagree, and the caller already has a
  // retry/merge path for a failed save.
  const doWrite = async () => {
    const project = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(projects)
        .set(updateData)
        .where(and(eq(projects.id, projectId), eq(projects.version, casVersion)))
        .returning()

      if (!row) {
        // Dedicated error class so the caller's retry loop can `instanceof`
        // check instead of string-matching "conflict" in arbitrary messages
        // (which would catch unrelated SQL errors containing "ON CONFLICT").
        throw new IpcConflictError('Project was modified concurrently. Please retry.')
      }

      if (writesScenes && normalizedScenes) {
        const graphToWrite =
          updates.sceneGraph !== undefined ? updates.sceneGraph : readProjectSceneBlob(existing.description).sceneGraph
        // This is the store-authoritative user autosave: an empty scene set here
        // is a genuine "user deleted every scene" clear, not a persist filter
        // artifact — so authorize the full-branch delete (branch-scoped: see the
        // writerBranchId resolution above). The agent persist paths deliberately
        // omit this signal, so a `cleanScenesForAgentPersistence` that filtered
        // down to `[]` can no longer wipe a populated branch.
        await writeProjectScenesToTablesTx(
          tx,
          projectId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          normalizedScenes as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          graphToWrite as any,
          writerBranchId,
          { intentionalClear: true },
        )
      }

      return row
    })

    if (shouldPromoteDraft) await promoteDraftToReady(projectId).catch(() => {})

    // Post-commit only: version records are a side effect of a save that
    // actually landed, and scheduleSceneVersion writes on its own timer — it
    // must never sit inside (and extend) the write transaction.
    if (writesScenes && normalizedScenes && writerBranchId) {
      // Schedule version records for user edits using a 20-second transaction
      // window (Penpot pattern) + content diff check (tldraw pattern).
      // Rapid autosaves within the window collapse to one row; identical
      // saves are skipped entirely.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const scene of normalizedScenes as any[]) {
        if (!scene?.id) continue
        scheduleSceneVersion({
          sceneId: scene.id,
          branchId: writerBranchId,
          layerSnapshot: scene as Record<string, unknown>,
          operation: 'user_edit',
          source: 'user',
        })
      }
    }

    return project
  }

  try {
    if (writesScenes && writerBranchId) {
      return await withWriterGate({ branchId: writerBranchId, projectId }, doWrite)
    }
    return await doWrite()
  } catch (err) {
    if (err instanceof BranchWriterBlockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

// In dev, scenes live under `<repo>/public/scenes/*.html` (served by Next.js).
// In packaged Electron, they live under `<userData>/scenes/` (the writable
// mount used by the `dreambyte://scenes/*` protocol handler). Branch here so
// cleanup removes the right files regardless of mode.
// resolveScenesDir() is imported from src/lib/scene-html-paths — DREAMBYTE_SCENES_DIR
// is stamped by main.ts before any IPC handler runs.

function resolvePublishedDir(projectId: string): string {
  const base =
    process.env.DREAMBYTE_PUBLISHED_DIR ??
    (app.isPackaged ? path.join(app.getPath('userData'), 'published') : path.join(process.cwd(), 'public', 'published'))
  return path.join(base, projectId)
}

/**
 * Best-effort filesystem cleanup for a deleted/purged project:
 * scene HTML files, the published dir, and the project's userData data dir
 * (WAL + snapshots). Shared by the delete IPC and the startup draft sweep so a
 * swept draft frees the SAME on-disk state a manual delete does instead of
 * orphaning these files. `description` is
 * the project's scene blob (passed in so the caller can load the row before its
 * DB delete). Every step swallows its own error — cleanup never throws.
 */
async function cleanupProjectFiles(projectId: string, description?: string | null): Promise<void> {
  const scenesDir = resolveScenesDir()
  const publishedDir = resolvePublishedDir(projectId)
  if (description) {
    try {
      const parsed = readProjectSceneBlob(description)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sceneIds: string[] = (parsed.scenes || []).map((s: any) => s.id)
      await Promise.allSettled(sceneIds.map((sid) => fs.unlink(path.join(scenesDir, `${sid}.html`)).catch(() => {})))
    } catch {
      // Best-effort HTML cleanup; a malformed blob or missing file is non-fatal.
    }
  }
  await fs.rm(publishedDir, { recursive: true, force: true }).catch(() => {})
  // Remove the project's userData data dir (WAL + snapshots). Without this a
  // deleted project leaves an orphan WAL that boot replay retries against the
  // now-absent project_id FK on every launch.
  try {
    const { getProjectDataDir } = await import('../paths')
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true }).catch(() => {})
  } catch {
    // Best-effort removal of the project's userData dir; failure is non-fatal.
  }
}

/**
 * Load a project row by id and run the shared fs cleanup for it.
 * The draft-sweep purge hook: given only an id, it fetches the scene blob and
 * frees the on-disk state, then the sweep does the DB delete. Best-effort — a
 * missing row or read failure is swallowed (the sweep proceeds to delete the
 * row regardless).
 */
export async function cleanupProjectFilesById(projectId: string): Promise<void> {
  try {
    const [row] = await db.select({ description: projects.description }).from(projects).where(eq(projects.id, projectId))
    await cleanupProjectFiles(projectId, row?.description ?? null)
  } catch {
    // Best-effort — never block the purge.
  }
}

async function remove(projectId: string) {
  // Deliberately NOT loadProjectOrThrow: that helper rejects status='forking'
  // (half-built forks must not be OPENED), but deleting one is always-safe
  // cleanup — and the only manual escape hatch for a fork orphaned with a
  // live-looking heartbeat, which the boot sweep keeps sparing. Load the row
  // directly so stuck forks stay deletable.
  assertValidUuid(projectId, 'projectId')
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) throw new IpcNotFoundError(`Project ${projectId} not found`)
  await db.delete(projects).where(eq(projects.id, projectId))

  // Fire-and-forget the shared fs cleanup (background).
  cleanupProjectFiles(projectId, project.description).catch((err) =>
    console.error(`[projects.remove] Cleanup failed for ${projectId}:`, err),
  )

  return { ok: true as const }
}

async function listAssets(args: {
  projectId: string
  type?: 'image' | 'video' | 'svg'
  source?: 'upload' | 'generated'
}) {
  await loadProjectOrThrow(args.projectId)
  const conditions: SQL[] = [eq(projectAssets.projectId, args.projectId)]
  if (args.type && ['image', 'video', 'svg'].includes(args.type)) {
    conditions.push(eq(projectAssets.type, args.type))
  }
  if (args.source === 'upload' || args.source === 'generated') {
    conditions.push(eq(projectAssets.source, args.source))
  }
  const assets = await db
    .select()
    .from(projectAssets)
    .where(and(...conditions))
    .orderBy(desc(projectAssets.createdAt))
  return { assets: assets.map(stripStoragePath) }
}

async function updateBrandKit(args: { projectId: string; updates: Partial<BrandKit> }) {
  assertValidUuid(args.projectId, 'projectId')
  const [project] = await db
    .select({ brandKit: projects.brandKit })
    .from(projects)
    .where(eq(projects.id, args.projectId))
  if (!project) throw new IpcNotFoundError(`Project ${args.projectId} not found`)

  const current: BrandKit = (project.brandKit as BrandKit) ?? { ...DEFAULT_BRAND_KIT }
  const updated: BrandKit = { ...current }
  const { updates } = args

  if (typeof updates.brandName === 'string' || updates.brandName === null) {
    updated.brandName = updates.brandName as string | null
  }
  if (Array.isArray(updates.logoAssetIds)) {
    if (updates.logoAssetIds.length > MAX_LOGO_ASSET_IDS) {
      throw new IpcValidationError(`logoAssetIds exceeds ${MAX_LOGO_ASSET_IDS} item limit`)
    }
    // Must be UUIDs — otherwise `inArray` could silently match nothing
    // on coerced numeric values, and the DB parameter stream is cheaper
    // with a known shape.
    for (const id of updates.logoAssetIds) {
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new IpcValidationError('logoAssetIds entries must be valid UUIDs')
      }
    }
    if (updates.logoAssetIds.length > 0) {
      const existing = await db
        .select({ id: projectAssets.id })
        .from(projectAssets)
        .where(and(eq(projectAssets.projectId, args.projectId), inArray(projectAssets.id, updates.logoAssetIds)))
      const existingIds = new Set(existing.map((a) => a.id))
      updated.logoAssetIds = updates.logoAssetIds.filter((id) => existingIds.has(id))
    } else {
      updated.logoAssetIds = []
    }
  }
  if (Array.isArray(updates.palette)) {
    updated.palette = updates.palette.filter((c) => typeof c === 'string').slice(0, 8)
  }
  if (typeof updates.fontPrimary === 'string' || updates.fontPrimary === null) {
    updated.fontPrimary = updates.fontPrimary as string | null
  }
  if (typeof updates.fontSecondary === 'string' || updates.fontSecondary === null) {
    updated.fontSecondary = updates.fontSecondary as string | null
  }
  if (typeof updates.guidelines === 'string' || updates.guidelines === null) {
    updated.guidelines = updates.guidelines as string | null
  }

  await db.update(projects).set({ brandKit: updated }).where(eq(projects.id, args.projectId))
  return { brandKit: updated }
}

/**
 * Lightweight version check — returns scalar metadata without deserializing scene blobs.
 * Used by saveProjectToDb to replace the full ipc.get round-trip in the stripped-localStorage guard.
 */
async function getVersion(projectId: string) {
  assertValidUuid(projectId, 'projectId')

  const [projectRow] = await db
    .select({ version: projects.version, updatedAt: projects.updatedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!projectRow) throw new IpcNotFoundError(`Project ${projectId} not found`)

  const [sceneRow] = await db
    .select({
      sceneCount: sql<number>`count(*)`,
      hasRichContent: sql<number>`max(case when scene_blob is not null then 1 else 0 end)`,
    })
    .from(scenes)
    .where(eq(scenes.projectId, projectId))

  return {
    version: projectRow.version,
    updatedAt: projectRow.updatedAt,
    sceneCount: Number(sceneRow?.sceneCount ?? 0),
    hasRichContent: Boolean(sceneRow?.hasRichContent),
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:projects.list', (_e, args?: ListArgs) => list(args ?? {}))
  ipcMain.handle('dreambyte:projects.create', (_e, args: CreateArgs) => create(args))
  ipcMain.handle('dreambyte:projects.get', (_e, projectId: string, branchId?: string) => get(projectId, branchId))
  ipcMain.handle('dreambyte:projects.getVersion', (_e, projectId: string) => getVersion(projectId))
  ipcMain.handle('dreambyte:projects.update', (_e, args: UpdateArgs) => update(args))
  ipcMain.handle('dreambyte:projects.delete', (_e, projectId: string) => remove(projectId))
  ipcMain.handle(
    'dreambyte:projects.listAssets',
    (_e, args: { projectId: string; type?: 'image' | 'video' | 'svg'; source?: 'upload' | 'generated' }) =>
      listAssets(args),
  )
  ipcMain.handle('dreambyte:projects.updateBrandKit', (_e, args: { projectId: string; updates: Partial<BrandKit> }) =>
    updateBrandKit(args),
  )
  // Single-asset CRUD. Route the service's validation/not-found errors
  // through the existing IPC-side error classes so the renderer sees a
  // consistent shape across all categories.
  const mapAssetError = (err: unknown) => {
    if (err instanceof AssetValidationError) throw new IpcValidationError(err.message)
    if (err instanceof AssetNotFoundError) throw new IpcNotFoundError(err.message)
    if (err instanceof UploadAssetValidationError) throw new IpcValidationError(err.message)
    throw err
  }
  ipcMain.handle(
    'dreambyte:projects.patchAsset',
    async (_e, args: { projectId: string; assetId: string; name?: string; tags?: string[] }) => {
      try {
        const r = await svcPatchAsset(args)
        return { ...r, asset: stripStoragePath(r.asset) }
      } catch (err) {
        mapAssetError(err)
      }
    },
  )
  ipcMain.handle('dreambyte:projects.deleteAsset', async (_e, args: { projectId: string; assetId: string }) => {
    try {
      return await svcDeleteAsset(args)
    } catch (err) {
      mapAssetError(err)
    }
  })
  ipcMain.handle(
    'dreambyte:projects.regenerateAsset',
    async (
      _e,
      args: {
        projectId: string
        assetId: string
        promptOverride?: string
        model?: string
        aspectRatio?: string
        enhanceTags?: string[]
      },
    ) => {
      try {
        const r = await svcRegenerateAsset(args)
        return { ...r, asset: stripStoragePath(r.asset) }
      } catch (err) {
        mapAssetError(err)
      }
    },
  )
  ipcMain.handle(
    'dreambyte:projects.uploadAsset',
    async (
      _e,
      args: {
        projectId: string
        data?: ArrayBuffer
        filePath?: string
        mimeType: string
        originalName: string
        tags?: string[]
        name?: string | null
      },
    ) => {
      try {
        const r = await svcUploadAsset(args)
        return { ...r, asset: stripStoragePath(r.asset) }
      } catch (err) {
        mapAssetError(err)
      }
    },
  )
}
