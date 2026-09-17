// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useVideoStore } from '../index'

/**
 * saveProjectToDb stale-capture guard (v0.6.0.0 follow-up).
 *
 * The stripped-localStorage path awaits ipc.getVersion BEFORE building the
 * update payload. State mutated during that round-trip (agent stream sync,
 * user edit) must reach the write — the top-of-function snapshot exists for
 * the pull-from-DB guards only. And if the ACTIVE PROJECT switches during the
 * await, the save must bail entirely: loadProject pre-saves the outgoing
 * project itself, and mixing the old row id with the new project's state
 * would cross-write projects.
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222'

function makeProject(id: string) {
  return {
    id,
    name: 'Freshness Test',
    outputMode: 'mp4',
    updatedAt: new Date().toISOString(),
  } as never
}

function makeScene(id: string) {
  return {
    id,
    name: 'late',
    sceneType: 'react' as const,
    duration: 5,
    sceneHTML: '',
    reactCode: '',
    svgContent: '',
    canvasCode: '',
    sceneCode: '',
    lottieSource: '',
    messages: [],
  } as never
}

type ProjectsIpcStub = {
  getVersion: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
}

function installIpc(overrides: Partial<ProjectsIpcStub> = {}): ProjectsIpcStub {
  const stub: ProjectsIpcStub = {
    getVersion: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString() }),
    create: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
  ;(window as never as Record<string, unknown>).dreambyteApi = { projects: stub }
  return stub
}

beforeEach(() => {
  window.localStorage.clear()
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

describe('saveProjectToDb write freshness', () => {
  it('includes scenes added during the getVersion await in the update payload', async () => {
    let resolveVersion!: (v: null) => void
    const ipc = installIpc({
      getVersion: vi.fn().mockImplementation(() => new Promise((r) => (resolveVersion = r))),
    })

    const save = useVideoStore.getState().saveProjectToDb()
    // The save is now parked on getVersion (scenes were empty → !localRich path).
    // A scene lands in the store mid-flight — e.g. an agent stream sync.
    useVideoStore.setState({ scenes: [makeScene('late-scene')] } as never)
    resolveVersion(null) // no DB snapshot → pull-guards skipped, write proceeds
    await save

    expect(ipc.update).toHaveBeenCalledTimes(1)
    const payload = ipc.update.mock.calls[0][0] as { projectId: string; updates: { scenes: Array<{ id: string }> } }
    expect(payload.projectId).toBe(PROJECT_ID)
    expect(payload.updates.scenes.map((s) => s.id)).toContain('late-scene')
  })

  it('bails without writing when the active project switches during the await, resetting save status', async () => {
    let resolveVersion!: (v: null) => void
    const ipc = installIpc({
      getVersion: vi.fn().mockImplementation(() => new Promise((r) => (resolveVersion = r))),
    })

    const save = useVideoStore.getState().saveProjectToDb()
    // Project switch mid-flight (loadProject replaced the active project).
    useVideoStore.setState({ project: makeProject(OTHER_PROJECT_ID) } as never)
    resolveVersion(null)
    await save

    expect(ipc.update).not.toHaveBeenCalled()
    expect(ipc.create).not.toHaveBeenCalled()
    // The bail must not strand the 'saving' claim it made pre-await.
    expect(useVideoStore.getState().projectSaveStatus).toBe('idle')
  })

  it('bails without writing when the active BRANCH switches during the await', async () => {
    let resolveVersion!: (v: null) => void
    const ipc = installIpc({
      getVersion: vi.fn().mockImplementation(() => new Promise((r) => (resolveVersion = r))),
    })
    useVideoStore.setState({ projectActiveBranchId: 'branch-A' } as never)

    const save = useVideoStore.getState().saveProjectToDb()
    // Branch switch mid-flight — the version-CAS is project-scoped, so a save
    // started on branch A must not route its write to branch B.
    useVideoStore.setState({ projectActiveBranchId: 'branch-B' } as never)
    resolveVersion(null)
    await save

    expect(ipc.update).not.toHaveBeenCalled()
    expect(useVideoStore.getState().projectSaveStatus).toBe('idle')
  })

  it('writes fresh scenes when getVersion returns a non-blocking snapshot (dbVer-truthy proceed path)', async () => {
    let resolveVersion!: (v: unknown) => void
    const ipc = installIpc({
      getVersion: vi.fn().mockImplementation(() => new Promise((r) => (resolveVersion = r))),
    })

    const save = useVideoStore.getState().saveProjectToDb()
    useVideoStore.setState({ scenes: [makeScene('late-scene')] } as never)
    // Older DB snapshot with no rich content — none of the pull-guards fire.
    resolveVersion({
      version: 1,
      updatedAt: new Date(Date.now() - 60_000),
      sceneCount: 0,
      hasRichContent: false,
    })
    await save

    expect(ipc.update).toHaveBeenCalledTimes(1)
    const payload = ipc.update.mock.calls[0][0] as { updates: { scenes: Array<{ id: string }> } }
    expect(payload.updates.scenes.map((s) => s.id)).toContain('late-scene')
  })

  it('clears the crash marker under the SAME branch key it was set with, even if the branch switches mid-update', async () => {
    let resolveUpdate!: (v: unknown) => void
    const ipc = installIpc({
      update: vi.fn().mockImplementation(() => new Promise((r) => (resolveUpdate = r))),
    })
    useVideoStore.setState({ projectActiveBranchId: 'branch-A' } as never)

    const save = useVideoStore.getState().saveProjectToDb()
    // While ipc.update is in flight, the user switches branches. The marker was
    // set under branch-A's key — the clear must target branch-A too, not the
    // freshly-read branch-B (which would orphan the marker and fire a false
    // "work may be missing" at next boot).
    await vi.waitFor(() => expect(ipc.update).toHaveBeenCalledTimes(1))
    useVideoStore.setState({ projectActiveBranchId: 'branch-B' } as never)
    resolveUpdate({ updatedAt: new Date().toISOString() })
    await save

    const markerKeys = Object.keys(window.localStorage).filter((k) => k.includes('pendingSave'))
    expect(markerKeys).toEqual([])
  })

  it('rich local content skips the getVersion round-trip entirely (no stale window)', async () => {
    const ipc = installIpc()
    useVideoStore.setState({
      scenes: [{ ...(makeScene('rich') as object), sceneHTML: '<div>real content</div>' }],
    } as never)

    await useVideoStore.getState().saveProjectToDb()

    expect(ipc.getVersion).not.toHaveBeenCalled()
    expect(ipc.update).toHaveBeenCalledTimes(1)
  })
})
