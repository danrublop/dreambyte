/**
 * Real DB-backed `LoadTargetRow` for the cross-project isolation boundary
 * (Phase C.2). Injected into `resolveLegBody` by the main-process
 * dispatchProjects orchestration; dormant on the single-project (identity) path.
 *
 * Reads the TARGET project's OWN settings + content, branch-scoped to its
 * default branch — NEVER the whole project graph. This is the fix for the
 * branch-blind merge hazard: the project-wide scene read (today
 * `getProjectScenesLight`) pulls every branch's scenes, so a
 * target leg must read its default branch's scene graph via
 * `readProjectScenesFromTables(projectId, branchId)`, not a project-wide reload.
 *
 * Errors propagate (no `.catch`): a failed read must reach `resolveLegBody` as a
 * thrown error so the leg fails closed (CrossProjectLegAbort) rather than running
 * under the origin project's settings.
 */

import type { APIPermissions, GlobalStyle, MP4Settings, Scene, SceneGraph, Timeline } from '@/lib/types'
import type { LoadTargetRow, TargetProjectRow } from './resolve-leg-body'
import { getProjectSettingsRow, getProjectDescription } from '@/lib/db/queries/projects'
import { getDefaultBranch, backfillProjectBranch } from '@/lib/db/queries/branches'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'
import { readProjectSceneBlob } from '@/lib/db/project-scene-storage'

/**
 * Scope a scene graph to a branch's scenes. `readProjectScenesFromTables` scopes
 * SCENES by branch but reads sceneNodes/sceneEdges PROJECT-wide, so its graph
 * includes the target's OTHER branches. Drop nodes/edges that don't belong to
 * this branch's scenes so a leg can't receive (or persist back) another branch's
 * graph.
 */
function scopeGraphToScenes(graph: SceneGraph, scenes: Scene[]): SceneGraph {
  const ids = new Set(scenes.map((s) => s.id))
  return {
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.fromSceneId) && ids.has(e.toSceneId)),
    startSceneId: ids.has(graph.startSceneId) ? graph.startSceneId : (scenes[0]?.id ?? ''),
  }
}

export const loadTargetProjectRow: LoadTargetRow = async (projectId): Promise<TargetProjectRow | null> => {
  const row = await getProjectSettingsRow(projectId)
  if (!row) return null // project does not exist → resolveLegBody aborts the leg

  // Backfill legacy null-branch rows onto the default branch BEFORE the scoped
  // read — matches every other branch-scoped reader (in-app load
  // src/electron/ipc/projects.ts, MCP handler/bridge, branches IPC). Without it, a
  // target whose scene rows are stamped branch_id=NULL (a legacy/never-opened
  // project) reads as {scenes:[]} (rows exist project-wide, none on the resolved
  // branch) — which is NON-null, so the blob fallback below does NOT fire, the
  // leg runs EMPTY, and persist clobbers the target's real scenes. Backfill
  // stamps those rows onto the default branch so the read finds them.
  await backfillProjectBranch(projectId)

  // Fail closed when the target has no default branch: a leg must run inside a
  // branch boundary, never "outside" it with downstream fallbacks deciding what
  // "default" means. Returning null → resolveLegBody aborts the leg.
  const defaultBranchId = (await getDefaultBranch(projectId))?.id ?? null
  if (!defaultBranchId) return null

  // Scenes + graph: prefer the branch-scoped scene-table read. When the project
  // has NO scene-table rows at all (readProjectScenesFromTables → null: a brand-
  // new project, or an un-migrated blob-only legacy project), fall back to the
  // legacy scene blob so the leg runs against B's REAL content. This mirrors the
  // single-project path (mergeServerScenes → getProjectScenesLight is blob-aware).
  // Without the fallback a table-less target would run EMPTY and clobber B's
  // blob-resident scenes on persist (un-migrated case), while a naive fail-closed
  // would wrongly reject legitimately empty brand-new projects. A NON-null result
  // with empty scenes is a legitimately empty branch — run it as-is.
  const tables = await readProjectScenesFromTables(projectId, defaultBranchId)
  let scenes: Scene[]
  let rawGraph: SceneGraph | undefined
  // The NLE timeline lives in the description blob regardless of whether scenes
  // are table- or blob-backed (there is no projects.timeline column), so read it
  // from the blob here. When scenes come from the blob path we already parse it;
  // reuse that parse, else read description for the timeline only (v6 TIMELINE).
  let timeline: Timeline | null = null
  if (tables) {
    scenes = tables.scenes
    rawGraph = tables.sceneGraph
    timeline = (readProjectSceneBlob(await getProjectDescription(projectId)).timeline as Timeline | null) ?? null
  } else {
    const blob = readProjectSceneBlob(await getProjectDescription(projectId))
    scenes = blob.scenes as Scene[]
    rawGraph = (blob.sceneGraph as SceneGraph | null) ?? undefined
    timeline = (blob.timeline as Timeline | null) ?? null
  }
  const sceneGraph = rawGraph ? scopeGraphToScenes(rawGraph, scenes) : undefined

  return {
    // Pass apiPermissions through as-is (do NOT default null→{}): resolveLegBody
    // fails closed on null permissions, and {} = B's real allow-all.
    apiPermissions: row.apiPermissions as unknown as APIPermissions,
    audioProviderEnabled: row.audioProviderEnabled ?? {},
    mediaGenEnabled: row.mediaGenEnabled ?? {},
    globalStyle: row.globalStyle as GlobalStyle,
    projectName: row.name ?? '',
    outputMode: row.outputMode ?? 'mp4',
    mp4Settings: row.mp4Settings ?? undefined,
    sceneGraph,
    timeline,
    scenes,
    defaultBranchId,
  }
}
