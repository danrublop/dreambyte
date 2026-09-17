// @vitest-environment jsdom

/**
 * Review #166 — refreshProjectFromServer's branch-aware fetch.
 *
 * Pins:
 *  - the 30s poll fetches the ACTIVE branch's scenes (#156 latent finding —
 *    the no-arg form returns DEFAULT-branch scenes, which swaps the visible
 *    document on a non-default branch AND poisons the per-scene baseline,
 *    keyed by the active branch but filled with main's hashes);
 *  - null active branch stays the historical no-branch form;
 *  - a branch switch completing while the fetch is in flight DISCARDS the
 *    result (post-await guard — every sibling DB→store path has one);
 *  - an empty branch-scoped read does not wipe unsaved local scenes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useVideoStore } from '../index'
import { resetSceneBaseline } from '../project-actions'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const BRANCH_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_BRANCH = '33333333-3333-4333-8333-333333333333'

function makeProject(id: string) {
  return { id, name: 'Refresh Test', outputMode: 'mp4', updatedAt: new Date().toISOString() } as never
}

function makeScene(id: string, reactCode: string) {
  return {
    id,
    name: id,
    sceneType: 'react' as const,
    duration: 5,
    sceneHTML: '',
    reactCode,
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    messages: [],
  } as never
}

function remotePayload(scenes: unknown[]) {
  return {
    id: PROJECT_ID,
    name: 'Refresh Test',
    outputMode: 'mp4',
    updatedAt: new Date().toISOString(),
    scenes,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  resetSceneBaseline()
  useVideoStore.setState({
    project: makeProject(PROJECT_ID),
    scenes: [],
    _dbLoadComplete: true,
    _isDirty: false,
    projectActiveBranchId: null,
    selectedSceneId: null,
  } as never)
})

afterEach(() => {
  delete (window as never as Record<string, unknown>).dreambyteApi
  vi.restoreAllMocks()
})

describe('refreshProjectFromServer — branch scoping (review #166)', () => {
  it('fetches the ACTIVE branch when one is set', async () => {
    const getMock = vi.fn().mockResolvedValue(remotePayload([makeScene('a', 'A0')]))
    ;(window as never as Record<string, unknown>).dreambyteApi = { projects: { get: getMock } }
    useVideoStore.setState({ projectActiveBranchId: BRANCH_ID } as never)
    await useVideoStore.getState().refreshProjectFromServer()
    expect(getMock).toHaveBeenCalledWith(PROJECT_ID, BRANCH_ID)
    expect((useVideoStore.getState().scenes as Array<{ id: string }>).map((s) => s.id)).toEqual(['a'])
  })

  it('passes NO branch on the default branch (null → undefined)', async () => {
    const getMock = vi.fn().mockResolvedValue(remotePayload([]))
    ;(window as never as Record<string, unknown>).dreambyteApi = { projects: { get: getMock } }
    await useVideoStore.getState().refreshProjectFromServer()
    expect(getMock).toHaveBeenCalledWith(PROJECT_ID, undefined)
  })

  it('discards the fetch when the active branch changed mid-flight (post-await guard)', async () => {
    let release!: (v: unknown) => void
    const getMock = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    ;(window as never as Record<string, unknown>).dreambyteApi = { projects: { get: getMock } }
    const localScenes = [makeScene('local', 'L0')]
    useVideoStore.setState({ projectActiveBranchId: BRANCH_ID, scenes: localScenes } as never)
    const refresh = useVideoStore.getState().refreshProjectFromServer()
    // The user switches branches while the IPC is in flight.
    useVideoStore.setState({ projectActiveBranchId: OTHER_BRANCH } as never)
    release(remotePayload([makeScene('stale', 'FROM-OLD-BRANCH')]))
    await refresh
    // The stale branch's scenes were NOT written into the new branch's store.
    expect(useVideoStore.getState().scenes).toBe(localScenes)
  })

  it('does not wipe unsaved local scenes when the branch read returns empty', async () => {
    const getMock = vi.fn().mockResolvedValue(remotePayload([]))
    ;(window as never as Record<string, unknown>).dreambyteApi = { projects: { get: getMock } }
    const localScenes = [makeScene('unsaved', 'U0')]
    useVideoStore.setState({ projectActiveBranchId: BRANCH_ID, scenes: localScenes, _isDirty: true } as never)
    await useVideoStore.getState().refreshProjectFromServer()
    expect(useVideoStore.getState().scenes).toBe(localScenes) // skipped, not blanked
  })
})
