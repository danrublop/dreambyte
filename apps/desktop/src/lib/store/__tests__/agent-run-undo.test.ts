// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentActions } from '../agent-actions'
import { createUndoActions } from '../undo-actions'
import type { Scene } from '../../types'

/**
 * Agent-run undo snapshot wiring (eng-review D2/D9/C1-C3 + T1-R).
 *
 * The pre-run undo snapshot used to live in `setAgentRunning` — which had
 * ZERO callers, so agent runs were never undoable through the legacy stack
 * (the safety net for the raw-set fallback in syncScenesFromAgent). These
 * tests pin the moved capture in `setAgentRunSceneLock(true)`:
 *
 *  - captured exactly once per run, stamped with a `_seq` order key (C3)
 *  - sets isAgentRunning + _agentRunStartedAt (C2 — the merge guard reads it)
 *  - D9 size guard: oversized projects strip code fields instead of janking
 *  - undo() restores the pre-run scenes off the legacy stack (raw-set path)
 *  - T1-R: cross-stack LIFO — action entries pushed DURING the run undo
 *    before the run-start legacy snapshot, never the reverse
 */

interface MockState {
  scenes: Array<Record<string, unknown>>
  globalStyle: Record<string, unknown>
  project: Record<string, unknown> | null
  _undoStack: Array<{ _seq?: number; scenes: Array<Record<string, unknown>> }>
  _redoStack: unknown[]
  _runSnapshots: Array<{ msgId: string; snapshot: { scenes: Array<Record<string, unknown>> } }>
  isAgentRunning: boolean
  _agentRunStartedAt: number
  selectedSceneId: string | null
  sceneHtmlVersion: number
  acquireSceneLock: ReturnType<typeof vi.fn>
  touchSceneLock: ReturnType<typeof vi.fn>
  releaseSceneLock: ReturnType<typeof vi.fn>
  saveSceneHTML?: ReturnType<typeof vi.fn>
  actionUndo?: () => boolean
  _actionUndoStack?: Array<{ _seq?: number }>
  inspectorSelectedElement?: unknown
  inspectorSelectedLayerId?: unknown
  inspectorElements?: Record<string, unknown>
  inspectorPendingChanges?: Record<string, unknown>
}

function makeScene(overrides: Partial<Record<string, unknown>> & { id: string }): Record<string, unknown> {
  return {
    name: 'unnamed',
    sceneType: 'react',
    duration: 5,
    sceneHTML: '',
    reactCode: '',
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    aiLayers: [],
    messages: [],
    ...overrides,
  }
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    scenes: [makeScene({ id: 'scene-1', sceneCode: 'const x = 1' })],
    globalStyle: { presetId: null },
    project: { id: 'proj-1', timeline: null, updatedAt: '' },
    _undoStack: [],
    _redoStack: [],
    _runSnapshots: [],
    isAgentRunning: false,
    _agentRunStartedAt: 0,
    selectedSceneId: null, // startAgentLock no-ops without a selection — lock path unit-tested elsewhere
    sceneHtmlVersion: 0,
    acquireSceneLock: vi.fn(() => ({ ok: true })),
    touchSceneLock: vi.fn(),
    releaseSceneLock: vi.fn(),
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
  const set = vi.fn((partial: Partial<MockState> | ((s: MockState) => Partial<MockState>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
  })
  const get = vi.fn(() => state)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = createAgentActions(set as any, get as any) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const undo = createUndoActions(set as any, get as any) as any
  return { agent, undo, get: () => state }
}

describe('setAgentRunSceneLock(true) — pre-run snapshot capture (D2)', () => {
  it('captures exactly one snapshot per run, even across repeated true calls', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    agent.setAgentRunSceneLock(true) // re-entrant true (effect re-fire) must not double-capture
    expect(get()._undoStack).toHaveLength(1)
    expect(get().isAgentRunning).toBe(true)
    expect(get()._agentRunStartedAt).toBeGreaterThan(0) // C2 — merge guard reads this
  })

  it('stamps the snapshot with a _seq order key (C3)', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    expect(typeof get()._undoStack[0]._seq).toBe('number')
    expect(get()._undoStack[0]._seq).toBeGreaterThan(0)
  })

  it('snapshot holds the PRE-run scenes and clears BOTH redo stacks (F89, /review fix)', () => {
    const { agent, get } = makeActions(
      makeState({
        _redoStack: [{ stale: true }],
        // A stale action-redo entry left behind would be reachable via the
        // cross-stack seq routing after the run-start snapshot lands.
        _actionRedoStack: [{ _seq: 999 }],
      } as Partial<MockState>),
    )
    agent.setAgentRunSceneLock(true)
    const snap = get()._undoStack[0]
    expect(snap.scenes.map((s) => s.id)).toEqual(['scene-1'])
    expect((snap.scenes[0] as { sceneCode: string }).sceneCode).toBe('const x = 1')
    expect(get()._redoStack).toHaveLength(0)
    expect((get() as MockState & { _actionRedoStack?: unknown[] })._actionRedoStack).toHaveLength(0)
  })

  it('captures a fresh snapshot for a SECOND run after the first ends', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    agent.setAgentRunSceneLock(false)
    expect(get().isAgentRunning).toBe(false)
    agent.setAgentRunSceneLock(true)
    expect(get()._undoStack).toHaveLength(2)
  })

  it('D9 size guard: an oversized project strips code fields from the snapshot', () => {
    const huge = 'x'.repeat(16 * 1024 * 1024) // > 15MB budget
    const state = makeState({
      scenes: [makeScene({ id: 'scene-big', sceneCode: huge, svgContent: '<svg>real</svg>' })],
    })
    const { agent, get } = makeActions(state)
    agent.setAgentRunSceneLock(true)
    const snap = get()._undoStack[0]
    expect((snap.scenes[0] as { sceneCode: string }).sceneCode).toBe('') // stripped
    expect((snap.scenes[0] as { svgContent: string }).svgContent).toBe('') // stripped
    expect(snap.scenes[0].id).toBe('scene-big') // identity kept
    // live scenes untouched
    expect((get().scenes[0] as { sceneCode: string }).sceneCode).toBe(huge)
  })

  it('normal-size project keeps full code in the snapshot (no stripping)', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    expect((get()._undoStack[0].scenes[0] as { sceneCode: string }).sceneCode).toBe('const x = 1')
  })
})

describe('undo() after an agent run — legacy-stack safety net (raw-set fallback path)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('restores the pre-run scenes when the action stack is empty (raw-set fallback)', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    // Simulate the raw-set fallback: agent overwrote scenes without an action entry.
    get().scenes = [makeScene({ id: 'scene-agent', sceneCode: 'agent output' }) as Record<string, unknown>]
    agent.setAgentRunSceneLock(false)
    undo.undo()
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-1'])
    expect((get().scenes[0] as { sceneCode: string }).sceneCode).toBe('const x = 1')
  })

  it('T1-R: cross-stack LIFO — an action entry pushed DURING the run undoes before the run-start snapshot', () => {
    const actionUndo = vi.fn(() => true)
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    const snapshotSeq = get()._undoStack[0]._seq as number
    agent.setAgentRunSceneLock(false)
    // Action entry stamped AFTER the snapshot (as agent/applyRun would be).
    // Mutate the CURRENT state object (set() replaces it, so fetch fresh).
    get().actionUndo = actionUndo
    get()._actionUndoStack = [{ _seq: snapshotSeq + 1 }]

    undo.undo() // newer action entry wins
    expect(actionUndo).toHaveBeenCalledTimes(1)
    expect(get()._undoStack).toHaveLength(1) // legacy snapshot untouched

    // Action stack now drained — next undo falls through to the legacy snapshot.
    get()._actionUndoStack = []
    undo.undo()
    expect(actionUndo).toHaveBeenCalledTimes(1)
    expect(get()._undoStack).toHaveLength(0)
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-1'])
  })

  it('undo is blocked while the run is still active (isAgentRunning guard)', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    get().scenes = [makeScene({ id: 'scene-agent' }) as Record<string, unknown>]
    undo.undo() // mid-run — must be a no-op
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-agent'])
    expect(get()._undoStack).toHaveLength(1)
  })
})

describe('structuredClone failure fallback', () => {
  it('still marks the run active when the snapshot clone throws', () => {
    const scenes = [makeScene({ id: 'scene-fn' })]
    // Functions are not structured-cloneable → forces the catch path.
    ;(scenes[0] as Record<string, unknown>).poison = () => undefined
    const { agent, get } = makeActions(makeState({ scenes }))
    agent.setAgentRunSceneLock(true)
    expect(get()._undoStack).toHaveLength(0) // capture skipped
    expect(get().isAgentRunning).toBe(true) // run proceeds
    expect(get()._agentRunStartedAt).toBeGreaterThan(0)
  })
})

/**
 * Checkpoint-coupled rewind (S3). The pre-run snapshot is ALSO keyed by the run's
 * streaming assistant message id so a conversation rewind can restore the project
 * to its state before that run, and restoreRunSnapshot applies + prunes it.
 */
describe('S3 — run-keyed pre-run snapshots', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('keys the snapshot by the run message id when one is supplied', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true, 'assistant-msg-1')
    expect(get()._runSnapshots).toHaveLength(1)
    expect(get()._runSnapshots[0].msgId).toBe('assistant-msg-1')
    expect(get()._runSnapshots[0].snapshot.scenes.map((s) => s.id)).toEqual(['scene-1'])
    expect(agent.hasRunSnapshot('assistant-msg-1')).toBe(true)
    expect(agent.hasRunSnapshot('nope')).toBe(false)
    expect(agent.hasRunSnapshot(null)).toBe(false)
  })

  it('captures no run-snapshot when no message id is supplied (plain lock)', () => {
    const { agent, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true)
    expect(get()._undoStack).toHaveLength(1) // undo capture still happens
    expect(get()._runSnapshots).toHaveLength(0) // but nothing keyed for rewind
  })

  it('restoreRunSnapshot rolls scenes back and reports success', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true, 'm1')
    // The run mutates the project, then ends.
    get().scenes = [makeScene({ id: 'scene-agent', sceneCode: 'agent output' }) as Record<string, unknown>]
    agent.setAgentRunSceneLock(false)

    const ok = undo.restoreRunSnapshot('m1')
    expect(ok).toBe(true)
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-1'])
    expect((get().scenes[0] as { sceneCode: string }).sceneCode).toBe('const x = 1')
    // The snapshot is consumed by the restore.
    expect(get()._runSnapshots).toHaveLength(0)
  })

  it('prunes the restored snapshot AND every snapshot captured after it', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true, 'm1')
    agent.setAgentRunSceneLock(false)
    agent.setAgentRunSceneLock(true, 'm2')
    agent.setAgentRunSceneLock(false)
    agent.setAgentRunSceneLock(true, 'm3')
    agent.setAgentRunSceneLock(false)
    expect(get()._runSnapshots.map((r) => r.msgId)).toEqual(['m1', 'm2', 'm3'])

    undo.restoreRunSnapshot('m2') // restoring m2 invalidates m2 and m3
    expect(get()._runSnapshots.map((r) => r.msgId)).toEqual(['m1'])
  })

  it('restore is itself undoable (current state pushed to the undo stack)', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true, 'm1')
    get().scenes = [makeScene({ id: 'scene-agent', sceneCode: 'agent output' }) as Record<string, unknown>]
    agent.setAgentRunSceneLock(false)

    undo.restoreRunSnapshot('m1')
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-1'])
    undo.undo() // brings the post-run state back
    expect(get().scenes.map((s) => s.id)).toEqual(['scene-agent'])
  })

  it('returns false for an unknown id and while a run is active', () => {
    const { agent, undo, get } = makeActions(makeState())
    agent.setAgentRunSceneLock(true, 'm1')
    // Mid-run: refuse (mirrors undo()'s isAgentRunning guard).
    expect(undo.restoreRunSnapshot('m1')).toBe(false)
    agent.setAgentRunSceneLock(false)
    expect(undo.restoreRunSnapshot('ghost')).toBe(false)
  })
})
