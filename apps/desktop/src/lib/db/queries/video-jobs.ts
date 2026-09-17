import { db } from '../index'
import { videoJobs } from '../schema'
import { and, eq, inArray, lt } from 'drizzle-orm'

// Persistence for in-flight text-to-video jobs (video job durability). The stateless
// poll loop reads the row to enforce a deadline; a wedged job is timed out instead of
// polled forever. See src/lib/services/video-job-deadline.ts for the deadline policy.

export type VideoJobStatus = 'pending' | 'done' | 'error' | 'timeout'

export interface VideoJobRow {
  operationName: string
  projectId: string
  provider: string
  reservationId: string | null
  status: VideoJobStatus
  requestHash: string | null
  videoUrl: string | null
  /** Duration-scaled reserved cost (cents) — committed verbatim on success so reserve==commit. */
  estimatedCostCents: number | null
  startedAt: Date
  deadlineAt: Date
  errorReason: string | null
}

/** Record a newly-started video job. `deadlineAtMs` is epoch ms (deadlineFor(...)). */
export async function createVideoJob(input: {
  operationName: string
  projectId: string
  provider: string
  reservationId: string | null
  deadlineAtMs: number
  /** Hash of the canonical request params (start-cache dedupe + completion alias). */
  requestHash?: string | null
  /** Duration-scaled reserved cost in cents — committed verbatim by the poll on success. */
  estimatedCostCents?: number | null
}): Promise<void> {
  await db
    .insert(videoJobs)
    .values({
      operationName: input.operationName,
      projectId: input.projectId,
      provider: input.provider,
      reservationId: input.reservationId,
      status: 'pending',
      requestHash: input.requestHash ?? null,
      estimatedCostCents: input.estimatedCostCents ?? null,
      deadlineAt: new Date(input.deadlineAtMs),
    })
    // Re-starting the same operation id overwrites the prior row entirely (fresh attempt) —
    // including provider/project/reservation so a collided id can't carry stale accounting.
    .onConflictDoUpdate({
      target: videoJobs.operationName,
      set: {
        projectId: input.projectId,
        provider: input.provider,
        reservationId: input.reservationId,
        status: 'pending',
        requestHash: input.requestHash ?? null,
        estimatedCostCents: input.estimatedCostCents ?? null,
        videoUrl: null,
        deadlineAt: new Date(input.deadlineAtMs),
        errorReason: null,
      },
    })
}

/** Record a cache-HIT job: already 'done' with the cached clip, no reservation, no provider
 *  operation. The renderer's first poll returns videoUrl immediately (no bill, no provider call). */
export async function recordCachedVideoJob(input: {
  operationName: string
  projectId: string
  provider: string
  requestHash: string
  videoUrl: string
  deadlineAtMs: number
}): Promise<void> {
  const set = {
    projectId: input.projectId,
    provider: input.provider,
    reservationId: null,
    status: 'done' as const,
    requestHash: input.requestHash,
    videoUrl: input.videoUrl,
    deadlineAt: new Date(input.deadlineAtMs),
    errorReason: null,
  }
  await db
    .insert(videoJobs)
    .values({ operationName: input.operationName, ...set })
    .onConflictDoUpdate({ target: videoJobs.operationName, set })
}

/** Atomically complete a pending job: status 'done' + the resulting clip URL. Returns true
 *  only for the winning poll (rowsAffected > 0) so spend/alias side effects run once. */
export async function completeVideoJob(operationName: string, videoUrl: string): Promise<boolean> {
  const res = await db
    .update(videoJobs)
    .set({ status: 'done', videoUrl })
    .where(and(eq(videoJobs.operationName, operationName), eq(videoJobs.status, 'pending')))
  return ((res as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}

/**
 * Atomically transition a job from 'pending' to a terminal status. Returns true only for the
 * caller that actually performed the transition (rowsAffected > 0) — so concurrent polls
 * (multiple tabs / a late poll) can gate side effects (logSpend / releaseSpend) on the
 * winner and never double-bill or double-release. A no-op (already terminal) returns false.
 */
export async function transitionVideoJobFromPending(
  operationName: string,
  to: Exclude<VideoJobStatus, 'pending'>,
  errorReason?: string | null,
): Promise<boolean> {
  const res = await db
    .update(videoJobs)
    .set({ status: to, errorReason: errorReason ?? null })
    .where(and(eq(videoJobs.operationName, operationName), eq(videoJobs.status, 'pending')))
  return ((res as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}

export async function getVideoJob(operationName: string): Promise<VideoJobRow | null> {
  const [row] = await db.select().from(videoJobs).where(eq(videoJobs.operationName, operationName)).limit(1)
  return (row as VideoJobRow) ?? null
}

/**
 * Find an in-flight (pending) video job with this request hash for the project. Used to
 * dedupe a fast second identical start before it issues a SECOND paid provider job — the
 * start-cache only catches COMPLETED clips, so two quick clicks otherwise both pay. Best-effort
 * check-then-act: two truly-simultaneous starts (before either row is visible) can still both
 * proceed, which is acceptable on a single-user desktop. The caller checks the deadline.
 */
export async function getPendingVideoJobByRequestHash(
  projectId: string,
  requestHash: string,
): Promise<VideoJobRow | null> {
  const [row] = await db
    .select()
    .from(videoJobs)
    .where(
      and(eq(videoJobs.projectId, projectId), eq(videoJobs.requestHash, requestHash), eq(videoJobs.status, 'pending')),
    )
    .limit(1)
  return (row as VideoJobRow) ?? null
}

/**
 * Delete TERMINAL (done/error/timeout) video_job rows older than maxAgeMs. The table
 * grows one row per generation and is otherwise never cleaned. Pending rows are left untouched —
 * they're either in-flight or get timed out by the deadline path. Best-effort, low-rate
 * housekeeping that mirrors sweepStaleReservations. Returns the number of rows deleted.
 */
export async function pruneTerminalVideoJobs(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const res = await db
    .delete(videoJobs)
    .where(and(inArray(videoJobs.status, ['done', 'error', 'timeout']), lt(videoJobs.createdAt, cutoff)))
  return (res as { rowsAffected?: number }).rowsAffected ?? 0
}
