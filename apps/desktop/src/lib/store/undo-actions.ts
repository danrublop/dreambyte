'use client'

import type { Set, Get, UndoableState } from './types'
import { scheduleDurablePersistFromState } from './undo-persistence'
import {
  MAX_UNDO,
  _debouncedPushTimer,
  _hasPendingSnapshot,
  _inspectorSaveTimer,
  _inspectorUndoPushed,
  nextUndoSeq,
  setDebouncedPushTimer,
  setHasPendingSnapshot,
  setInspectorSaveTimer,
  setInspectorUndoPushed,
} from './helpers'

/** Read the order key off either stack's top entry; absent → oldest. */
function topSeq(entry: { _seq?: number } | undefined): number {
  return entry?._seq ?? -1
}

/** Code-bearing scene fields whose change forces an on-disk HTML re-save. */
const HTML_CODE_FIELDS = [
  'svgContent',
  'canvasCode',
  'canvasBackgroundCode',
  'sceneCode',
  'reactCode',
  'sceneHTML',
  'sceneStyles',
  'lottieSource',
] as const

/**
 * Re-save HTML for every restored scene whose code-bearing content differs
 * from the state we're leaving (`beforeScenes`). Scenes brought back from a
 * delete (no `beforeScenes` entry) are always rewritten; deleted scenes have
 * no `restoredScenes` entry and are skipped (their file stays on disk,
 * harmless). Shared by undo(), redo(), and restoreRunSnapshot().
 */
function reSaveChangedSceneHTML(
  get: Get,
  restoredScenes: UndoableState['scenes'],
  beforeScenes: UndoableState['scenes'],
): void {
  const beforeBySceneId = new Map(beforeScenes.map((s) => [s.id, s]))
  for (const restored of restoredScenes) {
    const was = beforeBySceneId.get(restored.id)
    if (!was || HTML_CODE_FIELDS.some((f) => restored[f] !== was[f])) {
      get().saveSceneHTML(restored.id, true)
    }
  }
}

/**
 * G1 — Action-stack-first undo routing (v0.3.5+).
 *
 * Cmd+Z and Cmd+Shift+Z try the action layer first. When the action stack
 * is non-empty, `actionUndo()` / `actionRedo()` run the typed inverse and
 * we stop. When empty, we fall back to the legacy `_pushUndo` snapshot
 * stack so operations that haven't been migrated to `dispatchAction` yet
 * still have working undo.
 *
 * Routing log: every undo emits a `[undo] handled by: ...` console warn
 * so the cutover progress is observable in DevTools. Once every mutation
 * dispatches an action (no more `_pushUndo*()` callers), this routing
 * collapses to action-stack-only.
 *
 * Opt-out (rare): for users on v0.3.4 who explicitly want the legacy
 * stack only — e.g., bisecting a regression introduced by the action
 * layer — set `localStorage.setItem('dreambyte-undo-legacy-only', '1')` in
 * DevTools and reload. Default behavior (no flag) is action-stack-first.
 */
function isLegacyUndoForced(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage?.getItem('dreambyte-undo-legacy-only') === '1'
  } catch {
    return false
  }
}

function logUndoSource(source: 'action-stack' | 'legacy-snapshot' | 'no-op'): void {
  // Renderer-side console log so the cutover is visible in DevTools.
  // Not gated on logger plumbing — that's overkill for an observability
  // hook meant to inform the v0.3.x → v0.4 flip decision.
  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(`[undo] handled by: ${source}`)
  }
}

// ── sessionStorage persistence for undo/redo stacks ─────────────────────────

const UNDO_STORAGE_KEY = 'dreambyte-undo-stack'
const REDO_STORAGE_KEY = 'dreambyte-redo-stack'

/**
 * Wipe the persisted undo/redo stacks (sessionStorage). Used by branch switch
 * Undo history captured on branch A must not be replayable on
 * branch B — a legacy snapshot restore would write branch A's scenes into
 * branch B's timeline. State rewind across branches is the branch system's
 * job, not Cmd+Z's. The in-memory stacks are cleared by the caller's set().
 */
export function clearPersistedUndoStacks(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(UNDO_STORAGE_KEY)
    window.sessionStorage.removeItem(REDO_STORAGE_KEY)
  } catch {
    /* best-effort */
  }
}

/**
 * Strip large fields from scenes before serializing to sessionStorage.
 *
 * `sessionStorage` is bounded (Chrome ~5MB per origin). Projects with many
 * AI-generated layers used to hit QuotaExceeded after a dozen edits because
 * each `imageUrl` / `stickerUrl` carries either a long
 * remote URL or a data: blob. We strip the same way we'd strip code: the
 * snapshot tracks structure + IDs but not bytes. On undo, the restored
 * scene's missing fields fall back to current store state (the live
 * project still has the real URLs).
 *
 * Stripped fields:
 *   - all code / HTML / CSS source
 *   - aiLayers[].{imageUrl, stickerUrl, videoUrl, thumbnailUrl}
 *   - chartLayers (re-derived from sceneCode on undo)
 *
 * Exported: also reused by the agent-run pre-snapshot's size guard
 * (agent-actions.ts captureAgentRunSnapshot) so the "what
 * counts as a heavy field" list has exactly one home.
 */
export function stripCodeFields(stack: UndoableState[]): UndoableState[] {
  const HEAVY_AI_KEYS = ['imageUrl', 'stickerUrl', 'videoUrl', 'thumbnailUrl'] as const
  return stack.map((s) => ({
    ...s,
    scenes: s.scenes.map((sc) => ({
      ...sc,
      svgContent: '',
      canvasCode: '',
      canvasBackgroundCode: '',
      sceneCode: '',
      reactCode: '',
      sceneHTML: '',
      sceneStyles: '',
      lottieSource: '',
      // Heavy derivable arrays — `normalizeScene` re-derives chart layers
      // from the scene's primary code on rehydrate. AI layers keep
      // their identity (id, type, label, …) but lose the bulky URLs.
      chartLayers: [],
      aiLayers: (sc.aiLayers ?? []).map((l) => {
        const stripped: Record<string, unknown> = { ...l }
        for (const k of HEAVY_AI_KEYS) {
          if (k in stripped) stripped[k] = ''
        }
        // Cast via unknown — AILayer is a discriminated union and TS won't
        // accept the direct widening from Record<string, unknown>. We
        // know the discriminator (`type`) is preserved by the spread, so
        // restoration into the right variant is safe.
        return stripped as unknown as typeof l
      }),
      // Thumbnail is a data URL on freshly-rendered scenes — drop it.
      thumbnail: null,
    })),
  }))
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null

function persistUndoStacks(undoStack: UndoableState[], redoStack: UndoableState[]) {
  if (_persistTimer) clearTimeout(_persistTimer)
  _persistTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(stripCodeFields(undoStack)))
      sessionStorage.setItem(REDO_STORAGE_KEY, JSON.stringify(stripCodeFields(redoStack)))
    } catch {
      // QuotaExceededError — trim oldest half and retry once
      try {
        const trimmed = undoStack.slice(Math.floor(undoStack.length / 2))
        sessionStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(stripCodeFields(trimmed)))
        sessionStorage.setItem(REDO_STORAGE_KEY, JSON.stringify(stripCodeFields(redoStack)))
      } catch {
        // Give up silently — memory-only undo is the fallback
      }
    }
  }, 500) // debounce writes
}

/** Restore undo/redo stacks from sessionStorage (called once during store init). */
export function restoreUndoStacks(): { undoStack: UndoableState[]; redoStack: UndoableState[] } {
  try {
    const undoRaw = sessionStorage.getItem(UNDO_STORAGE_KEY)
    const redoRaw = sessionStorage.getItem(REDO_STORAGE_KEY)
    return {
      undoStack: undoRaw ? JSON.parse(undoRaw) : [],
      redoStack: redoRaw ? JSON.parse(redoRaw) : [],
    }
  } catch {
    return { undoStack: [], redoStack: [] }
  }
}

// ── Undo/Redo actions ───────────────────────────────────────────────────────

export function createUndoActions(set: Set, get: Get) {
  return {
    _pushUndo: () => {
      const { scenes, globalStyle, project, _undoStack, isAgentRunning } = get()
      if (isAgentRunning) return // don't capture intermediate agent state
      // Sanitize d3Data (may contain non-cloneable values) before cloning
      const safeScenes = scenes.map((s) =>
        s.d3Data !== null && s.d3Data !== undefined ? { ...s, d3Data: JSON.parse(JSON.stringify(s.d3Data)) } : s,
      )
      const snapshot: UndoableState = structuredClone({ scenes: safeScenes, globalStyle, project })
      snapshot._seq = nextUndoSeq()
      const newStack = [..._undoStack, snapshot]
      if (newStack.length > MAX_UNDO) newStack.shift()
      // Clear BOTH redo stacks: a new op invalidates redo, and with cross-stack
      // seq routing a stale entry left on the action redo stack would
      // otherwise be reachable by a later redo.
      set({ _undoStack: newStack, _redoStack: [], _actionRedoStack: [] })
      persistUndoStacks(newStack, [])
      scheduleDurablePersistFromState(get()) // DB copy survives restarts
      // Suppress debounced pushes for the next second (prevents double-snapshot
      // when a discrete action calls _pushUndo then delegates to updateScene)
      setHasPendingSnapshot(true)
      if (_debouncedPushTimer) clearTimeout(_debouncedPushTimer)
      setDebouncedPushTimer(
        setTimeout(() => {
          setHasPendingSnapshot(false)
        }, 1000),
      )
    },

    _pushUndoDebounced: () => {
      if (!_hasPendingSnapshot) {
        get()._pushUndo()
        setHasPendingSnapshot(true)
      }
      if (_debouncedPushTimer) clearTimeout(_debouncedPushTimer)
      setDebouncedPushTimer(
        setTimeout(() => {
          setHasPendingSnapshot(false)
        }, 1000),
      )
    },

    undo: () => {
      const { _undoStack, _redoStack, scenes, globalStyle, project, isAgentRunning } = get()
      if (isAgentRunning) return

      // G1 routing (v0.3.5+): action-stack-first by default. Fall through
      // to the legacy snapshot path when the action stack is empty
      // (operations that haven't been migrated to dispatchAction yet) OR
      // when the user explicitly forces legacy-only mode for debugging.
      if (!isLegacyUndoForced()) {
        const state = get() as unknown as {
          actionUndo?: () => boolean
          _actionUndoStack?: Array<{ _seq?: number }>
        }
        // Cross-stack LIFO: take the action stack only when its top was
        // pushed at-or-after the legacy stack's top. Previously this was
        // unconditional whenever the action stack was non-empty, so undoing
        // after a legacy op (e.g. addClip) reverted the older action op
        // instead of the most recent edit. Ties favor the action layer (the
        // migration target).
        const actionTop =
          state._actionUndoStack && state._actionUndoStack.length > 0
            ? state._actionUndoStack[state._actionUndoStack.length - 1]
            : undefined
        const legacyTop = _undoStack.length > 0 ? _undoStack[_undoStack.length - 1] : undefined
        if (typeof state.actionUndo === 'function' && actionTop && topSeq(actionTop) >= topSeq(legacyTop)) {
          // Wrap in try/catch — actionUndo() calls dispatchSync → reducer
          // code which can throw (malformed action, reducer bug). The
          // legacy path can't throw, so an unwrapped throw here would
          // propagate to the keyboard handler. Fall through to legacy on
          // throw so Cmd+Z still does *something* sensible.
          try {
            const handled = state.actionUndo()
            if (handled) {
              logUndoSource('action-stack')
              return
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[undo] action-stack undo threw, falling through to legacy:', err)
          }
        }
      }

      if (_undoStack.length === 0) {
        logUndoSource('no-op')
        return
      }
      logUndoSource('legacy-snapshot')
      setInspectorUndoPushed(false)
      if (_inspectorSaveTimer) {
        clearTimeout(_inspectorSaveTimer)
        setInspectorSaveTimer(null)
      }
      const current: UndoableState = structuredClone({ scenes, globalStyle, project })
      current._seq = nextUndoSeq() // re-stamp so redo() LIFO sees this as newest
      const newUndo = [..._undoStack]
      const prev = newUndo.pop()!
      const newRedo = [..._redoStack, current]
      set({
        scenes: prev.scenes,
        globalStyle: prev.globalStyle,
        project: prev.project,
        _undoStack: newUndo,
        _redoStack: newRedo,
        sceneHtmlVersion: get().sceneHtmlVersion + 1,
        inspectorSelectedElement: null,
        inspectorSelectedLayerId: null,
        inspectorElements: {},
        inspectorPendingChanges: {},
      })
      persistUndoStacks(newUndo, newRedo)
      scheduleDurablePersistFromState(get())
      // Fix selectedSceneId if it no longer exists
      const sel = get().selectedSceneId
      if (sel && !prev.scenes.find((s) => s.id === sel)) {
        set({ selectedSceneId: prev.scenes[0]?.id ?? null })
      }
      // Re-save HTML for every scene whose code-bearing content changed
      // between the snapshot we just restored (`current`) and the state
      // we're restoring TO (`prev`). Multi-scene reverts (an agent run
      // touching N scenes, or the authoritative removeClip that drops an
      // entire scene) would otherwise leave other scenes' on-disk HTML stale.
      reSaveChangedSceneHTML(get, prev.scenes, current.scenes)
    },

    redo: () => {
      const { _undoStack, _redoStack, scenes, globalStyle, project, isAgentRunning } = get()
      if (isAgentRunning) return

      // G1 routing: mirror the undo() routing — action layer first by
      // default; legacy fallback when the redo stack is empty or the
      // legacy-only flag is forced.
      if (!isLegacyUndoForced()) {
        const state = get() as unknown as {
          actionRedo?: () => boolean
          _actionRedoStack?: Array<{ _seq?: number }>
        }
        // Cross-stack LIFO: redo whichever redo-stack top was undone
        // most recently (largest seq), mirroring undo()'s routing.
        const actionTop =
          state._actionRedoStack && state._actionRedoStack.length > 0
            ? state._actionRedoStack[state._actionRedoStack.length - 1]
            : undefined
        const legacyTop = _redoStack.length > 0 ? _redoStack[_redoStack.length - 1] : undefined
        if (typeof state.actionRedo === 'function' && actionTop && topSeq(actionTop) >= topSeq(legacyTop)) {
          try {
            const handled = state.actionRedo()
            if (handled) {
              logUndoSource('action-stack')
              return
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[undo] action-stack redo threw, falling through to legacy:', err)
          }
        }
      }

      if (_redoStack.length === 0) {
        logUndoSource('no-op')
        return
      }
      logUndoSource('legacy-snapshot')
      setInspectorUndoPushed(false)
      if (_inspectorSaveTimer) {
        clearTimeout(_inspectorSaveTimer)
        setInspectorSaveTimer(null)
      }
      const current: UndoableState = structuredClone({ scenes, globalStyle, project })
      current._seq = nextUndoSeq() // re-stamp so a subsequent undo() sees this as newest
      const newRedo = [..._redoStack]
      const next = newRedo.pop()!
      const newUndo = [..._undoStack, current]
      set({
        scenes: next.scenes,
        globalStyle: next.globalStyle,
        project: next.project,
        _undoStack: newUndo,
        _redoStack: newRedo,
        sceneHtmlVersion: get().sceneHtmlVersion + 1,
        inspectorSelectedElement: null,
        inspectorSelectedLayerId: null,
        inspectorElements: {},
        inspectorPendingChanges: {},
      })
      persistUndoStacks(newUndo, newRedo)
      scheduleDurablePersistFromState(get())
      const sel = get().selectedSceneId
      if (sel && !next.scenes.find((s) => s.id === sel)) {
        set({ selectedSceneId: next.scenes[0]?.id ?? null })
      }
      // Mirror undo(): re-save HTML for every scene whose code changed.
      reSaveChangedSceneHTML(get, next.scenes, current.scenes)
    },

    // Checkpoint-coupled rewind (S3). Restore the project to the pre-run snapshot
    // captured before `msgId`'s agent run (keyed in captureAgentRunSnapshot). This
    // is the project-state half of a conversation rewind: the hook truncates the
    // transcript, then calls this so the agent reruns against the restored state
    // rather than the post-run state. The restore is itself pushed onto the undo
    // stack so Cmd+Z brings the post-run state back. Mirrors undo()'s disk
    // reconcile. Returns false when no snapshot exists or a run is in flight.
    restoreRunSnapshot: (msgId: string): boolean => {
      const { _runSnapshots, scenes, globalStyle, project, isAgentRunning, _undoStack } = get()
      if (isAgentRunning) return false
      const idx = _runSnapshots.findIndex((r) => r.msgId === msgId)
      if (idx < 0) return false
      const target = _runSnapshots[idx].snapshot

      // Snapshot the current (post-run) state onto the undo stack first so the
      // restore is Cmd+Z-able, sanitizing d3Data exactly as _pushUndo does.
      const safeScenes = scenes.map((s) =>
        s.d3Data !== null && s.d3Data !== undefined ? { ...s, d3Data: JSON.parse(JSON.stringify(s.d3Data)) } : s,
      )
      const current: UndoableState = structuredClone({ scenes: safeScenes, globalStyle, project })
      current._seq = nextUndoSeq()
      const newUndo = [..._undoStack, current]
      if (newUndo.length > MAX_UNDO) newUndo.shift()

      set({
        scenes: target.scenes,
        globalStyle: target.globalStyle,
        project: target.project,
        _undoStack: newUndo,
        // A restore invalidates redo (new branch of history), same as undo()/_pushUndo.
        _redoStack: [],
        _actionRedoStack: [],
        // Prune the restored snapshot AND every snapshot captured after it — their
        // runs were just removed by the rewind, so they're no longer reachable.
        _runSnapshots: _runSnapshots.slice(0, idx),
        sceneHtmlVersion: get().sceneHtmlVersion + 1,
        inspectorSelectedElement: null,
        inspectorSelectedLayerId: null,
        inspectorElements: {},
        inspectorPendingChanges: {},
      })
      persistUndoStacks(newUndo, [])
      scheduleDurablePersistFromState(get())
      const sel = get().selectedSceneId
      if (sel && !target.scenes.find((s) => s.id === sel)) {
        set({ selectedSceneId: target.scenes[0]?.id ?? null })
      }
      // Re-save HTML for every scene whose code-bearing content changed (mirror undo()).
      reSaveChangedSceneHTML(get, target.scenes, current.scenes)
      return true
    },
  }
}
