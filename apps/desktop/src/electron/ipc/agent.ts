import { app } from 'electron'
import type { IpcMain, WebContents } from 'electron'
import crypto from 'crypto'
import type { SSEEvent } from '@/lib/agents/types'
import { runAgentRequest, reserveRunSlot, releaseRunSlot, type AgentAPIRequest } from '@/lib/services/agent-runner'
import { resolveLegBody } from '@/lib/services/resolve-leg-body'
import { runCrossProjectDispatch } from '@/lib/agents/cross-project-dispatch'
import { loadTargetProjectRow } from '@/lib/services/load-target-project-row'
import { getOrCreateDefaultBranch, getDefaultBranch } from '@/lib/db/queries/branches'
import { mergeBranchScopedScenes, type MergeScene } from '@/lib/services/merge-server-scenes'
import { resolvePendingCapture, rejectPendingCapture } from '@/lib/agents/pending-captures'
import { acceptSteer, clearSteers, drainSteers } from '@/lib/agents/pending-steers'
import { resolvePendingExport, rejectPendingExport } from '@/lib/agents/pending-exports'
import { resolvePendingClip, rejectPendingClip } from '@/lib/agents/pending-clips'
import { decodeClipDataUri } from '@/lib/agents/clip-datauri'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { projects as projectsTable } from '@/lib/db/schema'
import type { Scene } from '@/lib/types'
import { createLogger } from '@/lib/logger'
import { instanceIdFor } from '@/lib/mcp/instance-registry'
import {
  acquireRunLease,
  heartbeatRunLease,
  releaseRunLease,
  mintRunLeaseToken,
  HEARTBEAT_MS,
} from '@/lib/db/queries/agent-run-leases'
import { IpcValidationError, assertValidUuid } from './_helpers'

/**
 * Minimum BYOK coverage for the agent to reach a provider. The runner picks
 * among Anthropic, OpenAI, Google, and local models at runtime depending on
 * the selected model + thinking budget. If NONE of those has credentials,
 * the agent will 401 deep in the SDK and the user gets a raw "Unauthorized"
 * toast with no actionable direction.
 *
 * Pre-flight the check so we can emit a structured `error` SSE event with
 * `reason: 'no_api_key'` the renderer can turn into an "Open Settings"
 * action. Local (Ollama) counts as a valid provider if `OLLAMA_ENDPOINT` is
 * set — the user may be running entirely offline.
 */
function hasAnyAgentProviderConfigured(): boolean {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_AI_KEY ||
    process.env.GEMINI_API_KEY ||
    // Cheap OpenAI-compat agent providers (Phase 2.6) — a user whose only
    // configured key is DeepSeek/Qwen/Kimi must still be allowed to start a run.
    process.env.DEEPSEEK_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.MOONSHOT_API_KEY ||
    process.env.OLLAMA_ENDPOINT
  )
}

/**
 * Category: agent
 *
 * The live agent entry point for the shipped app. This module wires the `runAgentRequest()` orchestrator into Electron IPC so the packaged
 * desktop app can reach the agent without an HTTP server.
 *
 * Streaming model: invoke `dreambyte:agent.start` to open a run; the main
 * process pushes each `SSEEvent` back over `dreambyte:agent.event` keyed
 * by the returned `runId`. Renderer subscribes once at boot and routes
 * events to the right consumer by runId.
 *
 * Channels:
 *   dreambyte:agent.start            (invoke) → { runId }
 *   dreambyte:agent.subscribed       (invoke) → { ok } — renderer acks its
 *                                      listener is attached; main flushes the
 *                                      per-runId early-event buffer, then goes live
 *   dreambyte:agent.event            (push)   webContents.send → { runId, event }
 *   dreambyte:agent.abort            (invoke) → { ok: boolean }
 *   dreambyte:agent.captureResponse  (invoke) → { ok: boolean }
 *
 * Single-user desktop: every run is treated as `authenticatedUserId = null`
 * (mirrors `_helpers.ts`). When auth ships, resolve the session here and
 * pass through.
 */

const log = createLogger('ipc.agent')

// runId → controller. Used by `dreambyte:agent.abort` to cancel a specific run.
// Cleared in the finally block when the run resolves.
// `done` settles when the run's own finally has run — i.e. after
// persistScenesFromAgentRun and after the run lease is released. Shutdown awaits
// it (see abortActiveRunsForShutdown); it is undefined only in the sub-tick
// before the runner is actually started, when there is nothing to persist yet.
const activeControllers = new Map<
  string,
  { abort: AbortController; sender: WebContents; done?: Promise<unknown> }
>()

/**
 * Abort every in-flight run and wait for each to finish persisting.
 *
 * Called from `before-quit`. Without it, Cmd-Q nine minutes into a build tore
 * the process down mid-run: `runAgent` never returned, so
 * `persistScenesFromAgentRun` never ran and every scene the run built was lost,
 * AND the run-lease row was orphaned so the next launch refused to start on that
 * branch until the 30s TTL lapsed.
 *
 * Abort is already the correct shutdown path — `runAgent` returns
 * `stopReason: 'aborted'` and src/lib/services/agent-runner.ts persists
 * unconditionally on that path — so this only has to fire it and wait. The wait
 * is bounded: a wedged run must not hold the app open forever, and losing one
 * run's scenes beats a quit that never completes.
 */
export async function abortActiveRunsForShutdown(timeoutMs = 10_000): Promise<number> {
  const inFlight = [...activeControllers.values()]
  if (inFlight.length === 0) return 0
  log.info('aborting active agent runs for shutdown', { extra: { count: inFlight.length, timeoutMs } })
  for (const entry of inFlight) {
    try {
      entry.abort.abort()
    } catch (e) {
      log.warn('failed to abort run on shutdown', { error: e })
    }
  }
  const settled = Promise.allSettled(inFlight.map((e) => e.done).filter(Boolean))
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  const stragglers = activeControllers.size
  if (stragglers > 0) {
    log.warn('quit proceeding with runs still unfinished — their scenes may not have persisted', {
      extra: { stragglers },
    })
  }
  return inFlight.length
}

// Per-runId early-event buffer (run-start race fix). The renderer AWAITS
// `agent.start` and only THEN attaches its `dreambyte:agent.event` listener and
// acks via `dreambyte:agent.subscribed`. Under main-process load the runner can
// emit `run_start` / the first tokens BEFORE that listener exists, so a raw
// `sender.send` would be silently dropped and the chat looks frozen.
//
// While `live === false` (renderer hasn't acked yet) `emit` PUSHES events here
// instead of sending. On ack we flush in order then flip to `live: true` for
// pass-through. The entry is deleted on flush-into-live AND on run
// completion/abort/`__stream_end__` so it can't leak.
//
// `cap`: a renderer that starts a run but never acks (crash between start and
// subscribe) must not grow main-process memory unbounded — once the buffer
// exceeds the cap we drop the OLDEST event (keeping the newest, incl. the
// terminal `__stream_end__`) and warn once.
const MAX_BUFFERED_EVENTS = 500
// Grace window to keep a completed-but-never-acked buffer alive so a late ack
// can still drain it (incl. the terminal `__stream_end__`) before we reap it.
const BUFFER_REAP_GRACE_MS = 30_000
// The terminal sentinel isn't a modeled `SSEEvent` (it only resolves the
// renderer's stream promise), so the buffer accepts it alongside real events.
type BufferableEvent = SSEEvent | { type: '__stream_end__' }
// `sender` is the WebContents that started the run — recorded so the ack
// handler can reject a flush request from any other window (no cross-window
// stream theft) and so `flushAndGoLive` drains to the legitimate owner.
const earlyEventBuffers = new Map<
  string,
  { events: BufferableEvent[]; live: boolean; warned: boolean; sender: WebContents; reapTimer?: ReturnType<typeof setTimeout> }
>()

/**
 * Emit an agent event for `runId`, buffering it when the renderer hasn't yet
 * acked its subscription (see `earlyEventBuffers`). Once `live`, sends straight
 * through. Caps the buffer defensively so a renderer that never acks can't grow
 * main-process memory without bound. Skips dead windows (the runner keeps going
 * so persistence still completes).
 */
function sendOrBufferEvent(sender: WebContents, runId: string, sseEvent: BufferableEvent): void {
  const entry = earlyEventBuffers.get(runId)
  // No entry → already flushed-and-cleaned (live pass-through). Send directly.
  if (!entry || entry.live) {
    if (sender.isDestroyed()) return
    try {
      sender.send('dreambyte:agent.event', { runId, event: sseEvent })
    } catch (e) {
      log.warn('failed to forward agent event', { extra: { runId }, error: e })
    }
    return
  }
  // Pre-ack: buffer in order. Cap defensively (drop OLDEST so the terminal
  // events that resolve the renderer's stream promise survive).
  entry.events.push(sseEvent)
  if (entry.events.length > MAX_BUFFERED_EVENTS) {
    entry.events.shift()
    if (!entry.warned) {
      entry.warned = true
      log.warn('agent early-event buffer over cap; dropping oldest', {
        extra: { runId, cap: MAX_BUFFERED_EVENTS },
      })
    }
  }
}

/**
 * Flush all buffered events for `runId` in order, then flip the run to live
 * pass-through and drop the buffer entry. Called from `dreambyte:agent.subscribed`
 * once the renderer confirms its listener is attached. Idempotent: a second ack
 * (or an ack for an unknown/already-flushed run) is a no-op.
 */
function flushAndGoLive(sender: WebContents, runId: string): void {
  const entry = earlyEventBuffers.get(runId)
  if (!entry || entry.live) return
  // Mark live + delete BEFORE sending so any event emitted re-entrantly during
  // the flush goes straight through (preserving order after the drain).
  entry.live = true
  if (entry.reapTimer) clearTimeout(entry.reapTimer)
  const buffered = entry.events
  earlyEventBuffers.delete(runId)
  if (sender.isDestroyed()) return
  for (const sseEvent of buffered) {
    try {
      sender.send('dreambyte:agent.event', { runId, event: sseEvent })
    } catch (e) {
      log.warn('failed to flush buffered agent event', { extra: { runId }, error: e })
      break
    }
  }
}

/**
 * Reap a run's buffer at end-of-run WITHOUT racing the renderer's ack.
 *
 * The run can finish (or fail the no-api-key pre-flight) before the renderer's
 * async `subscribed` ack lands. Deleting the entry here immediately would throw
 * away every buffered event — including the terminal `__stream_end__` — so the
 * late ack flushes nothing and the renderer's `await done` hangs forever (the
 * exact freeze the buffer exists to prevent). Instead: if already flushed-live,
 * the entry is gone — nothing to do. Otherwise keep it for a grace window so a
 * late ack can still drain it; only if no ack arrives do we drop it (covers a
 * renderer that crashed between `start` and `subscribe`, so it can't leak).
 */
function reapBufferOnRunEnd(runId: string): void {
  const entry = earlyEventBuffers.get(runId)
  if (!entry || entry.live) return // already drained + deleted by flushAndGoLive
  if (entry.reapTimer) return // grace timer already running
  entry.reapTimer = setTimeout(() => {
    earlyEventBuffers.delete(runId)
  }, BUFFER_REAP_GRACE_MS)
}

// groupId → controller for a cross-project dispatch (Phase C.2). Aborting the
// group aborts every leg. Cleared when all legs settle.
const activeCrossProjectGroups = new Map<string, { abort: AbortController; sender: WebContents }>()

// Raised from 50k: large pasted content (a technical doc, a transcript) is now a
// first-class input — the composer turns a big paste into an editable chip whose
// text rides in the message. 200k chars ≈ 50k tokens, comfortably inside the
// large-context models' windows alongside the ~25k-token system prompt. A paste
// past this still rejects cleanly rather than overflowing the model context.
const MAX_MESSAGE_LENGTH = 200_000
const MAX_SCENES = 100
const MAX_HISTORY = 200
// Cap a single cross-project broadcast's fan-out (renderer→main DoS/spend guard).
const MAX_DISPATCH_TARGETS = 24

function validateBody(body: unknown): AgentAPIRequest {
  if (!body || typeof body !== 'object') {
    throw new IpcValidationError('body must be an object')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any

  const isValidMessage =
    (typeof b.message === 'string' && b.message.trim().length > 0) || (Array.isArray(b.message) && b.message.length > 0)
  if (!isValidMessage) {
    throw new IpcValidationError('Missing required field: message')
  }

  if (!b.scenes || !Array.isArray(b.scenes)) {
    throw new IpcValidationError('Missing required field: scenes')
  }

  const msgTextForValidation = typeof b.message === 'string' ? b.message : JSON.stringify(b.message)
  if (msgTextForValidation.length > MAX_MESSAGE_LENGTH) {
    throw new IpcValidationError('Message too long')
  }
  if (b.scenes.length > MAX_SCENES) {
    throw new IpcValidationError('Too many scenes')
  }
  if (b.history && b.history.length > MAX_HISTORY) {
    throw new IpcValidationError('History too long')
  }

  if (b.projectId !== undefined && b.projectId !== null) {
    assertValidUuid(b.projectId, 'projectId')
  }

  return b as AgentAPIRequest
}

/**
 * Replicates the HTTP route's server-authoritative scene merge: the agent
 * must see the full scene code even if the renderer's working copy stripped
 * `canvasCode` / `sceneHTML` etc. for transport size. Without this, the
 * agent operates on placeholder fields and overwrites real work.
 */
async function mergeServerScenes(body: AgentAPIRequest): Promise<void> {
  if (!body.projectId) return
  let serverScenes: MergeScene[] = []
  let defaultBranchId: string | null = null
  const loadStart = Date.now()
  try {
    // Light scene read — this merge doesn't need layers/media/interactions or
    // sceneEdges, so loading the full project graph would only add run-start
    // latency. getProjectScenesLight stamps the TABLE's branchId column onto
    // every returned blob, so the branch-scoping below can never silently
    // degrade to "all → default".
    const { getProjectScenesLight } = await import('@/lib/db/queries/projects')
    serverScenes = (await getProjectScenesLight(body.projectId)) as unknown as MergeScene[]
    // Latency telemetry: the deeper selective-load work (summaries-only +
    // fetch-on-write) is deferred until this number actually hurts — make it
    // measurable instead of guessing. Captured here so the window covers the
    // scene query + blob JSON.parse (eager, inside the awaited query) and
    // NOT the default-branch lookup below.
    log.info('agent run-start scene load', {
      extra: { scenes: serverScenes.length, ms: Date.now() - loadStart },
    })
    // The read is NOT branch-scoped (the CODE-FILL leg must match variant runs'
    // source-branch client scenes by id). We need the project's default branch
    // to scope the APPEND leg (and to treat unstamped/null-branch scenes
    // correctly). Resolve it read-only; a project with no branch yet
    // (legacy/single-branch) yields null → no filtering.
    defaultBranchId = (await getDefaultBranch(body.projectId))?.id ?? null
  } catch (e) {
    log.warn('could not read server scenes for merge', { extra: { message: (e as Error).message } })
    return
  }
  if (serverScenes.length === 0) return

  // Branch-scope the merge so a single-branch run can NEVER pull or append another
  // branch's scenes into body.scenes (the pre-existing multi-branch blindness —
  // the scene read above returns all branches). The body's branchId is the run's
  // target branch; fall back to the default branch when the renderer sent null.
  body.scenes = mergeBranchScopedScenes(body.scenes as unknown as MergeScene[], serverScenes, {
    branchId: body.branchId ?? null,
    defaultBranchId,
  }) as unknown as Scene[]
}

/**
 * Resolve the project's owning user, if any, so generation logs and memories
 * attribute correctly. Single-user desktop today; when auth ships, replace
 * with a session lookup off `event.sender.session`.
 */
async function resolveOwnerUserId(projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null
  try {
    const row = await db
      .select({ userId: projectsTable.userId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1)
    return row[0]?.userId ?? null
  } catch (e) {
    log.warn('failed to resolve project owner', { error: e })
    return null
  }
}

/**
 * This window's human-readable instance id, derived EXACTLY the way main.ts
 * derives it for the MCP instance registry (instanceIdFor(userData, repoPath)),
 * so the run-lease "held by window <id>" message names the same window the
 * terminal/MCP connector would. Best-effort: if Electron `app` is somehow
 * unavailable (non-Electron test harness), returns null and the lease still
 * works keyed on pid alone.
 */
function thisInstanceId(): string | null {
  try {
    const userDataPath = app.getPath('userData')
    const repoPath = app.isPackaged ? null : app.getAppPath()
    return instanceIdFor(userDataPath, repoPath)
  } catch {
    return null
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:agent.start', async (event, body: unknown) => {
    const validated = validateBody(body)

    // Phase C cross-project isolation boundary. Every run is routed through
    // resolveLegBody BEFORE the prelude (reserveRunSlot + mergeServerScenes),
    // because those key on the leg's projectId. Today the only producer is
    // single-project, so this is always the IDENTITY case (target == origin) —
    // a byte-identical passthrough (`leg === validated`). A future cross-project
    // producer (Phase C.2) passes a distinct target projectId + a target-row
    // loader; until then a cross-project leg fails closed (CrossProjectLegAbort)
    // rather than running under the origin project's settings.
    const leg = await resolveLegBody(validated, validated.projectId, validated.projectId)

    // Per-branch lock (v0.3.8). Runs on different branches of the same
    // project can proceed in parallel — this is what unlocks the parallel
    // multi-variant agent spawn. Same-branch runs are still serialized so
    // two simultaneous edits to the same per-branch action_log can't
    // interleave.
    // Create the abort controller up front so the run slot can key staleness
    // on its liveness rather than a fixed wall-clock TTL — a long but healthy
    // run must not have its slot stolen at 10 min.
    const abortController = new AbortController()
    const slot = reserveRunSlot(leg.projectId, leg.branchId, abortController.signal)
    if (!slot.ok) {
      throw new IpcValidationError('Agent run already in progress for this branch')
    }

    const runId = crypto.randomUUID()
    const sender = event.sender

    // Open the early-event buffer for this run BEFORE any event can be emitted.
    // The renderer awaits this `start` reply, then attaches its listener and acks
    // via `dreambyte:agent.subscribed`, which flushes + flips to live. Until then
    // every emit (incl. the no-api-key fast path below) is buffered, not dropped.
    earlyEventBuffers.set(runId, { events: [], live: false, warned: false, sender })

    // Pre-flight BYOK check. If the user hasn't set any LLM key yet, fail
    // early with a structured event the chat UI can turn into an "Open
    // Settings" action — no 401 from the SDK deep in the stack.
    // Mock mode skips this entirely — the whole point of the toggle is to
    // exercise the chat UI without provider credentials.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockModeRequested = (leg as any).mockMode === true
    if (!mockModeRequested && !hasAnyAgentProviderConfigured()) {
      releaseRunSlot(leg.projectId, leg.branchId)
      setImmediate(() => {
        sendOrBufferEvent(sender, runId, {
          type: 'error',
          error:
            'No API key configured. Open Settings → Models and add a provider key (Anthropic, OpenAI, Google, DeepSeek, Qwen, or Kimi) to start generating.',
          reason: 'no_api_key',
        } as SSEEvent)
        // Terminal sentinel so the renderer resolves its stream promise. Buffered
        // until ack like any other event, so it can't be dropped pre-subscribe.
        sendOrBufferEvent(sender, runId, { type: '__stream_end__' })
        // This path has no runAgentRequest().finally to reap the buffer, so
        // schedule the grace reaper here: a late ack still flushes the error +
        // __stream_end__; a renderer that never acks can't leak the entry.
        reapBufferOnRunEnd(runId)
      })
      return { runId }
    }

    // Cross-PROCESS run lease. reserveRunSlot above only guards runs
    // within THIS window's memory; two windows / git worktrees driving the same
    // project share one ~/.dreambyte/studio.db and would each pass their own
    // in-memory check and run concurrently on the same (projectId, branchId),
    // double-mutating that branch's action_log. The DB lease is the authoritative
    // cross-window exclusion. Mirrors branch_locks: heartbeat + TTL liveness, so a
    // crashed window's lease is reclaimable; a CLEAN stop releases it (see the
    // .finally below) so a resume — same handler, resumeCheckpoint:true — is NOT
    // refused. The token is per-acquisition so two runs can't alias each other.
    const ownerToken = mintRunLeaseToken()
    const ownerInstanceId = thisInstanceId()
    let lease: Awaited<ReturnType<typeof acquireRunLease>>
    try {
      lease = await acquireRunLease(leg.projectId, leg.branchId, {
        ownerToken,
        instanceId: ownerInstanceId,
        pid: process.pid,
        runId,
      })
    } catch (leaseErr) {
      // The lease query itself failed (e.g. DB unavailable). Don't soft-brick
      // the run on infra noise — log, release the slot, and refuse honestly so
      // the user can retry rather than silently running unguarded.
      log.error('failed to acquire agent run lease', { extra: { runId }, error: leaseErr })
      releaseRunSlot(leg.projectId, leg.branchId)
      setImmediate(() => {
        sendOrBufferEvent(sender, runId, {
          type: 'error',
          error: 'Could not acquire the run lease (database error). Please try again.',
        } as SSEEvent)
        sendOrBufferEvent(sender, runId, { type: '__stream_end__' })
        reapBufferOnRunEnd(runId)
      })
      return { runId }
    }

    if (!lease.acquired) {
      // Another window holds a LIVE lease on this (project, branch). Refuse
      // honestly with the holder's identity, mirroring how other agent errors
      // are surfaced on the event channel. Release our in-memory slot (the DB
      // lease is not ours to touch) and return WITHOUT starting the run.
      releaseRunSlot(leg.projectId, leg.branchId)
      const { instanceId: heldInstance, pid: heldPid, ageMs } = lease.heldBy
      const windowDesc = heldInstance ? `window ${heldInstance}` : 'another window'
      const pidDesc = heldPid != null ? `, pid ${heldPid}` : ''
      const ageSec = Math.round(ageMs / 1000)
      setImmediate(() => {
        sendOrBufferEvent(sender, runId, {
          type: 'error',
          error: `Another agent run is active on this project (${windowDesc}${pidDesc}, last seen ${ageSec}s ago). Wait for it to finish or stop it, then retry.`,
          reason: 'run_lease_held',
        } as SSEEvent)
        sendOrBufferEvent(sender, runId, { type: '__stream_end__' })
        reapBufferOnRunEnd(runId)
      })
      return { runId }
    }

    // Wall-clock heartbeat to keep the lease alive. It MUST be loop-decoupled:
    // a single run iteration can block ~10 min on media generation, so a
    // heartbeat coupled to the run loop would let the lease go stale mid-run and
    // another window would steal it. setInterval ticks on wall time regardless
    // of what the run is doing. unref so this timer can't keep the process alive
    // on shutdown. Cleared in the .finally below alongside releaseRunLease.
    const leaseHeartbeat = setInterval(() => {
      void heartbeatRunLease(leg.projectId, leg.branchId, ownerToken).catch((err) =>
        log.warn('agent run lease heartbeat failed', { extra: { runId }, error: err }),
      )
    }, HEARTBEAT_MS)
    if (typeof leaseHeartbeat.unref === 'function') leaseHeartbeat.unref()

    // Prelude (DB merge + owner lookup) can throw on transient network
    // errors. Without the try/catch, the lock reserved above would stay
    // held until the 10-min STALE_RUN_TIMEOUT_MS, blocking the branch
    // for any retry — and with v0.3.8 per-branch locks, a spawn that
    // hits a network blip mid-prelude could leave several branches in
    // that locked state at once. Release on throw so the IPC client
    // can immediately retry.
    let authenticatedUserId: string | null
    try {
      await mergeServerScenes(leg)
      authenticatedUserId = await resolveOwnerUserId(leg.projectId)
    } catch (preludeErr) {
      releaseRunSlot(leg.projectId, leg.branchId)
      // The run never starts, so its .finally never runs — tear down the lease
      // here (stop heartbeat + release the DB row) so a retry isn't refused.
      clearInterval(leaseHeartbeat)
      void releaseRunLease(leg.projectId, leg.branchId, ownerToken).catch((err) =>
        log.warn('agent run lease release failed (prelude error)', { extra: { runId }, error: err }),
      )
      // `start` is about to reject, so the renderer never subscribes/acks — drop
      // the buffer entry we opened above so it can't leak.
      earlyEventBuffers.delete(runId)
      throw preludeErr
    }

    activeControllers.set(runId, { abort: abortController, sender })

    // Forward each runner event back to the renderer that started the run.
    // Buffers pre-subscribe (run-start race fix) then sends live once the
    // renderer acks via `dreambyte:agent.subscribed`. Skips dead windows — the
    // runner keeps going so generation log + persistence still complete.
    const emit = (sseEvent: SSEEvent) => {
      sendOrBufferEvent(sender, runId, sseEvent)
      // The post-run DB persist completion is ALSO forwarded out-of-band on a
      // dedicated channel, keyed by runId. The normal event channel rides the
      // transport subscription, which the renderer tears down the instant it
      // aborts a run (src/lib/agent-transport.ts) — exactly the case where the
      // renderer's refresh would otherwise race main's persist. This direct send
      // bypasses the transport so the renderer's persist-wait always resolves and
      // refreshes from a settled DB. Best-effort; the renderer also has a
      // version-poll fallback so a dropped send never freezes the UI.
      if (sseEvent.type === 'persist_done' && !sender.isDestroyed()) {
        try {
          sender.send('dreambyte:agent.persistDone', { runId, persistOk: sseEvent.persistOk !== false })
        } catch (e) {
          log.warn('failed to forward persist_done out-of-band', { extra: { runId }, error: e })
        }
      }
    }

    // Defer the actual runner start until the next tick so the IPC reply
    // carrying `runId` reaches the renderer first. This is now a latency hint,
    // not the correctness mechanism: the per-runId early-event buffer above is
    // what guarantees no `run_start`/token is dropped if the renderer hasn't
    // attached + acked its listener yet (under main-process load `setImmediate`
    // alone can still fire before the renderer subscribes).
    setImmediate(() => {
      // Held on the controller entry so `before-quit` can await the persist
      // instead of tearing the process down mid-run (abortActiveRunsForShutdown).
      const done = runAgentRequest({
        body: leg,
        authenticatedUserId,
        abortSignal: abortController.signal,
        emit,
        // Unify the run id: the runner's logger.runId MUST equal the runId that
        // keys activeControllers + the event channel here, so mid-run steering can
        // target the same run the IPC tracks. Without this they were two
        // independent UUIDs and steers were rejected / never drained.
        runId,
      })
        .catch((err) => {
          log.error('agent run threw', { extra: { runId }, error: err })
          emit({
            type: 'error',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            error: `Agent error: ${(err as any)?.message ?? 'Unknown error'}`,
          })
        })
        .finally(() => {
          releaseRunSlot(leg.projectId, leg.branchId)
          // Cross-process lease teardown. Stop the wall-clock heartbeat
          // and release the DB row. release is token-scoped (ownerToken), so if
          // the TTL already reclaimed this run's row and re-granted a new lease
          // to another window, this DELETE matches only OUR token and can never
          // free someone else's live lease. This clean release is exactly what
          // lets a stop→resume re-acquire immediately.
          clearInterval(leaseHeartbeat)
          void releaseRunLease(leg.projectId, leg.branchId, ownerToken).catch((err) =>
            log.warn('agent run lease release failed', { extra: { runId }, error: err }),
          )
          activeControllers.delete(runId)
          // A steer can land in the narrow gap between the runner's final drain and
          // this de-registration — the IPC active-check still passed, so it returned
          // ok:true but the runner will never drain it. Report it as unconsumed
          // (not silently dropped) so the client resends it; this also reclaims the
          // globalThis inbox key. Sent BEFORE __stream_end__ so the client sees it.
          // Routed through sendOrBufferEvent so a still-unacked run buffers it too.
          if (!sender.isDestroyed()) {
            const orphaned = drainSteers(runId)
            if (orphaned.length > 0) {
              sendOrBufferEvent(sender, runId, {
                type: 'steer_unconsumed',
                ids: orphaned.map((s) => s.id),
              } as SSEEvent)
            }
          } else {
            clearSteers(runId) // window can't reach the renderer; just reclaim the key
          }
          // Sentinel so the renderer can resolve the streaming promise even if
          // the runner crashed before emitting `done`.
          sendOrBufferEvent(sender, runId, { type: '__stream_end__' })
          // Reap WITHOUT racing the ack. If the run finished before the renderer
          // acked, deleting now would discard the buffered events (incl. the
          // __stream_end__ just queued) and hang `await done`. reapBufferOnRunEnd
          // keeps an unacked buffer for a grace window so a late ack still drains
          // it, then drops it; an already-live run was deleted on flush.
          reapBufferOnRunEnd(runId)
        })
      const entry = activeControllers.get(runId)
      if (entry) entry.done = done
    })

    return { runId }
  })

  // Run-start race fix: the renderer calls this AFTER attaching its
  // `dreambyte:agent.event` listener for `runId`, signalling it is ready to
  // receive. We flush any events the runner emitted in the window between
  // `start` returning and the listener attaching (which were buffered, not
  // dropped), then switch the run to live pass-through. Enforced order on the
  // renderer side: attach listener → invoke this ack → main flushes buffer, so
  // no event can slip between the flush and live mode. Unknown/already-flushed
  // runIds are a harmless no-op (idempotent).
  ipcMain.handle('dreambyte:agent.subscribed', async (event, args: { runId?: string }) => {
    const runId = args?.runId
    if (!runId || typeof runId !== 'string') {
      throw new IpcValidationError('Missing runId')
    }
    // Owner check: only the window that started the run may flush it. Without
    // this, any window that learns a runId could ack it, steal the buffered
    // stream, and flip it live — leaving the real owner to hang. Unknown/
    // already-flushed runIds have no entry → silently ignored (idempotent).
    const entry = earlyEventBuffers.get(runId)
    if (entry && entry.sender !== event.sender) {
      return { ok: false as const }
    }
    flushAndGoLive(event.sender, runId)
    return { ok: true as const }
  })

  // Phase C.2: cross-project dispatch — fan one request across N target projects,
  // each leg fully isolated (resolveLegBody builds a fresh leg from the target's
  // own settings + branch-scoped scenes). Leg events are tagged onto a SEPARATE
  // channel (dreambyte:agent.crossProjectEvent) so the renderer's cross-project run
  // view consumes them WITHOUT ever touching the active project's store. Dormant
  // until the dispatch_to_projects tool + renderer wire it.
  ipcMain.handle(
    'dreambyte:agent.dispatchProjects',
    async (event, args: { originBody?: unknown; targets?: unknown; instruction?: unknown; groupBudgetUsd?: number | null }) => {
      const originBody = validateBody(args?.originBody)
      if (!originBody.projectId) throw new IpcValidationError('originBody.projectId is required')
      if (!Array.isArray(args?.targets) || args.targets.length === 0) {
        throw new IpcValidationError('targets must be a non-empty array')
      }
      if (args.targets.length > MAX_DISPATCH_TARGETS) {
        throw new IpcValidationError(`too many targets (max ${MAX_DISPATCH_TARGETS})`)
      }
      const targets = args.targets.map((t, i) => {
        if (typeof t !== 'string') throw new IpcValidationError(`targets[${i}] must be a string`)
        assertValidUuid(t, `targets[${i}]`)
        return t
      })
      const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : ''
      if (!instruction) throw new IpcValidationError('instruction is required')
      // instruction overwrites every leg's message, so it must obey the same cap.
      if (instruction.length > MAX_MESSAGE_LENGTH) {
        throw new IpcValidationError(`instruction too long (max ${MAX_MESSAGE_LENGTH})`)
      }
      const groupBudgetUsd = args?.groupBudgetUsd ?? null
      if (groupBudgetUsd !== null && (typeof groupBudgetUsd !== 'number' || !Number.isFinite(groupBudgetUsd) || groupBudgetUsd < 0)) {
        throw new IpcValidationError('groupBudgetUsd must be null or a finite number >= 0')
      }

      const groupId = crypto.randomUUID()
      const sender = event.sender
      const abortController = new AbortController()
      activeCrossProjectGroups.set(groupId, { abort: abortController, sender })

      try {
        const { outcomes, settled } = await runCrossProjectDispatch(
          { originBody, targets, instruction, groupBudgetUsd, groupId, abortSignal: abortController.signal },
          {
            loadTargetRow: loadTargetProjectRow,
            ensureDefaultBranch: async (projectId) => (await getOrCreateDefaultBranch(projectId)).id,
            reserveRunSlot,
            releaseRunSlot,
            // Cross-process run lease: each leg acquires/heartbeats/releases
            // the SAME DB lease the direct run-start handler uses, so two windows /
            // worktrees can't run the same (target, branch) concurrently. Wired here
            // (not imported inside the DB-free dispatch module) to keep that module
            // unit-testable.
            acquireRunLease,
            heartbeatRunLease,
            releaseRunLease,
            mintRunLeaseToken,
            leaseHeartbeatMs: HEARTBEAT_MS,
            leaseInstanceId: thisInstanceId(),
            resolveOwnerUserId,
            runAgentRequest,
            emitLegEvent: (msg) => {
              if (sender.isDestroyed()) return
              try {
                sender.send('dreambyte:agent.crossProjectEvent', msg)
              } catch (e) {
                log.warn('failed to forward cross-project event', { extra: { groupId }, error: e })
              }
            },
            newRunId: () => crypto.randomUUID(),
          },
        )
        // Fire-and-forget: legs run in the background; return groupId + outcomes now.
        // Clean up the group once every leg settles.
        void settled.finally(() => activeCrossProjectGroups.delete(groupId))
        return { groupId, outcomes }
      } catch (e) {
        // Setup-phase throw (runCrossProjectDispatch contains per-leg failures, so
        // this is only the no-projectId guard or an unexpected fault). Never leak
        // the group-map entry.
        activeCrossProjectGroups.delete(groupId)
        throw e
      }
    },
  )

  ipcMain.handle('dreambyte:agent.abortCrossProject', async (_event, args: { groupId: string }) => {
    const entry = args?.groupId ? activeCrossProjectGroups.get(args.groupId) : null
    if (!entry) return { ok: false as const }
    entry.abort.abort()
    return { ok: true as const }
  })

  ipcMain.handle('dreambyte:agent.abort', async (_event, args: { runId: string }) => {
    const entry = args?.runId ? activeControllers.get(args.runId) : null
    if (!entry) return { ok: false as const }
    entry.abort.abort()
    return { ok: true as const }
  })

  // Live run ids, for the renderer's orphan-chat-row probe (orphan-detection.ts /
  // agent-actions.ts): a persisted chat row whose runId is NOT among the live runs
  // is orphaned. `activeControllers` is the authoritative set of in-flight runs
  // (keyed by runId; set on agent.start, deleted on completion). Without this
  // handler the renderer's `invoke('dreambyte:agent.activeRunIds')` threw
  // "No handler registered" on every probe and the store silently fell back to
  // "unknown" — so the orphan optimization never engaged.
  ipcMain.handle('dreambyte:agent.activeRunIds', async () => ({
    runIds: Array.from(activeControllers.keys()),
  }))

  // Mid-run steering: push a typed message into a LIVE run. Validate at the
  // trust boundary — only an ACTIVE run can be steered (ended/unknown runId →
  // ok:false so the client falls back to a normal new turn), bound the text, and
  // let the inbox's flood cap reject excess. The runner drains it next iteration.
  ipcMain.handle(
    'dreambyte:agent.steer',
    async (_event, payload: { runId?: string; id?: string; text?: string }) => {
      const r = acceptSteer(payload, (runId) => activeControllers.has(runId))
      if (r.status === 'invalid') throw new IpcValidationError(`Invalid steer payload (${r.reason})`)
      if (r.status === 'inactive') return { ok: false as const } // run ended → client resends (no silent loss)
      return { ok: r.ok } // false when the per-run queue is at the flood cap
    },
  )

  ipcMain.handle(
    'dreambyte:agent.captureResponse',
    async (_event, payload: { captureId: string; dataUri?: string; mimeType?: string; error?: string }) => {
      if (!payload?.captureId || typeof payload.captureId !== 'string') {
        throw new IpcValidationError('Missing captureId')
      }
      if (payload.error) {
        return { ok: rejectPendingCapture(payload.captureId, payload.error) }
      }
      if (!payload.dataUri || typeof payload.dataUri !== 'string' || !payload.dataUri.startsWith('data:')) {
        throw new IpcValidationError('Missing or invalid dataUri')
      }
      return { ok: resolvePendingCapture(payload.captureId, payload.dataUri, payload.mimeType ?? 'image/jpeg') }
    },
  )

  ipcMain.handle(
    'dreambyte:agent.exportResponse',
    async (
      _event,
      payload: { exportId: string; outputPath?: string; error?: string; sceneIndex?: number; sceneId?: string },
    ) => {
      if (!payload?.exportId || typeof payload.exportId !== 'string') {
        throw new IpcValidationError('Missing exportId')
      }
      if (payload.error) {
        // 11b: thread the failing-scene context through to the rejection so the
        // runner's job catch can persist structured errorSceneIndex/errorSceneId.
        return {
          ok: rejectPendingExport(payload.exportId, payload.error, {
            sceneIndex: typeof payload.sceneIndex === 'number' ? payload.sceneIndex : undefined,
            sceneId: typeof payload.sceneId === 'string' && payload.sceneId ? payload.sceneId : undefined,
          }),
        }
      }
      if (!payload.outputPath || typeof payload.outputPath !== 'string') {
        throw new IpcValidationError('Missing or invalid outputPath')
      }
      return { ok: resolvePendingExport(payload.exportId, payload.outputPath) }
    },
  )

  ipcMain.handle(
    'dreambyte:agent.clipResponse',
    async (_event, payload: { clipId: string; dataUri?: string; mimeType?: string; error?: string }) => {
      if (!payload?.clipId || typeof payload.clipId !== 'string') {
        throw new IpcValidationError('Missing clipId')
      }
      if (payload.error) {
        return { ok: rejectPendingClip(payload.clipId, payload.error) }
      }
      // Decode + validate at the trust boundary (size ceiling + mime allowlist):
      // the renderer's 14MB cap is advisory; a compromised/replayed renderer
      // message must not amplify into main-process memory or spoof the mime that
      // flows into Gemini. The pure helper throws; surface as a validation error.
      let decoded
      try {
        decoded = decodeClipDataUri(payload.dataUri)
      } catch (err) {
        throw new IpcValidationError((err as Error).message)
      }
      return { ok: resolvePendingClip(payload.clipId, decoded.bytes, decoded.mimeType) }
    },
  )
}
