import { db } from '../index'
import { projects, scenes, messages } from '../schema'
import { eq, and, inArray, sql } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { Scene, SceneGraph, GlobalStyle, ProjectBrief } from '@/lib/types'
import { normalizeScenesForPersistence } from '@/lib/charts/normalize-scenes'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'
import { isPlaceholderContent } from '@/lib/scenes/placeholder-content'
import { writeProjectScenesToTablesTx } from '@/lib/db/project-scene-table'
import { createLogger } from '@/lib/logger'
import { getBranch, getOrCreateDefaultBranch } from './branches'
import { createSceneVersion, flushAllPendingVersions } from './scene-versions'
import { setProposalField } from './branch-proposals'
import { withWriterGate } from './branch-locks'

const log = createLogger('db.projects')

export type Project = InferSelectModel<typeof projects>
export type NewProject = InferInsertModel<typeof projects>

/**
 * Light scene read for the agent path (run-start merge + CC final sync).
 *
 * The agent consumers only read scenes, and the full Scene already lives in
 * sceneBlob, so no layers/media/interactions/sceneEdges joins. This reads scene rows alone,
 * all branches (the merge's CODE-FILL leg must match variant runs' source-
 * branch client scenes by id, so callers branch-scope the APPEND leg
 * themselves via filterScenesToBranch).
 *
 * The returned object is the sceneBlob with `id` and `branchId` stamped from
 * the TABLE columns — the blob is the renderer's Scene object and may predate
 * branch stamping (or carry a stale copy), while the table column is
 * authoritative. mergeServerScenes' branch scoping reads `scene.branchId`, so
 * dropping the stamp would silently degrade every row to "null branch →
 * default".
 *
 * NOT the same as readProjectScenesFromTables (project-scene-table.ts): that
 * returns the raw blob cast as Scene (no table stamp) plus the scene graph,
 * and supports branch filtering. The table-over-blob stamp here IS this
 * function's contract — do not "unify" the two without preserving it.
 */
export async function getProjectScenesLight(projectId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.query.scenes.findMany({
    where: eq(scenes.projectId, projectId),
    orderBy: (s, { asc }) => [asc(s.position)],
    columns: { id: true, branchId: true, sceneBlob: true },
  })
  return rows.map((r) => {
    const blob = r.sceneBlob && typeof r.sceneBlob === 'object' ? (r.sceneBlob as Record<string, unknown>) : {}
    const out = { ...blob, id: r.id, branchId: r.branchId ?? null }
    // JSON.parse can hand back an OWN `__proto__` data property (it never
    // pollutes the chain, and the spread above only shadows). Drop it so a
    // future deep-merge consumer of scene objects can't be turned into a
    // pollution sink (defense-in-depth; no current consumer merges these).
    if (Object.prototype.hasOwnProperty.call(out, '__proto__')) delete (out as Record<string, unknown>)['__proto__']
    return out
  })
}

/**
 * Read just the per-project settings columns an agent run needs (no scenes, no
 * relations). Used by the cross-project isolation loader (src/lib/services/
 * load-target-project-row.ts) to build a TARGET project's leg without pulling
 * the whole project graph. Returns null if the project does not exist.
 */
export async function getProjectSettingsRow(projectId: string) {
  const rows = await db
    .select({
      name: projects.name,
      outputMode: projects.outputMode,
      globalStyle: projects.globalStyle,
      mp4Settings: projects.mp4Settings,
      apiPermissions: projects.apiPermissions,
      audioProviderEnabled: projects.audioProviderEnabled,
      mediaGenEnabled: projects.mediaGenEnabled,
      projectBrief: projects.projectBrief,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (rows.length === 0) return null
  return rows[0]
}

/**
 * Read ONLY a project's legacy scene blob (the `description` JSON). The
 * cross-project loader falls back to this when a target has no scene-table rows
 * (a brand-new project, or an un-migrated blob-only legacy project), so the leg
 * runs against the project's REAL content. Kept separate from
 * getProjectSettingsRow so the common (migrated) path doesn't pull the blob.
 * Returns null if the project does not exist.
 */
export async function getProjectDescription(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ description: projects.description })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (rows.length === 0) return null
  return rows[0].description ?? null
}

/**
 * Run the startup draft sweep: soft-hide provably-untouched
 * empty drafts and hard-purge drafts hidden for >7 days. Reads candidates,
 * classifies them with the pure planDraftSweep, then applies the plan. Returns
 * the plan for logging/tests. Best-effort — callers fire-and-forget at boot.
 */
export async function runDraftSweep(
  now: number = Date.now(),
  /** fs-cleanup hook for purged ids (COMMIT 5); main.ts supplies it. */
  cleanupFs?: (projectId: string) => Promise<void>,
) {
  const { planDraftSweep } = await import('@/lib/store/draft-sweep')
  const candidates = await getDraftSweepCandidates()
  const plan = planDraftSweep(candidates, now)
  if (plan.toHide.length > 0 || plan.toPurge.length > 0) {
    await applyDraftSweep(plan, cleanupFs)
    log.info('draft sweep', { extra: { hidden: plan.toHide.length, purged: plan.toPurge.length } })
  }
  return plan
}

export async function createProject(data: NewProject) {
  const [project] = await db.insert(projects).values(data).returning()
  return project
}

export async function updateProject(projectId: string, data: Partial<NewProject>) {
  const [project] = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning()
  return project
}

/**
 * Cheap existence check — does this project still have a row? Used by boot-time
 * WAL replay to skip orphan project directories (deleted projects, or a create
 * that never committed its row) instead of failing every action_log insert
 * against the `project_id -> projects.id` foreign key.
 */
export async function projectExists(projectId: string): Promise<boolean> {
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)
  return rows.length > 0
}

export async function touchProject(projectId: string) {
  // lastOpenedAt ONLY — deliberately not updatedAt: an open is not an edit, and
  // bumping updatedAt here would churn the recents ordering and the optimistic
  // save-conflict freshness checks on every open. The draft sweep's
  // "never reopened" exclusion (draft-sweep.ts) is the consumer.
  await db.update(projects).set({ lastOpenedAt: new Date() }).where(eq(projects.id, projectId))
}

/**
 * Promote a draft (or soft-hidden draft) to a real 'ready' project . Called on first real activity — a chat message, a rename, a scene save,
 * or a reopen — so the startup sweep stops considering it. No-op for rows that
 * aren't drafts (the WHERE gate), so it's cheap + safe to call broadly. Clears
 * hiddenAt so a previously-swept draft un-hides on activity.
 */
export async function promoteDraftToReady(projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ status: 'ready', hiddenAt: null })
    .where(and(eq(projects.id, projectId), inArray(projects.status, ['draft', 'hidden'])))
}

/**
 * Apply a draft sweep plan: SOFT-hide the given draft ids (status -> 'hidden',
 * stamp hiddenAt) and HARD-purge the given already-hidden ids. The decision of
 * WHICH ids lives in src/lib/store/draft-sweep.ts (pure + unit-tested); this only
 * applies it. Re-checks status in the WHERE so a draft promoted between the
 * read and the write is never hidden out from under live activity.
 */
export async function applyDraftSweep(
  plan: { toHide: string[]; toPurge: string[] },
  /**
   * Optional fs-cleanup hook (COMMIT 5). Called per purged id BEFORE the DB
   * delete so the purge frees the SAME on-disk state a manual delete does
   * (scene HTML, published dir, project data dir). main.ts wires this to
   * src/electron/ipc/projects.ts `cleanupProjectFiles` (the sweep runs in main, so
   * it has fs access). Omitted in tests / non-Electron callers — purge then
   * does the DB delete only, as before.
   */
  cleanupFs?: (projectId: string) => Promise<void>,
): Promise<void> {
  const now = new Date()
  for (const id of plan.toHide) {
    await db
      .update(projects)
      .set({ status: 'hidden', hiddenAt: now })
      .where(and(eq(projects.id, id), eq(projects.status, 'draft')))
  }
  for (const id of plan.toPurge) {
    // Free on-disk state BEFORE removing the row (the cleanup reads the row).
    // The hook is best-effort and swallows its own errors.
    if (cleanupFs) {
      try {
        await cleanupFs(id)
      } catch {
        // A cleanup failure must not block the row purge.
      }
    }
    // Hard-delete only rows STILL hidden — never a draft, never a ready project.
    await db.delete(projects).where(and(eq(projects.id, id), eq(projects.status, 'hidden')))
  }
}

/**
 * Read the draft/hidden candidate rows the startup sweep classifies. Pulls
 * per-project scene + message counts so the pure classifier can apply the
 * "provably untouched empty" predicate. Only draft/hidden rows are returned —
 * a 'ready' project is never a sweep candidate.
 */
export async function getDraftSweepCandidates(): Promise<
  Array<{
    id: string
    status: string
    name: string
    sceneCount: number
    messageCount: number
    createdAt: number
    lastOpenedAt: number | null
    hiddenAt: number | null
  }>
> {
  const rows = await db
    .select({
      id: projects.id,
      status: projects.status,
      name: projects.name,
      description: projects.description,
      createdAt: projects.createdAt,
      lastOpenedAt: projects.lastOpenedAt,
      hiddenAt: projects.hiddenAt,
    })
    .from(projects)
    .where(inArray(projects.status, ['draft', 'hidden']))

  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const sceneCounts = await db
    .select({ projectId: scenes.projectId, count: sql<number>`count(*)` })
    .from(scenes)
    .where(inArray(scenes.projectId, ids))
    .groupBy(scenes.projectId)
  const msgCounts = await db
    .select({ projectId: messages.projectId, count: sql<number>`count(*)` })
    .from(messages)
    .where(inArray(messages.projectId, ids))
    .groupBy(messages.projectId)

  const sceneMap = new Map(sceneCounts.map((r) => [r.projectId, Number(r.count)]))
  const msgMap = new Map(msgCounts.map((r) => [r.projectId, Number(r.count)]))

  // The scenes TABLE lags the description blob (table sync is lazy, on first
  // ipc.get) — counting only the table once classified an actively-edited
  // drop-media project as "provably empty" and soft-hid it. Count BOTH.
  const blobSceneCount = (description: string | null): number => {
    if (!description) return 0
    try {
      const parsed = JSON.parse(description)
      return Array.isArray(parsed?.scenes) ? parsed.scenes.length : 0
    } catch {
      return 0
    }
  }

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    name: r.name,
    sceneCount: Math.max(sceneMap.get(r.id) ?? 0, blobSceneCount(r.description)),
    messageCount: msgMap.get(r.id) ?? 0,
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt ?? 0),
    lastOpenedAt: r.lastOpenedAt instanceof Date ? r.lastOpenedAt.getTime() : (r.lastOpenedAt as number | null),
    hiddenAt: r.hiddenAt instanceof Date ? r.hiddenAt.getTime() : (r.hiddenAt as number | null),
  }))
}

/** Write agent run output to the DB so the editor can recover if SSE disconnects before state_change. */
/** Code fields a placeholder can poison; guarded against placeholder-over-real overwrite. */
const GUARDED_CODE_FIELDS = [
  'sceneHTML',
  'svgContent',
  'canvasCode',
  'sceneCode',
  'reactCode',
  'lottieSource',
  'canvasBackgroundCode',
] as const

/**
 * Persist-side hard guard: refuse to overwrite a scene's real DB code
 * with a placeholder (`[<n> chars]`). The renderer strips non-selected scenes'
 * code to placeholders before a run; if one leaks all the way here (the merge +
 * clean steps are the first lines of defense), this belt-and-braces guard keeps
 * the durable DB value and logs a warning instead of corrupting the scene.
 *
 * Real (non-placeholder) incoming code always wins, including legitimately
 * blanking a field — only placeholder-shaped incoming values are rejected, and
 * only when a non-placeholder DB value exists to protect.
 */
function guardPlaceholderOverwrite(incomingScenes: Scene[], existingDescription: string | null | undefined): Scene[] {
  const existingById = new Map<string, Record<string, unknown>>()
  for (const s of readProjectSceneBlob(existingDescription).scenes ?? []) {
    if (s && typeof s === 'object' && (s as any).id) existingById.set((s as any).id, s as any)
  }
  if (existingById.size === 0) return incomingScenes

  let guarded = 0
  const result = incomingScenes.map((scene) => {
    const prior = existingById.get((scene as any).id)
    if (!prior) return scene
    let patched: Record<string, unknown> | null = null
    for (const field of GUARDED_CODE_FIELDS) {
      const incoming = (scene as any)[field]
      if (!isPlaceholderContent(typeof incoming === 'string' ? incoming : null)) continue
      const priorVal = prior[field]
      if (typeof priorVal === 'string' && priorVal && !isPlaceholderContent(priorVal)) {
        const target = patched ?? (patched = { ...(scene as any) })
        target[field] = priorVal
        guarded++
      }
    }
    return (patched ?? scene) as Scene
  })
  if (guarded > 0) {
    log.warn('persistScenesFromAgentRun: refused to overwrite real scene code with placeholder', {
      extra: { fieldsGuarded: guarded },
    })
  }
  return result
}

export async function persistScenesFromAgentRun(
  projectId: string,
  payload: {
    scenes: Scene[]
    sceneGraph: SceneGraph
    globalStyle: GlobalStyle
    zdogLibrary?: any[]
    zdogStudioLibrary?: any[]
    /** The agent run's NLE timeline. Merged into the
     *  description blob (where the renderer reads it) INSIDE the same
     *  version-checked transaction as the scene write — only when present
     *  (a timeline tool ran this run); undefined leaves the stored timeline
     *  untouched. Same blob-merge contract as persistMcpSceneWrite. */
    timeline?: import('@/lib/types').Timeline | null
  },
  branchIdOrMaxRetries?: string | null | number,
  maxRetries = 4,
): Promise<boolean> {
  // Support legacy 3-arg call (maxRetries as number) and new 4-arg call with branchId.
  let callerBranchId: string | null = null
  if (typeof branchIdOrMaxRetries === 'number') {
    maxRetries = branchIdOrMaxRetries
  } else if (typeof branchIdOrMaxRetries === 'string') {
    callerBranchId = branchIdOrMaxRetries
  }

  const normalizedScenes = normalizeScenesForPersistence(payload.scenes)

  // Flush any pending autosave timers before the agent writes its own versions.
  // This ensures autosave rows don't interleave with agent rows in history.
  await flushAllPendingVersions()

  // Resolve the branch for scene writes and version creation.
  // Caller-provided branchId takes priority — BUT ONLY if it actually belongs to
  // this project. A run request can carry a stale active-branch id from a
  // previously-open project (renderer state not reset on project switch); writing
  // scenes onto a foreign project's branch marooned them where the editor's
  // branch-scoped read (getOrCreateDefaultBranch) never looks — the timeline
  // rendered empty though 6 rows existed. Validate ownership; fall back to the
  // project's default branch on any mismatch. Fixes the class at the DB layer.
  let versionBranchId: string | null = null
  if (callerBranchId) {
    const b = await getBranch(callerBranchId)
    if (b && b.projectId === projectId) {
      versionBranchId = callerBranchId
    } else {
      log.warn('persistScenesFromAgentRun: caller branchId does not belong to project — using default', {
        extra: { projectId, callerBranchId, ownerProjectId: b?.projectId ?? null },
      })
    }
  }
  if (!versionBranchId) {
    try {
      const branch = await getOrCreateDefaultBranch(projectId)
      versionBranchId = branch.id
    } catch (branchErr) {
      log.warn('persistScenesFromAgentRun: could not resolve branch, skipping version creation', {
        extra: { projectId },
        error: branchErr,
      })
    }
  }

  // The retry loop that actually persists the agent's scenes + versions. Gated
  // below (when the branch is known) behind the writer gate so an agent persist
  // queues behind — never interleaves with — a concurrent fork/restore/delete on
  // the same branch. Fails loud if a destructive op holds the branch past the
  // bounded wait, so the agent run's persist surfaces instead of racing.
  const persistLoop = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const txResult = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ version: projects.version, description: projects.description })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)

        if (!row) return { found: false, updated: false }

        // Protect real DB code from a placeholder leak. Compute against
        // THIS attempt's freshly-read row so a concurrent writer's real code is
        // what we refuse to clobber.
        const guardedScenes = guardPlaceholderOverwrite(normalizedScenes as unknown as Scene[], row.description)

        const currentVersion = row.version ?? 1
        // Empty-clobber guard, SYMMETRIC to writeProjectScenesToTablesTx's
        // intentionalClear refusal: an interrupted / iteration-cap run reaches
        // persist with an empty scene set (a filter artifact, not a real clear).
        // The table writer already refuses to wipe a populated branch; an
        // unconditional blob overwrite with `scenes: []` would orphan the
        // table rows from the blob. Preserve the existing blob scenes (pass
        // undefined → writeProjectSceneBlob keeps the stored array) unless the
        // incoming set is genuinely non-empty.
        const existingBlobScenes = readProjectSceneBlob(row.description).scenes ?? []
        const blobScenesUpdate = guardedScenes.length === 0 && existingBlobScenes.length > 0 ? undefined : guardedScenes
        const newDescription = writeProjectSceneBlob(row.description, {
          scenes: blobScenesUpdate,
          sceneGraph: payload.sceneGraph,
          zdogLibrary: payload.zdogLibrary,
          zdogStudioLibrary: payload.zdogStudioLibrary,
          // Merge the timeline into the FRESH (this-tx) blob
          // only when present. writeProjectSceneBlob no-ops the key when the
          // value is undefined, so a scene-only run leaves the stored timeline
          // intact — same contract as persistMcpSceneWrite's `.timeline` merge.
          ...(payload.timeline != null ? { timeline: payload.timeline } : {}),
        })

        const columnUpdates: Record<string, any> = {
          description: newDescription,
          globalStyle: payload.globalStyle,
          version: currentVersion + 1,
          updatedAt: new Date(),
        }
        const [updated] = await tx
          .update(projects)
          .set(columnUpdates)
          .where(and(eq(projects.id, projectId), eq(projects.version, currentVersion)))
          .returning({ id: projects.id })

        if (!updated) return { found: true, updated: false }

        await writeProjectScenesToTablesTx(tx, projectId, guardedScenes as any, payload.sceneGraph, versionBranchId)

        // Create scene versions for each scene that has a branchId assigned.
        // branchId is populated by the migration backfill or by the branch create flow.
        // Scenes without a branchId (pre-branching data) are skipped here — they get
        // versioned once the user visits the project and the backfill runs.
        if (versionBranchId) {
          // One batchId for the whole save: every scene versioned here is part of
          // the same logical operation, so branch history shows it as one entry
          // and restore reverts all of them together (no cross-operation splice).
          const { randomUUID } = await import('node:crypto')
          const saveBatchId = randomUUID()
          for (const scene of guardedScenes) {
            if (!(scene as any).id) continue
            const blob = scene as unknown as Record<string, unknown>
            try {
              await createSceneVersion(tx, {
                sceneId: (scene as any).id,
                branchId: versionBranchId,
                layerSnapshot: blob,
                operation: 'agent_run',
                source: 'agent',
                batchId: saveBatchId,
              })
            } catch (versionErr) {
              // Version creation must not fail the main transaction.
              // Log and continue — scene state is still persisted correctly.
              log.warn('createSceneVersion failed, skipping version for scene', {
                extra: { sceneId: (scene as any).id },
                error: versionErr,
              })
            }
          }
        }

        return { found: true, updated: true }
      })

      if (!txResult.found) return false
      if (txResult.updated) return true
    }

    log.warn('persistScenesFromAgentRun: optimistic lock failed after retries', { extra: { projectId } })
    return false
  }

  // Gate the persist behind the branch's writer gate when the branch is known.
  // Without a branch we can't key the gate, so fall through ungated (legacy
  // pre-branching data — there's no fork/restore target to race anyway).
  if (versionBranchId) {
    return withWriterGate({ branchId: versionBranchId, projectId }, persistLoop)
  }
  return persistLoop()
}

// Run-checkpoint persistence moved to src/lib/db/queries/branch-proposals.ts (0015)
// — it is branch-scoped now (getRunCheckpoint/persistRunCheckpoint/
// clearRunCheckpoint take a branchId). Import from there, not here.

/** Read the project's OKF intent brief (the compass). Null if not yet extracted. */
export async function getProjectBrief(projectId: string): Promise<ProjectBrief | null> {
  const [row] = await db
    .select({ projectBrief: projects.projectBrief })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return (row?.projectBrief as ProjectBrief | null) ?? null
}

/** Set or replace the project's OKF intent brief. */
export async function setProjectBrief(projectId: string, brief: ProjectBrief): Promise<void> {
  await db.update(projects).set({ projectBrief: brief, updatedAt: new Date() }).where(eq(projects.id, projectId))
}
