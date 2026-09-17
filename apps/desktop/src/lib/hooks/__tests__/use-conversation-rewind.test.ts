import { describe, it, expect } from 'vitest'
import { findPrecedingUserIndex, buildEditedContent, findRestoreSnapshotMsgId } from '../use-conversation-rewind'
import type { ChatMessage, ImageAttachment } from '../../agents/types'

function msg(id: string, role: 'user' | 'assistant', content = id): ChatMessage {
  return { id, role, content, timestamp: 0 }
}

/**
 * Regression for the retry/regenerate anchor selection (T6). The legacy
 * handleRetry walked backward from the assistant message to the preceding user
 * message and re-ran its prompt; the rewind migration must pick the SAME
 * anchor. This captures that contract.
 */
describe('findPrecedingUserIndex (retry/regenerate anchor)', () => {
  it('finds the user message immediately before an assistant reply', () => {
    const msgs = [msg('u1', 'user'), msg('a1', 'assistant')]
    expect(findPrecedingUserIndex(msgs, 'a1')).toBe(0)
  })

  it('skips intervening assistant rows to the nearest user message', () => {
    const msgs = [msg('u1', 'user'), msg('a1', 'assistant'), msg('a2', 'assistant')]
    // Retry on a2 walks back past a1 to u1 — same as the legacy backward walk.
    expect(findPrecedingUserIndex(msgs, 'a2')).toBe(0)
  })

  it('picks the LATEST preceding user message in a multi-turn thread', () => {
    const msgs = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')]
    expect(findPrecedingUserIndex(msgs, 'a2')).toBe(2)
  })

  it('returns -1 when there is no preceding user message (no-op retry)', () => {
    const msgs = [msg('a1', 'assistant')]
    expect(findPrecedingUserIndex(msgs, 'a1')).toBe(-1)
  })

  it('returns -1 for an unknown id', () => {
    const msgs = [msg('u1', 'user'), msg('a1', 'assistant')]
    expect(findPrecedingUserIndex(msgs, 'ghost')).toBe(-1)
  })
})

/**
 * Block-preserving message edit (S7). Editing a multipart message must keep its
 * image blocks while swapping only the text — the legacy path sent text-only
 * newContent and would silently drop attachments.
 */
describe('buildEditedContent (S7 block-preserving edit)', () => {
  const img = (fileName: string): ImageAttachment => ({
    dataUri: `data:image/png;base64,${fileName}`,
    mimeType: 'image/png',
    fileName,
  })

  it('returns a plain string when the original was text-only', () => {
    expect(buildEditedContent('old', 'new')).toBe('new')
  })

  it('returns a plain string when a multipart message has no image blocks', () => {
    const original = [{ type: 'text' as const, text: 'old' }]
    expect(buildEditedContent(original, 'new')).toBe('new')
  })

  it('keeps image blocks and replaces the text, text-first', () => {
    const original = [
      { type: 'text' as const, text: 'old caption' },
      { type: 'image' as const, image: img('a.png') },
    ]
    expect(buildEditedContent(original, 'new caption')).toEqual([
      { type: 'text', text: 'new caption' },
      { type: 'image', image: img('a.png') },
    ])
  })

  it('preserves multiple images in their original relative order', () => {
    const original = [
      { type: 'image' as const, image: img('a.png') },
      { type: 'text' as const, text: 'old' },
      { type: 'image' as const, image: img('b.png') },
    ]
    expect(buildEditedContent(original, 'new')).toEqual([
      { type: 'text', text: 'new' },
      { type: 'image', image: img('a.png') },
      { type: 'image', image: img('b.png') },
    ])
  })
})

/**
 * Checkpoint-coupled rewind restore-target selection (S3). The snapshot to
 * restore is the first message AFTER the anchor that has one — the earliest run
 * being removed.
 */
describe('findRestoreSnapshotMsgId (S3 restore target)', () => {
  const thread = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')]

  it('returns the first message after the anchor that has a snapshot', () => {
    // Rewinding to u2: the run that produced a2 is removed → restore to its snapshot.
    const has = (id: string) => id === 'a2'
    expect(findRestoreSnapshotMsgId(thread, 'u2', has)).toBe('a2')
  })

  it('picks the EARLIEST removed run when several after the anchor have snapshots', () => {
    const has = (id: string) => id === 'a1' || id === 'a2'
    expect(findRestoreSnapshotMsgId(thread, 'u1', has)).toBe('a1')
  })

  it('returns null when nothing after the anchor has a snapshot (conversation-only rewind)', () => {
    expect(findRestoreSnapshotMsgId(thread, 'u2', () => false)).toBeNull()
  })

  it('returns null when the EARLIEST removed run was evicted, even if a later run has a snapshot', () => {
    // Anchor u1: the first removed run is a1 (snapshot evicted by the FIFO cap),
    // a2 still has one. Returning a2 would roll the project back only partway
    // while the whole tail is truncated — a silent partial restore. Must be null.
    const has = (id: string) => id === 'a2'
    expect(findRestoreSnapshotMsgId(thread, 'u1', has)).toBeNull()
  })

  it('ignores snapshots at or before the anchor', () => {
    const has = (id: string) => id === 'a1' // before the u2 anchor
    expect(findRestoreSnapshotMsgId(thread, 'u2', has)).toBeNull()
  })

  it('returns null for an unknown anchor', () => {
    expect(findRestoreSnapshotMsgId(thread, 'ghost', () => true)).toBeNull()
  })
})
