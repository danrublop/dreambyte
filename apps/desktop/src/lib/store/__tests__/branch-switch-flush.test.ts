// @vitest-environment jsdom
//
// T3 / D6 — branch-switch + conversation-switch pre-flush behavior.
//   - a pending project edit is flushed (durable) BEFORE the branch's scenes
//     load, and survives the switch round-trip;
//   - a flush FAILURE blocks the switch loudly (status='error', no scene swap);
//   - the confirm gate fires ONLY when a live agent run would be aborted.
// IPC is mocked on window.dreambyteApi.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useVideoStore } from '../index'

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const BRANCH_A = '22222222-2222-2222-2222-222222222222'
const BRANCH_B = '33333333-3333-3333-3333-333333333333'

function installIpc(
  over: {
    updateImpl?: (args: unknown) => Promise<unknown>
    loadEditorScenesImpl?: (args: unknown) => Promise<{ scenes: unknown[] }>
  } = {},
) {
  const update = vi.fn(over.updateImpl ?? (async () => ({ updatedAt: new Date().toISOString() })))
  const loadEditorScenes = vi.fn(
    over.loadEditorScenesImpl ?? (async () => ({ scenes: [{ id: 'scene-b', name: 'B', sceneType: 'react' }] })),
  )
  ;(window as unknown as { dreambyteApi: unknown }).dreambyteApi = {
    projects: { update },
    branches: {
      loadEditorScenes,
      getProposals: vi.fn(async () => ({ proposals: null })),
    },
  }
  return { update, loadEditorScenes }
}

function seedProject() {
  useVideoStore.setState({
    project: { ...useVideoStore.getState().project, id: PROJECT_ID, name: 'P', updatedAt: new Date().toISOString() },
    projectActiveBranchId: BRANCH_A,
    projectDefaultBranchId: BRANCH_A,
    scenes: [{ id: 'scene-a', name: 'A' } as never],
    branchOperation: null,
    branchSwitchNeedsConfirm: null,
    isAgentRunning: false,
    _dbLoadComplete: true,
    projectSaveStatus: 'idle',
    projectSaveError: null,
    setCenterTab: vi.fn() as never,
    resetBranchProposals: vi.fn() as never,
    loadBranchProposals: vi.fn(async () => {}) as never,
  } as never)
}

beforeEach(() => {
  seedProject()
})

describe('switchProjectBranch — pre-flush (T3 / D6)', () => {
  it('flushes the pending edit BEFORE loading scenes; pending edit survives the round-trip', async () => {
    const order: string[] = []
    const { update, loadEditorScenes } = installIpc({
      updateImpl: async (args) => {
        order.push('flush')
        // Capture what was flushed — the pending scene edit must be in it.
        const scenes = (args as { updates: { scenes: Array<{ id: string }> } }).updates.scenes
        expect(scenes.map((s) => s.id)).toContain('scene-a')
        return { updatedAt: new Date().toISOString() }
      },
      loadEditorScenesImpl: async () => {
        order.push('load')
        return { scenes: [{ id: 'scene-b', name: 'B', sceneType: 'react' }] }
      },
    })

    await useVideoStore.getState().switchProjectBranch(BRANCH_B)

    expect(update).toHaveBeenCalledTimes(1)
    expect(loadEditorScenes).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['flush', 'load']) // flush strictly before scene load
    const s = useVideoStore.getState()
    expect(s.projectActiveBranchId).toBe(BRANCH_B)
    expect(s.scenes.map((sc) => sc.id)).toEqual(['scene-b'])
    expect(s.branchOperation).toBeNull()
  })

  it('a flush FAILURE blocks the switch loudly — scenes never swap', async () => {
    const { loadEditorScenes } = installIpc({
      updateImpl: async () => {
        throw new Error('disk full')
      },
    })

    await useVideoStore.getState().switchProjectBranch(BRANCH_B)

    const s = useVideoStore.getState()
    expect(loadEditorScenes).not.toHaveBeenCalled() // never reached scene load
    expect(s.projectActiveBranchId).toBe(BRANCH_A) // unchanged
    expect(s.scenes.map((sc) => sc.id)).toEqual(['scene-a']) // unchanged
    expect(s.projectSaveStatus).toBe('error')
    expect(s.branchOperation).toBeNull()
  })

  it('confirm gate fires ONLY when a live agent run would be aborted', async () => {
    installIpc()
    useVideoStore.setState({ isAgentRunning: true, abortAgentRun: vi.fn() } as never)

    await useVideoStore.getState().switchProjectBranch(BRANCH_B)
    // Switch did NOT proceed — it parked on the confirm gate.
    let s = useVideoStore.getState()
    expect(s.branchSwitchNeedsConfirm).toEqual({ kind: 'branch', targetId: BRANCH_B })
    expect(s.projectActiveBranchId).toBe(BRANCH_A)

    // Re-invoke with confirmation → it proceeds and aborts the run.
    await useVideoStore.getState().switchProjectBranch(BRANCH_B, { confirmedAbortRun: true })
    s = useVideoStore.getState()
    expect(s.abortAgentRun).toHaveBeenCalled()
    expect(s.branchSwitchNeedsConfirm).toBeNull()
    expect(s.projectActiveBranchId).toBe(BRANCH_B)
  })

  it('no confirm gate when no run is live (silent switch)', async () => {
    installIpc()
    await useVideoStore.getState().switchProjectBranch(BRANCH_B)
    expect(useVideoStore.getState().branchSwitchNeedsConfirm).toBeNull()
    expect(useVideoStore.getState().projectActiveBranchId).toBe(BRANCH_B)
  })
})

describe('switchConversation — pre-flush (T3 / D6)', () => {
  function seedConversations() {
    useVideoStore.setState({
      conversations: [
        { id: 'c1', title: 'one' },
        { id: 'c2', title: 'two' },
      ] as never,
      activeConversationId: 'c1',
    } as never)
  }

  it('flush failure blocks the conversation switch', async () => {
    installIpc({
      updateImpl: async () => {
        throw new Error('disk full')
      },
    })
    seedConversations()
    // Dirty something so the flush actually attempts a write.
    useVideoStore.setState({ scenes: [{ id: 'scene-a', name: 'A' }] } as never)

    await useVideoStore.getState().switchConversation('c2')
    const s = useVideoStore.getState()
    expect(s.activeConversationId).toBe('c1') // never switched
    expect(s.projectSaveStatus).toBe('error')
  })

  it('confirm gate fires for a conversation switch only with a live run', async () => {
    installIpc()
    seedConversations()
    useVideoStore.setState({ isAgentRunning: true, abortAgentRun: vi.fn() } as never)

    await useVideoStore.getState().switchConversation('c2')
    expect(useVideoStore.getState().branchSwitchNeedsConfirm).toEqual({ kind: 'conversation', targetId: 'c2' })
    expect(useVideoStore.getState().activeConversationId).toBe('c1')
  })
})
