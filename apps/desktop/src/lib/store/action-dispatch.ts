/**
 * Store-side glue for the new action layer.
 *
 * Coexists with the legacy snapshot-based `_undoStack` (per the strangler-fig
 * plan in the doc — "old `_pushUndo()` paths still work, will be removed
 * when no callers remain"). Callers ready to graduate to the action layer
 * use `dispatchAction(input)`; everyone else stays on the existing
 * `addScene` / `updateScene` / etc.
 *
 * The new path provides:
 *   - `dispatchAction(input)`   — runs the executor, applies state, pushes inverse
 *   - `actionUndo()` / `actionRedo()` — pop + re-dispatch with source='replay'
 *   - `beginAgentRun()` / `endAgentRun()` — group the next batch of actions
 *     under one `runId` so "undo last agent run" reverts them as a unit
 *   - `setUiEditingLayerId(id)` — sets the per-layer lock (locked decision #4)
 */

import { dispatchSync, type Action, type ActionInput, type ActionResult, type ProjectState } from '@/lib/actions'
import { fillBaseFields } from '@/lib/actions/executor'
import { sceneIdForAction } from '@/lib/actions/scene-lock-guard'
import { nextUndoSeq } from './helpers'
import { scheduleDurablePersistFromState } from './undo-persistence'
import type { Set, Get } from './types'
import { createLogger } from '../logger'

const log = createLogger('action-dispatch')

/**
 * Best-effort fire-and-forget persistence to main. The renderer doesn't
 * await this — the action is already applied locally and the WAL write is
 * synchronous on the main side, so a hung promise here cannot lose data.
 *
 * If `dreambyteApi.actionLog` is unavailable (web fallback / SSR / tests), the
 * action stays in-memory only. That's expected and matches the strangler-fig
 * coexistence with the legacy snapshot undo stack — degrading gracefully.
 *
 * Under the EAGER draft model the project row already exists
 * (status='draft') from creation, so the action_log FK is always satisfiable —
 * there is no draft-promotion step to await before the append.
 */
function persistActionAsync(projectId: string, branchId: string | null, action: Action): void {
  if (typeof window === 'undefined') return
  const ipc = window.dreambyteApi?.actionLog
  if (!ipc) return
  // Eager draft model: the project row already exists (status='draft') from
  // creation, so there is no draft-promotion step to await before the append.
  void Promise.resolve()
    .then(() => ipc.append({ projectId, branchId, action: action as unknown as Record<string, unknown> }))
    .then((res: { success: true; written: { wal: boolean; db: boolean } }) => {
      if (!res.written.db || !res.written.wal) {
        log.warn('action_log partial write', { extra: { actionId: action.id, ...res.written } })
      }
    })
    .catch((err: unknown) => {
      log.error('action_log append IPC failed', { extra: { actionId: action.id }, error: err })
    })
}

/**
 * Maximum action-stack depth — symmetric with MAX_UNDO in undo-actions.ts.
 * Bounded so a runaway agent run can't OOM the renderer.
 */
const MAX_ACTION_UNDO = 200

export interface ActionDispatchSlice {
  /** Inverse actions, most-recent on top. */
  _actionUndoStack: Action[]
  /** Actions popped from undo, most-recent on top. */
  _actionRedoStack: Action[]
  /** Active agent-run id; new actions inherit it for grouped undo. Null = user actions. */
  currentAgentRunId: string | null
  /**
   * Field-level lock: when set, agent-source actions targeting this layer
   * are rejected with `LAYER_EDITING`. Cleared when the user blurs the
   * inspector field. See src/lib/actions/reducers/layer-reducer.ts.
   */
  uiEditingLayerId: string | null

  setUiEditingLayerId(id: string | null): void
  beginAgentRun(runId: string): void
  endAgentRun(): void

  /**
   * Run an action through the executor. Returns the result so callers can
   * surface validation errors back to the user / agent. State is applied
   * to the Zustand store on success.
   */
  dispatchAction(input: ActionInput, options?: { source?: 'user' | 'agent' }): ActionResult

  /**
   * Emit-only: stamp an Action and persist it to action_log + WAL, but do NOT
   * run the reducer and do NOT push an inverse onto the undo stack. Use for
   * legacy renderer mutations that have side-effect logic the reducer doesn't
   * model yet (e.g., moveClip's linked-audio/scene-reorder logic). The action
   * is recorded so it shows in the diff viewer / git timeline; Cmd+Z still
   * routes through the legacy snapshot stack for these ops.
   *
   * Returns the typed Action with id + timestamp filled in.
   */
  recordUserAction(input: ActionInput): Action

  actionUndo(): boolean
  actionRedo(): boolean
}

interface VideoStoreLite {
  scenes: ProjectState['scenes']
  globalStyle: ProjectState['globalStyle']
  project: ProjectState['project']
  selectedSceneId: ProjectState['selectedSceneId']
  uiEditingLayerId: ProjectState['uiEditingLayerId']
  _actionUndoStack: Action[]
  _actionRedoStack: Action[]
  currentAgentRunId: string | null
  /** Mirrors the store's active branch so action_log rows go to the right branch. */
  projectActiveBranchId: string | null
  scheduleSaveProjectToDb?: () => void
  saveSceneHTML?: (sceneId: string, quiet?: boolean) => void
  /** Transient feedback hook (optional — tests may not provide it). */
  showTransientStatus?: (text: string, durationMs?: number) => void
  /** Live-run conflict tracking (optional: tests may not provide them).
   *  globalThis.Set is explicit qualification only — the type-only `Set` import
   *  from './types' is erased at runtime and does not shadow the global. */
  isAgentRunning?: boolean
  _userEditedScenesDuringRun?: globalThis.Set<string>
}

function projectSlice(s: VideoStoreLite): ProjectState {
  return {
    scenes: s.scenes,
    globalStyle: s.globalStyle,
    project: s.project,
    selectedSceneId: s.selectedSceneId,
    uiEditingLayerId: s.uiEditingLayerId,
  }
}

function applyResult(set: Set, result: ActionResult): void {
  if (!result.success || !result.state) return
  const next = result.state
  set({
    scenes: next.scenes,
    globalStyle: next.globalStyle,
    project: next.project,
    selectedSceneId: next.selectedSceneId,
    uiEditingLayerId: next.uiEditingLayerId,
  })
}

export function createActionDispatch(set: Set, get: Get): ActionDispatchSlice {
  return {
    _actionUndoStack: [],
    _actionRedoStack: [],
    currentAgentRunId: null,
    uiEditingLayerId: null,

    setUiEditingLayerId(id) {
      set({ uiEditingLayerId: id })
    },

    beginAgentRun(runId) {
      set({ currentAgentRunId: runId })
    },

    endAgentRun() {
      set({ currentAgentRunId: null })
    },

    dispatchAction(input, options = {}) {
      const source = options.source ?? 'user'
      const state = get() as unknown as VideoStoreLite
      const projState = projectSlice(state)
      const runId = state.currentAgentRunId

      const { result, action } = dispatchSync(projState, input, {
        source,
        runId,
        // Production: skip freeze for perf. Tests + dev: freeze (perf
        // overhead is negligible at human-action rates).
        freezeInput: process.env.NODE_ENV !== 'production',
      })

      if (!result.success) {
        // Surface a lock rejection so the user understands why their edit didn't land — without
        // this the cursor model silently swallows the action. (Other errors stay silent; callers
        // already handle them.)
        if (result.error?.code === 'SCENE_LOCKED' && source === 'user') {
          state.showTransientStatus?.('The agent is editing this scene — stop it to take over', 2600)
        }
        return result
      }

      applyResult(set, result)

      // Scene-lock acquisition (cursor model): a successful user/agent mutate acquires/refreshes
      // that source's lock on the target scene + arms the 3s idle auto-release. The action already
      // passed the enforcement guard, so acquire only ever sees unlocked or same-owner here. After
      // 3s of no mutates the lock releases, freeing the scene for the other editor. (Agent runs
      // also acquire explicitly at run start — this covers per-action refresh during the run.)
      const lockSceneId = sceneIdForAction(action)
      if (lockSceneId && (source === 'user' || source === 'agent')) {
        get().acquireSceneLock(lockSceneId, source, 'in-app')
      }

      // Source-tagged conflict tracking. A USER mutate landing while an
      // agent run is live marks its scene so syncScenesFromAgent's merge skips
      // the agent's write for it (and reports the conflict). scene.updatedAt
      // alone can't make this call — agent reducers bump it with Date.now() too,
      // so a timestamp guard misclassifies agent writes as user edits.
      if (lockSceneId && source === 'user') {
        const live = get() as unknown as VideoStoreLite
        if (live.isAgentRunning && live._userEditedScenesDuringRun) {
          const next = new globalThis.Set<string>(live._userEditedScenesDuringRun)
          next.add(lockSceneId)
          set({ _userEditedScenesDuringRun: next })
        }
      }

      if (result.inverseAction) {
        // Stamp the order key so undo() routes by true LIFO across the legacy
        // and action stacks.
        ;(result.inverseAction as { _seq?: number })._seq = nextUndoSeq()
        const newUndo = [...state._actionUndoStack, result.inverseAction]
        if (newUndo.length > MAX_ACTION_UNDO) newUndo.shift()
        set({
          _actionUndoStack: newUndo,
          // Any new action invalidates BOTH redo stacks — clearing only the
          // action one would leave a stale legacy redo entry reachable via the
          // cross-stack seq routing.
          _actionRedoStack: [],
          _redoStack: [],
        })
        scheduleDurablePersistFromState(get()) // DB copy survives restarts
      }

      // Run side-effects flagged by the reducer.
      if (result.effects) {
        for (const effect of result.effects) {
          switch (effect.kind) {
            case 'schedule-project-save':
              state.scheduleSaveProjectToDb?.()
              break
            case 'regenerate-scene-html':
              state.saveSceneHTML?.(effect.sceneId, true)
              break
          }
        }
      }

      // P1b persistence: WAL append + action_log row in main, fire-and-forget.
      // `dispatchAction` only ever runs `user` / `agent` sources — replay
      // dispatches go through actionUndo/actionRedo and skip persistence.
      if (state.project?.id) {
        persistActionAsync(state.project.id, state.projectActiveBranchId ?? null, action)
      }

      return result
    },

    recordUserAction(input) {
      const state = get() as unknown as VideoStoreLite
      const action = fillBaseFields(input, 'user', state.currentAgentRunId ?? null)
      if (state.project?.id) {
        persistActionAsync(state.project.id, state.projectActiveBranchId ?? null, action)
      }
      return action
    },

    actionUndo() {
      const state = get() as unknown as VideoStoreLite
      if (state._actionUndoStack.length === 0) return false
      const inverse = state._actionUndoStack[state._actionUndoStack.length - 1]
      const newUndo = state._actionUndoStack.slice(0, -1)
      const projState = projectSlice(state)
      const { result, action: redoAction } = dispatchSync(projState, inverse, {
        source: 'replay',
        runId: inverse.runId,
        freezeInput: false,
      })
      if (!result.success) return false
      applyResult(set, result)
      // Re-stamp so redo() routes this (just-undone op) as the newest redo entry.
      if (result.inverseAction) (result.inverseAction as { _seq?: number })._seq = nextUndoSeq()
      const newRedo = result.inverseAction ? [...state._actionRedoStack, result.inverseAction] : state._actionRedoStack
      set({ _actionUndoStack: newUndo, _actionRedoStack: newRedo })
      // Run side-effects on undo too — HTML must regenerate when a code-bearing
      // patch is reverted.
      if (result.effects) {
        for (const effect of result.effects) {
          if (effect.kind === 'regenerate-scene-html') state.saveSceneHTML?.(effect.sceneId, true)
          else if (effect.kind === 'schedule-project-save') state.scheduleSaveProjectToDb?.()
        }
      }
      // Transient status-bar feedback. inverse.type already describes
      // what the user is undoing (e.g., "clip/move" — the inverse of a move).
      state.showTransientStatus?.(`Undid: ${inverse.type}`)
      void redoAction
      return true
    },

    actionRedo() {
      const state = get() as unknown as VideoStoreLite
      if (state._actionRedoStack.length === 0) return false
      const inverseOfInverse = state._actionRedoStack[state._actionRedoStack.length - 1]
      const newRedo = state._actionRedoStack.slice(0, -1)
      const projState = projectSlice(state)
      const { result } = dispatchSync(projState, inverseOfInverse, {
        source: 'replay',
        runId: inverseOfInverse.runId,
        freezeInput: false,
      })
      if (!result.success) return false
      applyResult(set, result)
      // Re-stamp so a subsequent undo() routes this (just-redone op) as newest.
      if (result.inverseAction) (result.inverseAction as { _seq?: number })._seq = nextUndoSeq()
      const newUndo = result.inverseAction ? [...state._actionUndoStack, result.inverseAction] : state._actionUndoStack
      set({ _actionUndoStack: newUndo, _actionRedoStack: newRedo })
      if (result.effects) {
        for (const effect of result.effects) {
          if (effect.kind === 'regenerate-scene-html') state.saveSceneHTML?.(effect.sceneId, true)
          else if (effect.kind === 'schedule-project-save') state.scheduleSaveProjectToDb?.()
        }
      }
      state.showTransientStatus?.(`Redid: ${inverseOfInverse.type}`)
      return true
    },
  }
}
