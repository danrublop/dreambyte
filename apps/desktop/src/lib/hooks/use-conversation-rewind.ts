'use client'

/**
 * Conversation rewind + rerun glue for the chat surface.
 *
 * The store owns the rewind PRIMITIVE (`truncateConversation` → DB tail-delete +
 * lockstep store splice). This hook wires the three chat affordances that ride
 * on it — retry, edit, regenerate — to a single rerun callback (AgentChat's
 * `runAgentStream` against an existing user turn). AgentChat only wires; the
 * decision logic lives here so it is unit-testable without a React render.
 *
 * Conversation-only semantics: rewind NEVER touches project state. The
 * messages after the anchor are removed and the agent reruns against CURRENT
 * project state. Project changes made by the removed messages are KEPT. The
 * confirm dialog (owned by the component) states this and offers a
 * "create a branch first" escape hatch.
 */

import { useCallback } from 'react'
import type { ChatMessage, MessageContent } from '../agents/types'
import { messageContentToText } from '../agents/types'
import { useVideoStore } from '../store'
import { RewindError } from '../store/conversation-rewind'
import { createLogger } from '../logger'

const log = createLogger('hooks.conversation-rewind')

/**
 * Pure: index of the user message immediately preceding `msgId` (an assistant
 * message). Returns -1 if none — retry/regenerate then no-op. Walks backward so
 * intervening assistant/system rows are skipped.
 */
export function findPrecedingUserIndex(messages: ChatMessage[], msgId: string): number {
  const idx = messages.findIndex((m) => m.id === msgId)
  if (idx < 1) return -1
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** The rerun side effect AgentChat injects: re-run the agent on an existing
 *  user turn WITHOUT appending a new user message (the turn already survives
 *  the rewind). The hook hands it the user message content to rerun. */
export type RerunFn = (userContent: MessageContent) => Promise<void>

/**
 * Pure: the post-edit content. Text-only messages stay a plain string;
 * multipart messages get one text block with the new text, image blocks
 * preserved in their original relative order after it.
 */
export function buildEditedContent(original: MessageContent, newText: string): MessageContent {
  if (typeof original === 'string') return newText
  const imageBlocks = original.filter((b) => b.type === 'image')
  if (imageBlocks.length === 0) return newText
  return [{ type: 'text', text: newText }, ...imageBlocks]
}

/**
 * Pure: the run-snapshot key to restore when rewinding to `anchorMsgId`.
 *
 * The only correct restore point is the pre-run snapshot of the EARLIEST run
 * being removed — the first assistant message after the anchor (snapshots are
 * keyed by the run's streaming assistant message id). Restoring a *later* run's
 * snapshot would roll the project back only partway while truncation removes the
 * whole tail — a silent partial restore the dialog would mislabel as a full one.
 * So if that earliest run's snapshot was evicted (the FIFO cap in
 * captureAgentRunSnapshot) we return null: restore is reported unavailable rather
 * than skipping forward to a snapshot that doesn't cover the first removed run.
 * Returns null too when the anchor is unknown or no run follows it (a
 * conversation-only rewind, the default). `hasSnapshot` keeps this pure — the
 * caller supplies the store lookup.
 */
export function findRestoreSnapshotMsgId(
  messages: ChatMessage[],
  anchorMsgId: string,
  hasSnapshot: (msgId: string) => boolean,
): string | null {
  const anchorIdx = messages.findIndex((m) => m.id === anchorMsgId)
  if (anchorIdx < 0) return null
  for (let i = anchorIdx + 1; i < messages.length; i++) {
    // First run after the anchor = first assistant message. Its snapshot is the
    // sole valid restore point; evicted → unavailable (do not skip forward).
    if (messages[i].role === 'assistant') {
      return hasSnapshot(messages[i].id) ? messages[i].id : null
    }
  }
  return null
}

/** Options shared by the rewind actions. `restore` additionally rolls the
 *  project back to the pre-run snapshot before the removed run(s). */
export interface RewindOpts {
  restore?: boolean
}

export interface UseConversationRewindArgs {
  /** Live agent-run flag (AgentChat local state). Gates the rewind. */
  isGenerating: boolean
  /** Re-run the agent on an existing user turn (no new user message appended). */
  rerun: RerunFn
  /** Surface a user-visible error (toast / status line). */
  onError?: (message: string) => void
}

export interface ConversationRewindActions {
  /**
   * Retry an assistant message: rewind to (and keep) the preceding user message,
   * then rerun it. Same observable contract as the legacy handleRetry — the
   * preceding user prompt is re-run — but now the stale assistant reply (and
   * anything after it) is removed first, so history stays coherent.
   */
  retryAssistant: (assistantMsgId: string, opts?: RewindOpts) => Promise<void>
  /**
   * Regenerate an assistant message. Identical to retry; named for the
   * assistant-message "Regenerate" action.
   */
  regenerateAssistant: (assistantMsgId: string, opts?: RewindOpts) => Promise<void>
  /**
   * Edit a user message: swap its content, drop everything after it, then rerun
   * the edited turn.
   */
  editUserMessage: (userMsgId: string, newText: string, opts?: RewindOpts) => Promise<void>
}

export function useConversationRewind(args: UseConversationRewindArgs): ConversationRewindActions {
  const { isGenerating, rerun, onError } = args

  const rewindToUserAndRerun = useCallback(
    async (assistantMsgId: string, opts?: RewindOpts) => {
      if (isGenerating) return
      const msgs = useVideoStore.getState().chatMessages
      const userIdx = findPrecedingUserIndex(msgs, assistantMsgId)
      if (userIdx < 0) return
      const userMsg = msgs[userIdx]
      // Resolve the restore target from the PRE-truncate messages (the tail
      // is gone afterward). Computed before the DB op so a restore is possible.
      const restoreMsgId = opts?.restore
        ? findRestoreSnapshotMsgId(msgs, userMsg.id, (id) => useVideoStore.getState().hasRunSnapshot(id))
        : null
      try {
        // Rewind AFTER the user message (keep it; drop the stale reply + tail).
        await useVideoStore.getState().truncateConversation(userMsg.id, { isGenerating })
      } catch (err) {
        if (err instanceof RewindError) onError?.(err.message)
        else log.error('rewind failed', { error: err })
        return
      }
      // Restore project state before the removed run, so the rerun acts on
      // the pre-run state — a true rewind, not a trim against post-run state. The
      // transcript is already truncated, so if the snapshot vanished between
      // dialog-open and now (eviction / branch change) say so rather than
      // silently leaving the project in its post-run state.
      if (restoreMsgId) {
        const restored = useVideoStore.getState().restoreRunSnapshot(restoreMsgId)
        if (!restored) {
          onError?.('Conversation rewound, but the project snapshot was no longer available — scene changes were kept.')
        }
      }
      await rerun(userMsg.content)
    },
    [isGenerating, rerun, onError],
  )

  const editUserMessage = useCallback(
    async (userMsgId: string, newText: string, opts?: RewindOpts) => {
      if (isGenerating) return
      const trimmed = newText.trim()
      if (!trimmed) return
      const msgs = useVideoStore.getState().chatMessages
      const target = msgs.find((m) => m.id === userMsgId)
      if (!target || target.role !== 'user') return
      // If the edit is a no-op against the current text, do nothing.
      if (messageContentToText(target.content) === trimmed) return
      // Restore target resolved from PRE-truncate messages (anchor = the
      // edited user message; the run that responded to it is the first removed).
      const restoreMsgId = opts?.restore
        ? findRestoreSnapshotMsgId(msgs, userMsgId, (id) => useVideoStore.getState().hasRunSnapshot(id))
        : null
      // Block-preserving edit. When the original content carries image
      // blocks, the edited message keeps them — the new text replaces the text
      // block(s), images survive in-memory and in the rerun. The DB swap stays
      // plain text, matching how multipart user messages have always been
      // persisted (persistUserMessage strips to text).
      const rerunContent: MessageContent = buildEditedContent(target.content, trimmed)
      try {
        // Swap content + drop the tail in one atomic DB-first op.
        await useVideoStore.getState().truncateConversation(userMsgId, {
          newContent: trimmed,
          newStoreContent: rerunContent,
          isGenerating,
        })
      } catch (err) {
        if (err instanceof RewindError) onError?.(err.message)
        else log.error('edit rewind failed', { error: err })
        return
      }
      if (restoreMsgId) {
        const restored = useVideoStore.getState().restoreRunSnapshot(restoreMsgId)
        if (!restored) {
          onError?.('Conversation rewound, but the project snapshot was no longer available — scene changes were kept.')
        }
      }
      await rerun(rerunContent)
    },
    [isGenerating, rerun, onError],
  )

  return {
    retryAssistant: rewindToUserAndRerun,
    regenerateAssistant: rewindToUserAndRerun,
    editUserMessage,
  }
}
