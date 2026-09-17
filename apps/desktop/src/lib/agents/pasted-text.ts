/**
 * Pasted-text chips (Claude-style): a large paste is appended to the message
 * `content` behind a stable delimiter so the model reads it verbatim and it
 * persists normally — while the transcript renderer splits it back out into
 * collapsible chips instead of flooding the bubble.
 *
 * `content` stays the single source of truth (no schema change, survives
 * reload). Both the composer (when assembling the sent message) and the
 * renderer (when splitting for display) import PASTE_DELIM from here so they
 * can never drift.
 */

/** Marker that precedes each inlined pasted block. The leading blank line keeps
 *  it readable for the model; the renderer splits on the exact string. */
export const PASTE_DELIM = '\n\n[Pasted content]:\n'

export interface PastedChip {
  id: string
  text: string
}

export interface SplitPasted {
  /** The user's own text, with the pasted blocks removed. */
  display: string
  /** The pasted blocks, in order, as chips. */
  chips: PastedChip[]
}

/**
 * Split message text into the user's display text and its pasted-block chips.
 * Inverse of the `display + PASTE_DELIM + block + PASTE_DELIM + block …`
 * assembly in AgentChat.handleSend. Pure + allocation-light; safe to call on
 * every render. When there are no pasted blocks, returns the text unchanged
 * with an empty chip list.
 */
export function splitPastedContent(text: string): SplitPasted {
  if (!text.includes(PASTE_DELIM)) return { display: text, chips: [] }
  const parts = text.split(PASTE_DELIM)
  const display = parts[0] ?? ''
  const chips: PastedChip[] = parts.slice(1).map((t, i) => ({ id: `paste-${i}`, text: t }))
  return { display, chips }
}
