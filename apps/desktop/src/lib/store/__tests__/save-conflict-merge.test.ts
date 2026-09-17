// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useVideoStore } from '../index'
import { resetSceneBaseline } from '../project-actions'

/**
 * Item 8a (decision D1/A) — per-scene reconciliation in saveProjectToDb's
 * 409-conflict retry. The old retry substituted the DB scene array WHOLESALE
 * (agent-wins), displacing the local edit that triggered the save while the
 * status claimed 'saved'. With a baseline (set by the previous successful
 * save), the retry now 3-way-merges per scene: dirty local scenes keep their
 * slot, untouched ones take the remote (agent) version, and the store
 * converges onto the merged result when no newer edit landed mid-save.
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'

function makeProject(id: string) {
  return { id, name: 'Merge Test', outputMode: 'mp4', updatedAt: new Date().toISOString() } as never
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

beforeEach(() => {
  window.localStorage.clear()
  resetSceneBaseline() // module state must not leak between tests
  useVideoStore.setState({
    project: makeProject(PROJECT_ID),
    scenes: [],
    _dbLoadComplete: true,
    _isDirty: false,
    projectActiveBranchId: null,
    projectSaveStatus: 'idle',
    projectSaveError: null,
  } as never)
})

afterEach(() => {
  delete (window as never as Record<string, unknown>).dreambyteApi
  vi.restoreAllMocks()
})

describe('saveProjectToDb conflict retry — per-scene merge (item 8a)', () => {
  it('keeps the dirty local edit AND the agent-edited scene in one retried write, then converges the store', async () => {
    const sceneA0 = makeScene('a', 'A0')
    const sceneB0 = makeScene('b', 'B0')

    let updateCalls = 0
    const updatePayloads: Array<{ scenes: Array<{ id: string; reactCode: string }> }> = []
    const remoteScenes = [makeScene('a', 'A0'), makeScene('b', 'B-agent')] // agent edited b
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: remoteScenes }),
        update: vi.fn(async (args: { updates: { scenes: never[] } }) => {
          updateCalls += 1
          updatePayloads.push(args.updates as never)
          // Save 1 (baseline-setter) succeeds; save 2's FIRST attempt
          // conflicts; its retry succeeds.
          if (updateCalls === 2) throw new Error('Project was modified concurrently — retry')
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }

    // Save 1: establishes the baseline (a=A0, b=B0 are the agreed state).
    useVideoStore.setState({ scenes: [sceneA0, sceneB0] } as never)
    await useVideoStore.getState().saveProjectToDb()
    expect(updateCalls).toBe(1)

    // The user edits scene a; the agent (remote) edited scene b meanwhile.
    useVideoStore.setState({ scenes: [makeScene('a', 'A-user'), sceneB0] } as never)
    await useVideoStore.getState().saveProjectToDb()

    expect(updateCalls).toBe(3) // save1, conflicted attempt, merged retry
    const retried = updatePayloads[2].scenes
    expect(retried.map((s) => [s.id, s.reactCode])).toEqual([
      ['a', 'A-user'], // the dirty local edit was NOT displaced
      ['b', 'B-agent'], // the agent's edit was NOT clobbered
    ])
    // Store converged onto the merged result (no newer edit landed mid-save).
    const stored = useVideoStore.getState().scenes as Array<{ id: string; reactCode: string }>
    expect(stored.map((s) => [s.id, s.reactCode])).toEqual([
      ['a', 'A-user'],
      ['b', 'B-agent'],
    ])
    expect(useVideoStore.getState().projectSaveStatus).toBe('saved')
  })

  it('skips store convergence when a NEWER edit landed mid-save (reference guard)', async () => {
    let updateCalls = 0
    let releaseRetry!: (v: Record<string, unknown>) => void
    const remoteScenes = [makeScene('a', 'A0'), makeScene('b', 'B-agent')]
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: remoteScenes }),
        update: vi.fn(async () => {
          updateCalls += 1
          if (updateCalls === 2) throw new Error('Project was modified concurrently — retry')
          if (updateCalls === 3) return new Promise<Record<string, unknown>>((r) => (releaseRetry = r)) // retry hangs
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }
    // Save 1: baseline.
    useVideoStore.setState({ scenes: [makeScene('a', 'A0'), makeScene('b', 'B0')] } as never)
    await useVideoStore.getState().saveProjectToDb()
    // Save 2 (will conflict + merge); while its retried write hangs, the user
    // edits again — convergence must NOT clobber the newer edit.
    useVideoStore.setState({ scenes: [makeScene('a', 'A-user'), makeScene('b', 'B0')] } as never)
    const save2 = useVideoStore.getState().saveProjectToDb()
    await vi.waitFor(() => expect(updateCalls).toBe(3))
    const newerEdit = [makeScene('a', 'A-user-NEWER'), makeScene('b', 'B0')]
    useVideoStore.setState({ scenes: newerEdit } as never)
    releaseRetry({ updatedAt: new Date().toISOString() })
    await save2
    // The store kept the newer edit; the merged array was NOT forced over it.
    const stored = useVideoStore.getState().scenes as Array<{ id: string; reactCode: string }>
    expect(stored.map((x) => x.reactCode)).toEqual(['A-user-NEWER', 'B0'])
  })

  it('re-points selectedSceneId when the merge drops the selected scene (honored remote delete)', async () => {
    let updateCalls = 0
    // Agent deleted scene x (clean locally) — the merge honors the delete.
    const remoteScenes = [makeScene('a', 'A0')]
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: remoteScenes }),
        update: vi.fn(async () => {
          updateCalls += 1
          if (updateCalls === 2) throw new Error('Project was modified concurrently — retry')
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }
    useVideoStore.setState({ scenes: [makeScene('a', 'A0'), makeScene('x', 'X0')] } as never)
    await useVideoStore.getState().saveProjectToDb() // baseline
    useVideoStore.setState({ selectedSceneId: 'x' } as never)
    await useVideoStore.getState().saveProjectToDb() // conflict → x dropped by the merge
    const st = useVideoStore.getState()
    expect((st.scenes as Array<{ id: string }>).map((s) => s.id)).toEqual(['a'])
    expect(st.selectedSceneId).toBe('a') // re-pointed, not dangling
  })

  it('the retry re-fetch is branch-aware: ipc.get receives the branch the save WRITES to', async () => {
    let updateCalls = 0
    const remoteScenes = [makeScene('a', 'A0'), makeScene('b', 'B-agent')]
    const getMock = vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: remoteScenes })
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: getMock,
        update: vi.fn(async () => {
          updateCalls += 1
          if (updateCalls === 2) throw new Error('Project was modified concurrently — retry')
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }
    const BRANCH_ID = '22222222-2222-4222-8222-222222222222'
    useVideoStore.setState({
      projectActiveBranchId: BRANCH_ID,
      scenes: [makeScene('a', 'A0'), makeScene('b', 'B0')],
    } as never)
    await useVideoStore.getState().saveProjectToDb() // baseline (no conflict)
    useVideoStore.setState({ scenes: [makeScene('a', 'A-user'), makeScene('b', 'B0')] } as never)
    await useVideoStore.getState().saveProjectToDb() // conflict → branch-scoped re-fetch
    // #156 latent finding: the no-arg form returns DEFAULT-branch scenes — a
    // different document than the one this save writes (BRANCH_ID).
    expect(getMock).toHaveBeenCalledWith(PROJECT_ID, BRANCH_ID)
    // …and on the default branch (null) it stays the historical no-branch form.
    expect(getMock).not.toHaveBeenCalledWith(PROJECT_ID, null)
  })

  it('the retry re-fetch passes NO branch when the editor is on the default branch (null)', async () => {
    let updateCalls = 0
    const getMock = vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: [makeScene('a', 'A-agent')] })
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: getMock,
        update: vi.fn(async () => {
          updateCalls += 1
          if (updateCalls === 1) throw new Error('Project was modified concurrently — retry')
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }
    useVideoStore.setState({ scenes: [makeScene('a', 'A-user')] } as never) // projectActiveBranchId: null (beforeEach)
    await useVideoStore.getState().saveProjectToDb()
    expect(getMock).toHaveBeenCalledWith(PROJECT_ID, undefined)
  })

  it('without a baseline (no prior agreed state) the retry degrades to the old agent-wins substitution', async () => {
    let updateCalls = 0
    const updatePayloads: Array<{ scenes: Array<{ id: string; reactCode: string }> }> = []
    const remoteScenes = [makeScene('a', 'A-agent')]
    ;(window as never as Record<string, unknown>).dreambyteApi = {
      projects: {
        getVersion: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString(), scenes: remoteScenes }),
        update: vi.fn(async (args: { updates: { scenes: never[] } }) => {
          updateCalls += 1
          updatePayloads.push(args.updates as never)
          if (updateCalls === 1) throw new Error('Project was modified concurrently — retry')
          return { updatedAt: new Date().toISOString() }
        }),
      },
    }
    // Use a DIFFERENT project id than any earlier test set a baseline for —
    // the baseline key (project+branch) must mismatch.
    const freshProject = '33333333-3333-4333-8333-333333333333'
    useVideoStore.setState({
      project: makeProject(freshProject),
      scenes: [makeScene('a', 'A-user')],
    } as never)
    await useVideoStore.getState().saveProjectToDb()

    expect(updateCalls).toBe(2)
    // Old behavior preserved: remote substituted wholesale.
    expect(updatePayloads[1].scenes.map((s) => [s.id, s.reactCode])).toEqual([['a', 'A-agent']])
  })
})
