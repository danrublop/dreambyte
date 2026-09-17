/**
 * No-progress (stuck / ping-pong) loop detector.
 *
 * A stuck model that repeats the same tool call, or ping-pongs between two
 * tools, with no effect on world state used to burn the entire cost cap and
 * 5–10 minutes before the 40-iteration / 150-call caps fired. This detector
 * cuts that short: after N no-progress calls drawn from at most two distinct
 * signatures it asks the runner to steer once; if the model keeps repeating
 * after the steer it asks the runner to hard-stop with a `stuck` reason +
 * checkpoint.
 *
 * Kept in its own module (mirrors run-stopped.ts) so it can be unit-tested
 * without pulling the runner's provider dependency graph.
 *
 * Design notes:
 *  - Signature = `(toolName, JSON.stringify(input))`. Two calls that differ in
 *    EITHER the tool name or a single arg are distinct signatures.
 *  - "No progress" means the completed tool produced no state delta: no new
 *    `affectedSceneId`, and no change in runProgress `scenesCreated` /
 *    `scenesEdited` / `errors` counts. ANY call that makes progress clears the
 *    detector window, so a healthy retry that actually writes a scene (it
 *    carries `affectedSceneId`) can never trip it — this is what keeps the
 *    audit-bounded verify→write→verify loop (verificationCyclesMax=2) from
 *    being mistaken for a stall.
 *  - The detector watches the last K MUTATING calls (a sliding window). It
 *    fires when that window is full of no-delta calls drawn from ≤2 distinct
 *    signatures — catching BOTH a single repeated call (1 signature) and a
 *    true A↔B ping-pong (2 signatures), while A→B→C→… real progress (3+
 *    distinct, or any delta) never trips.
 *  - Poll / read-only tools that legitimately repeat while waiting on async
 *    work (export, video, avatar jobs) are EXEMPT — they're skipped entirely,
 *    so a build correctly waiting on a long job is not killed and the poll
 *    calls don't dilute the mutating-call window.
 */

/** Sliding-window size of recent MUTATING calls examined for a stall. */
export const STUCK_WINDOW = 4

/** Distinct no-delta signatures within a full window that still counts as a
 *  stall. 2 covers a single repeated call (1) and an A↔B ping-pong (2). */
export const STUCK_MAX_DISTINCT = 2

/** Once the window first shows a stall the runner steers ONCE. The detector
 *  then needs this many ADDITIONAL no-delta mutating calls (still ≤2 distinct)
 *  before it asks for the hard stop — a full extra window past the steer for
 *  the model to change course. */
export const STUCK_STOP_GRACE = STUCK_WINDOW

/**
 * Read-only / query tool NAME PREFIXES. Any tool whose name begins with one of
 * these is a non-mutator by convention in this codebase (a status poll, a state
 * read, a structural describe, a library query, or a vision review) — repeating
 * it cannot itself advance the project, so it must never accumulate toward a
 * stall. Exempting by PROPERTY (the verb prefix) instead of a hand-maintained
 * allowlist is what keeps this robust when the tool registry drifts: a new
 * `get_*` / `list_*` / `read_*` tool is exempt the day it's added.
 *
 * Verified against src/lib/agents/tools.ts (the live registry): every registered
 * tool matching one of these prefixes is read-only — see the grep audit in the
 * accompanying test. Mutators in this codebase use action verbs (create/set/
 * add/update/remove/move/apply/generate/rollback/…), none of which collide.
 */
export const STUCK_EXEMPT_PREFIXES: readonly string[] = ['get_', 'list_', 'read_', 'describe_', 'query_', 'review_']

/**
 * Read-only / non-mutating tools whose NAMES do not match a prefix above but
 * which still legitimately repeat (searches, fetches, reference analysis) or
 * are documented async-poll / state-read primitives we want exempt explicitly
 * for belt-and-suspenders even though a prefix already covers them.
 *
 * These must NOT count toward the stuck window: the detector judges only
 * potential MUTATORS, and re-reading/searching state is exactly how a healthy
 * model (especially the weaker DeepSeek/Kimi/Qwen tiers) orients itself between
 * edits. Verified read-only against the tool-handlers; do NOT add a mutator.
 */
export const STUCK_EXEMPT_EXTRAS: ReadonlySet<string> = new Set([
  // async job polls — repetition is the correct behavior while waiting
  'get_status',
  // explicit read-only state primitives (also prefix-covered; pinned here so a
  // prefix rename can never silently un-exempt them)
  'inspect',
  // design_brief is read+write (action discriminator), so not blanket-exempt;
  // media_library(action:query) reads.
  // search / fetch / analysis reads (no verb prefix, never mutate state)
  'media_library',
  'web_search',
  'request_web_search',
  'fetch_url_content',
  'analyze_reference_media',
])

/**
 * True when a tool may NOT advance project state by construction — a status
 * poll, a state/structure read, a library query, a search/fetch, or a vision
 * review. Such tools are skipped entirely by the detector: they neither
 * accumulate toward a stall NOR reset the mutating-call window. Exempt-by-
 * PROPERTY (prefix) first, then the explicit extras for non-prefixed reads.
 *
 * NOTE: a read-only tool that nonetheless returns a non-null affectedSceneId
 * (e.g. review(scope:'motion') echoes its target sceneId) is ALSO handled by the
 * runner's hadDelta path — so it can never trip the detector regardless. This
 * predicate is the cheap, registry-drift-proof first line of defense.
 */
export function isStuckExempt(toolName: string): boolean {
  for (const p of STUCK_EXEMPT_PREFIXES) {
    if (toolName.startsWith(p)) return true
  }
  return STUCK_EXEMPT_EXTRAS.has(toolName)
}

/**
 * @deprecated Back-compat alias. Prefer {@link isStuckExempt}, which also
 * applies the read-only prefix heuristic. This set is now only the EXPLICIT
 * non-prefixed extras and does NOT, on its own, capture every exempt tool.
 */
export const STUCK_EXEMPT_TOOLS: ReadonlySet<string> = STUCK_EXEMPT_EXTRAS

export interface StuckDetectorState {
  /** Signatures of the last STUCK_WINDOW (+grace) mutating no-delta calls. */
  window: string[]
  /** Whether the one-time steering note has already been injected for the
   *  current stall. Cleared whenever real progress resets the window. */
  steered: boolean
  /** How many no-delta mutating calls have been recorded since the steer note
   *  was injected (used to grant the post-steer grace window). */
  callsSinceSteer: number
}

export function createStuckDetectorState(): StuckDetectorState {
  return { window: [], steered: false, callsSinceSteer: 0 }
}

/** Stable signature for a tool call. Distinct tool OR distinct args ⇒ distinct
 *  signature. Input that fails to serialize (cycles) falls back to a name-only
 *  signature rather than throwing — a degenerate but safe outcome. */
export function toolSignature(toolName: string, input: unknown): string {
  let argStr: string
  try {
    argStr = JSON.stringify(input ?? {})
  } catch {
    argStr = '<unserializable>'
  }
  return `${toolName} ${argStr}`
}

export type StuckAction = { kind: 'none' } | { kind: 'steer'; signature: string } | { kind: 'stop'; signature: string }

function distinctCount(sigs: string[]): number {
  return new Set(sigs).size
}

/**
 * Feed one completed tool call into the detector and decide what (if anything)
 * the runner should do.
 *
 * @param state    mutable detector state (carried across the run)
 * @param toolName the tool that just completed
 * @param input    the tool's input object (for the signature)
 * @param hadDelta whether the call produced a real state delta (new
 *                 affectedSceneId or a change in scenesCreated/scenesEdited/
 *                 errors counts)
 *
 * Returns:
 *  - `{kind:'steer'}` exactly once, when a full window of no-delta mutating
 *    calls first collapses to ≤STUCK_MAX_DISTINCT distinct signatures.
 *  - `{kind:'stop'}`  when the stall persists for STUCK_STOP_GRACE more
 *    no-delta mutating calls after the steer.
 *  - `{kind:'none'}`  otherwise (progress made, exempt tool, or not yet a
 *    confirmed stall).
 */
export function recordToolForStuckDetection(
  state: StuckDetectorState,
  toolName: string,
  input: unknown,
  hadDelta: boolean,
): StuckAction {
  // Exempt poll/read tools entirely: they neither advance NOR reset the
  // mutating-call window, so a build that polls get_status (or re-reads
  // inspect(kind:'scene'/'editor') to orient) between mutating
  // retries is still judged purely on the mutating signatures around it.
  if (isStuckExempt(toolName)) {
    return { kind: 'none' }
  }

  // A mutating call that actually changed state is healthy progress. Clear the
  // window — the model is doing useful work, not thrashing.
  if (hadDelta) {
    state.window = []
    state.steered = false
    state.callsSinceSteer = 0
    return { kind: 'none' }
  }

  const sig = toolSignature(toolName, input)
  state.window.push(sig)
  // Keep enough history to span the detection window plus the post-steer grace.
  const maxLen = STUCK_WINDOW + STUCK_STOP_GRACE
  if (state.window.length > maxLen) state.window.shift()
  if (state.steered) state.callsSinceSteer += 1

  // Not enough samples to judge a stall yet.
  if (state.window.length < STUCK_WINDOW) return { kind: 'none' }

  // Is the most-recent window a stall? (full window, ≤2 distinct signatures)
  const recent = state.window.slice(-STUCK_WINDOW)
  const isStall = distinctCount(recent) <= STUCK_MAX_DISTINCT
  if (!isStall) {
    // Window broke out of the stall (3+ distinct recent signatures). Don't
    // reset `steered` — a model that already earned a steer and then briefly
    // diversified before relapsing shouldn't get an unlimited supply of
    // steers — but there's nothing to do this call.
    return { kind: 'none' }
  }

  if (!state.steered) {
    state.steered = true
    state.callsSinceSteer = 0
    return { kind: 'steer', signature: recent[recent.length - 1] }
  }

  // Already steered and still stalling: stop once the grace window is spent.
  if (state.callsSinceSteer >= STUCK_STOP_GRACE) {
    return { kind: 'stop', signature: recent[recent.length - 1] }
  }

  return { kind: 'none' }
}

/**
 * The runner drains at most ONE stuck action per iteration, but several tools
 * can complete within a single iteration (a parallel batch or a burst). This
 * folds each tool's freshly-computed {@link StuckAction} into the pending slot
 * across a burst, resolving the two hazards a naive "last write wins" had:
 *
 *  - A real-progress call that RESET the detector window (`hadDelta` on a
 *    non-exempt tool) clears any steer/stop queued earlier in the SAME burst —
 *    otherwise a now-stale steer/stop fired at the boundary even though the
 *    model just advanced state.
 *  - The FIRST steer of the iteration is sticky: a later `stop` in the same
 *    burst must NOT overwrite it, or the "one steer (and a turn to react) before
 *    we hard-stop" guarantee is skipped when a whole stall unfolds in one turn.
 *
 * `exempt` is `isStuckExempt(toolName)` — an exempt poll/read never resets the
 * detector window, so its (rare) hadDelta must not clear a real pending action.
 */
export function accumulateStuckAction(
  box: { action: StuckAction },
  action: StuckAction,
  hadDelta: boolean,
  exempt: boolean,
): void {
  if (hadDelta && !exempt) {
    box.action = { kind: 'none' }
    return
  }
  if (action.kind === 'steer') {
    if (box.action.kind === 'none') box.action = action
  } else if (action.kind === 'stop') {
    if (box.action.kind !== 'steer') box.action = action
  }
}

/** The one-time steering note injected into the conversation when the detector
 *  first fires. Plain string (the runner pushes it as user-role content). */
export function buildStuckSteerNote(toolName: string): string {
  return (
    `[SYSTEM: You have repeatedly called the same tool(s) (e.g. \`${toolName}\`) with no effect on the project — ` +
    `no scene was created, edited, or fixed. Repeating the same calls will not help. ` +
    `Change your approach: try a different tool or different arguments, or if the task cannot be completed, ` +
    `stop and explain what is blocking you. If you keep repeating with no effect the run will be stopped.]`
  )
}
