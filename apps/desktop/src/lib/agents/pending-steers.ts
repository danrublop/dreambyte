/**
 * Server-side inbox for mid-run STEER messages (mid-run steering).
 *
 * While the agent runs, the user can keep typing. Each typed message is a
 * "steer": the renderer posts it into the live run (via a runId-scoped IPC,
 * `dreambyte:agent.steer`), and the top-level runner loop drains it between
 * iterations and pushes it as the next user turn (`runner.ts` loop top).
 *
 * This is the REVERSE direction of pending-captures.ts: there the runner creates
 * a promise and the renderer resolves it; here the renderer initiates (appends)
 * and the runner polls (drains). So the inbox is a plain `Map<runId, Steer[]>` —
 * no promise/await. Stored on globalThis so hot-reload / Next.js route bundling
 * don't produce competing maps (same pattern as pending-captures/pending-exports).
 *
 * Lifecycle (per top-level run; sub-agents have distinct runIds and are NOT drained):
 *   enqueueSteer(runId, steer)  ← IPC handler, on each typed message
 *   drainSteers(runId)          → runner, each top-level iteration (and once on teardown)
 *   clearSteers(runId)          ← defensive teardown (drainSteers already clears)
 *
 * Honesty contract: a steer is either consumed (drained into an LLM call →
 * `steer_consumed`) or reported on teardown (`steer_unconsumed`). It is never
 * silently dropped — the runner drains the remainder on every exit path.
 */

export interface Steer {
  /** Client-generated id, echoed back in steer_consumed/steer_unconsumed so the
   *  renderer can reconcile its optimistic message (delivered vs resend). */
  id: string
  text: string
}

/** Flood guard: max queued steers per run. The IPC handler rejects beyond this
 *  so a runaway client can't grow the inbox unbounded. */
export const STEER_QUEUE_MAX = 20
/** Max steer text length (chars). Bounded at the IPC trust boundary. */
export const STEER_TEXT_MAX = 8000

const GLOBAL_KEY = '__dreambytePendingSteers__' as const
type SteerMap = Map<string, Steer[]>

function getMap(): SteerMap {
  const g = globalThis as unknown as Record<string, unknown>
  let map = g[GLOBAL_KEY] as SteerMap | undefined
  if (!map) {
    map = new Map()
    g[GLOBAL_KEY] = map
  }
  return map
}

/**
 * Append a steer to a run's inbox. Returns false when the run's queue is already
 * at `STEER_QUEUE_MAX` (flood guard) — the IPC handler rejects so the client can
 * surface "slow down / still queued" rather than silently growing the inbox.
 */
export function enqueueSteer(runId: string, steer: Steer): boolean {
  if (!runId || !steer?.id) return false
  const map = getMap()
  const queue = map.get(runId) ?? []
  if (queue.length >= STEER_QUEUE_MAX) return false
  queue.push(steer)
  map.set(runId, queue)
  return true
}

/**
 * Return and REMOVE all queued steers for a run, in FIFO order. Empty array when
 * the run has nothing queued (or unknown runId). Draining always clears the key,
 * so the runner can call it each iteration and once more on teardown to collect
 * any remainder for `steer_unconsumed`.
 */
export function drainSteers(runId: string): Steer[] {
  const map = getMap()
  const queue = map.get(runId)
  map.delete(runId)
  return queue && queue.length > 0 ? queue : []
}

/** Drop a run's inbox without draining (defensive teardown). drainSteers already
 *  clears, so this is a no-op after a drain — kept for an explicit abort path. */
export function clearSteers(runId: string): void {
  getMap().delete(runId)
}

/** Current queue depth for a run (0 if none). Test/introspection helper. */
export function steerQueueDepth(runId: string): number {
  return getMap().get(runId)?.length ?? 0
}

export type SteerValidation =
  | { ok: true; runId: string; steer: Steer }
  | { ok: false; reason: 'missing-runid' | 'missing-id' | 'missing-text' | 'empty' | 'too-long' }

/**
 * Validate a raw steer IPC payload at the trust boundary (pure, no Electron deps
 * so it's unit-testable). The IPC handler maps `ok:false` reasons to a validation
 * error, then checks the run is still active before enqueuing. Trims the text.
 */
export function validateSteerPayload(payload: { runId?: unknown; id?: unknown; text?: unknown }): SteerValidation {
  if (typeof payload?.runId !== 'string' || payload.runId.length === 0) return { ok: false, reason: 'missing-runid' }
  if (typeof payload.id !== 'string' || payload.id.length === 0) return { ok: false, reason: 'missing-id' }
  if (typeof payload.text !== 'string') return { ok: false, reason: 'missing-text' }
  const text = payload.text.trim()
  if (text.length === 0) return { ok: false, reason: 'empty' }
  if (text.length > STEER_TEXT_MAX) return { ok: false, reason: 'too-long' }
  return { ok: true, runId: payload.runId, steer: { id: payload.id, text } }
}

/**
 * The full steer-accept decision at the IPC trust boundary (pure — `isActive` is
 * injected, so it's unit-testable without Electron). Validate → check the run is
 * still active → enqueue (honoring the flood cap). The IPC handler maps:
 *   'invalid'  → throw IpcValidationError (bad client payload)
 *   'inactive' → { ok: false } (run ended — client resends as a normal turn)
 *   'enqueued' → { ok } (ok=false means the per-run flood cap was hit)
 */
export function acceptSteer(
  payload: { runId?: unknown; id?: unknown; text?: unknown },
  isActive: (runId: string) => boolean,
):
  | { status: 'invalid'; reason: 'missing-runid' | 'missing-id' | 'missing-text' | 'empty' | 'too-long' }
  | { status: 'inactive' }
  | { status: 'enqueued'; ok: boolean } {
  const v = validateSteerPayload(payload)
  if (!v.ok) return { status: 'invalid', reason: v.reason }
  if (!isActive(v.runId)) return { status: 'inactive' }
  return { status: 'enqueued', ok: enqueueSteer(v.runId, v.steer) }
}
