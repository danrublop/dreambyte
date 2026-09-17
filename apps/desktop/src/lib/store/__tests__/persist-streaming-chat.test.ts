// @vitest-environment jsdom
//
// Store-level test of persistStreamingChatMessage (COMMIT 7a). Covers the
// insert-then-update routing keyed on _persistedMessageIds, seq forwarding, the
// applied:false propagation from a stale-seq IPC response, and the guard paths
// (!conversationId / !ipc) that return {applied:false} with no IPC call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentActions } from '../agent-actions'

type AnyRecord = Record<string, any>

function makeHarness(overrides: AnyRecord = {}) {
  const state: AnyRecord = {
    project: { id: 'proj-1' },
    activeConversationId: 'conv-1',
    chatMessages: [{ id: 'm1', role: 'assistant', agentType: 'scene-maker', modelId: 'claude' }],
    _persistedMessageIds: new Set<string>(),
    ...overrides,
  }
  const get = () => state as any
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  const actions = createAgentActions(set as any, get as any)
  return { state, actions }
}

describe('persistStreamingChatMessage (COMMIT 7a)', () => {
  const addMessage = vi.fn(async (_args: AnyRecord) => ({}))
  const updateMessage = vi.fn(async (_args: AnyRecord) => ({ success: true, applied: true }))

  beforeEach(() => {
    addMessage.mockClear()
    updateMessage.mockClear()
    updateMessage.mockResolvedValue({ success: true, applied: true } as any)
    ;(globalThis as any).window.dreambyteApi = {
      conversations: { addMessage, updateMessage },
    }
  })
  afterEach(() => {
    delete (globalThis as any).window.dreambyteApi
  })

  it('first call with an unknown messageId takes addMessage and records the id', async () => {
    const { state, actions } = makeHarness()
    const res = await actions.persistStreamingChatMessage({
      messageId: 'm1',
      runId: 'run-1',
      seq: 0,
      content: 'partial',
    })
    expect(addMessage).toHaveBeenCalledTimes(1)
    expect(updateMessage).not.toHaveBeenCalled()
    expect(addMessage.mock.calls[0][0]).toMatchObject({
      id: 'm1',
      seq: 0,
      conversationId: 'conv-1',
      projectId: 'proj-1',
    })
    expect(res).toEqual({ applied: true })
    expect(state._persistedMessageIds.has('m1')).toBe(true)
  })

  it('second call takes updateMessage and forwards the seq', async () => {
    const { actions } = makeHarness({ _persistedMessageIds: new Set(['m1']) })
    const res = await actions.persistStreamingChatMessage({
      messageId: 'm1',
      runId: 'run-1',
      seq: 5,
      content: 'newer',
    })
    expect(updateMessage).toHaveBeenCalledTimes(1)
    expect(addMessage).not.toHaveBeenCalled()
    expect(updateMessage.mock.calls[0][0]).toMatchObject({ messageId: 'm1', seq: 5, conversationId: 'conv-1' })
    expect(res).toEqual({ applied: true })
  })

  it('propagates applied:false from a stale-seq IPC response', async () => {
    updateMessage.mockResolvedValueOnce({ success: true, applied: false } as any)
    const { actions } = makeHarness({ _persistedMessageIds: new Set(['m1']) })
    const res = await actions.persistStreamingChatMessage({
      messageId: 'm1',
      runId: 'run-1',
      seq: 1,
      content: 'stale',
    })
    expect(res).toEqual({ applied: false })
  })

  it('returns {applied:false} with no IPC call when there is no active conversation', async () => {
    const { actions } = makeHarness({ activeConversationId: null })
    const res = await actions.persistStreamingChatMessage({ messageId: 'm1', runId: null, seq: 0, content: 'x' })
    expect(res).toEqual({ applied: false })
    expect(addMessage).not.toHaveBeenCalled()
    expect(updateMessage).not.toHaveBeenCalled()
  })

  it('returns {applied:false} with no IPC call when the conversations IPC is unavailable', async () => {
    delete (globalThis as any).window.dreambyteApi
    const { actions } = makeHarness()
    const res = await actions.persistStreamingChatMessage({ messageId: 'm1', runId: null, seq: 0, content: 'x' })
    expect(res).toEqual({ applied: false })
  })

  it('falls back to applied:true when an older main omits the applied field', async () => {
    updateMessage.mockResolvedValueOnce({ success: true } as any)
    const { actions } = makeHarness({ _persistedMessageIds: new Set(['m1']) })
    const res = await actions.persistStreamingChatMessage({ messageId: 'm1', runId: null, seq: 2, content: 'x' })
    expect(res).toEqual({ applied: true })
  })
})
