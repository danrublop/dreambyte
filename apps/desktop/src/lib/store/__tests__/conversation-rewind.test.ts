import { describe, it, expect, vi } from 'vitest'
import { planRewind, truncateConversationAfter, RewindError, type RewindDeps } from '../conversation-rewind'
import type { ChatMessage } from '../../agents/types'

function msg(id: string, role: 'user' | 'assistant', content = id): ChatMessage {
  return { id, role, content, timestamp: 0 }
}

const sample = (): ChatMessage[] => [
  msg('u1', 'user'),
  msg('a1', 'assistant'),
  msg('u2', 'user'),
  msg('a2', 'assistant'),
]

describe('planRewind (pure)', () => {
  it('keeps everything up to and including the anchor', () => {
    const plan = planRewind(sample(), 'u2')
    expect(plan).not.toBeNull()
    expect(plan!.kept.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(plan!.anchorIndex).toBe(2)
  })

  it('swaps the anchor content when newContent is given (edit case)', () => {
    const plan = planRewind(sample(), 'u2', { newContent: 'edited' })
    expect(plan!.kept.map((m) => m.content)).toEqual(['u1', 'a1', 'edited'])
  })

  it('prefers newStoreContent (rich, image-preserving) over newContent (S7)', () => {
    const rich = [
      { type: 'text' as const, text: 'edited' },
      { type: 'image' as const, image: { dataUri: 'data:image/png;base64,x', mimeType: 'image/png' as const } },
    ]
    const plan = planRewind(sample(), 'u2', { newContent: 'edited', newStoreContent: rich })
    expect(plan!.kept[2].content).toEqual(rich)
  })

  it('returns null for an unknown id (zero mutation signal)', () => {
    expect(planRewind(sample(), 'nope')).toBeNull()
  })

  it('keeping the last message is a no-op tail-delete', () => {
    const plan = planRewind(sample(), 'a2')
    expect(plan!.kept.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})

function makeDeps(over: Partial<RewindDeps> & { messages?: ChatMessage[] } = {}) {
  const messages = over.messages ?? sample()
  const setMessages = vi.fn<(m: ChatMessage[]) => void>()
  const deleteMessagesAfter = vi
    .fn<RewindDeps['deleteMessagesAfter']>()
    .mockResolvedValue({ found: true, remaining: [] })
  const deps: RewindDeps = {
    getMessages: () => messages,
    getConversationId: () => 'conv-1',
    isGenerating: () => false,
    deleteMessagesAfter,
    setMessages,
    ...over,
  }
  return { deps, setMessages, deleteMessagesAfter }
}

describe('truncateConversationAfter (orchestrator)', () => {
  it('deletes in the DB FIRST, then splices the store in lockstep', async () => {
    const { deps, setMessages, deleteMessagesAfter } = makeDeps()
    const kept = await truncateConversationAfter(deps, 'a1')
    expect(deleteMessagesAfter).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'a1',
      newContent: undefined,
    })
    expect(setMessages).toHaveBeenCalledTimes(1)
    expect(setMessages.mock.calls[0][0].map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(kept.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('threads newContent through to the DB and the splice (edit case)', async () => {
    const { deps, setMessages, deleteMessagesAfter } = makeDeps()
    await truncateConversationAfter(deps, 'u2', { newContent: 'edited' })
    expect(deleteMessagesAfter).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'u2',
      newContent: 'edited',
    })
    expect(setMessages.mock.calls[0][0].map((m) => m.content)).toEqual(['u1', 'a1', 'edited'])
  })

  it('refuses while generating — RewindError, zero DB call, zero splice', async () => {
    const { deps, setMessages, deleteMessagesAfter } = makeDeps({ isGenerating: () => true })
    await expect(truncateConversationAfter(deps, 'a1')).rejects.toMatchObject({
      name: 'RewindError',
      reason: 'generating',
    })
    expect(deleteMessagesAfter).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('unknown msgId — RewindError before any DB call, zero splice', async () => {
    const { deps, setMessages, deleteMessagesAfter } = makeDeps()
    await expect(truncateConversationAfter(deps, 'ghost')).rejects.toBeInstanceOf(RewindError)
    expect(deleteMessagesAfter).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('DB failure ⇒ store NOT spliced, error surfaced (atomicity)', async () => {
    const { deps, setMessages } = makeDeps({
      deleteMessagesAfter: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    await expect(truncateConversationAfter(deps, 'a1')).rejects.toMatchObject({
      name: 'RewindError',
      reason: 'db-failed',
    })
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('DB reports found:false ⇒ refuse with zero splice', async () => {
    const { deps, setMessages } = makeDeps({
      deleteMessagesAfter: vi.fn().mockResolvedValue({ found: false, remaining: [] }),
    })
    await expect(truncateConversationAfter(deps, 'a1')).rejects.toMatchObject({
      reason: 'unknown-message',
    })
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('no active conversation ⇒ RewindError, zero DB call', async () => {
    const { deps, deleteMessagesAfter } = makeDeps({ getConversationId: () => null })
    await expect(truncateConversationAfter(deps, 'a1')).rejects.toMatchObject({
      reason: 'no-conversation',
    })
    expect(deleteMessagesAfter).not.toHaveBeenCalled()
  })
})
