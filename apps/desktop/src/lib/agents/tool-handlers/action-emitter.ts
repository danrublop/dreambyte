/**
 * Action recorder for agent tool handlers (P1b of NLE-FOUNDATION).
 *
 * Each agent tool that mutates `world` should emit one or more typed
 * `Action`s alongside its existing in-memory mutation, so the action_log
 * table records the agent's intent. The mutation logic itself stays where
 * it is — the agent's `WorldStateMutable` is a different shape from the
 * renderer's `ProjectState`, and unifying them is out of scope here.
 *
 * The agent runs in the main process, so we can write directly to:
 *   - `~/.dreambyte/projects/{projectId}/wal.jsonl` (sync)
 *   - `action_log` table (async)
 * without going through IPC.
 *
 * `runId` is plumbed through from the agent runner so every action emitted
 * during one agent run shares the same group id (locked decision: "undo
 * last agent run" reverts every action with that runId in reverse order).
 *
 * Best-effort: every error is logged + swallowed. The tool result is what
 * the LLM sees; persistence failures should not break agent runs.
 */

import type { Action, ActionInput } from '@/lib/actions'
import { fillBaseFields } from '@/lib/actions/executor'
import { recordDispatchedAction } from '@/lib/actions/snapshot-orchestrator'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent/action-emitter')

/**
 * Deps for `emitAgentAction`. `projectId: null` skips persistence (CLI /
 * tests); otherwise the WAL + action_log writes both fire.
 */
export interface ActionEmitterDeps {
  /** Project the actions belong to. Null = no persistence (CLI / tests). */
  projectId: string | null
  /** Active branch (null = main / unspecified). */
  branchId?: string | null
  /** Agent run id for grouped undo. Null = ad-hoc tool call (rare). */
  runId?: string | null
}

/**
 * Standard `ActionEmitterDeps` for a tool handler. Every tool-handler call
 * site needs the same `{ projectId, runId }` derivation from the agent's
 * world state, so this is the single source of truth.
 */
export function emitterDepsForWorld(world: WorldStateMutable): ActionEmitterDeps {
  return {
    projectId: world.projectId ?? null,
    runId: world.currentRunId ?? null,
  }
}

let cachedAppender: ((projectId: string, action: Action, branchId: string | null) => Promise<void>) | null = null
async function getDbAppender(): Promise<typeof cachedAppender> {
  if (cachedAppender !== null) return cachedAppender
  try {
    const { appendActionRow } = await import('@/lib/db/queries/action-log')
    cachedAppender = (projectId, action, branchId) => appendActionRow(projectId, action, branchId)
  } catch (err) {
    log.error('action_log query module unavailable; agent-emitted actions will not persist', { error: err })
    cachedAppender = async () => {}
  }
  return cachedAppender
}

let cachedWalAppender: ((projectId: string, line: string) => void) | null = null
async function getWalAppender(): Promise<typeof cachedWalAppender> {
  if (cachedWalAppender !== null) return cachedWalAppender
  try {
    const fsSync = await import('node:fs')
    const path = await import('node:path')
    const { app } = await import('electron')
    // The import RESOLVES outside Electron (the package is present) but `app` is
    // undefined, so the guard below is what actually detects a non-Electron context —
    // without it every emit threw TypeError: Cannot read properties of undefined
    // (reading 'getPath') and logged a warning from an unawaited async IIFE. In tests
    // those logs landed after the worker began tearing down, which vitest surfaces as
    // "Closing rpc while onUserConsoleLog was pending" and a non-zero exit on a run
    // where every test passed.
    if (typeof app?.getPath !== 'function') {
      cachedWalAppender = () => {}
      return cachedWalAppender
    }
    cachedWalAppender = (projectId, line) => {
      const dir = path.join(app.getPath('userData'), 'projects', projectId)
      fsSync.mkdirSync(dir, { recursive: true })
      fsSync.appendFileSync(path.join(dir, 'wal.jsonl'), line, { encoding: 'utf-8' })
    }
  } catch {
    // Non-Electron context (some tests). WAL is best-effort.
    cachedWalAppender = () => {}
  }
  return cachedWalAppender
}

/**
 * Record one action attributed to the agent. Fire-and-forget — never throws,
 * always returns the typed Action so the caller can include the id in its
 * tool result if needed.
 */
export function emitAgentAction(input: ActionInput, deps: ActionEmitterDeps): Action {
  const action = fillBaseFields(input, 'agent', deps.runId ?? null)

  if (!deps.projectId)
    return action

    // WAL append synchronously off the hot path (main-process scheduler will
    // process this before the next tool call returns to the LLM).
  ;(async () => {
    try {
      const wal = await getWalAppender()
      wal?.(deps.projectId!, JSON.stringify(action) + '\n')
    } catch (err) {
      log.warn('agent WAL append failed', { extra: { actionId: action.id }, error: err })
    }
    let dbOk = false
    try {
      const append = await getDbAppender()
      await append?.(deps.projectId!, action, deps.branchId ?? null)
      dbOk = true
    } catch (err) {
      log.warn('agent action_log append failed', { extra: { actionId: action.id }, error: err })
    }
    if (dbOk) {
      recordDispatchedAction({
        projectId: deps.projectId!,
        branchId: deps.branchId ?? null,
        actionId: action.id,
      })
    }
  })().catch((err) => {
    // Fire-and-forget must never reject unhandled: the WAL/DB steps each
    // catch their own failures, but the recordDispatchedAction tail was
    // unprotected — an escapee there surfaced as an unhandled rejection
    // (vitest flags it as EnvironmentTeardownError noise when module loads
    // race worker teardown; it would be silent crash-noise in production).
    log.warn('agent action post-append bookkeeping failed', { extra: { actionId: action.id }, error: err })
  })

  return action
}
