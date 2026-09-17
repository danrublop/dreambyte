// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgentActions } from '../agent-actions'
import type { Scene, GlobalStyle } from '../../types'

/**
 * IT4 — mid-run edit protection (source-tagged, C6) + branch-identity guard (D6).
 *
 * - A scene the user edited DURING the run (recorded source-tagged in
 *   _userEditedScenesDuringRun by dispatchAction) keeps the user's version in
 *   the merge, regardless of timestamps, and the conflict is surfaced via
 *   showTransientStatus.
 * - If the active branch changed since run start (_agentRunBranchId mismatch),
 *   the live store is NOT touched at all — no dispatch, no raw-set, no
 *   sceneHtmlVersion bump — and the user is told where the results went
 *   (main already persisted them to the run's branch).
 */

function makeScene(overrides: Partial<Record<string, unknown>> & { id: string }): Scene {
  return {
    name: 'unnamed',
    sceneType: 'react',
    duration: 5,
    sceneHTML: '', // empty → HTML write loop is skipped in jsdom
    reactCode: '',
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    messages: [],
    ...overrides,
  } as unknown as Scene
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

function makeStore(initial: Record<string, unknown>, overrides: { dispatchAction?: ReturnType<typeof vi.fn> } = {}) {
  let state: Record<string, unknown> = {
    scenes: [],
    globalStyle: makeStyle(),
    selectedSceneId: null,
    sceneHtmlVersion: 0,
    _agentRunStartedAt: 0,
    _agentRunBranchId: null,
    _userEditedScenesDuringRun: new Set<string>(),
    projectActiveBranchId: null,
    project: { id: 'proj-1' },
    dispatchAction: overrides.dispatchAction,
    sceneWriteErrors: {},
    showTransientStatus: vi.fn(),
    ...initial,
  }
  const set = vi.fn((updater: unknown) => {
    const next = typeof updater === 'function' ? (updater as (s: unknown) => Record<string, unknown>)(state) : updater
    state = { ...state, ...(next as Record<string, unknown>) }
  })
  const get = vi.fn(() => state) as unknown as () => never
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions = createAgentActions(set as any, get as any) as any
  state = { ...state, ...actions }
  return { actions, set, get: () => state }
}

beforeEach(() => {
  Object.defineProperty(window, 'dreambyteApi', { value: undefined, writable: true, configurable: true })
  window.localStorage.clear()
})

describe('source-tagged edit guard (C6)', () => {
  it('a user-edited scene keeps the USER version even with no updatedAt timestamps', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const existing = makeScene({ id: 'scene-A', name: 'A user', reactCode: 'user code' })
    const { actions, get } = makeStore(
      {
        scenes: [existing],
        _agentRunStartedAt: 1_000_000,
        _userEditedScenesDuringRun: new Set(['scene-A']),
      },
      { dispatchAction },
    )

    const agentVersion = makeScene({ id: 'scene-A', name: 'A agent', reactCode: 'agent code' })
    await actions.syncScenesFromAgent([agentVersion], makeStyle())

    const dispatched = dispatchAction.mock.calls[0][0].params.scenes
    expect(dispatched[0].name).toBe('A user')
    expect(dispatched[0].reactCode).toBe('user code')
    // Conflict surfaced, not silent (names the scene).
    const status = (get() as Record<string, unknown>).showTransientStatus as ReturnType<typeof vi.fn>
    expect(status).toHaveBeenCalledTimes(1)
    expect(String(status.mock.calls[0][0])).toContain('A user')
  })

  it('untouched scenes still take the agent version (guard is per-scene)', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const a = makeScene({ id: 'scene-A', name: 'A user', reactCode: 'user code' })
    const b = makeScene({ id: 'scene-B', name: 'B pre', reactCode: 'old' })
    const { actions } = makeStore(
      {
        scenes: [a, b],
        _agentRunStartedAt: 1_000_000,
        _userEditedScenesDuringRun: new Set(['scene-A']),
      },
      { dispatchAction },
    )

    await actions.syncScenesFromAgent(
      [
        makeScene({ id: 'scene-A', name: 'A agent', reactCode: 'agent A' }),
        makeScene({ id: 'scene-B', name: 'B agent', reactCode: 'agent B' }),
      ],
      makeStyle(),
    )

    const dispatched = dispatchAction.mock.calls[0][0].params.scenes
    expect(dispatched.find((s: Scene) => s.id === 'scene-A').reactCode).toBe('user code')
    expect(dispatched.find((s: Scene) => s.id === 'scene-B').reactCode).toBe('agent B')
  })
})

describe('branch-identity guard (D6)', () => {
  it('branch switch mid-run: live store untouched, no dispatch, user notified', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const branchBScene = makeScene({ id: 'scene-branchB', name: 'B scene', reactCode: 'branch B content' })
    const { actions, get } = makeStore(
      {
        scenes: [branchBScene], // the OTHER branch's scenes are live now
        _agentRunStartedAt: 1_000_000,
        _agentRunBranchId: 'branch-A', // run started here…
        projectActiveBranchId: 'branch-B', // …user switched here
      },
      { dispatchAction },
    )

    await actions.syncScenesFromAgent(
      [makeScene({ id: 'scene-runA', name: 'Run result', reactCode: 'run output' })],
      makeStyle(),
    )

    // No store apply of any kind.
    expect(dispatchAction).not.toHaveBeenCalled()
    const st = get() as Record<string, unknown>
    expect((st.scenes as Scene[]).map((s) => s.id)).toEqual(['scene-branchB'])
    expect(st.sceneHtmlVersion).toBe(0) // bump skipped
    // User told where the results went.
    const status = st.showTransientStatus as ReturnType<typeof vi.fn>
    expect(status).toHaveBeenCalledTimes(1)
    expect(String(status.mock.calls[0][0])).toMatch(/another branch/i)
  })

  it('same branch (both null) applies normally', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore(
      { scenes: [], _agentRunStartedAt: 1_000_000, _agentRunBranchId: null, projectActiveBranchId: null },
      { dispatchAction },
    )
    await actions.syncScenesFromAgent([makeScene({ id: 's1', name: 'S1', reactCode: 'x' })], makeStyle())
    expect(dispatchAction).toHaveBeenCalledTimes(1)
  })

  it('F7: PROJECT switch mid-run skips the merge even when branch ids match', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions, get } = makeStore(
      {
        scenes: [makeScene({ id: 'projB-scene', name: 'B' })],
        _agentRunStartedAt: 1_000_000,
        _agentRunBranchId: null, // both default…
        projectActiveBranchId: null,
        _agentRunProjectId: 'proj-A', // …but the run belongs to another project
        project: { id: 'proj-B' },
      },
      { dispatchAction },
    )
    await actions.syncScenesFromAgent([makeScene({ id: 'runA-scene', name: 'From A', reactCode: 'x' })], makeStyle())
    expect(dispatchAction).not.toHaveBeenCalled()
    expect(((get() as Record<string, unknown>).scenes as Scene[]).map((s) => s.id)).toEqual(['projB-scene'])
  })
})

describe('F5 — conflict winners are persisted, not memory-only (/review Codex P1)', () => {
  it('calls saveProjectToDb when user edits won the merge, and skips the agent HTML write for those scenes', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const writeHtml = vi.fn().mockResolvedValue(undefined)
    const getVersion = vi.fn().mockResolvedValue({ updatedAt: new Date(2_000_000) }) // fresh vs runStart 1_000_000
    Object.defineProperty(window, 'dreambyteApi', {
      value: { scene: { writeHtml }, projects: { getVersion } },
      writable: true,
      configurable: true,
    })
    const saveProjectToDb = vi.fn().mockResolvedValue(undefined)
    const userScene = makeScene({ id: 'scene-A', name: 'A user', reactCode: 'user code' })
    const { actions } = makeStore(
      {
        scenes: [userScene],
        _agentRunStartedAt: 1_000_000,
        _userEditedScenesDuringRun: new Set(['scene-A']),
        saveProjectToDb,
      },
      { dispatchAction },
    )

    await actions.syncScenesFromAgent(
      [
        makeScene({ id: 'scene-A', name: 'A agent', reactCode: 'agent', sceneHTML: '<html>agent A</html>' }),
        makeScene({ id: 'scene-B', name: 'B agent', reactCode: 'agent', sceneHTML: '<html>agent B</html>' }),
      ],
      makeStyle(),
    )

    // Conflict winners persisted to DB (main already wrote the agent versions).
    expect(saveProjectToDb).toHaveBeenCalledTimes(1)
    // The preserved scene's AGENT HTML must NOT be written over the user's file…
    const writtenIds = writeHtml.mock.calls.map((c) => c[0].id)
    expect(writtenIds).not.toContain('scene-A')
    // …while untouched scenes still get their HTML.
    expect(writtenIds).toContain('scene-B')
  })

  it('does NOT call saveProjectToDb when there are no conflicts', async () => {
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const saveProjectToDb = vi.fn().mockResolvedValue(undefined)
    const { actions } = makeStore({ scenes: [], _agentRunStartedAt: 1_000_000, saveProjectToDb }, { dispatchAction })
    await actions.syncScenesFromAgent([makeScene({ id: 's1', name: 'S1', reactCode: 'x' })], makeStyle())
    expect(saveProjectToDb).not.toHaveBeenCalled()
  })
})

describe('IT3 marker confirmation integration (/review testing gap)', () => {
  function setupIpc(updatedAt: Date | null) {
    const getVersion =
      updatedAt === null ? vi.fn().mockRejectedValue(new Error('ipc down')) : vi.fn().mockResolvedValue({ updatedAt })
    Object.defineProperty(window, 'dreambyteApi', {
      value: { projects: { getVersion } },
      writable: true,
      configurable: true,
    })
    return getVersion
  }

  it('clears the marker when the DB row is fresh (>= runStart, with tolerance)', async () => {
    setupIpc(new Date(1_000_500))
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [], _agentRunStartedAt: 1_000_000 }, { dispatchAction })
    await actions.syncScenesFromAgent([makeScene({ id: 's1', name: 'S1', reactCode: 'x' })], makeStyle())
    expect(window.localStorage.getItem('dreambyte:pendingSave:proj-1:default')).toBeNull()
  })

  it('KEEPS the marker when the DB row is stale (the crash-protection branch)', async () => {
    setupIpc(new Date(1_000_000 - 5_000)) // well before runStart, beyond tolerance
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [], _agentRunStartedAt: 1_000_000 }, { dispatchAction })
    await actions.syncScenesFromAgent([makeScene({ id: 's1', name: 'S1', reactCode: 'x' })], makeStyle())
    const raw = window.localStorage.getItem('dreambyte:pendingSave:proj-1:default')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).ts).toBe(1_000_000)
  })

  it('KEEPS the marker when the probe throws (boot reconciliation owns it)', async () => {
    setupIpc(null)
    const dispatchAction = vi.fn().mockReturnValue({ success: true })
    const { actions } = makeStore({ scenes: [], _agentRunStartedAt: 1_000_000 }, { dispatchAction })
    await actions.syncScenesFromAgent([makeScene({ id: 's1', name: 'S1', reactCode: 'x' })], makeStyle())
    expect(window.localStorage.getItem('dreambyte:pendingSave:proj-1:default')).not.toBeNull()
  })
})
