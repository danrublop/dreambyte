import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { isValidUuid } from '@/lib/utils/uuid'
import { db } from './index'
import { projects, sceneEdges, sceneNodes, scenes } from './schema'
import { normalizeTransition } from '@/lib/transitions'
import type { EdgeCondition, Scene, SceneGraph } from '@/lib/types'

function buildFallbackSceneFromRow(row: any): Scene {
  return {
    id: row.id,
    name: row.name ?? '',
    prompt: '',
    summary: '',
    svgContent: '',
    duration: row.duration ?? 8,
    bgColor: row.bgColor ?? '#ffffff',
    thumbnail: row.thumbnailUrl ?? null,
    videoLayer: row.videoLayer ?? { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: row.audioLayer ?? {
      enabled: false,
      src: null,
      volume: 1,
      fadeIn: false,
      fadeOut: false,
      startOffset: 0,
    },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: normalizeTransition((row.transition?.type as string | undefined) ?? 'none'),
    usage: null,
    sceneType: 'svg',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    chartLayers: [],
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: row.styleOverride ?? {},
    cameraMotion: row.cameraMotion ?? null,
    worldConfig: row.worldConfig ?? null,
  }
}

function isUuid(value: string | undefined | null): value is string {
  if (!value) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function normalizeEdgeCondition(cond: unknown): EdgeCondition {
  const c = cond && typeof cond === 'object' ? (cond as Record<string, unknown>) : {}
  return {
    type: ((c.type as string) ?? 'auto') as EdgeCondition['type'],
    interactionId: (c.interactionId as string | null) ?? null,
    variableName: (c.variableName as string | null) ?? null,
    variableValue: (c.variableValue as string | null) ?? null,
  }
}

function edgeSemanticKey(edge: { fromSceneId: string; toSceneId: string; condition: EdgeCondition }): string {
  return `${edge.fromSceneId}::${edge.toSceneId}::${JSON.stringify(edge.condition)}`
}

export interface WriteProjectScenesOptions {
  /**
   * Explicit "the caller intentionally cleared every scene" signal. Only an
   * intentional clear may wipe a populated branch down to zero rows.
   *
   * When an EMPTY (or fully-filtered) incoming scene set reaches the writer and
   * the branch already holds rows, we REFUSE the destructive delete unless this
   * is set — because an empty set can also be a *filter artifact*
   * (`cleanScenesForAgentPersistence` returning `[]` after sweeping a
   * never-coded shell), not a real clear. A silent wipe there would delete a
   * user's real scenes. User-driven autosaves (the store is authoritative and
   * a delete-all is a genuine intent) pass `intentionalClear: true`; the agent
   * persist paths do NOT, so a filter artifact can no longer nuke a branch.
   */
  intentionalClear?: boolean
}

export async function writeProjectScenesToTables(
  projectId: string,
  projectScenes: Scene[],
  sceneGraph: SceneGraph | null | undefined,
  branchId?: string | null,
  options?: WriteProjectScenesOptions,
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeProjectScenesToTablesTx(tx, projectId, projectScenes, sceneGraph, branchId, options)
  })
}

export async function writeProjectScenesToTablesTx(
  tx: any,
  projectId: string,
  projectScenes: Scene[],
  sceneGraph: SceneGraph | null | undefined,
  branchId?: string | null,
  options?: WriteProjectScenesOptions,
): Promise<void> {
  // Safety invariant: never allow scene id collisions across projects to be
  // silently rewritten. We fail fast so callers can regenerate IDs instead.
  const incomingSceneIds = projectScenes.map((s) => s.id)
  // Only UUID ids take part in the collision check and row sync below; legacy
  // scenes may carry slug-style ids, which are skipped.
  const uuidSceneIds = incomingSceneIds.filter((id) => isValidUuid(id))

  if (uuidSceneIds.length > 0) {
    const crossProjectRows = await tx
      .select({ id: scenes.id })
      .from(scenes)
      .where(and(ne(scenes.projectId, projectId), inArray(scenes.id, uuidSceneIds)))
      .limit(1)
    if (crossProjectRows.length > 0) {
      throw new Error(`scene id collision across projects for id ${crossProjectRows[0].id}`)
    }
  }

  await tx
    .update(projects)
    .set({ sceneGraphStartSceneId: sceneGraph?.startSceneId || null, updatedAt: new Date() })
    .where(eq(projects.id, projectId))

  // Tracks a refused full-branch wipe so the node/edge cleanup below is skipped
  // too (a refused scene delete must not leave the graph half-cleared).
  let refusedEmptyClear = false

  if (uuidSceneIds.length > 0) {
    // When branchId is provided, only delete scenes on that branch — other branches are untouched.
    const deleteWhere = branchId
      ? and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchId), notInArray(scenes.id, uuidSceneIds))
      : and(eq(scenes.projectId, projectId), notInArray(scenes.id, uuidSceneIds))
    await tx.delete(scenes).where(deleteWhere)
  } else {
    // The incoming set writes ZERO scene rows. This is a full-branch wipe — and
    // it can be reached two very different ways:
    //   1. A genuine "the user deleted every scene" clear (store-authoritative).
    //   2. A FILTER ARTIFACT: the caller *did* have scenes but they all dropped
    //      out — either `cleanScenesForAgentPersistence` swept a never-coded
    //      shell to `[]`, or every incoming id was a non-UUID legacy slug the
    //      `UUID_RE` filter rejected. Here the emptiness is accidental, and
    //      deleting would destroy the branch's real, persisted scenes.
    // We only allow the destructive delete when it can't be case (2): either the
    // caller explicitly signalled an intentional clear of a truly-empty input,
    // or the branch had nothing to lose in the first place.
    const emptyDueToFiltering = projectScenes.length > 0
    const priorWhere = branchId
      ? and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchId))
      : eq(scenes.projectId, projectId)
    const priorRows = await tx.select({ id: scenes.id }).from(scenes).where(priorWhere).limit(1)
    const hasPriorRows = priorRows.length > 0

    const allowDelete = !hasPriorRows || (options?.intentionalClear === true && !emptyDueToFiltering)

    if (allowDelete) {
      await tx.delete(scenes).where(priorWhere)
    } else {
      // Refuse: keep the existing rows intact rather than silently wiping them.
      refusedEmptyClear = true
    }
  }

  const uuidScenes = projectScenes.filter((s) => isValidUuid(s.id))
  if (uuidScenes.length > 0) {
    await tx
      .insert(scenes)
      .values(
        uuidScenes.map((s, idx) => ({
          id: s.id,
          projectId,
          branchId: branchId ?? null,
          name: s.name ?? '',
          position: idx,
          duration: s.duration ?? 8,
          bgColor: s.bgColor ?? '#ffffff',
          styleOverride: s.styleOverride ?? {},
          transition: { type: normalizeTransition(s.transition), duration: 0.5 },
          audioLayer: s.audioLayer ?? null,
          videoLayer: s.videoLayer ?? null,
          thumbnailUrl: s.thumbnail ?? null,
          cameraMotion: s.cameraMotion ?? null,
          worldConfig: s.worldConfig ?? null,
          sceneBlob: s as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: scenes.id,
        set: {
          // Keep projectId immutable on conflicts to avoid cross-project reassignment.
          // branchId is updated so backfilled (null) rows get their branch stamped correctly.
          branchId: sql`excluded.branch_id`,
          name: sql`excluded.name`,
          position: sql`excluded.position`,
          duration: sql`excluded.duration`,
          bgColor: sql`excluded.bg_color`,
          styleOverride: sql`excluded.style_override`,
          transition: sql`excluded.transition`,
          audioLayer: sql`excluded.audio_layer`,
          videoLayer: sql`excluded.video_layer`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          cameraMotion: sql`excluded.camera_motion`,
          worldConfig: sql`excluded.world_config`,
          sceneBlob: sql`excluded.scene_blob`,
          updatedAt: new Date(),
        },
      })
  }

  // sceneNodes and sceneEdges have no branchId column. When saving a specific
  // branch we CANNOT run project-wide `notInArray` cleanup — it would delete the
  // node positions / edges of scenes that live on OTHER branches (they share the
  // same projectId). So on a branch-scoped write we skip node/edge deletion
  // entirely and only upsert the incoming rows. The tradeoff: rows for scenes
  // that were removed from a branch are never deleted here, so orphans slowly
  // accumulate in these two tables.
  //
  // Adding a real `branch_id` column would let us scope the cleanup, but that is
  // a cross-cutting schema change (schema.ts + the relational read queries) that
  // exceeds this file's ownership. Instead we DEFANG the orphans at read time:
  // `readProjectScenesFromTables` filters the returned graph to only the nodes
  // and edges whose scenes are actually present in the branch result, so a stale
  // row can never leak into another branch's node map even though it lingers in
  // the table. See the reader guard below.
  const nodes = sceneGraph?.nodes ?? []
  const incomingNodeSceneIds = nodes.map((n) => n.id)
  if (!branchId && !refusedEmptyClear) {
    if (incomingNodeSceneIds.length > 0) {
      await tx
        .delete(sceneNodes)
        .where(and(eq(sceneNodes.projectId, projectId), notInArray(sceneNodes.sceneId, incomingNodeSceneIds)))
    } else {
      await tx.delete(sceneNodes).where(eq(sceneNodes.projectId, projectId))
    }
  }
  if (nodes.length > 0) {
    await tx
      .insert(sceneNodes)
      .values(
        nodes.map((n) => ({
          projectId,
          sceneId: n.id,
          position: n.position ?? { x: 0, y: 0 },
        })),
      )
      .onConflictDoUpdate({
        target: [sceneNodes.projectId, sceneNodes.sceneId],
        set: { position: sql`excluded.position` },
      })
  }

  const existingEdges = await tx
    .select({
      id: sceneEdges.id,
      fromSceneId: sceneEdges.fromSceneId,
      toSceneId: sceneEdges.toSceneId,
      condition: sceneEdges.condition,
    })
    .from(sceneEdges)
    .where(eq(sceneEdges.projectId, projectId))

  const existingBySemantic = new Map<string, string[]>()
  for (const ee of existingEdges) {
    const key = edgeSemanticKey({
      fromSceneId: ee.fromSceneId ?? '',
      toSceneId: ee.toSceneId ?? '',
      condition: normalizeEdgeCondition(ee.condition),
    })
    const list = existingBySemantic.get(key) ?? []
    list.push(ee.id)
    existingBySemantic.set(key, list)
  }

  const edges = sceneGraph?.edges ?? []
  const edgeRows = edges.map((e) => {
    const normalizedCondition = normalizeEdgeCondition(e.condition)
    let edgeId = isUuid(e.id) ? e.id : null
    if (!edgeId) {
      const key = edgeSemanticKey({
        fromSceneId: e.fromSceneId,
        toSceneId: e.toSceneId,
        condition: normalizedCondition,
      })
      const existing = existingBySemantic.get(key)
      edgeId = existing?.shift() ?? null
    }
    return {
      id: edgeId ?? randomUUID(),
      projectId,
      fromSceneId: e.fromSceneId,
      toSceneId: e.toSceneId,
      condition: normalizedCondition,
    }
  })

  const incomingEdgeIds = edgeRows.map((e) => e.id)
  if (!branchId && !refusedEmptyClear) {
    if (incomingEdgeIds.length > 0) {
      await tx
        .delete(sceneEdges)
        .where(and(eq(sceneEdges.projectId, projectId), notInArray(sceneEdges.id, incomingEdgeIds)))
    } else {
      await tx.delete(sceneEdges).where(eq(sceneEdges.projectId, projectId))
    }
  }
  if (edgeRows.length > 0) {
    await tx
      .insert(sceneEdges)
      .values(edgeRows)
      .onConflictDoUpdate({
        target: sceneEdges.id,
        set: {
          fromSceneId: sql`excluded.from_scene_id`,
          toSceneId: sql`excluded.to_scene_id`,
          condition: sql`excluded.condition`,
        },
      })
  }
}

export async function readProjectScenesFromTables(
  projectId: string,
  branchId?: string,
): Promise<{ scenes: Scene[]; sceneGraph: SceneGraph } | null> {
  const rows = await db.query.scenes.findMany({
    where: branchId
      ? and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchId))
      : eq(scenes.projectId, projectId),
    orderBy: (s, { asc }) => [asc(s.position)],
  })

  if (!branchId && rows.length === 0) return null

  // branchId specified but 0 results — check if project has ANY table scenes
  if (branchId && rows.length === 0) {
    const [anyRow] = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.projectId, projectId)).limit(1)
    // No table rows at all — caller should trigger blob→table migration
    if (!anyRow) return null
    // Table rows exist but none on this branch (new branch, no scenes yet)
    return { scenes: [], sceneGraph: { nodes: [], edges: [], startSceneId: '' } }
  }

  const edgeRows = await db.query.sceneEdges.findMany({
    where: eq(sceneEdges.projectId, projectId),
  })
  const nodeRows = await db.query.sceneNodes.findMany({
    where: eq(sceneNodes.projectId, projectId),
  })
  const [projectRow] = await db
    .select({ startSceneId: projects.sceneGraphStartSceneId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  const outScenes: Scene[] = rows.map((r: any) => {
    const blob = r.sceneBlob as Record<string, unknown> | null
    if (blob && typeof blob === 'object') return blob as unknown as Scene
    return buildFallbackSceneFromRow(r)
  })

  // Orphan guard: sceneNodes/sceneEdges are keyed by projectId only (no
  // branch_id column — see writer comment), so `nodeRows`/`edgeRows` above
  // include every branch's rows PLUS orphans left behind by scenes that were
  // removed from a branch. Filter both down to the scenes actually present in
  // this result, so a stale/foreign-branch row can never leak into the returned
  // graph. Nodes must reference a present scene; edges must reference present
  // scenes on BOTH ends.
  const presentSceneIds = new Set(outScenes.map((s) => s.id))
  const liveNodeRows = nodeRows.filter((n: any) => presentSceneIds.has(n.sceneId))
  const liveEdgeRows = edgeRows.filter(
    (e: any) => presentSceneIds.has(e.fromSceneId) && presentSceneIds.has(e.toSceneId),
  )

  // Only trust a stored start scene that is actually part of this result.
  const storedStart = projectRow?.startSceneId
  const startSceneId = storedStart && presentSceneIds.has(storedStart) ? storedStart : (outScenes[0]?.id ?? '')

  const outGraph: SceneGraph = {
    nodes:
      liveNodeRows.length > 0
        ? liveNodeRows.map((n: any) => ({
            id: n.sceneId,
            position: n.position ?? { x: 0, y: 0 },
          }))
        : outScenes.map((s, i) => ({ id: s.id, position: { x: i * 300, y: 100 } })),
    edges: liveEdgeRows.map((e: any) => ({
      id: e.id,
      fromSceneId: e.fromSceneId,
      toSceneId: e.toSceneId,
      condition: e.condition ?? { type: 'auto', interactionId: null, variableName: null, variableValue: null },
    })),
    startSceneId,
  }

  return { scenes: outScenes, sceneGraph: outGraph }
}
