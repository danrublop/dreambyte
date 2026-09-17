/**
 * Action executor.
 *
 * Pipeline (per locked decisions #5 and #6):
 *
 *   ActionInput ──► fillBaseFields ──► [WAL append, sync] ──► runReducer
 *                                                                │
 *                                ┌───────────────────────────────┤
 *                                ▼                               ▼
 *                       state' (returned to caller)     inverseAction (caller pushes onto undo stack)
 *
 * - WAL is OPTIONAL at this layer (signature accepts a writer or null). The
 *   in-app store wires a project-scoped writer; CLI tools / tests pass null
 *   and lose only crash-safety, not correctness.
 * - DB persistence (`action_log` table) lives downstream of dispatch — the
 *   reducer is sync, the disk WAL is sync, the DB write is async fire-and-
 *   forget. Reducer return is what the caller renders against; the DB row is
 *   a projection.
 * - `source` is always set by `dispatch()` from the explicit `source` arg —
 *   never read from the input — so an agent tool can't spoof
 *   `source: 'user'` to bypass the layer-edit lock.
 */

import type { Action, ActionInput, ActionResult, ActionSource, ProjectState } from './types'
import { ACTION_VERSION } from './types'
import { runReducer } from './reducers'
import { checkSceneLockViolation } from './scene-lock-guard'

export interface DispatchOptions {
  /** Set by dispatcher; never trusted from the input itself. */
  source: ActionSource
  /** Optional run grouping for "undo last agent run". */
  runId?: string | null
  /**
   * If provided, the executor calls `wal.append(action)` synchronously after
   * passing all validators / before running the reducer. WAL append failures
   * are logged + surfaced as STORAGE_FULL — the action is rejected so the
   * caller doesn't think it succeeded when the disk record was lost.
   */
  wal?: WalWriter | null
  /**
   * Freeze the input state in dev/test to enforce reducer purity. Default
   * true in vitest + when NODE_ENV !== 'production'.
   */
  freezeInput?: boolean
}

export interface WalWriter {
  append(action: Action): void | Promise<void>
}

/**
 * Universal UUID v4. Uses `globalThis.crypto.randomUUID()` when present
 * (modern browsers + Node ≥19, including Electron renderer); falls back
 * to a manual v4 generator for older environments + JSDOM test runs.
 * Importing `node:crypto` here would break the renderer bundle where the
 * shim doesn't export `randomUUID`.
 */
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const rnd = (n: number) => Math.floor(Math.random() * n)
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0')
  const parts = [
    hex(rnd(0x100000000), 8),
    hex(rnd(0x10000), 4),
    hex(0x4000 | rnd(0x1000), 4),
    hex(0x8000 | rnd(0x4000), 4),
    hex(rnd(0x100000000), 8) + hex(rnd(0x10000), 4),
  ]
  return parts.join('-')
}

/**
 * Fill the dispatcher-controlled fields. `version` is always the current
 * compile-time constant; replaying an older log with a per-version reducer
 * uses the value already on the recorded action, not this constant.
 */
export function fillBaseFields(input: ActionInput, source: ActionSource, runId: string | null = null): Action {
  const action = {
    ...input,
    id: input.id ?? uuid(),
    timestamp: input.timestamp ?? Date.now(),
    source,
    runId: input.runId ?? runId,
    version: ACTION_VERSION,
  } as Action
  return action
}

function deepFreezeForTest<T>(value: T): T {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') return value
  if (value === null || typeof value !== 'object') return value
  // Shallow freeze on the project state + its top-level arrays/objects is
  // enough to catch the common mutation mistakes (push into scenes, splice
  // a layer array, assign onto state.project). We skip deep on Scene to
  // keep tests cheap.
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key]
    if (Array.isArray(v)) Object.freeze(v)
    else if (v && typeof v === 'object') Object.freeze(v)
  }
  return value
}

/**
 * Build a typed Action from an input, run validators + the reducer, and
 * return the result. Pure once the WAL writer is invoked: callers must
 * apply the returned `state` to their store.
 */
export async function dispatch(
  state: ProjectState,
  input: ActionInput,
  options: DispatchOptions,
): Promise<{ result: ActionResult; action: Action }> {
  const action = fillBaseFields(input, options.source, options.runId)

  // WAL append BEFORE the reducer. If the disk write fails, the action is
  // rejected — we don't want the in-memory state to mutate while the WAL
  // record is missing (the action_log projection later wouldn't reflect it).
  if (options.wal) {
    try {
      await options.wal.append(action)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        action,
        result: {
          success: false,
          error: {
            code: 'STORAGE_FULL',
            message: `WAL append failed: ${message}`,
            suggestion: 'Free disk space and retry.',
          },
        },
      }
    }
  }

  const frozen = options.freezeInput === false ? state : deepFreezeForTest(state)
  // Scene-lock enforcement (cursor model) — reject before the reducer if the action's source
  // conflicts with the scene's current owner. No-op until a lock is actually acquired.
  const lockViolation = checkSceneLockViolation(frozen, action)
  if (lockViolation) return { action, result: { success: false, error: lockViolation } }
  const result = runReducer(frozen, action)

  return { action, result }
}

/**
 * Synchronous variant for callers that don't need WAL persistence (CLI
 * scripts, tests, replay path). Identical to `dispatch` minus the IO.
 */
export function dispatchSync(
  state: ProjectState,
  input: ActionInput,
  options: Omit<DispatchOptions, 'wal'>,
): { result: ActionResult; action: Action } {
  const action = fillBaseFields(input, options.source, options.runId)
  const frozen = options.freezeInput === false ? state : deepFreezeForTest(state)
  const lockViolation = checkSceneLockViolation(frozen, action)
  if (lockViolation) return { action, result: { success: false, error: lockViolation } }
  return { action, result: runReducer(frozen, action) }
}
