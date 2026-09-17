/**
 * Durable undo persistence.
 *
 * sessionStorage (undo-actions.ts) remains the fast same-session path — this
 * module adds the DB layer beneath it so Cmd+Z history survives app restarts
 * AND branch round-trips. One `snapshots` row per (projectId, branchId) with
 * operation='undo-stacks' holds all four stacks (legacy undo/redo +
 * action-layer undo/redo) as one JSON payload.
 *
 * Branch safety: stacks are keyed per branch and only ever hydrated for
 * the branch being loaded — branch A's history can never be replayed on
 * branch B. A branch switch flushes the OLD branch's stacks under its own key
 * before the in-memory wipe, then hydrates the TARGET branch's key, so
 * switching A→B→A now restores A's history instead of losing it.
 *
 * Size: legacy stacks are stripped via the same stripCodeFields used for
 * sessionStorage, then the whole payload is capped — oldest entries trimmed
 * first — so a single row stays well under SQLite comfort (~1MB default).
 *
 * Pure/injected: all IPC goes through the `UndoStacksIpc` interface so the
 * module unit-tests with a fake. The store wires the real
 * window.dreambyteApi.undoStacks bridge.
 */

import type { Action } from '@/lib/actions'
import type { UndoableState } from './types'
import { stripCodeFields } from './undo-actions'
import { createLogger } from '../logger'

const log = createLogger('undo-persistence')

export const UNDO_STACKS_OPERATION = 'undo-stacks'

/** Default cap for the serialized payload (bytes of JSON). */
export const UNDO_PAYLOAD_MAX_BYTES = 1_000_000

/** Debounce for durable writes — coarser than sessionStorage's 500ms; the
 *  session path covers the fast cases, the DB covers restarts. */
export const UNDO_DB_DEBOUNCE_MS = 2_000

export interface UndoStacksPayload {
  /** Payload shape version — bump on breaking changes; hydrate ignores unknown versions. */
  v: 1
  undoStack: UndoableState[]
  redoStack: UndoableState[]
  actionUndoStack: Action[]
  actionRedoStack: Action[]
}

export interface UndoStacksKey {
  projectId: string
  /** null = default branch (pre-branch rows / projects without branches). */
  branchId: string | null
}

/** Minimal IPC surface — the preload bridge or a test fake. */
export interface UndoStacksIpc {
  save(args: UndoStacksKey & { payload: string }): Promise<{ success: boolean }>
  load(args: UndoStacksKey): Promise<{ payload: string | null }>
}

export interface UndoStacksInput {
  undoStack: UndoableState[]
  redoStack: UndoableState[]
  actionUndoStack: Action[]
  actionRedoStack: Action[]
}

/**
 * Serialize the four stacks to a capped JSON string. Legacy stacks are
 * code-stripped (same policy as sessionStorage). When over the cap, trim the
 * OLDEST entries — undo history degrades from the far end, never the recent
 * end — alternating across the two undo stacks (redo stacks are dropped
 * entirely first; they're the cheapest history to lose).
 */
export function serializeUndoStacks(stacks: UndoStacksInput, maxBytes = UNDO_PAYLOAD_MAX_BYTES): string {
  let payload: UndoStacksPayload = {
    v: 1,
    undoStack: stripCodeFields(stacks.undoStack),
    redoStack: stripCodeFields(stacks.redoStack),
    actionUndoStack: stacks.actionUndoStack,
    actionRedoStack: stacks.actionRedoStack,
  }

  let json = JSON.stringify(payload)
  if (json.length <= maxBytes) return json

  // Over cap: drop redo history first (cheapest loss).
  payload = { ...payload, redoStack: [], actionRedoStack: [] }
  json = JSON.stringify(payload)

  // Still over: trim oldest undo entries, alternating stacks, until it fits
  // or both undo stacks are empty.
  while (json.length > maxBytes && (payload.undoStack.length > 0 || payload.actionUndoStack.length > 0)) {
    if (payload.undoStack.length >= payload.actionUndoStack.length) {
      payload = { ...payload, undoStack: payload.undoStack.slice(1) }
    } else {
      payload = { ...payload, actionUndoStack: payload.actionUndoStack.slice(1) }
    }
    json = JSON.stringify(payload)
  }
  return json
}

/** Parse a stored payload. Returns null on junk / unknown version. */
export function parseUndoStacksPayload(raw: string | null | undefined): UndoStacksPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UndoStacksPayload>
    if (parsed?.v !== 1) return null
    return {
      v: 1,
      undoStack: Array.isArray(parsed.undoStack) ? parsed.undoStack : [],
      redoStack: Array.isArray(parsed.redoStack) ? parsed.redoStack : [],
      actionUndoStack: Array.isArray(parsed.actionUndoStack) ? parsed.actionUndoStack : [],
      actionRedoStack: Array.isArray(parsed.actionRedoStack) ? parsed.actionRedoStack : [],
    }
  } catch {
    return null
  }
}

// ── Debounced durable writer ─────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null
let _pending: { ipc: UndoStacksIpc; key: UndoStacksKey; json: string } | null = null

async function writePending(): Promise<void> {
  const job = _pending
  _pending = null
  if (!job) return
  try {
    await job.ipc.save({ ...job.key, payload: job.json })
  } catch (err) {
    // Best-effort: durable undo is a convenience layer; never surface into the
    // edit path. The sessionStorage copy still covers the live session.
    log.warn('durable undo persist failed', { error: err })
  }
}

/**
 * Schedule a durable write of the stacks for (projectId, branchId). Debounced;
 * the latest call wins. Safe to call from hot paths — serialization happens
 * here (synchronously, on already-stripped-size data) but the IPC is deferred.
 */
export function scheduleDurableUndoPersist(ipc: UndoStacksIpc, key: UndoStacksKey, stacks: UndoStacksInput): void {
  _pending = { ipc, key, json: serializeUndoStacks(stacks) }
  if (_timer) clearTimeout(_timer)
  _timer = setTimeout(() => {
    _timer = null
    void writePending()
  }, UNDO_DB_DEBOUNCE_MS)
}

/**
 * Flush any pending durable write NOW (awaitable). Used by branch switch so
 * the OLD branch's stacks land under its key before the in-memory wipe, and
 * by tests.
 */
export async function flushDurableUndoPersist(): Promise<void> {
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
  }
  await writePending()
}

/** Test hook: drop any pending write without executing it. */
export function _resetDurableUndoPersist(): void {
  if (_timer) clearTimeout(_timer)
  _timer = null
  _pending = null
}

/**
 * Load the durable stacks for (projectId, branchId). Returns null when there
 * is no row, the payload is unparseable, or the IPC fails — callers treat all
 * three as "no durable history".
 */
export async function hydrateUndoStacks(ipc: UndoStacksIpc, key: UndoStacksKey): Promise<UndoStacksPayload | null> {
  try {
    const { payload } = await ipc.load(key)
    return parseUndoStacksPayload(payload)
  } catch (err) {
    log.warn('durable undo hydrate failed', { error: err })
    return null
  }
}

// ── Store-facing convenience wiring ──────────────────────────────────────────

/** The preload bridge, when running inside the desktop shell. */
export function getUndoStacksIpc(): UndoStacksIpc | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((window as any).dreambyteApi?.undoStacks as UndoStacksIpc | undefined) ?? null
}

/** The slice of store state the durable writer needs. */
export interface DurableUndoStateSlice {
  project?: { id: string } | null
  projectActiveBranchId: string | null
  _undoStack: UndoableState[]
  _redoStack: UndoableState[]
  _actionUndoStack: Action[]
  _actionRedoStack: Action[]
}

/**
 * Schedule a durable persist straight from store state. No-ops without a
 * project or outside the desktop shell — callers sprinkle this after every
 * stack mutation without guards.
 */
export function scheduleDurablePersistFromState(s: DurableUndoStateSlice): void {
  const projectId = s.project?.id
  if (!projectId) return
  const ipc = getUndoStacksIpc()
  if (!ipc) return
  scheduleDurableUndoPersist(
    ipc,
    { projectId, branchId: s.projectActiveBranchId ?? null },
    {
      undoStack: s._undoStack,
      redoStack: s._redoStack,
      actionUndoStack: s._actionUndoStack,
      actionRedoStack: s._actionRedoStack,
    },
  )
}
