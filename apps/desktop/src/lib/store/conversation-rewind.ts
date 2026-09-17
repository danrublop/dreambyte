/**
 * Conversation rewind primitive.
 *
 * `truncateConversationAfter(msgId, opts)` deletes every message AFTER `msgId`
 * in the conversation and, for the edit case, swaps `msgId`'s own content. The
 * DB tail-delete and the in-memory store splice happen IN LOCKSTEP:
 *
 *   1. The DB delete runs FIRST (via the conversations IPC). If it throws, the
 *      store is NOT touched and the error surfaces to the caller — chat and DB
 *      can never diverge.
 *   2. An unknown `msgId` (no anchor row, `found: false`) is treated as an
 *      error with ZERO mutation on either side.
 *   3. Only once the DB confirms does the store splice to match.
 *
 * Guard: refuses to run while a run is generating, with a visible reason — a
 * rewind mid-stream would race the streaming writer.
 *
 * The decision logic (`planRewind`) is a pure function so it is unit-testable
 * without React; the orchestrator takes its side effects (IPC, store get/set,
 * the isGenerating flag) as injected dependencies (steer-ui.ts precedent).
 *
 * Conversation-only semantics: this NEVER touches project state. Project
 * changes made by the removed messages are intentionally KEPT; the
 * caller reruns the agent against current project state afterwards.
 */

import type { ChatMessage, MessageContent } from '../agents/types'

export class RewindError extends Error {
  constructor(
    message: string,
    readonly reason: 'generating' | 'unknown-message' | 'no-conversation' | 'db-failed',
  ) {
    super(message)
    this.name = 'RewindError'
  }
}

export interface RewindPlan {
  /** Messages to keep, in order — everything up to and including `msgId`. */
  kept: ChatMessage[]
  /** The index of the anchor message in the original array. */
  anchorIndex: number
}

/**
 * Pure: given the current messages and an anchor id, compute the post-rewind
 * message list (everything up to and including the anchor, with an optional
 * content swap on the anchor). Returns null if the anchor isn't present — the
 * caller turns that into a RewindError with zero mutation.
 */
export function planRewind(
  messages: ChatMessage[],
  msgId: string,
  opts?: { newContent?: string; newStoreContent?: MessageContent },
): RewindPlan | null {
  const anchorIndex = messages.findIndex((m) => m.id === msgId)
  if (anchorIndex < 0) return null

  const kept = messages.slice(0, anchorIndex + 1)
  if (opts?.newContent !== undefined || opts?.newStoreContent !== undefined) {
    const anchor = kept[anchorIndex]
    // The store copy may carry richer content than the DB row — editing a
    // multipart message keeps its image blocks in-memory (newStoreContent)
    // while the DB swap stays text-only (newContent), matching how multipart
    // user messages have always been persisted (persistUserMessage strips to
    // text). Falls back to the DB string when no rich copy is supplied.
    kept[anchorIndex] = { ...anchor, content: opts.newStoreContent ?? (opts.newContent as MessageContent) }
  }
  return { kept, anchorIndex }
}

export interface RewindDeps {
  /** Reads the live `chatMessages`. */
  getMessages: () => ChatMessage[]
  /** Reads the active conversation id (null ⇒ nothing to rewind). */
  getConversationId: () => string | null
  /** True while a local agent run is generating. */
  isGenerating: () => boolean
  /** The conversations IPC adapter (desktop-only). */
  deleteMessagesAfter: (args: {
    conversationId: string
    messageId: string
    newContent?: string
  }) => Promise<{ found: boolean; remaining: unknown[] }>
  /** Commits the spliced message list to the store. */
  setMessages: (messages: ChatMessage[]) => void
}

/**
 * Tail-delete the conversation after `msgId` (DB first, then store), optionally
 * swapping the anchor's content. Resolves to the kept messages; rejects with a
 * RewindError on any guard failure or DB error — without mutating the store.
 */
export async function truncateConversationAfter(
  deps: RewindDeps,
  msgId: string,
  opts?: { newContent?: string; newStoreContent?: MessageContent },
): Promise<ChatMessage[]> {
  if (deps.isGenerating()) {
    throw new RewindError('Cannot rewind the conversation while the agent is generating.', 'generating')
  }

  const conversationId = deps.getConversationId()
  if (!conversationId) {
    throw new RewindError('No active conversation to rewind.', 'no-conversation')
  }

  const plan = planRewind(deps.getMessages(), msgId, opts)
  if (!plan) {
    throw new RewindError('That message is no longer in the conversation.', 'unknown-message')
  }

  // DB FIRST. A throw here leaves the store untouched (atomicity). `found:false`
  // means the row vanished between the plan and the delete — same outcome as an
  // unknown id: refuse with zero mutation.
  let result: { found: boolean; remaining: unknown[] }
  try {
    result = await deps.deleteMessagesAfter({ conversationId, messageId: msgId, newContent: opts?.newContent })
  } catch (err) {
    throw new RewindError(
      `Failed to rewind the conversation: ${err instanceof Error ? err.message : String(err)}`,
      'db-failed',
    )
  }
  if (!result.found) {
    throw new RewindError('That message is no longer in the conversation.', 'unknown-message')
  }

  // Store splice ONLY after the DB confirms. We splice the in-memory list (not
  // the DB rows) so in-memory-only fields (usage, streaming flags) on surviving
  // messages are preserved; the SET of ids is what stays in lockstep with the DB.
  deps.setMessages(plan.kept)
  return plan.kept
}
