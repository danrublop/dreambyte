import { describe, it, expect } from 'vitest'
import {
  filterConversations,
  sortConversations,
  visibleConversations,
  type ListableConversation,
} from '../conversation-list'

const c = (id: string, over: Partial<ListableConversation> = {}): ListableConversation => ({
  id,
  isPinned: false,
  isArchived: false,
  lastMessageAt: null,
  ...over,
})

describe('filterConversations (T10)', () => {
  it('hides archived by default', () => {
    const list = [c('a'), c('b', { isArchived: true }), c('c')]
    expect(filterConversations(list).map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('includes archived when toggled', () => {
    const list = [c('a'), c('b', { isArchived: true })]
    expect(filterConversations(list, { includeArchived: true }).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input', () => {
    const list = [c('a')]
    filterConversations(list)
    expect(list.length).toBe(1)
  })
})

describe('sortConversations (T10)', () => {
  it('sorts pinned to the top', () => {
    const list = [c('a'), c('b', { isPinned: true }), c('c')]
    expect(sortConversations(list).map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by recency (lastMessageAt desc) within a pin group', () => {
    const list = [
      c('old', { lastMessageAt: '2026-01-01T00:00:00Z' }),
      c('new', { lastMessageAt: '2026-06-01T00:00:00Z' }),
      c('mid', { lastMessageAt: '2026-03-01T00:00:00Z' }),
    ]
    expect(sortConversations(list).map((x) => x.id)).toEqual(['new', 'mid', 'old'])
  })

  it('pinned beats recency', () => {
    const list = [
      c('recent', { lastMessageAt: '2026-06-01T00:00:00Z' }),
      c('pinned-old', { isPinned: true, lastMessageAt: '2026-01-01T00:00:00Z' }),
    ]
    expect(sortConversations(list).map((x) => x.id)).toEqual(['pinned-old', 'recent'])
  })

  it('falls back to createdAt when lastMessageAt is null', () => {
    const list = [
      c('a', { lastMessageAt: null, createdAt: '2026-01-01T00:00:00Z' }),
      c('b', { lastMessageAt: null, createdAt: '2026-05-01T00:00:00Z' }),
    ]
    expect(sortConversations(list).map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('is stable for equal keys', () => {
    const list = [c('a'), c('b'), c('d')]
    expect(sortConversations(list).map((x) => x.id)).toEqual(['a', 'b', 'd'])
  })
})

describe('visibleConversations (T10 — filter then sort)', () => {
  it('hides archived AND floats pinned to top', () => {
    const list = [
      c('a', { lastMessageAt: '2026-02-01T00:00:00Z' }),
      c('archived', { isArchived: true }),
      c('pinned', { isPinned: true, lastMessageAt: '2026-01-01T00:00:00Z' }),
      c('b', { lastMessageAt: '2026-03-01T00:00:00Z' }),
    ]
    expect(visibleConversations(list).map((x) => x.id)).toEqual(['pinned', 'b', 'a'])
  })

  it('shows archived (sorted) when the toggle is on', () => {
    const list = [c('a', { lastMessageAt: '2026-01-01T00:00:00Z' }), c('z', { isArchived: true })]
    expect(
      visibleConversations(list, { includeArchived: true })
        .map((x) => x.id)
        .sort(),
    ).toEqual(['a', 'z'])
  })
})
