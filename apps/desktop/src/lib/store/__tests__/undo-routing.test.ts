// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUndoActions } from '../undo-actions'

/**
 * G1 routing tests (v0.3.5+).
 *
 * Cmd+Z and Cmd+Shift+Z route to the action layer first by default. The
 * legacy snapshot stack is the fallback for operations that haven't been
 * migrated to dispatchAction yet. Users can force legacy-only mode via
 * `localStorage.setItem('dreambyte-undo-legacy-only', '1')` for bisecting a
 * regression introduced by the action layer.
 *
 * Was opt-IN to the action layer in v0.3.0-v0.3.4 (via the
 * `dreambyte-action-layer-undo` localStorage key); v0.3.5 flips the default
 * and replaces the opt-in flag with an opt-out flag.
 */

interface MockState {
  scenes: unknown[]
  globalStyle: Record<string, unknown>
  project: { timeline: null; updatedAt: string } | null
  _undoStack: unknown[]
  _redoStack: unknown[]
  isAgentRunning: boolean
  selectedSceneId: string | null
  sceneHtmlVersion: number
  actionUndo?: () => boolean
  actionRedo?: () => boolean
  _actionUndoStack?: unknown[]
  _actionRedoStack?: unknown[]
  saveSceneHTML?: (id: string, quiet?: boolean) => void
  inspectorSelectedElement?: unknown
  inspectorSelectedLayerId?: unknown
  inspectorElements?: Record<string, unknown>
  inspectorPendingChanges?: Record<string, unknown>
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    scenes: [],
    globalStyle: {},
    project: { timeline: null, updatedAt: '' },
    _undoStack: [],
    _redoStack: [],
    isAgentRunning: false,
    selectedSceneId: null,
    sceneHtmlVersion: 0,
    saveSceneHTML: vi.fn(),
    inspectorSelectedElement: null,
    inspectorSelectedLayerId: null,
    inspectorElements: {},
    inspectorPendingChanges: {},
    ...overrides,
  }
}

function makeActions(initial: MockState) {
  let state = initial
  const set = vi.fn((partial: Partial<MockState>) => {
    state = { ...state, ...partial }
  })
  const get = vi.fn(() => state) as unknown as () => MockState
  const actions = createUndoActions(set as any, get as any)
  return { actions, set, get: () => state }
}

describe('G1 — undo() routing (v0.3.5+: action-stack-first default)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    window.localStorage.clear()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    window.localStorage.clear()
  })

  it('default (no flag) routes Cmd+Z to the action stack when it has entries', () => {
    const actionUndoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionUndo: actionUndoFn,
        _actionUndoStack: [{ type: 'scene/update' }],
      }),
    )

    actions.undo()

    expect(actionUndoFn).toHaveBeenCalledTimes(1)
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: action-stack')
    expect(consoleWarnSpy).not.toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })

  it('default + action stack empty → falls back to legacy snapshot', () => {
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionUndo: vi.fn(() => true),
        _actionUndoStack: [], // empty
      }),
    )

    actions.undo()

    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })

  it('default + actionUndo returns false → falls back to legacy snapshot', () => {
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionUndo: vi.fn(() => false), // dispatch failed
        _actionUndoStack: [{ type: 'scene/update' }],
      }),
    )

    actions.undo()

    // action stack tried first, returned false, legacy then fired
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })

  it('dreambyte-undo-legacy-only="1" forces legacy stack even when action stack has entries', () => {
    window.localStorage.setItem('dreambyte-undo-legacy-only', '1')
    const actionUndoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionUndo: actionUndoFn,
        _actionUndoStack: [{ type: 'scene/update' }],
      }),
    )

    actions.undo()

    // Legacy-only flag is set → action stack is NEVER tried.
    expect(actionUndoFn).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })

  it('legacy-only flag must be literal "1" — "true" / "yes" / anything else → action-stack-first', () => {
    const actionUndoFn = vi.fn(() => true)
    for (const value of ['true', 'yes', '0', '', 'on']) {
      window.localStorage.setItem('dreambyte-undo-legacy-only', value)
      consoleWarnSpy.mockClear()
      actionUndoFn.mockClear()
      const { actions } = makeActions(
        makeState({
          _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
          actionUndo: actionUndoFn,
          _actionUndoStack: [{ type: 'scene/update' }],
        }),
      )

      actions.undo()

      expect(actionUndoFn, `legacy-only flag=${value} should NOT force legacy`).toHaveBeenCalledTimes(1)
      expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: action-stack')
    }
  })

  it('both stacks empty → no-op log, no state change', () => {
    const { actions, set } = makeActions(
      makeState({
        _undoStack: [],
        _actionUndoStack: [],
      }),
    )

    actions.undo()

    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: no-op')
    expect(set).not.toHaveBeenCalled()
  })

  it('isAgentRunning=true → undo is a no-op (no log, no state change)', () => {
    const { actions, set } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        isAgentRunning: true,
      }),
    )

    actions.undo()

    // Agent-running guard fires before any logging
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })
})

describe('G1 — redo() routing (v0.3.5+)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    window.localStorage.clear()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    window.localStorage.clear()
  })

  it('default (no flag) routes Cmd+Shift+Z to the action stack when it has entries', () => {
    const actionRedoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _redoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionRedo: actionRedoFn,
        _actionRedoStack: [{ type: 'scene/update' }],
      }),
    )

    actions.redo()

    expect(actionRedoFn).toHaveBeenCalledTimes(1)
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: action-stack')
  })

  it('legacy-only flag forces legacy for redo too', () => {
    window.localStorage.setItem('dreambyte-undo-legacy-only', '1')
    const actionRedoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _redoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null }],
        actionRedo: actionRedoFn,
        _actionRedoStack: [{ type: 'scene/update' }],
      }),
    )

    actions.redo()

    expect(actionRedoFn).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })
})

// F89: when both stacks have entries, undo must take whichever was pushed most
// recently (largest _seq) — not unconditionally prefer the action stack.
describe('F89 — cross-stack LIFO ordering', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    window.localStorage.clear()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleWarnSpy.mockRestore()
    window.localStorage.clear()
  })

  it('undo takes the legacy stack when its top is newer than the action top', () => {
    // Repro: removeClip (action, _seq 1) then addClip (legacy snapshot, _seq 2).
    // Cmd+Z must undo the newer legacy op, NOT the older action op.
    const actionUndoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null, _seq: 2 }],
        actionUndo: actionUndoFn,
        _actionUndoStack: [{ type: 'clip/remove', _seq: 1 }],
      }),
    )

    actions.undo()

    expect(actionUndoFn).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })

  it('undo takes the action stack when its top is newer than the legacy top', () => {
    const actionUndoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _undoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null, _seq: 1 }],
        actionUndo: actionUndoFn,
        _actionUndoStack: [{ type: 'clip/remove', _seq: 2 }],
      }),
    )

    actions.undo()

    expect(actionUndoFn).toHaveBeenCalledTimes(1)
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: action-stack')
  })

  it('redo mirrors: takes whichever redo top was undone most recently', () => {
    const actionRedoFn = vi.fn(() => true)
    const { actions } = makeActions(
      makeState({
        _redoStack: [{ scenes: [{ id: 's1' }], globalStyle: {}, project: null, _seq: 5 }],
        actionRedo: actionRedoFn,
        _actionRedoStack: [{ type: 'clip/remove', _seq: 3 }],
      }),
    )

    actions.redo()

    // Legacy redo top (_seq 5) is newer than action redo top (_seq 3) → legacy.
    expect(actionRedoFn).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith('[undo] handled by: legacy-snapshot')
  })
})
