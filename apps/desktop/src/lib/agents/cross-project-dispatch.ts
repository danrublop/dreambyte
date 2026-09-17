/**
 * Cross-project dispatch — main-process orchestration helpers.
 *
 * Planning + orchestration for fanning one agent request across N target
 * projects. The IPC handler (dreambyte:agent.dispatchProjects) validates/caps input,
 * then calls runCrossProjectDispatch, which plans the deduped, origin-excluded
 * leg set (planCrossProjectLegs) and per leg: ensureDefaultBranch(B) →
 * reserveRunSlot(B) → resolveLegBody (fail-closed) → runAgentRequest, tagging
 * every emitted event with its targetProjectId. Reserve-before-resolve closes the
 * stale-write race; per-leg failures are contained (never throw out).
 *
 * The planner + orchestrator are pure (no DB / no Electron — side effects are
 * injected via deps) so the logic is unit-testable. UUID validation + caps are the
 * IPC boundary's job, not this module's.
 */

import { reserveVariantBudget } from './spawn-variants'
import { resolveLegBody, CrossProjectLegAbort, type LoadTargetRow } from '@/lib/services/resolve-leg-body'
import type { AgentAPIRequest } from '@/lib/services/agent-runner'
import type { SSEEvent } from './types'

// ── Cross-process run lease ──────────────────────────────────────────
// Injected so this module stays DB-free / unit-testable. Shapes mirror the real
// src/lib/db/queries/agent-run-leases.ts API the IPC handler wires in. Threading the
// lease makes each cross-project leg obey the SAME cross-window exclusion the
// direct run-start handler already enforces — two windows can no longer run the
// same (target, branch) concurrently and race persistScenesFromAgentRun.
export interface RunLeaseOptions {
  ownerToken: string
  instanceId?: string | null
  pid?: number | null
  runId?: string | null
}
export type AcquireRunLeaseResult =
  | { acquired: true }
  | { acquired: false; heldBy: { instanceId: string | null; pid: number | null; ageMs: number } }
export interface RunLeaseApi {
  acquireRunLease: (
    projectId: string | undefined,
    branchId: string | null | undefined,
    opts: RunLeaseOptions,
  ) => Promise<AcquireRunLeaseResult>
  heartbeatRunLease: (
    projectId: string | undefined,
    branchId: string | null | undefined,
    ownerToken: string,
  ) => Promise<boolean>
  releaseRunLease: (
    projectId: string | undefined,
    branchId: string | null | undefined,
    ownerToken: string,
  ) => Promise<void>
  mintRunLeaseToken: () => string
  /** Wall-clock heartbeat interval (ms). Injected so this module needn't import
   *  the DB-bound constant. */
  leaseHeartbeatMs: number
  /** Owner instance id recorded on the lease (for the honest refuse message). */
  leaseInstanceId?: string | null
}

export interface CrossProjectLegPlan {
  targetProjectId: string
  /** Per-leg run budget. When the caller sets an explicit group budget it is that
   *  budget / N; otherwise it is the DEFAULT group ceiling / N, capped at the
   *  per-run default (see resolveLegBudgetUsd). Never undefined post-fix — a
   *  broadcast always carries an aggregate ceiling. */
  budgetUsd: number | undefined
}

/** Per-run default cap (mirrors runner.ts DEFAULT_RUN_CONFIG.maxRunCostUsd). A leg
 *  never gets MORE than this even when few legs would let the group ceiling grant
 *  it, so a 1-leg broadcast matches a normal direct run's budget. */
export const DEFAULT_LEG_BUDGET_USD = 25
/** Default GROUP ceiling applied when the caller sets no explicit groupBudgetUsd.
 *  Without it a broadcast could fan MAX_DISPATCH_TARGETS (24) legs at the full
 *  per-run default each with NO aggregate bound (24 × $25 = $600). Legs keep the
 *  per-run default until N is large enough that the ceiling would be exceeded
 *  (N > 6), then they split the ceiling — sum(perLeg) is always ≤ this value. */
export const DEFAULT_GROUP_BUDGET_USD = 150

/**
 * Resolve a single leg's run budget for a group of N legs.
 * - Explicit finite group budget → even split (groupBudget / N), unchanged.
 * - No explicit budget (null/undefined) → apply the DEFAULT group ceiling so the
 *   broadcast is always bounded, but never hand a leg more than the per-run
 *   default (min keeps small broadcasts at the normal $25/leg and only throttles
 *   wide ones). Returns undefined only for a degenerate N ≤ 0.
 */
export function resolveLegBudgetUsd(groupBudgetUsd: number | null | undefined, n: number): number | undefined {
  if (n <= 0) return undefined
  const explicit = reserveVariantBudget(groupBudgetUsd, n)
  if (explicit !== undefined) return explicit
  return Math.min(DEFAULT_LEG_BUDGET_USD, DEFAULT_GROUP_BUDGET_USD / n)
}

/**
 * Plan the legs for a cross-project dispatch: dedupe targets, drop the origin
 * (a leg targeting the origin would be the identity case — not a cross-project
 * leg — and re-running A under itself is never the intent), and give each leg a
 * bounded per-leg budget (explicit split, else the default group ceiling / N).
 * Returns [] when no distinct non-origin targets remain.
 */
export function planCrossProjectLegs(
  targets: string[],
  originProjectId: string,
  groupBudgetUsd: number | null | undefined,
): CrossProjectLegPlan[] {
  const unique = [...new Set(targets)].filter((id) => !!id && id !== originProjectId)
  if (unique.length === 0) return []
  const perLeg = resolveLegBudgetUsd(groupBudgetUsd, unique.length)
  return unique.map((targetProjectId) => ({ targetProjectId, budgetUsd: perLeg }))
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** Side-effectful collaborators, injected so the orchestration logic stays
 *  unit-testable without a DB / Electron. */
export interface CrossProjectDispatchDeps extends RunLeaseApi {
  /** Loads a target project row for resolveLegBody (fail-closed on missing/error). */
  loadTargetRow: LoadTargetRow
  /** Guarantees the target has a default branch and returns its id — used as the
   *  run-slot key so we can reserve B BEFORE snapshotting it (closes the
   *  resolve-then-reserve stale-write race). */
  ensureDefaultBranch: (projectId: string) => Promise<string>
  /** Per-(project,branch) run mutex. */
  reserveRunSlot: (projectId: string | undefined, branchId?: string | null) => { ok: boolean }
  releaseRunSlot: (projectId: string | undefined, branchId?: string | null) => void
  /** Server-authoritative owner of the TARGET project (never trusts the body). */
  resolveOwnerUserId: (projectId: string | undefined) => Promise<string | null>
  /** The transport-agnostic runner. */
  runAgentRequest: (opts: {
    body: AgentAPIRequest
    authenticatedUserId: string | null
    abortSignal: AbortSignal
    emit: (event: SSEEvent) => void
  }) => Promise<void>
  /** Forwards a leg's event to the renderer, TAGGED so the separate consumer can
   *  route it to the cross-project run view (and never the active store).
   *  `originProjectId` lets the renderer defensively assert target !== active. */
  emitLegEvent: (msg: {
    groupId: string
    originProjectId: string
    targetProjectId: string
    runId: string
    // SSEEvent, plus the `__stream_end__` transport sentinel the direct-run path
    // also sends (it is not part of the typed agent-event union).
    event: SSEEvent | { type: '__stream_end__' }
  }) => void
  newRunId: () => string
}

export interface CrossProjectDispatchInput {
  /** The ORIGIN project's request body (its projectId is the origin). */
  originBody: AgentAPIRequest
  targets: string[]
  /** The broadcast instruction — becomes each leg's message. */
  instruction: string
  groupBudgetUsd?: number | null
  groupId: string
  /** Aborts ALL legs in the group. */
  abortSignal: AbortSignal
}

export type CrossProjectLegStatus =
  | 'started'
  | 'unreadable'
  | 'slot-busy'
  // Another WINDOW/worktree holds a live cross-process DB lease on the target
  // branch — distinct from 'slot-busy' (this window's in-memory guard).
  | 'lease-held'
  // The lease query itself failed (DB error) — refuse rather than run unguarded.
  | 'lease-error'
  | 'aborted'
export interface CrossProjectLegOutcome {
  targetProjectId: string
  runId: string
  status: CrossProjectLegStatus
}

/**
 * Build a slim per-leg origin body: set the broadcast instruction + per-leg
 * budget, and blank the big fields resolveLegBody drops or overwrites anyway
 * (A's scenes/history/referenceMedia/scenePlan/editorState). Smaller deep clone
 * AND avoids structuredClone choking on a non-cloneable A-only field. The deep
 * clone gives each leg its own copy of the surviving user-global objects so
 * parallel legs never alias.
 */
function slimLegOrigin(
  originBody: AgentAPIRequest,
  instruction: string,
  budgetUsd: number | undefined,
): AgentAPIRequest {
  const base: AgentAPIRequest = {
    ...originBody,
    message: instruction,
    scenes: [],
    history: undefined,
    referenceMedia: undefined,
    initialScenePlan: undefined,
    editorState: undefined,
    // A spawned leg must never recursively spawn — no branch fan-out, no nested
    // cross-project dispatch (both gated by disableFanout in the runner).
    disableFanout: true,
  }
  if (budgetUsd !== undefined) base.runBudgetUsd = budgetUsd
  return structuredClone(base)
}

/**
 * Fan one agent request across N target projects, fully isolated.
 *
 * Per leg: bail if aborted → ensure B's default branch (→ slot key) → RESERVE B's
 * slot (before snapshotting B, to close the stale-write race) → build a slim
 * deep-cloned origin + resolveLegBody (fail-closed: unreadable/unresolvable B →
 * release slot + surface a leg error, never run under the origin's settings) →
 * runAgentRequest with a TAGGED emit. Legs run in parallel (not awaited inline);
 * each releases its slot + emits a tagged terminal sentinel on completion. A leg
 * failure NEVER throws out of this function (so one bad target can't kill the
 * dispatch or leak sibling slots). Returns per-leg outcomes immediately; `settled`
 * resolves when every started leg finishes (tests + group cleanup; NOT awaited by
 * the IPC handler, which returns the groupId promptly).
 */
export async function runCrossProjectDispatch(
  input: CrossProjectDispatchInput,
  deps: CrossProjectDispatchDeps,
): Promise<{ outcomes: CrossProjectLegOutcome[]; settled: Promise<void> }> {
  const { originBody, targets, instruction, groupBudgetUsd, groupId, abortSignal } = input
  const originProjectId = originBody.projectId
  if (!originProjectId) throw new Error('runCrossProjectDispatch: origin body must have a projectId')

  const legs = planCrossProjectLegs(targets, originProjectId, groupBudgetUsd)
  const outcomes: CrossProjectLegOutcome[] = []
  const running: Promise<void>[] = []

  for (const leg of legs) {
    const target = leg.targetProjectId
    const runId = deps.newRunId()
    const emit = (event: SSEEvent | { type: '__stream_end__' }) =>
      deps.emitLegEvent({ groupId, originProjectId, targetProjectId: target, runId, event })

    // Stop pressed mid-dispatch: don't prepare or launch any further legs.
    if (abortSignal.aborted) {
      outcomes.push({ targetProjectId: target, runId, status: 'aborted' })
      continue
    }

    let branchId: string
    try {
      branchId = await deps.ensureDefaultBranch(target)
    } catch {
      emit({ type: 'error', error: `Cross-project leg skipped — could not prepare project ${target}.` })
      outcomes.push({ targetProjectId: target, runId, status: 'unreadable' })
      continue
    }

    // Reserve BEFORE snapshotting B: holding B's slot across resolveLegBody closes
    // the stale-write race with a concurrent direct run on B (in THIS window's
    // memory). This is necessary but NOT sufficient across windows — see the lease.
    if (!deps.reserveRunSlot(target, branchId).ok) {
      emit({ type: 'error', error: `Cross-project leg skipped — project ${target} already has a run in progress.` })
      outcomes.push({ targetProjectId: target, runId, status: 'slot-busy' })
      continue
    }

    // Cross-PROCESS run lease. reserveRunSlot above only excludes runs
    // inside THIS window; another window / git worktree driving the same target
    // branch shares one ~/.dreambyte/studio.db and would pass its own in-memory
    // check and run concurrently on the same (target, branch), racing
    // persistScenesFromAgentRun. The DB lease is the authoritative cross-window
    // exclusion — mirror the direct run-start handler exactly: mint a per-leg
    // token, acquire, heartbeat on wall time, release in the run's .finally (and
    // in the pre-handoff catch below). A clean release lets a stop→retry
    // re-acquire immediately.
    const ownerToken = deps.mintRunLeaseToken()
    let lease: AcquireRunLeaseResult
    try {
      lease = await deps.acquireRunLease(target, branchId, {
        ownerToken,
        instanceId: deps.leaseInstanceId ?? null,
        pid: typeof process !== 'undefined' ? process.pid : null,
        runId,
      })
    } catch {
      // The lease query itself failed (e.g. DB unavailable). Don't run unguarded —
      // release the in-memory slot and refuse this leg honestly. Dispatch survives.
      deps.releaseRunSlot(target, branchId)
      emit({
        type: 'error',
        error: `Cross-project leg skipped — could not acquire the run lease for project ${target} (database error).`,
      })
      outcomes.push({ targetProjectId: target, runId, status: 'lease-error' })
      continue
    }
    if (!lease.acquired) {
      // A live lease is held by ANOTHER window on this (target, branch). Refuse
      // rather than double-run. Release our in-memory slot (the DB lease is not
      // ours to touch) and skip — never start the leg.
      deps.releaseRunSlot(target, branchId)
      const ageSec = Math.round(lease.heldBy.ageMs / 1000)
      const windowDesc = lease.heldBy.instanceId ? `window ${lease.heldBy.instanceId}` : 'another window'
      emit({
        type: 'error',
        error: `Cross-project leg skipped — project ${target} already has an agent run active (${windowDesc}, last seen ${ageSec}s ago).`,
      })
      outcomes.push({ targetProjectId: target, runId, status: 'lease-held' })
      continue
    }

    // Wall-clock heartbeat keeps the lease alive across a leg that may block ~10min
    // on media generation. It MUST be loop-decoupled (setInterval on wall time) so
    // the lease can't go stale mid-run and be stolen. unref so it can't keep the
    // process alive on shutdown. Cleared in the run's .finally AND the catch below.
    const leaseHeartbeat = setInterval(() => {
      void deps.heartbeatRunLease(target, branchId, ownerToken).catch(() => {})
    }, deps.leaseHeartbeatMs)
    if (typeof leaseHeartbeat.unref === 'function') leaseHeartbeat.unref()
    const teardownLease = () => {
      clearInterval(leaseHeartbeat)
      void deps.releaseRunLease(target, branchId, ownerToken).catch(() => {})
    }

    // EVERY post-reserve setup step (resolve, owner lookup, runner handoff) is in
    // this one try so a throw from ANY of them releases the slot + lease and is
    // contained — a leg failure must never leak the reserved slot/lease or throw
    // out (which would kill the whole dispatch). The catch only runs BEFORE a
    // successful handoff, so the run's own .finally (the sole other releaser) can't
    // double-release.
    try {
      const legBody = await resolveLegBody(
        slimLegOrigin(originBody, instruction, leg.budgetUsd),
        target,
        originProjectId,
        deps.loadTargetRow,
      )
      const authenticatedUserId = await deps.resolveOwnerUserId(legBody.projectId)
      running.push(
        deps
          .runAgentRequest({ body: legBody, authenticatedUserId, abortSignal, emit })
          .catch((err: unknown) =>
            emit({
              type: 'error',
              error: `Cross-project leg error (${target}): ${(err as Error)?.message ?? 'unknown'}`,
            }),
          )
          .finally(() => {
            // Cross-process lease teardown: stop the heartbeat + release the
            // DB row by OUR token (a stale-reclaimed row now owned by another window
            // won't match, so we can never free someone else's live lease). This
            // clean release is what lets a stop→retry re-acquire immediately.
            teardownLease()
            // Release by the captured (target, branchId) — never legBody.branchId,
            // which the runner could in principle mutate mid-run.
            deps.releaseRunSlot(target, branchId)
            // Tagged terminal sentinel so the renderer's cross-project view resolves
            // the leg even when it ended via .catch (matches the direct-run contract).
            emit({ type: '__stream_end__' })
          }),
      )
      outcomes.push({ targetProjectId: target, runId, status: 'started' })
    } catch (e) {
      // Never hold a slot/lease for a leg that won't run. teardownLease is the sole
      // lease releaser on this pre-handoff path (the run's .finally never fires).
      teardownLease()
      deps.releaseRunSlot(target, branchId)
      const why = e instanceof CrossProjectLegAbort ? 'could not be loaded' : 'failed to resolve'
      emit({ type: 'error', error: `Cross-project leg skipped — project ${target} ${why}.` })
      outcomes.push({ targetProjectId: target, runId, status: 'unreadable' })
    }
  }

  return { outcomes, settled: Promise.allSettled(running).then(() => undefined) }
}
