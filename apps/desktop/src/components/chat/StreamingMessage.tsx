'use client'

import React, { forwardRef, memo, useEffect, useImperativeHandle } from 'react'
import type { ToolCallRecord } from '@/lib/agents/types'
import type { StreamingHandle } from '@/lib/hooks/use-agent-run'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { useThrottledStream } from '@/hooks/use-throttled-stream'
import { prettyToolLabel } from './tool-name'
import { renderMarkdown } from './render-markdown'
import { ThinkingDots } from './ThinkingDots'
import { groupSegments } from './ToolCluster'
import { ActivitySegment, groupActivities } from './ActivitySegment'

export type StreamingSegment =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallRecord }
  | { type: 'thinking'; text: string }

export interface StreamingMessageProps {
  /** Committed text/tool segments (change only at tool-call boundaries). */
  segments: StreamingSegment[]
  /** Length of accumulated text already captured into `segments`. */
  snapshotLen: number
  /** Tool currently executing, or null. */
  activeToolName: string | null
  /** Whether the thinking stream is mid-flight. */
  isThinkingStreaming: boolean
  /**
   * Called after content grows (text/thinking flush or a new segment) so the
   * parent can keep the transcript pinned to the bottom. Must be referentially
   * stable (e.g. a useCallback) or memo + this effect will thrash.
   */
  onContentGrow?: () => void
}

/*
 *  RENDER ORDER (chronological, Cursor-style narrate -> act -> confirm):
 *    [committed segments] -> [trailing live text] -> [single status line]
 *
 *  trailing = text.value.slice(snapshotLen)
 *    At a tool-call boundary AgentChat flushes text THEN advances snapshotLen,
 *    so trailing collapses to '' exactly when the segment is committed (no
 *    duplicate, no flash).
 */
function StreamingMessageInner(
  { segments, snapshotLen, activeToolName, isThinkingStreaming, onContentGrow }: StreamingMessageProps,
  ref: React.Ref<StreamingHandle>,
) {
  const text = useThrottledStream(33)
  const thinking = useThrottledStream(33)

  // Keep the transcript pinned to the bottom as content grows. Fires on each
  // throttled flush (≈30fps cap) and at tool-call boundaries — not per token.
  useEffect(() => {
    onContentGrow?.()
  }, [text.value, thinking.value, segments, onContentGrow])

  useImperativeHandle(
    ref,
    () => ({
      pushText: text.push,
      flushText: text.flush,
      pushThinking: thinking.push,
      flushThinking: (full: string) => {
        thinking.push(full)
        thinking.flush()
      },
      // A finished reasoning block is committed as an interleaved `thinking`
      // SEGMENT by AgentChat (so it renders between the tool calls it happened
      // between); here we just clear the live buffer so it doesn't also linger
      // as the status-line block. Every past block therefore stays visible via
      // `segments`, not a separate history list.
      resetThinking: () => thinking.reset(),
      resetAll: () => {
        text.reset()
        thinking.reset()
      },
    }),
    // Depend on the stable useCallback refs, NOT the {value,...} objects (those
    // are fresh literals every render — depending on them would rebuild the
    // handle ~30x/sec during a stream).
    [text.push, text.flush, text.reset, thinking.push, thinking.flush, thinking.reset],
  )

  // INVARIANT: text.value and snapshotLen must both be slices of the same
  // accumulatedText (AgentChat flushes text at the tool-call boundary right
  // before advancing lastSnapshotTextRef). If a future edit advances one
  // without the other, trailing text duplicates or drops. Guarded by the
  // "collapses trailing text ... (no duplicate)" test in StreamingMessage.test.tsx.
  const trailingText = text.value.slice(snapshotLen).trim()

  // #4: group consecutive tool calls into one collapsible cluster so the stream
  // isn't flooded. groupSegments also drops permission-paused tools (they render
  // as a permission card elsewhere) and passes thinking blocks through inline so
  // each reasoning block sits between the tool calls it happened between.
  const chunks = groupSegments(
    segments.map((seg) =>
      seg.type === 'text' ? { text: seg.text } : seg.type === 'thinking' ? { thinking: seg.text } : { call: seg.call },
    ),
  )
  // Fold reasoning + tool chunks into activity segments. The trailing activity
  // (no text reply after it) is the one the agent is CURRENTLY working — render
  // it as a fixed-height auto-scroll viewport; earlier segments (a text reply
  // already broke them) collapse to a one-line summary.
  const activities = groupActivities(chunks)
  const liveIdx =
    activities.length > 0 && activities[activities.length - 1].type === 'activity' ? activities.length - 1 : -1

  return (
    <div className="space-y-2">
      {activities.map((a, i) =>
        a.type === 'text' ? (
          <div
            key={`seg-${i}`}
            className="text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap"
          >
            {renderMarkdown(a.text)}
          </div>
        ) : (
          <ActivitySegment key={`seg-${i}`} chunks={a.chunks} live={i === liveIdx} />
        ),
      )}

      {/* Trailing live text (after the last committed segment, still typing). */}
      {trailingText ? (
        <div className="text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap">
          {renderMarkdown(trailingText)}
        </div>
      ) : text.value && segments.length === 0 ? (
        <div className="text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap">
          {renderMarkdown(text.value)}
        </div>
      ) : null}

      {/* Single muted status line: active tool > extended (live) thinking > pending.
       *  Past reasoning blocks are committed as inline `thinking` segments above
       *  (rendered in the chunks loop), so this only shows the CURRENTLY-streaming
       *  block. */}
      {activeToolName ? (
        <div className="text-sm italic text-[var(--color-text-muted)]">
          {prettyToolLabel(activeToolName)}
          <ThinkingDots />
        </div>
      ) : isThinkingStreaming || thinking.value ? (
        <ThinkingBlock thinking={thinking.value} isStreaming={isThinkingStreaming} />
      ) : !text.value ? (
        <div className="text-sm italic text-[var(--color-text-muted)]">
          thinking
          <ThinkingDots />
        </div>
      ) : null}
    </div>
  )
}

/**
 * memo: AgentChat re-renders for unrelated state (input typing, panel toggles).
 * The shallow prop compare keeps this leaf from re-rendering then. Props are
 * primitives + the `segments` array (stable ref between tool boundaries), so
 * the compare is cheap and correct. High-frequency text/thinking updates come
 * from internal state, not props — those re-render only this leaf.
 */
export const StreamingMessage = memo(forwardRef<StreamingHandle, StreamingMessageProps>(StreamingMessageInner))
StreamingMessage.displayName = 'StreamingMessage'
