/**
 * Pure decision helpers for mid-run steering in the chat composer.
 *
 * Extracted from AgentChat so the gating + routing logic is unit-testable without
 * a React render. The component holds the state; these decide what it does with it.
 */

/**
 * Should the composer be disabled? Only when a REMOTE-window run owns the agent
 * and this tab has no local run to steer. During a local run the composer stays
 * live so the user can steer.
 */
export function composerDisabled(isGenerating: boolean, isAgentRunningRemote: boolean): boolean {
  return isAgentRunningRemote && !isGenerating
}

/** Marker appended to a steer message that never reached the model. */
export const UNCONSUMED_STEER_MARKER = '_(not applied — the run ended before this was read. Resend it.)_'

/**
 * Annotate a steer message body that came back unconsumed. Idempotent — a repeated
 * or re-delivered `steer_unconsumed` event won't append the marker twice.
 */
export function annotateUnconsumedSteer(content: string): string {
  if (content.includes(UNCONSUMED_STEER_MARKER)) return content
  return `${content}\n\n${UNCONSUMED_STEER_MARKER}`
}

/** Does this message body carry the unconsumed-steer marker? */
export function hasUnconsumedSteerMarker(content: string): boolean {
  return content.includes(UNCONSUMED_STEER_MARKER)
}

/**
 * Strip the unconsumed-steer marker from a message body, returning the original
 * steer text the user typed. Used by the "Resend" affordance to resubmit
 * the steer as a normal new turn. Removes the marker and any trailing whitespace
 * the annotation added; idempotent on un-annotated text.
 */
export function stripUnconsumedSteerMarker(content: string): string {
  if (!content.includes(UNCONSUMED_STEER_MARKER)) return content.trim()
  return content.split(UNCONSUMED_STEER_MARKER).join('').trim()
}

/**
 * On submit, route to a STEER (vs a normal new turn) when this tab has a live run
 * AND we know its runId. No runId yet (run starting) → fall through to a normal
 * send rather than dropping the message.
 */
export function shouldRouteToSteer(isGenerating: boolean, activeLocalRunId: string | null): boolean {
  return isGenerating && typeof activeLocalRunId === 'string' && activeLocalRunId.length > 0
}

// ── Chat-trust helpers ───────

/** How many recent chat messages are sent to the agent as history. ONE home
 *  for the number — AgentChat's slice and the visible cliff note both read it,
 *  so the indicator can never lie about the window size. */
export const AGENT_HISTORY_WINDOW = 10

/**
 * Composer placeholder during a live run. The steer path needs the
 * runId; in the brief window before run_start delivers it, handleSend
 * REFUSES the submit (`if (isGenerating) return` — the text stays in the
 * composer, nothing is sent). Say that, instead of promising a steer (or a
 * new turn) that won't happen yet. The refusal itself also shows a transient
 * status so an Enter in this window is never a silent no-op.
 */
export function composerSteerPlaceholder(steerReady: boolean): string {
  return steerReady
    ? 'Steer the agent — your message folds into the next step...'
    : 'Run starting — steering unlocks in a moment...'
}

/** Transient status shown when a submit lands in the pre-runId window (the
 *  composer keeps the text; the user just needs to resend in a second). */
export const STEER_NOT_READY_NOTICE =
  'Run is starting — your message is still in the box; try again in a second to steer.'

/**
 * Visible history-cliff note: only the last AGENT_HISTORY_WINDOW
 * messages reach the agent. Without this the user reads "it forgot my plan"
 * as model stupidity. Null when everything fits (no noise on short chats).
 */
export function historyCliffNote(totalMessages: number, window = AGENT_HISTORY_WINDOW): string | null {
  if (totalMessages <= window) return null
  return `agent sees the last ${window} of ${totalMessages} messages`
}

/**
 * Conversation-history search filter: case-insensitive match on title
 * and the single preview message the conversation list carries (the list IPC
 * ships each conversation's LATEST message, not full history — full-text
 * search would need a per-conversation fetch). Empty query returns the list
 * as-is.
 */
export function filterConversations<T extends { title?: string | null; messages?: Array<{ content?: string }> }>(
  conversations: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return conversations
  return conversations.filter((c) => {
    if (c.title?.toLowerCase().includes(q)) return true
    const preview = c.messages?.[0]?.content
    return typeof preview === 'string' && preview.toLowerCase().includes(q)
  })
}
