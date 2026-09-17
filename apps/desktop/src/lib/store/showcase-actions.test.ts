/**
 * Showcase mode: snapshot/restore lifecycle + the persistence fence.
 *
 * The fence assertions are the eng-review 1A acceptance test: while
 * showcaseMode is on, ZERO conversations-IPC writes occur — asserted at the
 * same layer the guards live (persistUserMessage / persistChatMessage /
 * persistStreamingChatMessage). R1 asserts the inverse: normal (non-showcase)
 * persistence is byte-for-byte unaffected by the guard's existence.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createShowcaseActions } from './showcase-actions'
import { createAgentActions } from './agent-actions'
import type { ChatMessage } from '../agents/types'

// ── Harness (spend-approval.test.ts pattern: minimal set/get over a plain object) ──

type AnyState = Record<string, any>

function harness(initial: AnyState = {}) {
  let state: AnyState = {
    // atoms the showcase swaps
    chatMessages: [],
    pendingPlan: null,
    planTodos: [],
    planAwaitingApproval: false,
    structuralCutsProposed: null,
    // persistence preconditions
    project: { id: 'proj-1' },
    activeConversationId: 'conv-1',
    _persistedMessageIds: new Set<string>(),
    // run state
    isGenerating: false,
    isAgentRunning: false,
    conversations: [],
    ...initial,
  }
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function' ? (updater as (s: AnyState) => object)(state) : updater
    state = { ...state, ...(patch as object) }
  }
  const get = () => state
  Object.assign(state, createShowcaseActions(set as never, get as never))
  Object.assign(state, createAgentActions(set as never, get as never))
  return { get: () => state, set }
}

/** Spy-able conversations IPC mounted on window (jsdom). */
function mockConversationsIpc() {
  const addMessage = vi.fn().mockResolvedValue({ ok: true })
  const updateMessage = vi.fn().mockResolvedValue({ applied: true })
  ;(window as any).dreambyteApi = { conversations: { addMessage, updateMessage } }
  return { addMessage, updateMessage }
}

const realMsg = (id: string, role: 'user' | 'assistant' = 'user'): ChatMessage => ({
  id,
  role,
  content: `real message ${id}`,
  timestamp: 1,
})

beforeEach(() => {
  delete (window as any).dreambyteApi
  vi.restoreAllMocks()
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('enterShowcase / exitShowcase lifecycle', () => {
  it('enter snapshots the card atoms, injects fixtures, sets the flag', () => {
    const h = harness({
      chatMessages: [realMsg('m1')],
      planTodos: [{ id: 't1', text: 'real todo', status: 'pending' }],
      planAwaitingApproval: false,
    })
    h.get().enterShowcase()
    const s = h.get()
    expect(s.showcaseMode).toBe(true)
    expect(s._showcaseSnapshot?.chatMessages).toEqual([realMsg('m1')])
    expect(s.chatMessages.length).toBeGreaterThan(5)
    expect(s.chatMessages.every((m: ChatMessage) => m.id.startsWith('showcase-'))).toBe(true)
    expect(s.pendingPlan).not.toBeNull()
    expect(s.planAwaitingApproval).toBe(true)
    expect(s.structuralCutsProposed?.length).toBeGreaterThan(0)
  })

  it('exit restores the exact pre-showcase state (reference-identical arrays)', () => {
    const real = [realMsg('m1'), realMsg('m2', 'assistant')]
    const h = harness({ chatMessages: real, planAwaitingApproval: false })
    h.get().enterShowcase()
    h.get().exitShowcase()
    const s = h.get()
    expect(s.showcaseMode).toBe(false)
    expect(s._showcaseSnapshot).toBeNull()
    expect(s.chatMessages).toBe(real) // same reference — untouched, not a copy
    expect(s.pendingPlan).toBeNull()
    expect(s.planAwaitingApproval).toBe(false)
    expect(s.structuralCutsProposed).toBeNull()
  })

  it('double-enter is idempotent — never re-snapshots the fixture as real', () => {
    const real = [realMsg('m1')]
    const h = harness({ chatMessages: real })
    h.get().enterShowcase()
    h.get().enterShowcase() // second enter must be a no-op
    expect(h.get()._showcaseSnapshot?.chatMessages).toBe(real)
    h.get().exitShowcase()
    expect(h.get().chatMessages).toBe(real)
  })

  it('exit-without-enter is a no-op', () => {
    const real = [realMsg('m1')]
    const h = harness({ chatMessages: real })
    h.get().exitShowcase()
    expect(h.get().chatMessages).toBe(real)
    expect(h.get().showcaseMode).toBe(false)
  })

  it('refuses to enter while a run is generating', () => {
    const h = harness({ isGenerating: true, chatMessages: [realMsg('m1')] })
    h.get().enterShowcase()
    expect(h.get().showcaseMode).toBe(false)
    expect(h.get().chatMessages).toEqual([realMsg('m1')])
  })
})

// ── Auto-exit on switch (D9: fixtures never bleed) ──────────────────────────

describe('auto-exit on conversation switch', () => {
  it('switchConversation exits showcase BEFORE any switch logic', async () => {
    const exitSpy = vi.fn()
    const h = harness()
    // Set AFTER harness assembly — the slice's defaults would overwrite these.
    h.set({ showcaseMode: true, exitShowcase: exitSpy })
    // Unknown conversation id → switch itself bails at validation, but the
    // showcase exit must already have run (guard is first).
    await h.get().switchConversation('not-a-real-conversation')
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('switchConversation leaves showcase alone when not active', async () => {
    const exitSpy = vi.fn()
    const h = harness()
    h.set({ showcaseMode: false, exitShowcase: exitSpy })
    await h.get().switchConversation('not-a-real-conversation')
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

// ── The fence: zero IPC writes while showcase is active (1A acceptance) ─────

describe('persistence fence while showcaseMode', () => {
  it('persistUserMessage / persistChatMessage / persistStreamingChatMessage never touch IPC', async () => {
    const ipc = mockConversationsIpc()
    const h = harness({ chatMessages: [realMsg('m1')] })
    h.get().enterShowcase()

    await h.get().persistUserMessage(realMsg('u-new'))
    await h.get().persistChatMessage('showcase-msg-2')
    const res = await h.get().persistStreamingChatMessage({
      messageId: 'showcase-msg-2',
      runId: 'run-1',
      seq: 1,
      content: 'partial',
    })

    expect(ipc.addMessage).not.toHaveBeenCalled()
    expect(ipc.updateMessage).not.toHaveBeenCalled()
    expect(res).toEqual({ applied: false })
  })
})

// ── R1 regression: normal persistence is unchanged (iron rule) ──────────────

describe('R1: non-showcase persistence unchanged', () => {
  it('persistUserMessage inserts with the same payload as before the guard', async () => {
    const ipc = mockConversationsIpc()
    const h = harness()
    await h.get().persistUserMessage(realMsg('u1'))
    expect(ipc.addMessage).toHaveBeenCalledTimes(1)
    expect(ipc.addMessage).toHaveBeenCalledWith({
      id: 'u1',
      conversationId: 'conv-1',
      projectId: 'proj-1',
      role: 'user',
      content: 'real message u1',
    })
    expect(h.get()._persistedMessageIds.has('u1')).toBe(true)
  })

  it('persistChatMessage INSERTs first, UPDATEs after', async () => {
    const ipc = mockConversationsIpc()
    const h = harness({ chatMessages: [realMsg('a1', 'assistant')] })
    await h.get().persistChatMessage('a1')
    expect(ipc.addMessage).toHaveBeenCalledTimes(1)
    await h.get().persistChatMessage('a1')
    expect(ipc.updateMessage).toHaveBeenCalledTimes(1)
  })

  it('persistStreamingChatMessage propagates the seq-gate verdict', async () => {
    const ipc = mockConversationsIpc()
    const h = harness({
      chatMessages: [realMsg('a1', 'assistant')],
      _persistedMessageIds: new Set(['a1']),
    })
    ipc.updateMessage.mockResolvedValueOnce({ applied: false })
    const res = await h.get().persistStreamingChatMessage({
      messageId: 'a1',
      runId: 'run-1',
      seq: 3,
      content: 'partial',
    })
    expect(res).toEqual({ applied: false })
    expect(ipc.updateMessage).toHaveBeenCalledTimes(1)
  })

  it('fence lifts after exitShowcase — persistence resumes', async () => {
    const ipc = mockConversationsIpc()
    const h = harness({ chatMessages: [realMsg('m1')] })
    h.get().enterShowcase()
    await h.get().persistUserMessage(realMsg('u-blocked'))
    expect(ipc.addMessage).not.toHaveBeenCalled()
    h.get().exitShowcase()
    await h.get().persistUserMessage(realMsg('u-allowed'))
    expect(ipc.addMessage).toHaveBeenCalledTimes(1)
  })
})
