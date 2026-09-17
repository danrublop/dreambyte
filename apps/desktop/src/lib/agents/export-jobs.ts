/**
 * Async MP4 export job registry for the MCP / external-agent path.
 *
 * A multi-scene 1080p render takes minutes — longer than the MCP client's
 * request timeout. So `export_mp4` (MCP) starts the render, registers a job
 * here, and returns immediately; the agent then polls `get_export_status`
 * until the job is `complete` (carrying the written path) or `error`.
 *
 * Status registry, not a promise (cf. pending-exports.ts, which the in-app
 * SSE path uses to await synchronously). Stored on globalThis so hot-reload
 * and route bundling don't produce competing maps. Lives in the main process,
 * where executeMcpTool runs and the export runner's promise resolves.
 */

import crypto from 'crypto'

export type ExportJobStatus = 'rendering' | 'complete' | 'error'

export interface ExportJob {
  jobId: string
  status: ExportJobStatus
  outputPath?: string
  error?: string
  /**
   * 11b — which scene the export died on (1-based) when the failure was
   * scene-scoped. Additive next to the legacy `error` string so a polling
   * agent can re-generate just the broken scene.
   */
  errorSceneIndex?: number
  errorSceneId?: string
  /** 0-100 for the current scene's render. */
  progress?: number
  currentScene?: number
  totalScenes?: number
  startedAt: number
  updatedAt: number
}

const GLOBAL_KEY = '__dreambyteExportJobs__' as const
const MAX_JOBS = 25
type JobMap = Map<string, ExportJob>

function getMap(): JobMap {
  const g = globalThis as unknown as Record<string, unknown>
  let map = g[GLOBAL_KEY] as JobMap | undefined
  if (!map) {
    map = new Map()
    g[GLOBAL_KEY] = map
  }
  return map
}

/**
 * Drop the oldest jobs once the map exceeds MAX_JOBS, so it can't grow
 * unbounded.
 *
 * INVARIANT: a `rendering` job is NEVER evicted. The
 * map is the single source of export status — evicting an in-flight render
 * would make a subsequent `get_export_status(jobId)` return null ("no such
 * job") on a poll for a render that's still running, i.e. a live export
 * silently looking like it vanished. Only terminal jobs (complete / error)
 * are eligible for pruning; we drop the oldest terminal jobs first. If every
 * job is `rendering` (pathological — more than MAX_JOBS concurrent renders),
 * the map is allowed to exceed MAX_JOBS rather than evict a live one.
 */
function prune(map: JobMap): void {
  if (map.size <= MAX_JOBS) return
  const evictable = [...map.values()].filter((j) => j.status !== 'rendering').sort((a, b) => a.startedAt - b.startedAt)
  const toDrop = map.size - MAX_JOBS
  for (const job of evictable.slice(0, toDrop)) map.delete(job.jobId)
}

export function createExportJob(totalScenes?: number): ExportJob {
  const now = Date.now()
  const job: ExportJob = {
    jobId: crypto.randomUUID(),
    status: 'rendering',
    progress: 0,
    ...(totalScenes != null ? { totalScenes } : {}),
    startedAt: now,
    updatedAt: now,
  }
  const map = getMap()
  map.set(job.jobId, job)
  prune(map)
  return job
}

export function updateExportJob(jobId: string, patch: Partial<Omit<ExportJob, 'jobId' | 'startedAt'>>): void {
  const map = getMap()
  const job = map.get(jobId)
  if (!job) return
  // Monotonic guard: a render advances scene-by-scene
  // and the renderer's progress poll is best-effort + can arrive out of order.
  // Never let currentScene regress while still rendering, so a late update for
  // an earlier scene can't push overall progress backwards for a polling agent.
  // A terminal patch (complete/error) bypasses this — it's the authoritative
  // final state.
  const merged = { ...job, ...patch, updatedAt: Date.now() }
  const stillRendering = (patch.status ?? job.status) === 'rendering'
  if (stillRendering && patch.currentScene != null && job.currentScene != null) {
    merged.currentScene = Math.max(job.currentScene, patch.currentScene)
    // If a stale update tried to move us back to an earlier scene, ignore its
    // per-scene progress too (it belongs to that earlier scene).
    if (patch.currentScene < job.currentScene && patch.progress != null) {
      merged.progress = job.progress
    }
  }
  map.set(jobId, merged)
}

export function getExportJob(jobId: string): ExportJob | null {
  return getMap().get(jobId) ?? null
}

/**
 * 11b — build the terminal error patch for a job from a rejected export
 * runner error. The runner (src/electron/main.ts) re-attaches `sceneIndex`/
 * `sceneId` it sampled from the renderer's exportProgress slot (the
 * executeJavaScript bridge strips custom Error fields, so the renderer's own
 * `exportScene*` stamps never arrive here); this maps them onto the job's
 * persisted `errorSceneIndex`/`errorSceneId`. Zero-dep + pure so the mapping
 * is unit-testable without importing the MCP handler.
 */
export function errorJobPatch(e: unknown): Partial<Omit<ExportJob, 'jobId' | 'startedAt'>> {
  const err = e as (Error & { sceneIndex?: number; sceneId?: string }) | null | undefined
  return {
    status: 'error',
    error: err instanceof Error ? err.message : String(e),
    ...(typeof err?.sceneIndex === 'number' && Number.isFinite(err.sceneIndex)
      ? { errorSceneIndex: err.sceneIndex }
      : {}),
    ...(typeof err?.sceneId === 'string' && err.sceneId ? { errorSceneId: err.sceneId } : {}),
  }
}

/**
 * Number of jobs currently in the registry. Test/diagnostic helper —
 * the registry is process-global so an exact count is otherwise opaque.
 */
export function exportJobCount(): number {
  return getMap().size
}

// NOTE: there is deliberately no `getLatestExportJob()`. With two export paths (in-app + MCP) sharing one global map,
// a jobId-less "latest" poll could resolve to the WRONG export — e.g. a
// concurrent export rejected by the re-entrancy guard registers a job that
// immediately goes `error`, and a jobId-less poll on the healthy in-flight
// render would surface that errored newcomer (cross-path poisoning). The only
// correct contract is: callers MUST hold the jobId returned by `export_mp4`
// and poll `getExportJob(jobId)`. `get_export_status` enforces this.
