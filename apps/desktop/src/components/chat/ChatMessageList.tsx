'use client'

import type { Dispatch, SetStateAction } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ChatMessage, ImageAttachment } from '@/lib/agents/types'
import { messageContentToText } from '@/lib/agents/types'
import type { Project } from '@/lib/types'
import type { VideoStore } from '@/lib/store/types'
import { hasUnconsumedSteerMarker } from '@/lib/agents/steer-ui'
import { renderMarkdown } from './render-markdown'
import { EditableUserMessage } from './EditableUserMessage'
import { MessagePastedChips } from './MessagePastedChips'
import { splitPastedContent } from '@/lib/agents/pasted-text'
import { useVideoStore } from '@/lib/store'
import { MessageActions } from './MessageActions'
import { groupSegments } from './ToolCluster'
import { ActivitySegment, groupActivities } from './ActivitySegment'
import { ToolCallSummary } from './ToolCallSummary'
import { SourcesBlock } from './SourcesBlock'
import { ThinkingBlock } from '../ThinkingBlock'
import GenerationConfirmCard from '../GenerationConfirmCard'
import { ClarificationCard } from './ClarificationCard'
import type { PreviewImage } from './ImageLightbox'

export interface ChatMessageListProps {
  messages: ChatMessage[]
  streamingMsgId: string | null
  isGenerating: boolean
  activeConversationId: string | null
  project: Project
  rateLimitCountdown: { msgId: string; seconds: number } | null
  setPreviewImage: Dispatch<SetStateAction<PreviewImage | null>>
  handleEditMessage: (userMsgId: string, newText: string) => void
  handleResendSteer: (steerText: string) => Promise<void>
  handlePermission: (msgId: string, api: string, decision: 'allow' | 'deny') => void
  continueAfterPermission: (msg: ChatMessage, api: string) => Promise<void>
  /** ask_user: resume the paused run with the user's answer. */
  answerClarification: (msg: ChatMessage, answer: string) => Promise<void>
  /** Deny ALSO resumes the run (denial context, no tool replay). */
  denyAndContinue: (msg: ChatMessage, api: string) => Promise<void>
  setGenerationOverride: VideoStore['setGenerationOverride']
  setAutoChooseDefault: VideoStore['setAutoChooseDefault']
  setSessionPermission: VideoStore['setSessionPermission']
  updateAPIPermissions: VideoStore['updateAPIPermissions']
  handleRate: (msgId: string, rating: number) => void
  handleRetry: (assistantMsgId: string) => void
  handleRegenerate: (assistantMsgId: string) => void
  handleRateLimitRetry: (assistantMsgId: string) => void
  handleDetails: (msg: ChatMessage) => void
}

/**
 * The chat transcript render (S2 slice 3) — the filter+map over messages that
 * renders each user/assistant bubble: attachments, interleaved tool segments,
 * permission/generation cards, incomplete + rate-limit banners, and the per-
 * message MessageActions. Extracted verbatim from AgentChat; every handler it
 * closes over is passed as a prop.
 */
export function ChatMessageList({
  messages,
  streamingMsgId,
  isGenerating,
  activeConversationId,
  project,
  rateLimitCountdown,
  setPreviewImage,
  handleEditMessage,
  handleResendSteer,
  handlePermission,
  continueAfterPermission,
  answerClarification,
  denyAndContinue,
  setGenerationOverride,
  setAutoChooseDefault,
  setSessionPermission,
  updateAPIPermissions,
  handleRate,
  handleRetry,
  handleRegenerate,
  handleRateLimitRetry,
  handleDetails,
}: ChatMessageListProps) {
  // Showcase fence: fixture messages are not editable.
  const showcaseMode = useVideoStore((s) => s.showcaseMode)
  return (
    <>
      {messages
        .filter((m) => {
          // While a stream is running, hide the in-flight assistant
          // message from this list — the streaming block below renders
          // it live. Without this, the persisted copy (with a premature
          // feedback footer) and the live copy show up side by side.
          if (streamingMsgId && m.id === streamingMsgId) return false
          return m.content || m.toolCalls?.length || m.thinking
        })
        .map((msg) => (
          <div key={msg.id} className="w-full">
            {msg.role === 'user' ? (
              <>
                <EditableUserMessage msg={msg} disabled={isGenerating || showcaseMode} onEdit={handleEditMessage}>
                  {typeof msg.content === 'string' ? (
                    (() => {
                      // Split any inlined pasted blocks back into chips so a
                      // sent paste shows as a chip, not a wall of text.
                      const { display, chips } = splitPastedContent(msg.content)
                      return (
                        <div className="space-y-2">
                          {display && <span className="whitespace-pre-wrap break-words">{display}</span>}
                          <MessagePastedChips chips={chips} />
                        </div>
                      )
                    })()
                  ) : (
                    <div className="space-y-2">
                      {msg.content.some((b) => b.type === 'image') && (
                        <div className="flex gap-2 flex-wrap justify-start">
                          {msg.content
                            .filter((b) => b.type === 'image')
                            .map((b, i) => {
                              const img = (b as { type: 'image'; image: ImageAttachment }).image
                              return (
                                <div
                                  key={i}
                                  className="relative cursor-pointer group"
                                  onClick={() =>
                                    setPreviewImage({
                                      src: img.dataUri,
                                      alt: img.fileName,
                                      width: img.width,
                                      height: img.height,
                                    })
                                  }
                                >
                                  <img
                                    src={img.dataUri}
                                    className="max-h-48 max-w-[280px] rounded-lg border border-[var(--color-border)] object-cover"
                                    alt={img.fileName ?? 'Attached'}
                                  />
                                  <div className="absolute inset-0 rounded-lg bg-black/0 group-hover:bg-black/10 transition-colors" />
                                </div>
                              )
                            })}
                        </div>
                      )}
                      {msg.content
                        .filter((b) => b.type === 'text')
                        .map((b, i) => {
                          const { display, chips } = splitPastedContent((b as { type: 'text'; text: string }).text)
                          return (
                            <div key={i} className="space-y-2">
                              {display && <span className="whitespace-pre-wrap break-words">{display}</span>}
                              <MessagePastedChips chips={chips} />
                            </div>
                          )
                        })}
                    </div>
                  )}
                </EditableUserMessage>
                {/* Resend affordance for an unconsumed steer. The steer
                      ended the run before the model read it; resend submits the
                      marker-stripped original text as a normal new turn. */}
                {typeof msg.content === 'string' && hasUnconsumedSteerMarker(msg.content) && !isGenerating && (
                  <div className="flex w-full justify-end px-1 pt-1">
                    <button
                      onClick={() => void handleResendSteer(msg.content as string)}
                      className="flex items-center gap-1 rounded bg-[var(--color-panel)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
                    >
                      <RefreshCw size={11} strokeWidth={1.5} />
                      Resend
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex w-full justify-center">
                <div className="relative w-full space-y-1.5">
                  {/* Agent + model header retired — same info lives in the
                   *  Details menu (handleDetails) per message.
                   *  Thinking block now renders AFTER the content, not
                   *  above, so the reply flows as one linear thing. */}

                  {/* Interleaved content: render `contentSegments` IN
                   * ORDER so tool cards stay where they were emitted
                   * during the run (Cursor-style narrate → act →
                   * confirm cadence). Prior version filtered text
                   * segments out and dropped a single ToolCallSummary
                   * at the bottom — that auto-bunched every tool
                   * regardless of conversation flow. Each ToolCallItem
                   * is collapsed by default; click to expand. */}
                  {msg.contentSegments && msg.contentSegments.length > 0 ? (
                    <div className="space-y-1.5">
                      {(() => {
                        const callsById = new Map((msg.toolCalls ?? []).map((c) => [c.id, c]))
                        // #4: group consecutive tool calls into one collapsible
                        // cluster (groupSegments drops permission-paused tools,
                        // shown as a permission card elsewhere).
                        const items = msg.contentSegments.map((seg) =>
                          seg.type === 'text'
                            ? { text: seg.text }
                            : seg.type === 'thinking'
                              ? { thinking: seg.text }
                              : { call: callsById.get(seg.toolCallId) },
                        )
                        // Fold reasoning + tool chunks into activity segments:
                        // each collapses to a one-line summary (click to
                        // expand) with any pulled/generated media surfaced
                        // above it. The run is done, so none render live.
                        return groupActivities(groupSegments(items)).map((a, i) =>
                          a.type === 'text' ? (
                            <div
                              key={`seg-${i}`}
                              className="py-1 text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
                            >
                              {renderMarkdown(a.text)}
                            </div>
                          ) : (
                            <ActivitySegment key={`seg-${i}`} chunks={a.chunks} live={false} />
                          ),
                        )
                      })()}
                      {msg.sources && msg.sources.length > 0 ? <SourcesBlock sources={msg.sources} /> : null}
                    </div>
                  ) : (
                    <>
                      {/* Message text */}
                      <div className="py-2 text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words">
                        {renderMarkdown(
                          typeof msg.content === 'string' ? msg.content : messageContentToText(msg.content),
                        )}
                      </div>

                      {/* Tool calls — compact summary by default. ToolCallSummary
                       * unwraps to a single ToolCallItem when there's one call, so
                       * this gives the same one-card UX for trivial runs and a
                       * collapsed-by-default summary for multi-tool runs across
                       * every provider. */}
                      {msg.toolCalls && msg.toolCalls.length > 0 && <ToolCallSummary calls={msg.toolCalls} />}
                      {msg.sources && msg.sources.length > 0 ? <SourcesBlock sources={msg.sources} /> : null}
                    </>
                  )}

                  {/* Extended reasoning — collapsed by default, tucked BELOW
                   *  the reply. Only shown here when the reasoning ISN'T
                   *  already interleaved as `thinking` segments above (older
                   *  messages, or a run with no segments) — otherwise it would
                   *  duplicate the last inline block. */}
                  {msg.thinking && !msg.contentSegments?.some((s) => s.type === 'thinking') && (
                    <ThinkingBlock thinking={msg.thinking} />
                  )}

                  {/* Permission / Generation confirmation cards */}
                  {msg.pendingPermissions && msg.pendingPermissions.length > 0 && (
                    <div className="space-y-2">
                      {msg.pendingPermissions.map((perm, i) => (
                        <GenerationConfirmCard
                          key={`${perm.api}-${i}`}
                          perm={perm}
                          onAllow={(overrides) => {
                            if (overrides) {
                              setGenerationOverride(perm.api, overrides)
                            }
                            handlePermission(msg.id, perm.api, 'allow')
                            void continueAfterPermission(msg, perm.api)
                          }}
                          onDeny={() => {
                            handlePermission(msg.id, perm.api, 'deny')
                            void denyAndContinue(msg, perm.api)
                          }}
                          onAutoChoose={(genType, defaults) => {
                            setAutoChooseDefault(genType, defaults)
                            // Also set session permission to always allow this API
                            setSessionPermission(perm.api, 'allow')
                          }}
                          currentMode={
                            project.apiPermissions?.[perm.api as import('@/lib/types').APIName]?.mode ?? 'always_ask'
                          }
                          onModeChange={(mode) => {
                            const apiKey = perm.api as import('@/lib/types').APIName
                            const existing = project.apiPermissions?.[apiKey]
                            updateAPIPermissions({
                              [apiKey]: { ...(existing ?? { mode: 'always_ask' }), mode },
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            } as any)
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* ask_user clarify card — the run paused for a question. */}
                  {msg.pendingClarification && (
                    <div className="space-y-2">
                      <ClarificationCard
                        clarification={msg.pendingClarification}
                        answered={msg.pendingClarification.answered}
                        onAnswer={(answer) => {
                          void answerClarification(msg, answer)
                        }}
                      />
                    </div>
                  )}

                  {/* Interrupted / incomplete indicator. Driven by the
                          explicit `incomplete` flag set when an orphaned/aborted row
                          loads with no live run — NOT a content-string sniff — so a
                          partial reply never reads as a finished one. The legacy
                          "Stopped by user" / "Generation interrupted" content sniff is
                          kept as a fallback for rows persisted before the flag existed. */}
                  {msg.role === 'assistant' &&
                    (() => {
                      const text = typeof msg.content === 'string' ? msg.content : ''
                      const isIncomplete =
                        msg.incomplete === true ||
                        text.includes('Stopped by user') ||
                        text.includes('Generation interrupted')
                      return isIncomplete ? (
                        <div className="flex items-center gap-1.5 py-1 text-[11px] text-[var(--color-text-muted)]">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-yellow-500/60" />
                          Incomplete — run was interrupted. Send a message to continue.
                        </div>
                      ) : null
                    })()}

                  {/* Run-level error strip. Driven by the explicit
                          `errored` flag (set when the run ended in an error and
                          carried through reload), NOT a content sniff — so a failed
                          run can never render as a finished one. Mirrors the
                          rate-limit strip below. The error text itself lives in the
                          message content/segments; this strip is the at-a-glance
                          signal. Suppressed when rateLimited (that strip is more
                          specific and owns the retry affordance). */}
                  {msg.role === 'assistant' && msg.errored === true && msg.rateLimited !== true && (
                    <div className="flex items-center gap-1.5 py-1 text-[11px] text-[var(--color-text-muted)]">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500/70" />
                      Run failed — see the message above. Send a follow-up to retry or adjust.
                    </div>
                  )}

                  {/* Rate-limit banner + retry-after countdown.
                          Shows the specific message; while the countdown runs the
                          Retry button is disabled, then enables when it elapses. */}
                  {msg.role === 'assistant' &&
                    msg.rateLimited === true &&
                    (() => {
                      const seconds =
                        rateLimitCountdown && rateLimitCountdown.msgId === msg.id ? rateLimitCountdown.seconds : 0
                      const canRetry = seconds <= 0
                      return (
                        <div className="flex items-center gap-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500/70" />
                          {canRetry ? <span>You can retry now.</span> : <span>Retry available in {seconds}s</span>}
                          {!isGenerating && (
                            <button
                              onClick={() => handleRateLimitRetry(msg.id)}
                              disabled={!canRetry}
                              className="rounded bg-[var(--color-panel)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      )
                    })()}

                  {/* Feedback actions — usage stats live in the Details modal now. */}
                  <div className="flex w-full min-w-0 items-center justify-end gap-2 pt-0.5">
                    <MessageActions
                      msg={msg}
                      onRate={handleRate}
                      onRetry={!isGenerating ? handleRetry : undefined}
                      onRegenerate={!isGenerating ? handleRegenerate : undefined}
                      onDetails={handleDetails}
                      conversationId={activeConversationId}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
    </>
  )
}
