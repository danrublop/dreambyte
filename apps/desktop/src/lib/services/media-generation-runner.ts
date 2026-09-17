/**
 * Media-generation job runner.
 *
 * Owns the poll loop for async AI-media generation so the agent does not have to keep calling
 * `get_video_status` (burning turns, stalling if it moves on), and the renderer reconcile loop
 * (which only runs while a window is open) is just a backstop. This runner is the durable owner:
 * it lives in the Electron MAIN process, ticks on its own timer regardless of agent turns or
 * open windows, advances each job's `media_generations` row through a 5-state machine, and pushes
 * status to the renderer (a push subscription instead of agent-side polling).
 *
 * It does NOT reimplement provider polling or cost accounting: each tick delegates to the existing
 * stateless `pollVideoStatus` / `pollHeygenStatus` services, whose atomic `completeVideoJob` /
 * reserve==commit logic already makes concurrent pollers (this runner + agent get_status + the
 * renderer reconcile) safe and bill-once. The runner just translates a poll result into a
 * `media_generations` transition and a push.
 *
 * Dependency-injected (pollers, transition fns, clock, scheduler) so the state machine is unit
 * testable without a DB, a network, or Electron.
 */

import type { MediaGenerationKind, MediaGenerationRow, MediaGenerationStatus } from '@/lib/db/queries/media-generations'

/** Normalized poll outcome the runner maps onto a media_generations transition. */
export interface PollOutcome {
  /** Still running — heartbeat queued→running, keep polling. */
  done: false
  error?: undefined
  resultUrl?: undefined
  resultDurationMs?: undefined
}
export interface PollDone {
  done: true
  /** Terminal success carries the finished asset; terminal failure carries an error. */
  resultUrl?: string
  resultDurationMs?: number
  error?: string
  /**
   * The row isn't runner-pollable (a synchronous kind — image/audio — with no async operation).
   * Drop it from the active set WITHOUT a transition: finalizing it here would mark it succeeded
   * with a null result_url and push an empty asset to the renderer.
   */
  drop?: boolean
}
export type PollResult = PollOutcome | PollDone

/** A push to the renderer when a job's status changes. */
export interface GenerationUpdate {
  jobId: string
  projectId: string
  kind: MediaGenerationKind
  status: MediaGenerationStatus
  sceneId?: string | null
  layerId?: string | null
  clipId?: string | null
  resultUrl?: string | null
  resultDurationMs?: number | null
  error?: string | null
}

export interface MediaGenerationRunnerDeps {
  /** Poll one job's provider. Returns the normalized outcome (or throws on a transient error). */
  poll: (row: MediaGenerationRow) => Promise<PollResult>
  getMediaGeneration: (id: string) => Promise<MediaGenerationRow | null>
  listActiveMediaGenerations: () => Promise<MediaGenerationRow[]>
  transitionMediaGeneration: (
    id: string,
    to: MediaGenerationStatus,
    patch?: { resultUrl?: string | null; resultDurationMs?: number | null; error?: string | null },
    from?: MediaGenerationStatus | MediaGenerationStatus[],
  ) => Promise<boolean>
  /** Push a status change to the renderer (broadcast on a single-user desktop). */
  emit: (update: GenerationUpdate) => void
  /**
   * Patch the PERSISTED scene layer main-side on a terminal outcome (video/avatar
   * → status ready + videoUrl, or status error). In a HEADLESS MCP run there is no
   * renderer store to run `applyGenerationUpdate`, so without this the finished
   * clip URL lands in the media_generations row while the scene BLOB stays
   * `status:'generating'` and the exported MP4 shows nothing. Best-effort +
   * optional: when a window IS open the renderer push still lands the layer (the
   * two converge idempotently), and tests can omit it. Called ONLY when this poller
   * won the terminal transition, so it never double-writes with the renderer.
   */
  patchPersistedLayer?: (patch: {
    projectId: string
    sceneId: string
    layerId: string
    kind: MediaGenerationKind
    status: 'succeeded' | 'failed'
    resultUrl?: string | null
    resultDurationMs?: number | null
  }) => Promise<void>
  now?: () => number
}

const TICK_MS = 15_000

export class MediaGenerationRunner {
  private deps: MediaGenerationRunnerDeps
  private active = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  // Guards against overlapping ticks if a poll round runs longer than the interval.
  private ticking = false

  constructor(deps: MediaGenerationRunnerDeps) {
    this.deps = deps
  }

  /** Register an in-flight job and ensure the timer is running. Idempotent. */
  enqueue(jobId: string): void {
    this.active.add(jobId)
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick()
      }, TICK_MS)
      // Don't keep the process alive just to poll (Electron main already has the app lifetime).
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  /** Re-enqueue every non-terminal job after an app restart so generations resume. */
  async recoverOnBoot(): Promise<void> {
    const rows = await this.deps.listActiveMediaGenerations()
    for (const row of rows) this.enqueue(row.id)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.active.clear()
  }

  /** Visible for tests: number of jobs the runner is tracking. */
  get activeCount(): number {
    return this.active.size
  }

  /** One poll round over every active job. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const ids = Array.from(this.active)
      for (const id of ids) {
        await this.tickOne(id).catch(() => {
          // A transient poll error (provider hiccup) is swallowed — the job stays active and is
          // retried next tick. The durable deadline (enforced inside the poll service) bounds a
          // permanently-wedged job, so this can't spin forever.
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private async tickOne(id: string): Promise<void> {
    const row = await this.deps.getMediaGeneration(id)
    if (!row) {
      this.active.delete(id)
      return
    }
    // Already terminal (some other poller — agent get_status / renderer reconcile — won the race).
    if (row.status === 'succeeded' || row.status === 'failed') {
      this.active.delete(id)
      return
    }

    const result = await this.deps.poll(row)

    if (!result.done) {
      // Heartbeat: queued→running on the first sign of life. Unconditional + idempotent (a no-op
      // once already running). Not pushed — the UI is already showing "generating".
      if (row.status === 'queued') {
        await this.deps.transitionMediaGeneration(id, 'running', {}, 'queued')
      }
      return
    }

    if (result.drop) {
      // Not a runner-pollable row (synchronous kind, no async op). Drop it without finalizing —
      // transitioning here would mark it succeeded with a null result_url and push an empty asset.
      this.active.delete(id)
      return
    }

    if (result.error) {
      const won = await this.deps.transitionMediaGeneration(id, 'failed', { error: result.error }, [
        'queued',
        'running',
        'downloading',
      ])
      // Only dequeue + push when WE won the terminal transition. The from-guard covers all three
      // non-terminal states, so won=false means another poller (renderer reconcile / agent
      // get_status) already finalized + pushed this row. Rather than blindly delete here, leave it
      // for the next tick's top-of-loop getMediaGeneration check — the single point that confirms
      // terminal and dequeues — so the active set is reconciled against the row of record, not a
      // stale transition result.
      if (won) {
        this.active.delete(id)
        await this.patchPersisted(row, 'failed', {})
        this.push(row, 'failed', { error: result.error })
      }
      return
    }

    // Terminal success. The poll service has ALREADY downloaded + cached the asset (resultUrl is a
    // local public path), so we go straight to succeeded — the 'downloading' state is reserved for
    // a future split poll/download path.
    const won = await this.deps.transitionMediaGeneration(
      id,
      'succeeded',
      { resultUrl: result.resultUrl ?? null, resultDurationMs: result.resultDurationMs ?? null },
      ['queued', 'running', 'downloading'],
    )
    // See the failure branch: only dequeue on a won transition; on won=false the row is already
    // terminal (another poller won) — let the next tick's top-of-loop check reconcile + dequeue.
    if (won) {
      this.active.delete(id)
      await this.patchPersisted(row, 'succeeded', {
        resultUrl: result.resultUrl ?? null,
        resultDurationMs: result.resultDurationMs ?? null,
      })
      this.push(row, 'succeeded', {
        resultUrl: result.resultUrl ?? null,
        resultDurationMs: result.resultDurationMs ?? null,
      })
    }
  }

  /**
   * Land the terminal outcome on the PERSISTED scene layer (main-side), so a headless
   * run's finished clip reaches the scene BLOB + on-disk HTML even with no renderer.
   * Best-effort: a failure here never blocks the transition/push (the renderer
   * reconcile still backstops when a window is open). Skipped for rows with no
   * scene/layer binding (e.g. project-level generations).
   */
  private async patchPersisted(
    row: MediaGenerationRow,
    status: 'succeeded' | 'failed',
    extra: { resultUrl?: string | null; resultDurationMs?: number | null },
  ): Promise<void> {
    if (!this.deps.patchPersistedLayer || !row.sceneId || !row.layerId) return
    try {
      await this.deps.patchPersistedLayer({
        projectId: row.projectId,
        sceneId: row.sceneId,
        layerId: row.layerId,
        kind: row.kind,
        status,
        resultUrl: extra.resultUrl ?? null,
        resultDurationMs: extra.resultDurationMs ?? null,
      })
    } catch {
      /* persisted-layer patch is best-effort; the row + push still carry the result */
    }
  }

  private push(
    row: MediaGenerationRow,
    status: MediaGenerationStatus,
    extra: { resultUrl?: string | null; resultDurationMs?: number | null; error?: string | null },
  ): void {
    this.deps.emit({
      jobId: row.id,
      projectId: row.projectId,
      kind: row.kind,
      status,
      sceneId: row.sceneId,
      layerId: row.layerId,
      clipId: row.clipId,
      ...extra,
    })
  }
}

// ── Singleton wiring (main-process default deps) ─────────────────────────────
// The runner singleton uses the real DB queries + the existing stateless pollers. `emit` is set
// by the Electron main process (it owns the WebContents); until then updates are dropped (the
// renderer reconcile + agent get_status still resolve the job, so this is a graceful no-op).

let singleton: MediaGenerationRunner | null = null
let emitFn: (update: GenerationUpdate) => void = () => {}

/** Wire the renderer-push sink. Called by src/electron/main once a window exists. */
export function setGenerationUpdateEmitter(fn: (update: GenerationUpdate) => void): void {
  emitFn = fn
}

/** Translate a media_generations row into a provider poll via the existing stateless services. */
async function pollForRow(row: MediaGenerationRow): Promise<PollResult> {
  if (row.kind === 'video') {
    const { pollVideoStatus } = await import('@/lib/services/generation')
    const r = await pollVideoStatus({
      operationName: row.operationName ?? '',
      projectId: row.projectId,
      prompt: row.prompt ?? undefined,
      providerId: row.provider,
    })
    if (!r.done) return { done: false }
    if (r.error) return { done: true, error: r.error }
    return { done: true, resultUrl: r.videoUrl }
  }
  if (row.kind === 'avatar') {
    const { pollHeygenStatus } = await import('@/lib/services/generation')
    const r = await pollHeygenStatus(row.operationName ?? '')
    if (r.status === 'completed' && r.videoUrl) {
      return {
        done: true,
        resultUrl: r.videoUrl,
        resultDurationMs: r.durationSeconds != null ? Math.round(r.durationSeconds * 1000) : undefined,
      }
    }
    if (r.status === 'failed') return { done: true, error: r.error ?? 'Avatar render failed.' }
    return { done: false }
  }
  // image/audio: no async provider poll wired yet (synchronous today — the submit path resolves
  // these inline). Such rows shouldn't be enqueued, but if one is (e.g. recoverOnBoot over a future
  // image row) drop it rather than finalize: finalizing would mark it succeeded with a null
  // result_url and push an empty asset.
  return { done: true, drop: true }
}

/**
 * Default `patchPersistedLayer` impl (main process, real DB). Reads the scene BLOB,
 * patches the target aiLayer in place (video/avatar → status ready + videoUrl, or
 * status error), persists the BLOB back, and re-writes the on-disk scene HTML so a
 * subsequent headless export renders the finished clip. Mirrors the renderer store's
 * applyGenerationUpdate / get_video_status completion, but DB-backed instead of
 * world/store-backed (there is no renderer in a headless run). Idempotent: a layer
 * already 'ready'/'error' is left untouched so a redundant push after a renderer win
 * is a no-op.
 */
async function patchPersistedSceneLayer(patch: {
  projectId: string
  sceneId: string
  layerId: string
  kind: MediaGenerationKind
  status: 'succeeded' | 'failed'
  resultUrl?: string | null
  resultDurationMs?: number | null
}): Promise<void> {
  // Only video/avatar carry an async clip that lands on an aiLayer; image/audio resolve inline.
  if (patch.kind !== 'video' && patch.kind !== 'avatar') return
  if (patch.status === 'succeeded' && !patch.resultUrl) return

  const { db } = await import('@/lib/db')
  const { scenes, projects } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')

  const sceneRow = await db.query.scenes.findFirst({ where: eq(scenes.id, patch.sceneId) })
  if (!sceneRow) return
  const blob = sceneRow.sceneBlob as Record<string, unknown> | null
  if (!blob || typeof blob !== 'object') return
  const aiLayers = Array.isArray((blob as any).aiLayers) ? ((blob as any).aiLayers as any[]) : null
  if (!aiLayers) return
  const idx = aiLayers.findIndex((l) => l && l.id === patch.layerId)
  if (idx < 0) return
  const current = aiLayers[idx]
  // Idempotent: a renderer/agent poller already resolved this layer.
  if (current.status === 'ready' || current.status === 'error') return

  const nextLayers = aiLayers.slice()
  nextLayers[idx] =
    patch.status === 'succeeded'
      ? { ...current, status: 'ready', videoUrl: patch.resultUrl }
      : { ...current, status: 'error' }
  const nextBlob = { ...(blob as any), aiLayers: nextLayers }

  await db
    .update(scenes)
    .set({ sceneBlob: nextBlob as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(scenes.id, patch.sceneId))

  // Re-write the on-disk scene HTML so a headless export sees the finished clip.
  // Best-effort — the persisted BLOB is the source of truth; a HTML write failure
  // (e.g. no scenes dir in a CLI context) doesn't undo the DB patch.
  try {
    const [projectRow] = await db
      .select({ globalStyle: projects.globalStyle, mp4Settings: projects.mp4Settings })
      .from(projects)
      .where(eq(projects.id, patch.projectId))
      .limit(1)
    const { generateSceneHTML } = await import('@/lib/sceneTemplate')
    const { resolveProjectDimensions } = await import('@/lib/dimensions')
    const { resolveScenesDir } = await import('@/lib/scene-html-paths')
    const fs = await import('fs/promises')
    const path = await import('path')
    const dims = resolveProjectDimensions(projectRow?.mp4Settings?.aspectRatio, projectRow?.mp4Settings?.resolution)
    const html = generateSceneHTML(nextBlob as any, projectRow?.globalStyle ?? undefined, undefined, undefined, dims)
    const scenesDir = resolveScenesDir()
    await fs.mkdir(scenesDir, { recursive: true })
    const finalPath = path.join(scenesDir, `${patch.sceneId}.html`)
    const tmpPath = path.join(scenesDir, `${patch.sceneId}.tmp.${Date.now()}.html`)
    await fs.writeFile(tmpPath, html, 'utf-8')
    await fs.rename(tmpPath, finalPath)
  } catch {
    /* HTML re-write is best-effort; the persisted BLOB already carries the clip URL */
  }
}

export function getMediaGenerationRunner(): MediaGenerationRunner {
  if (!singleton) {
    singleton = new MediaGenerationRunner({
      poll: pollForRow,
      getMediaGeneration: async (id) => (await import('@/lib/db/queries/media-generations')).getMediaGeneration(id),
      listActiveMediaGenerations: async () =>
        (await import('@/lib/db/queries/media-generations')).listActiveMediaGenerations(),
      transitionMediaGeneration: async (id, to, patch, from) =>
        (await import('@/lib/db/queries/media-generations')).transitionMediaGeneration(id, to, patch, from),
      emit: (update) => emitFn(update),
      patchPersistedLayer: patchPersistedSceneLayer,
    })
  }
  return singleton
}
