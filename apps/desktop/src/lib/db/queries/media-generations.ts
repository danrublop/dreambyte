import { db } from '../index'
import { mediaGenerations } from '../schema'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'

// Reactive generation-job records. One lifecycle row per async AI-media
// generation across all kinds. A main-process runner owns the poll loop, applies transitions
// here, and pushes status to the renderer — the agent never has to poll. Cost reserve/commit
// + request-hash dedupe live on `video_jobs`; this is the orchestration/lifecycle layer.

export type MediaGenerationKind = 'video' | 'image' | 'audio' | 'avatar'
// 5-state lifecycle:
// queued → running → downloading → succeeded | failed. 'queued' and 'running' map to the UI
// "generating" state; 'downloading' to "downloading"; terminal states resolve the placeholder.
export type MediaGenerationStatus = 'queued' | 'running' | 'downloading' | 'succeeded' | 'failed'

const ACTIVE_STATUSES: MediaGenerationStatus[] = ['queued', 'running', 'downloading']

export interface MediaGenerationRow {
  id: string
  projectId: string
  kind: MediaGenerationKind
  provider: string
  operationName: string | null
  status: MediaGenerationStatus
  prompt: string | null
  sceneId: string | null
  layerId: string | null
  clipId: string | null
  resultUrl: string | null
  resultDurationMs: number | null
  error: string | null
  attempts: number
  deadlineAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Mutable lifecycle fields a transition may patch alongside the status. */
export interface MediaGenerationPatch {
  resultUrl?: string | null
  resultDurationMs?: number | null
  error?: string | null
  operationName?: string | null
  sceneId?: string | null
  layerId?: string | null
  clipId?: string | null
}

/** Record a newly-submitted generation job (status 'queued'). Returns the row id. */
export async function createMediaGeneration(input: {
  projectId: string
  kind: MediaGenerationKind
  provider: string
  operationName?: string | null
  prompt?: string | null
  sceneId?: string | null
  layerId?: string | null
  clipId?: string | null
  /** Wall-clock ceiling (epoch ms) from deadlineFor(); past it the job is failed. */
  deadlineAtMs?: number | null
  /** Caller-supplied id (e.g. to align with a layer/operation). Defaults to a UUID. */
  id?: string
}): Promise<string> {
  const id = input.id ?? crypto.randomUUID()
  await db
    .insert(mediaGenerations)
    .values({
      id,
      projectId: input.projectId,
      kind: input.kind,
      provider: input.provider,
      operationName: input.operationName ?? null,
      status: 'queued',
      prompt: input.prompt ?? null,
      sceneId: input.sceneId ?? null,
      layerId: input.layerId ?? null,
      clipId: input.clipId ?? null,
      deadlineAt: input.deadlineAtMs != null ? new Date(input.deadlineAtMs) : null,
    })
    // Re-submitting the same id is a fresh attempt: reset the lifecycle entirely so a collided
    // id can't carry a stale result/error/operation.
    .onConflictDoUpdate({
      target: mediaGenerations.id,
      set: {
        projectId: input.projectId,
        kind: input.kind,
        provider: input.provider,
        operationName: input.operationName ?? null,
        status: 'queued',
        prompt: input.prompt ?? null,
        sceneId: input.sceneId ?? null,
        layerId: input.layerId ?? null,
        clipId: input.clipId ?? null,
        resultUrl: null,
        resultDurationMs: null,
        error: null,
        attempts: 0,
        deadlineAt: input.deadlineAtMs != null ? new Date(input.deadlineAtMs) : null,
        updatedAt: new Date(),
      },
    })
  return id
}

export async function getMediaGeneration(id: string): Promise<MediaGenerationRow | null> {
  const [row] = await db.select().from(mediaGenerations).where(eq(mediaGenerations.id, id)).limit(1)
  return (row as MediaGenerationRow) ?? null
}

/**
 * Active (non-terminal) jobs — queued/running/downloading. Drives the runner's boot recovery
 * (re-enqueue everything still in flight after an app restart). Optionally scoped to a project.
 */
export async function listActiveMediaGenerations(projectId?: string): Promise<MediaGenerationRow[]> {
  const where = projectId
    ? and(inArray(mediaGenerations.status, ACTIVE_STATUSES), eq(mediaGenerations.projectId, projectId))
    : inArray(mediaGenerations.status, ACTIVE_STATUSES)
  const rows = await db.select().from(mediaGenerations).where(where)
  return rows as MediaGenerationRow[]
}

/**
 * Apply a status transition + optional field patch. The `from` guard makes terminal transitions
 * (→ succeeded/failed) atomic win-once: a concurrent runner-tick / agent get_status / renderer
 * reconcile that already moved the row is a no-op (returns false), so a push fires exactly once.
 * `from` omitted updates unconditionally (used for the queued→running heartbeat, which is idempotent).
 * The `attempts` counter is bumped on every transition so a poll budget can be enforced.
 */
export async function transitionMediaGeneration(
  id: string,
  to: MediaGenerationStatus,
  patch: MediaGenerationPatch = {},
  from?: MediaGenerationStatus | MediaGenerationStatus[],
): Promise<boolean> {
  const where = from
    ? and(eq(mediaGenerations.id, id), inArray(mediaGenerations.status, Array.isArray(from) ? from : [from]))
    : eq(mediaGenerations.id, id)
  const res = await db
    .update(mediaGenerations)
    .set({
      status: to,
      attempts: sql`${mediaGenerations.attempts} + 1`,
      updatedAt: new Date(),
      ...('resultUrl' in patch ? { resultUrl: patch.resultUrl ?? null } : {}),
      ...('resultDurationMs' in patch ? { resultDurationMs: patch.resultDurationMs ?? null } : {}),
      ...('error' in patch ? { error: patch.error ?? null } : {}),
      ...('operationName' in patch ? { operationName: patch.operationName ?? null } : {}),
      ...('sceneId' in patch ? { sceneId: patch.sceneId ?? null } : {}),
      ...('layerId' in patch ? { layerId: patch.layerId ?? null } : {}),
      ...('clipId' in patch ? { clipId: patch.clipId ?? null } : {}),
    })
    .where(where)
  return ((res as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}

/**
 * Delete TERMINAL (succeeded/failed) rows older than maxAgeMs. The table grows one row per
 * generation; active rows are left untouched (they're in-flight or get failed by the deadline).
 * Returns the number of rows deleted.
 */
export async function pruneTerminalMediaGenerations(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const res = await db
    .delete(mediaGenerations)
    .where(and(inArray(mediaGenerations.status, ['succeeded', 'failed']), lt(mediaGenerations.createdAt, cutoff)))
  return (res as { rowsAffected?: number }).rowsAffected ?? 0
}
