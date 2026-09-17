// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgentActions } from '../agent-actions'
import type { Scene, GlobalStyle } from '../../types'

/**
 * Integration test: syncScenesFromAgent dispatches through the action layer
 * with source='agent'. This closes the bypass where agent runs silently
 * skipped action_log and broke G1 Cmd+Z routing.
 *
 * We mock dispatchAction and assert (a) it gets called with type
 * 'agent/applyRun' and source 'agent', (b) merged scenes are what the
 * existing merge logic produces, (c) UI-only fields (sceneHtmlVersion)
 * still bump, (d) fallback raw-set fires when there's no project id or
 * the dispatch is rejected.
 */

function makeScene(overrides: Partial<Scene> & { id: string }): Scene {
  return {
    name: 'unnamed',
    sceneType: 'react',
    duration: 5,
    sceneHTML: '', // empty so the IPC writeHtml path is skipped in jsdom
    reactCode: '',
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    messages: [],
    ...overrides,
  } as Scene
}

function makeStyle(): GlobalStyle {
  return {
    presetId: null,
    palette: ['#000', '#111', '#222', '#333'],
    duration: 8,
    theme: 'light',
    uiTypography: 'app',
    uiFontFamily: null,
  } as unknown as GlobalStyle
}

function makeStore(
  initial: Record<string, unknown>,
  overrides: { dispatchAction?: ReturnType<typeof vi.fn>; project?: { id?: string } | null } = {},
) {
  // Honor null explicitly — ?? would coerce it to the default.
  const project = 'project' in overrides ? overrides.project : { id: 'proj-1' }
  let state: Record<string, unknown> = {
    scenes: [],
    globalStyle: makeStyle(),
    selectedSceneId: null,
    sceneHtmlVersion: 0,
    _agentRunStartedAt: 0,
    project,
    dispatchAction: overrides.dispatchAction,
    sceneWriteErrors: {},
    ...initial,
  }
  const set = vi.fn((updater: any) => {
    const next = typeof updater === 'function' ? updater(state) : updater
    state = { ...state, ...next }
  })
  const get = vi.fn(() => state) as unknown as () => any
  const actions = createAgentActions(set as any, get as any)
  state = { ...state, ...actions }
  return { actions, set, get: () => state }
}

describe('syncScenesFromAgent (action-layer integration)', () => {
  beforeEach(() => {
    // No window.dreambyteApi.scene → writeHtml block is skipped because all
    // test scenes have empty sceneHTML (warn log fires instead of throw).
    Object.defineProperty(window, 'dreambyteApi', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  })

  it('dispatches agent/applyRun with source=agent when project id is present', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const existing = makeScene({ id: 'scene-A', name: 'A pre' })
    const { actions } = makeStore({ scenes: [existing] }, { dispatchAction })

    const incomingScene = makeScene({ id: 'scene-A', name: 'A post', reactCode: 'export default () => <div/>' })
    await actions.syncScenesFromAgent([incomingScene], makeStyle())

    expect(dispatchAction).toHaveBeenCalledTimes(1)
    const [actionInput, options] = dispatchAction.mock.calls[0]
    expect(actionInput.type).toBe('agent/applyRun')
    expect(actionInput.params.scenes).toHaveLength(1)
    expect(actionInput.params.scenes[0].id).toBe('scene-A')
    expect(actionInput.params.scenes[0].name).toBe('A post')
    expect(actionInput.params.globalStyle).toBeDefined()
    expect(options).toEqual({ source: 'agent' })
  })

  it('preserves user-edited scenes through the merge (passes pre-state to dispatch)', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const agentRunStart = 1_000_000
    const existing = makeScene({
      id: 'scene-A',
      name: 'A user-edited',
      reactCode: 'user code',
      updatedAt: agentRunStart + 5_000, // edited AFTER agent started → preserved
    } as any)
    const { actions } = makeStore({ scenes: [existing], _agentRunStartedAt: agentRunStart }, { dispatchAction })

    const agentVersionOfA = makeScene({ id: 'scene-A', name: 'A from agent', reactCode: 'agent code' })
    await actions.syncScenesFromAgent([agentVersionOfA], makeStyle())

    const dispatchedScenes = dispatchAction.mock.calls[0][0].params.scenes
    // User-edited version wins.
    expect(dispatchedScenes[0].name).toBe('A user-edited')
    expect(dispatchedScenes[0].reactCode).toBe('user code')
  })

  it('removes new empty agent-created scenes when other scenes have content', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [] }, { dispatchAction })

    const contentScene = makeScene({ id: 'scene-A', reactCode: 'export default () => <h1/>' })
    const emptyNewScene = makeScene({ id: 'scene-B' }) // no content, not in store → dropped
    await actions.syncScenesFromAgent([contentScene, emptyNewScene], makeStyle())

    const dispatchedScenes = dispatchAction.mock.calls[0][0].params.scenes
    expect(dispatchedScenes.map((s: any) => s.id)).toEqual(['scene-A'])
  })

  it('always bumps sceneHtmlVersion (UI-only field, outside action layer)', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions, get } = makeStore({ scenes: [], sceneHtmlVersion: 7 }, { dispatchAction })

    await actions.syncScenesFromAgent([makeScene({ id: 'X', reactCode: 'x' })], makeStyle())

    expect(get().sceneHtmlVersion).toBe(8)
  })

  it('falls back to raw set when there is no project id', async () => {
    const dispatchAction = vi.fn()
    const { actions, get } = makeStore({ scenes: [] }, { dispatchAction, project: null })

    await actions.syncScenesFromAgent([makeScene({ id: 'X', reactCode: 'x' })], makeStyle())

    // No dispatch attempted without a project id.
    expect(dispatchAction).not.toHaveBeenCalled()
    // But the state still updated via raw set.
    const scenes = (get() as any).scenes as Array<{ id: string }>
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe('X')
  })

  it('falls back to raw set when dispatch returns failure', async () => {
    const dispatchAction = vi.fn().mockReturnValue({
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'oops' },
    })
    const { actions, get } = makeStore({ scenes: [] }, { dispatchAction })

    await actions.syncScenesFromAgent([makeScene({ id: 'X', reactCode: 'x' })], makeStyle())

    expect(dispatchAction).toHaveBeenCalledTimes(1)
    // Fallback ran — state updated raw.
    const scenes = (get() as any).scenes as Array<{ id: string }>
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe('X')
  })

  it('falls back to raw set when dispatch throws', async () => {
    const dispatchAction = vi.fn().mockImplementation(() => {
      throw new Error('dispatch boom')
    })
    const { actions, get } = makeStore({ scenes: [] }, { dispatchAction })

    await actions.syncScenesFromAgent([makeScene({ id: 'X', reactCode: 'x' })], makeStyle())

    const scenes = (get() as any).scenes as Array<{ id: string }>
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe('X')
  })

  it('on the dispatch path, hands selectedSceneId reconciliation to the reducer (verified by call args)', async () => {
    // selectedSceneId is in ProjectState, so the REDUCER reconciles it
    // (covered by reducer tests). The wrapper just needs to send the right
    // params; verify the call goes out with the post-state scenes so the
    // reducer can do its job.
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const gone = makeScene({ id: 'scene-old' })
    const { actions } = makeStore({ scenes: [gone], selectedSceneId: 'scene-old' }, { dispatchAction })
    const newOne = makeScene({ id: 'scene-new', reactCode: 'real content' })
    await actions.syncScenesFromAgent([newOne], makeStyle())
    const dispatchedScenes = dispatchAction.mock.calls[0][0].params.scenes
    expect(dispatchedScenes.map((s: any) => s.id)).toEqual(['scene-new'])
  })

  it('fallback path (no project) reconciles selectedSceneId to first scene when current is removed', async () => {
    // When dispatch is unavailable, the wrapper's raw-set fallback runs.
    // It must mirror the reducer's reconciliation logic — otherwise tests
    // and never-opened projects would diverge from real agent-run semantics.
    const dispatchAction = vi.fn()
    const gone = makeScene({ id: 'scene-old' })
    const { actions, get } = makeStore(
      { scenes: [gone], selectedSceneId: 'scene-old' },
      { dispatchAction, project: null },
    )
    const newOne = makeScene({ id: 'scene-new', reactCode: 'real content' })
    await actions.syncScenesFromAgent([newOne], makeStyle())
    expect((get() as any).selectedSceneId).toBe('scene-new')
    expect(dispatchAction).not.toHaveBeenCalled()
  })

  it('fallback path keeps selectedSceneId when current scene still exists', async () => {
    const dispatchAction = vi.fn()
    const sceneA = makeScene({ id: 'scene-A', reactCode: 'a' })
    const { actions, get } = makeStore(
      { scenes: [sceneA], selectedSceneId: 'scene-A' },
      { dispatchAction, project: null },
    )
    const updated = makeScene({ id: 'scene-A', reactCode: 'a2' })
    await actions.syncScenesFromAgent([updated], makeStyle())
    expect((get() as any).selectedSceneId).toBe('scene-A')
  })

  it('passes sceneGraph through to dispatchAction when caller provides it', async () => {
    // Closes the regression where sceneGraph was updated via a separate
    // updateSceneGraph() bypass call AFTER syncScenesFromAgent — undo
    // would revert scenes but leave the graph at post-agent values.
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [] }, { dispatchAction })
    const sceneB = makeScene({ id: 'scene-B', reactCode: 'x' })
    const graph = { nodes: [{ id: 'scene-B' } as any], edges: [], startSceneId: 'scene-B' }
    await actions.syncScenesFromAgent([sceneB], makeStyle(), graph as any)
    const params = dispatchAction.mock.calls[0][0].params
    expect(params.sceneGraph).toEqual(graph)
  })

  it('omits sceneGraph from action params when caller does not pass one', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [] }, { dispatchAction })
    await actions.syncScenesFromAgent([makeScene({ id: 'X', reactCode: 'x' })], makeStyle())
    const params = dispatchAction.mock.calls[0][0].params
    expect(params.sceneGraph).toBeUndefined()
  })
})
