/**
 * Pure sort/filter helpers for the conversation list.
 *
 * Filtering semantics (decision of record):
 *   - Archived conversations are HIDDEN from the default list unless an
 *     "Archived" toggle is on (`includeArchived`).
 *   - Pinned conversations sort to the TOP, then by recency
 *     (`lastMessageAt` desc, falling back to `createdAt`).
 *
 * React-free + dependency-light so they are unit-testable in isolation and
 * shared by the in-chat list and (semantically) conversation search.
 */

export interface ListableConversation {
  id: string
  isPinned?: boolean | null
  isArchived?: boolean | null
  lastMessageAt?: string | null
  createdAt?: string
}

/** Hide archived conversations unless explicitly included. */
export function filterConversations<T extends ListableConversation>(
  conversations: T[],
  opts?: { includeArchived?: boolean },
): T[] {
  if (opts?.includeArchived) return conversations.slice()
  return conversations.filter((c) => !c.isArchived)
}

function recencyKey(c: ListableConversation): number {
  const t = c.lastMessageAt ?? c.createdAt
  const n = t ? Date.parse(t) : NaN
  return Number.isFinite(n) ? n : 0
}

/** Pinned first, then most-recent first. Stable, non-mutating. */
export function sortConversations<T extends ListableConversation>(conversations: T[]): T[] {
  return conversations
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pinDiff = Number(!!b.c.isPinned) - Number(!!a.c.isPinned)
      if (pinDiff !== 0) return pinDiff
      const recencyDiff = recencyKey(b.c) - recencyKey(a.c)
      if (recencyDiff !== 0) return recencyDiff
      return a.i - b.i // stable tiebreak
    })
    .map((x) => x.c)
}

/** Filter (hide archived) then sort (pinned-first, recency). */
export function visibleConversations<T extends ListableConversation>(
  conversations: T[],
  opts?: { includeArchived?: boolean },
): T[] {
  return sortConversations(filterConversations(conversations, opts))
}
