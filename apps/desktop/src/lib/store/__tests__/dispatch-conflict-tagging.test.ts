// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { createActionDispatch } from '../action-dispatch'
import { createSceneActions } from '../scene-actions'
import { createDefaultScene, createDefaultProject } from '../helpers'

/**
 * IT4/C6 producer test (/review testing gap): the CONSUMER of
 * `_userEditedScenesDuringRun` (syncScenesFromAgent's merge) is covered by
 * agent-merge-guards.test.ts with a pre-seeded set — but nothing covered the
 * PRODUCER: dispatchAction tagging the scene when a USER mutate lands while
 * an agent run is live. A regression here (dropping the isAgentRunning gate,
 * or tagging agent-sourced dispatches) silently disables / poisons the merge
 * guard without failing any test.
 */

function makeStore(initial: Record<string, unknown> = {}) {
  const sceneA = createDefaultScene()
  sceneA.id = 'scene-A'
  sceneA.name = 'A'
  const sceneB = createDefaultScene()
  sceneB.id = 'scene-B'
  sceneB.name = 'B'
  const project = createDefaultProject([sceneA, sceneB])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {
    scenes: [sceneA, sceneB],
    globalStyle: { presetId: null, palette: ['#000', '#111', '#222', '#333'], duration: 8, theme: 'light' },
    project,
    selectedSceneId: 'scene-A',
    uiEditingLayerId: null,
    _actionUndoStack: [],
    _actionRedoStack: [],
    _redoStack: [],
    currentAgentRunId: null,
    projectActiveBranchId: null,
    isAgentRunning: false,
    _userEditedScenesDuringRun: new Set<string>(),
    scheduleSaveProjectToDb: vi.fn(),
    saveSceneHTML: vi.fn(),
    _pushUndoDebounced: vi.fn(),
    showTransientStatus: vi.fn(),
    ...initial,
  }
  const get = () => state
  const set = vi.fn((arg: unknown) => {
    const next = typeof arg === 'function' ? (arg as (s: typeof state) => Partial<typeof state>)(state) : arg
    state = { ...state, ...(next as Partial<typeof state>) }
  })
  state = {
    ...state,
    ...createActionDispatch(set as never, get as never),
    ...createSceneActions(set as never, get as never),
  }
  return get
}

const editAs = (get: ReturnType<typeof makeStore>, source: 'user' | 'agent', sceneId: string, name: string) =>
  get().dispatchAction({ type: 'scene/update', params: { sceneId, patch: { name } } }, { source })

describe('dispatchAction → _userEditedScenesDuringRun (IT4/C6 producer)', () => {
  it('tags the scene when a USER mutate lands while a run is live', () => {
    const get = makeStore({ isAgentRunning: true })
    const r = editAs(get, 'user', 'scene-A', 'A (user)')
    expect(r.success).toBe(true)
    expect([...get()._userEditedScenesDuringRun]).toEqual(['scene-A'])
  })

  it('accumulates multiple scenes without losing earlier tags', () => {
    const get = makeStore({ isAgentRunning: true })
    editAs(get, 'user', 'scene-A', 'A2')
    get().releaseSceneLock?.('scene-A')
    editAs(get, 'user', 'scene-B', 'B2')
    expect([...get()._userEditedScenesDuringRun].sort()).toEqual(['scene-A', 'scene-B'])
  })

  it('does NOT tag when no run is live (isAgentRunning=false)', () => {
    const get = makeStore({ isAgentRunning: false })
    editAs(get, 'user', 'scene-A', 'A (user)')
    expect(get()._userEditedScenesDuringRun.size).toBe(0)
  })

  it('does NOT tag agent-sourced dispatches (would poison the merge guard)', () => {
    const get = makeStore({ isAgentRunning: true })
    const r = editAs(get, 'agent', 'scene-A', 'A (agent)')
    expect(r.success).toBe(true)
    expect(get()._userEditedScenesDuringRun.size).toBe(0)
  })

  it('does NOT tag when the user dispatch is rejected (scene locked by agent)', () => {
    const get = makeStore({ isAgentRunning: true })
    // Agent takes the lock first.
    editAs(get, 'agent', 'scene-A', 'A (agent)')
    const r = editAs(get, 'user', 'scene-A', 'A (user)')
    expect(r.success).toBe(false)
    expect(get()._userEditedScenesDuringRun.size).toBe(0)
  })
})
