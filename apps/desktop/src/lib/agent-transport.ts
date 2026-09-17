/**
 * Agent transport shim.
 *
 * Isolates the renderer from the underlying transport so `src/components/AgentChat.tsx`
 * can stay agnostic. Desktop-only: agent runs talk to the main process via
 * `window.dreambyteApi.agent.start` + per-runId event subscription on
 * `dreambyte:agent.event`. No HTTP server is involved.
 *
 * There is no HTTP fallback:
 * if `dreambyteApi` is missing (a pure `next dev` run outside Electron), calls
 * throw a clear setup error rather than silently 404.
 *
 * Event shape is whatever the agent runner emits (see `src/lib/agents/types`
 * `SSEEvent`). This module is transport-only — it does not interpret events.
 */

import type { SSEEvent } from '@/lib/agents/types'
import { createLogger } from './logger'

const log = createLogger('agent-transport')

export type AgentSseEvent = SSEEvent

export interface StreamAgentSseOptions {
  signal: AbortSignal
  onEvent: (event: AgentSseEvent) => void
  /** Fired once with the live IPC `runId` as soon as the run starts — before any
   *  events. Lets the caller target mid-run actions (steering) at THIS run. The
   *  `run_start` SSE event also carries it, but this resolves a tick earlier and
   *  is the single source of truth for "the run I can steer". */
  onRunId?: (runId: string) => void
}

// `subscribe` returns a runId-scoped listener; we route abort/capture-response
// through the same namespace. Typed loosely to avoid a hard dep on preload's
// types from an isomorphic file.
type DreambyteAgentApi = {
  start: (body: Record<string, unknown>) => Promise<{ runId: string }>
  abort: (runId: string) => Promise<{ ok: boolean }>
  captureResponse: (payload: {
    captureId: string
    dataUri?: string
    mimeType?: string
    error?: string
  }) => Promise<{ ok: boolean }>
  exportResponse: (payload: { exportId: string; outputPath?: string; error?: string }) => Promise<{ ok: boolean }>
  steer: (payload: { runId: string; id: string; text: string }) => Promise<{ ok: boolean }>
  clipResponse: (payload: {
    clipId: string
    dataUri?: string
    mimeType?: string
    error?: string
  }) => Promise<{ ok: boolean }>
  subscribe: (runId: string, handler: (event: Record<string, unknown>) => void) => () => void
  /** Ack that `subscribe`'s listener is attached so the main process flushes
   *  the events it buffered during the start→subscribe window (run-start race
   *  fix). Call AFTER `subscribe`. */
  subscribed: (runId: string) => Promise<{ ok: boolean }>
  /** Out-of-band "scenes persisted" signal for `runId` — survives the
   *  transport teardown an abort triggers. */
  onPersistDone?: (runId: string, handler: (persistOk: boolean) => void) => () => void
}

function getDreambyteAgentApi(): DreambyteAgentApi | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).dreambyteApi?.agent as DreambyteAgentApi | undefined
  return api ?? null
}

function getProjectVersionReader(): ((projectId: string) => Promise<number>) | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projects = (window as any).dreambyteApi?.projects
  if (!projects?.getVersion) return null
  return async (projectId: string) => {
    try {
      const res = await projects.getVersion(projectId)
      return typeof res?.version === 'number' ? res.version : -1
    } catch {
      return -1
    }
  }
}

/** Dependencies for {@link waitForRunPersist}, injectable for testing. */
export interface WaitForRunPersistDeps {
  /** Subscribe to the out-of-band persist_done signal; returns an unsubscribe fn. */
  onPersistDone?: (runId: string, handler: (persistOk: boolean) => void) => () => void
  /** Read a project's current DB version (cheap IPC). */
  readVersion?: (projectId: string) => Promise<number>
  /** Poll interval for the version fallback (ms). */
  pollIntervalMs?: number
  /** Hard ceiling before resolving regardless (ms) — the UI must never freeze. */
  timeoutMs?: number
}

/**
 * Resolve once the run's post-run DB persist has settled, so the renderer's
 * post-run refresh reads a durable DB instead of racing main's write.
 *
 * Fast path: the out-of-band `persist_done` signal (keyed by runId), which fires
 * even on the error/abort paths where the SSE transport is already torn down.
 *
 * Fallback: poll the project's version; resolve once it advances past the
 * pre-run value (a persist bumps `projects.version`). A hard timeout guarantees
 * the UI is never frozen by a dropped signal + a stuck poll — it resolves and
 * refreshes anyway (the prior, racy behavior is the floor, not a regression).
 *
 * Never rejects.
 */
export async function waitForRunPersist(
  runId: string,
  projectId: string | null | undefined,
  preRunVersion: number | null,
  deps: WaitForRunPersistDeps = {},
): Promise<{ persistOk: boolean | null }> {
  if (!projectId) return { persistOk: null }
  const onPersistDone = deps.onPersistDone ?? getDreambyteAgentApi()?.onPersistDone
  const readVersion = deps.readVersion ?? getProjectVersionReader() ?? undefined
  const pollIntervalMs = deps.pollIntervalMs ?? 600
  const timeoutMs = deps.timeoutMs ?? 10_000

  // The persist_done signal carries whether main's post-run scene persist
  // succeeded. null = we resolved via the version-poll/timeout fallback and
  // never saw the signal (unknown outcome).
  let persistOk: boolean | null = null

  return await new Promise<{ persistOk: boolean | null }>((resolve) => {
    let settled = false
    let unsub: (() => void) | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
      if (pollTimer) clearTimeout(pollTimer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve({ persistOk })
    }

    // Fast path: the out-of-band persist_done signal.
    if (onPersistDone) {
      try {
        unsub = onPersistDone(runId, (ok) => {
          persistOk = ok
          finish()
        })
      } catch {
        /* fall through to polling */
      }
    }

    // Fallback: version poll. A persist bumps projects.version past preRunVersion.
    if (readVersion && preRunVersion != null) {
      const poll = async () => {
        if (settled) return
        const v = await readVersion(projectId)
        if (v > preRunVersion) return finish()
        if (!settled) pollTimer = setTimeout(poll, pollIntervalMs)
      }
      pollTimer = setTimeout(poll, pollIntervalMs)
    }

    // Hard ceiling — never freeze the UI.
    hardTimer = setTimeout(finish, timeoutMs)

    // Nothing to wait on (no signal, no version reader) → resolve next tick so
    // the caller behaves exactly as before (refresh immediately).
    if (!onPersistDone && !(readVersion && preRunVersion != null)) {
      finish()
    }
  })
}

/**
 * Start an agent request and consume its event stream, firing `onEvent`
 * per event. Resolves when the stream completes. Throws on IPC failure or
 * AbortError (rethrown — caller distinguishes).
 */
export async function streamAgentSse(body: Record<string, unknown>, options: StreamAgentSseOptions): Promise<void> {
  const dreambyteAgent = getDreambyteAgentApi()
  if (!dreambyteAgent) {
    throw new Error(
      'Agent requires the desktop runtime (window.dreambyteApi.agent is unavailable). ' +
        'Launch via `npm run dev:electron` instead of `next dev`.',
    )
  }
  return streamAgentIpc(body, options, dreambyteAgent)
}

/**
 * Electron IPC path. We `start` the run (getting a runId), attach a per-runId
 * listener via `subscribe`, then `subscribed(runId)` to ack. The main process
 * BUFFERS every event emitted before that ack and flushes it on receipt, so the
 * subscribe-after-start race can't drop `run_start`/early tokens (the prior
 * `setImmediate`-only ordering was best-effort and lost events under load). The
 * runner emits a synthetic `__stream_end__` event during cleanup so we always
 * resolve, even if it crashed before emitting `done`.
 */
async function streamAgentIpc(
  body: Record<string, unknown>,
  { signal, onEvent, onRunId }: StreamAgentSseOptions,
  dreambyteAgent: DreambyteAgentApi,
): Promise<void> {
  if (signal.aborted) {
    throw new DOMException('Aborted before agent IPC start', 'AbortError')
  }

  let runId: string
  try {
    const result = await dreambyteAgent.start(body)
    runId = result.runId
  } catch (err) {
    throw new Error(`Agent IPC start failed: ${(err as Error).message}`, { cause: err })
  }

  // Surface the steer target before any events flow.
  try {
    onRunId?.(runId)
  } catch (err) {
    log.warn('onRunId handler threw', { error: err })
  }

  let resolveDone: () => void = () => {}
  let rejectDone: (err: Error) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const unsubscribe = dreambyteAgent.subscribe(runId, (event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = event as any
    if (ev?.type === '__stream_end__') {
      resolveDone()
      return
    }
    try {
      onEvent(ev as AgentSseEvent)
    } catch (handlerErr) {
      log.error('agent IPC event handler threw', { error: handlerErr })
    }
  })

  // Run-start race fix: `subscribe` above attached the per-runId listener
  // synchronously (ipcRenderer.on). NOW ack so the main process flushes any
  // events the runner emitted before this listener existed (buffered, not
  // dropped) and switches to live pass-through. Order is load-bearing: attach
  // listener → ack → flush. Fire-and-forget — the flush rides the normal event
  // channel; a failed ack only means events stay buffered (capped) until the
  // run ends, never a crash. The `subscribed` bridge method is new; guard it so
  // an older preload doesn't throw.
  void dreambyteAgent.subscribed?.(runId).catch((err) => {
    log.warn('agent.subscribed ack failed — early events may be delayed', { error: err })
  })

  // Wire abort: tell the main process to cancel the run, then reject the
  // pending promise. The runner will still emit __stream_end__ during
  // teardown but our reject takes precedence.
  const onAbort = () => {
    void dreambyteAgent.abort(runId).catch(() => {})
    rejectDone(new DOMException('Agent run aborted by client', 'AbortError'))
  }
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    await done
  } finally {
    unsubscribe()
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Send a captured frame (or error) back to the agent runner so it can
 * resolve a `capture_request` pending capture. Fire-and-forget is OK —
 * the runner has its own timeout on pending captures.
 */
export async function postAgentCaptureResponse(payload: {
  captureId: string
  dataUri?: string
  mimeType?: string
  error?: string
}): Promise<void> {
  const dreambyteAgent = getDreambyteAgentApi()
  if (!dreambyteAgent) {
    log.warn('captureResponse: dreambyteApi.agent unavailable — dropping capture', {
      extra: { captureId: payload.captureId },
    })
    return
  }
  await dreambyteAgent.captureResponse(payload).catch((e) => {
    log.warn('captureResponse IPC failed', { error: e })
  })
}

/**
 * Send the rendered MP4 path (or error) back to the agent runner so it can
 * resolve an `export_request` pending export. Fire-and-forget is OK — the
 * runner has its own timeout on pending exports.
 */
export async function postAgentExportResponse(payload: {
  exportId: string
  outputPath?: string
  error?: string
  /** 11b — failing-scene context for scene-scoped render errors (1-based). */
  sceneIndex?: number
  sceneId?: string
}): Promise<void> {
  const dreambyteAgent = getDreambyteAgentApi()
  if (!dreambyteAgent) {
    log.warn('exportResponse: dreambyteApi.agent unavailable — dropping export', {
      extra: { exportId: payload.exportId },
    })
    return
  }
  await dreambyteAgent.exportResponse(payload).catch((e) => {
    log.warn('exportResponse IPC failed', { error: e })
  })
}

/**
 * Push a mid-run steer message into a live run. The runner drains it into
 * the next top-level turn. Returns whether the main process accepted it — the
 * caller falls back to a normal new turn when `ok` is false (run ended / not
 * found / over the flood cap), so a typed message is never silently lost.
 */
export async function postAgentSteer(payload: { runId: string; id: string; text: string }): Promise<boolean> {
  const dreambyteAgent = getDreambyteAgentApi()
  if (!dreambyteAgent) {
    log.warn('steer: dreambyteApi.agent unavailable — dropping steer', { extra: { runId: payload.runId } })
    return false
  }
  try {
    const res = await dreambyteAgent.steer(payload)
    return res?.ok === true
  } catch (e) {
    log.warn('steer IPC failed', { error: e })
    return false
  }
}

/**
 * Send a rendered scene clip (or error) back to the agent runner so it can
 * resolve a `clip_request` pending clip for motion review. The MP4 bytes ride as
 * a base64 `data:` URI (mirrors the capture path) so the loosely-typed IPC layer
 * needs no binary-transfer handling. Fire-and-forget is OK — the runner has its
 * own timeout on pending clips.
 */
export async function postAgentClipResponse(payload: {
  clipId: string
  dataUri?: string
  mimeType?: string
  error?: string
}): Promise<void> {
  const dreambyteAgent = getDreambyteAgentApi()
  if (!dreambyteAgent) {
    log.warn('clipResponse: dreambyteApi.agent unavailable — dropping clip', {
      extra: { clipId: payload.clipId },
    })
    return
  }
  await dreambyteAgent.clipResponse(payload).catch((e: unknown) => {
    log.warn('clipResponse IPC failed', { error: e })
  })
}
