'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useVideoStore } from '@/lib/store'
import type { Scene, ExportFPS } from '@/lib/types'
import type { ChatMessage, ToolCallRecord, AgentType, MessageContent, UsageStats } from '@/lib/agents/types'
import { runModeSpendFlags } from '@/lib/agents/types'
import { StreamingChatPersister } from '@/lib/store/chat-persist'
import { shouldApplyRunEvent } from '@/lib/store/run-event-gate'
import { syncSceneGraphWithScenes } from '@/lib/scene-graph-sync'
import { broadcastAgentStart, broadcastAgentEnd } from '@/lib/store/tab-sync'
import { buildRateLimitNotice } from '@/lib/agents/rate-limit-ui'
import { annotateUnconsumedSteer, AGENT_HISTORY_WINDOW } from '@/lib/agents/steer-ui'
import { assertExportSucceeded } from '@/lib/store/export-outcome'
import { validateExportSettings } from '@/lib/export/export-settings-validation'
import { buildExportPath } from '@/lib/export/export-path'
import { reconcileSceneExportDuration } from '@/lib/export/reconcile-scene-duration'
import { arrayBufferToBase64 } from '@/lib/utils/base64'
import { resolveProjectDimensions } from '@/lib/dimensions'
import {
  streamAgentSse,
  postAgentCaptureResponse,
  postAgentExportResponse,
  postAgentClipResponse,
  waitForRunPersist,
} from '@/lib/agent-transport'
import { computeToolCodeDiff } from '@/lib/utils/tool-code-diff'
import { buildRunFooter, resolveRunOutcome, outcomeToPersistStatus } from '@/lib/agents/run-footer'

type PausedAgentRun = {
  toolName: string
  toolInput: Record<string, unknown>
  agentType?: string | null
  reason?: string | null
  createdAt: string
  /** Cumulative chain spend at the pause → resumeSpentUsd on resume. */
  spentUsd?: number
} | null

/**
 * Branch + version guard for proposal SSE events (0015). A run targets a fixed
 * branch; its proposal events must land only on that branch's card and only if
 * newer than the hydrated branch_proposals row. Moved here from AgentChat with
 * the run controller; used only by runAgentStream.
 */
function isProposalForActiveBranch(event: { branchId?: string | null; version?: number }): boolean {
  const st = useVideoStore.getState()
  const eventBranch = event.branchId ?? null
  const activeBranch = st.projectActiveBranchId ?? null
  if (eventBranch !== activeBranch) return false
  if (typeof event.version === 'number' && event.version <= st.proposalsVersion) return false
  return true
}

/** The project's real export pixel dimensions. */
function resolveExportDims(st: ReturnType<typeof useVideoStore.getState>): { width: number; height: number } {
  return resolveProjectDimensions(st.project?.mp4Settings?.aspectRatio, st.project?.mp4Settings?.resolution)
}

/**
 * Render ONE scene to MP4 bytes in the renderer.
 *
 * Extracted from the `clip_request` handler so the agent's scene-scoped EXPORT
 * (export(scope:'scene')) and the motion-review clip share one implementation
 * instead of a copy. The only difference between the two callers is the scale cap
 * and the duration cap, both parameters here.
 *
 * `maxRes` caps the LONGEST side; the HTML is generated at the same (possibly
 * reduced) dims as the export canvas so the scene's WIDTH/HEIGHT globals match the
 * surface it renders onto. Duration is the RECONCILED export duration (a ready
 * avatar/Veo clip grows the scene), clamped to `maxSeconds`.
 */
async function renderSceneMp4(
  sceneId: string,
  opts: { maxRes: number; fps: number; maxSeconds: number; profile: 'fast' | 'quality' },
): Promise<ArrayBuffer> {
  const st = useVideoStore.getState()
  const scene = st.scenes.find((s) => s.id === sceneId)
  if (!scene) throw new Error(`scene ${sceneId} not found`)

  const { exportSolidSceneMp4 } = await import('@/lib/export2/pixi-mp4')
  const { generateSceneHTML } = await import('@/lib/sceneTemplate')

  // Fetch the full scene from the DB — in-memory fields may be empty (the
  // localStorage partialize strips svgContent/sceneCode).
  let fullScene = scene
  try {
    const sceneIpc = window.dreambyteApi?.scene
    if (sceneIpc && st.project?.id) {
      const fullData = await sceneIpc.get({ projectId: st.project.id, sceneId: scene.id })
      if (fullData?.scene) fullScene = { ...scene, ...(fullData.scene as Partial<typeof scene>) }
    }
  } catch {}

  const base = resolveProjectDimensions(st.project?.mp4Settings?.aspectRatio, st.project?.mp4Settings?.resolution)
  const scale = Math.min(1, opts.maxRes / Math.max(base.width, base.height))
  const toEven = (n: number) => {
    const v = Math.max(2, Math.round(n * scale))
    return v % 2 === 0 ? v : v + 1
  }
  const dims = { width: toEven(base.width), height: toEven(base.height) }
  const freshHTML = generateSceneHTML(fullScene, st.globalStyle, undefined, st.audioSettings, dims)
  const durationSeconds = Math.min(reconcileSceneExportDuration(fullScene).duration || 0, opts.maxSeconds)

  return exportSolidSceneMp4({
    sceneId: fullScene.id,
    width: dims.width,
    height: dims.height,
    fps: opts.fps,
    durationSeconds,
    sceneType: fullScene.sceneType,
    svgContent: fullScene.svgContent,
    sceneHTML: freshHTML,
    bgColor: fullScene.bgColor || '#000000',
    videoSrc: fullScene.videoLayer?.enabled ? fullScene.videoLayer.src : null,
    videoOpacity: fullScene.videoLayer?.opacity ?? 1,
    trimStart: fullScene.videoLayer?.trimStart ?? 0,
    trimEnd: fullScene.videoLayer?.trimEnd ?? null,
    textOverlays: fullScene.textOverlays as never,
    svgObjects: fullScene.svgObjects as never,
    aiLayers: fullScene.aiLayers as never,
    layerHiddenIds: fullScene.layerHiddenIds ?? [],
    layerPanelOrder: fullScene.layerPanelOrder ?? [],
    cameraMotion: fullScene.cameraMotion as never,
    audioSrc: fullScene.audioLayer?.enabled ? fullScene.audioLayer.src : null,
    audioStartOffset: fullScene.audioLayer?.startOffset ?? 0,
    audioVolume: fullScene.audioLayer?.volume ?? 1,
    audioFadeIn: fullScene.audioLayer?.fadeIn ?? false,
    audioFadeOut: fullScene.audioLayer?.fadeOut ?? false,
    audioLayer: fullScene.audioLayer as never,
    profile: opts.profile,
  })
}

/**
 * Imperative surface AgentChat drives from its SSE `onEvent` handler. The
 * high-frequency text + thinking values live INSIDE the StreamingMessage leaf (see
 * useThrottledStream), so per-token pushes re-render only StreamingMessage —
 * not the 4849-line AgentChat parent. AgentChat holds a ref, never per-token
 * state.
 */
export interface StreamingHandle {
  /** token event: pass the FULL accumulated text. Throttled (~30fps). */
  pushText: (full: string) => void
  /** Force the buffered text to render now (tool-call boundary / stream end). */
  flushText: () => void
  /** thinking_token: pass the FULL accumulated thinking. Throttled. */
  pushThinking: (full: string) => void
  /** thinking_complete: set final thinking immediately. */
  flushThinking: (full: string) => void
  /** thinking_start: clear thinking + cancel pending flush. */
  resetThinking: () => void
  /** finally / run start: clear both streams + cancel timers (identity guard). */
  resetAll: () => void
}

/**
 * The agent run controller: owns all streaming state + refs, the
 * run-lifecycle effects (abort-on-unmount, abort-nonce, scene-lock), and the
 * ~940-line runAgentStream SSE driver. Extracted verbatim from AgentChat. The
 * store actions it needs are read from the store directly; `scene` and
 * `persistPausedAgentRun` are passed in (the latter is also used by AgentChat's
 * permission/resume handlers). AgentChat destructures the return; handleAbort,
 * handleSend, rerun, etc. stay there and use the returned refs/state.
 */
export function useAgentRun({
  scene,
  persistPausedAgentRun,
}: {
  scene?: Scene | null
  persistPausedAgentRun: (paused: PausedAgentRun) => Promise<void>
}) {
  const updateChatMessage = useVideoStore((s) => s.updateChatMessage)
  const persistChatMessage = useVideoStore((s) => s.persistChatMessage)
  const persistStreamingChatMessage = useVideoStore((s) => s.persistStreamingChatMessage)

  const [isGenerating, setIsGenerating] = useState(false)
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null)
  const [rateLimitCountdown, setRateLimitCountdown] = useState<{ msgId: string; seconds: number } | null>(null)
  const activeLocalRunIdRef = useRef<string | null>(null)
  const [steerReady, setSteerReady] = useState(false)
  const streamingRef = useRef<StreamingHandle>(null)
  const [streamingSegments, setStreamingSegments] = useState<
    Array<{ type: 'text'; text: string } | { type: 'tool'; call: ToolCallRecord } | { type: 'thinking'; text: string }>
  >([])
  const lastSnapshotTextRef = useRef('')
  const [activeToolName, setActiveToolName] = useState<string | null>(null)
  const [isThinkingStreaming, setIsThinkingStreaming] = useState(false)
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallRecord[]>([])
  const [currentIteration, setCurrentIteration] = useState<{ iteration: number; max: number } | null>(null)
  const [runProgress, setRunProgress] = useState<{
    toolCallsUsed: number
    toolCallsMax: number
    costUsd: number
    costMax: number
    inputTokens: number
    outputTokens: number
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fanoutSpecRef = useRef<{ count: number; instruction: string; sourceBranchId: string | null } | null>(null)
  const lastAgentRequestRef = useRef<Record<string, unknown> | null>(null)
  const crossProjectSpecRef = useRef<{ instruction: string; originBody: Record<string, unknown> | null } | null>(null)
  const lastRunAbortedRef = useRef(false)

  // Abort any in-flight agent SSE stream on unmount to prevent zombie connections
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  // Subscribe to abort nonce — abort in-flight stream when conversation switches
  const abortNonce = useVideoStore((s) => s._abortNonce)
  const abortNonceRef = useRef(abortNonce)
  useEffect(() => {
    if (abortNonceRef.current !== abortNonce) {
      abortNonceRef.current = abortNonce
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [abortNonce])

  // Agent run lifecycle (cursor model): keyed on streamingMsgId. On run start the
  // store action captures the pre-run undo snapshot (keyed by msgId for rewind-restore) +
  // acquires the scene lock; cleanup releases on run end / unmount.
  const setAgentRunSceneLock = useVideoStore((s) => s.setAgentRunSceneLock)
  useEffect(() => {
    setAgentRunSceneLock(streamingMsgId != null, streamingMsgId)
    return () => setAgentRunSceneLock(false)
  }, [streamingMsgId, setAgentRunSceneLock])

  const runAgentStream = useCallback(
    async (opts: {
      messageContent: MessageContent
      pendingAssistantMsg: ChatMessage
      forceAgentOverride?: AgentType
      /** Force plan-first mode for this run regardless of the store toggle
       *  (used by the /plan slash command). */
      forcePlanFirst?: boolean
      resumeToolCall?: { toolName: string; toolInput: Record<string, unknown> } | null
      /** This run EXECUTES an approved plan — a re-issued write_plan
       *  during the build updates todos in place and must not re-open the
       *  plan approval gate. */
      planBuildRun?: boolean
      extraBody?: Record<string, unknown>
      /** The just-appended user message for THIS turn. It travels separately as
       *  `message` (runner appends it after history), so its chatMessages copy
       *  is excluded from the history slice — no duplicate tokens, and the
       *  cliff note's "last N" counts real prior context. */
      currentUserMsgId?: string
    }) => {
      const {
        messageContent,
        pendingAssistantMsg,
        forceAgentOverride,
        forcePlanFirst,
        resumeToolCall,
        planBuildRun,
        extraBody,
        currentUserMsgId,
      } = opts
      // The plan card proposal only lands when this run is NOT executing an
      // already-approved plan (the written plan is the only user-facing planning
      // artifact).
      const showPlanProposal = !planBuildRun

      // Block if agent is running in another tab
      if (useVideoStore.getState().isAgentRunningRemote) {
        updateChatMessage(pendingAssistantMsg.id, { content: 'Agent is already running in another tab.' })
        return
      }

      setIsGenerating(true)
      setStreamingMsgId(pendingAssistantMsg.id)
      // No streaming-text reset needed: <StreamingMessage> mounts fresh (empty)
      // when isGenerating flips true.
      setIsThinkingStreaming(false)
      setStreamingToolCalls([])
      setCurrentIteration(null)
      setRunProgress(null)

      // Broadcast run start to other tabs
      const projectId = useVideoStore.getState().project?.id
      if (projectId) broadcastAgentStart(projectId)

      // A3: snapshot the project's DB version BEFORE the run so the post-run
      // refresh can wait for the persist to advance it past this value (the
      // version-poll fallback to the out-of-band persist_done signal). Best-
      // effort — a missing reader leaves preRunVersion null and the refresh
      // behaves as before (immediate).
      let preRunVersion: number | null = null
      if (projectId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await (window as any).dreambyteApi?.projects?.getVersion?.(projectId)
          if (typeof res?.version === 'number') preRunVersion = res.version
        } catch {
          /* leave null — refresh stays immediate */
        }
      }
      // Capture the conversation ID this stream belongs to (for the conversation-switch stale check)
      const streamConversationId = useVideoStore.getState().activeConversationId

      // INSERT placeholder in DB immediately — survives page refresh during streaming
      await persistChatMessage(pendingAssistantMsg.id, { status: 'streaming' })

      const st = useVideoStore.getState()
      // A2: window size shared with the visible cliff note (steer-ui) so the
      // indicator can never lie about what the agent actually receives.
      // Excluded as in-flight filler: the empty assistant
      // placeholder just appended for streaming, and this turn's user message
      // (the runner appends `message` after history — keeping it here sent the
      // same content twice every turn).
      const historyMsgs = st.chatMessages
        .filter((m) => m.id !== pendingAssistantMsg.id && (currentUserMsgId == null || m.id !== currentUserMsgId))
        .slice(-AGENT_HISTORY_WINDOW)
        .map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
        }))

      const controller = new AbortController()
      abortRef.current = controller

      let accumulatedText = ''
      let lastSegmentSnapshotText = ''
      let thinkingAccumulated = ''
      let finalAgentType: AgentType | undefined
      let finalModelId: string | undefined
      let finalUsage: UsageStats | undefined
      // Last run_progress snapshot — used to synthesize a usage footer when a run
      // is ABORTED (the `done` event, which carries the real usage, never arrives).
      let lastProgress: { costUsd: number; inputTokens?: number; outputTokens?: number } | undefined
      let finalGenerationLogId: string | undefined
      let finalSyncReceived = false
      // The run hit an error. The runner emits an error event THEN a
      // done event; this flag makes the error text survive `done` (instead of
      // being overwritten with the model's last fullText) and drives the error strip +
      // status:'error' persist in the finalizer.
      let errored = false
      const toolCalls: ToolCallRecord[] = []
      // Per-RUN last-written code map for inline diffs. Sequential writes
      // to the same scene within one run diff against each other; the store
      // scene (still pre-run until the end-of-run persist) is the fallback.
      const lastWrittenCode = new Map<string, string>()
      const accumulatedSources: import('@/lib/agents/types').ResearchSource[] = []
      const seenSourceUrls = new Set<string>()
      const segments: import('@/lib/agents/types').MessageSegment[] = []
      const pendingPermissions: import('@/lib/agents/types').PendingPermission[] = []
      // A run pauses on exactly ONE ask_user at a time → a single record. The
      // resume payload (toolName/toolInput) is carried so the answer path reads
      // it from the message, not the singular pausedAgentRun.
      let pendingClarification: {
        id: string
        question: string
        options?: string[]
        toolName: string
        toolInput: Record<string, unknown>
      } | null = null
      // The paused-run record persisted this stream (permission OR clarification),
      // re-stamped with the cumulative spend once the pause `done` arrives so a
      // resume can seed its cost ledger (carry-across-pause).
      let lastPausePersist: PausedAgentRun | null = null
      const finalSyncTasks: Promise<Error | null>[] = []

      // Incremental persist: debounced ~2s, seq-guarded streaming
      // upsert via the extracted StreamingChatPersister. It carries the live
      // runId + a monotonic seq so the persist layer rejects stale/out-of-order
      // writes, retries once on failure, and NEVER throws into this stream loop.
      // The local store row is still updated synchronously here so the visible
      // message tracks the latest tokens regardless of persist outcome.
      const persister = new StreamingChatPersister({
        messageId: pendingAssistantMsg.id,
        runId: activeLocalRunIdRef.current,
        persistFn: (a) =>
          persistStreamingChatMessage({
            messageId: a.messageId,
            runId: a.runId,
            seq: a.seq,
            content: a.snapshot.content,
            toolCalls: a.snapshot.toolCalls,
            contentSegments: a.snapshot.contentSegments,
            thinking: a.snapshot.thinking,
          }),
        getSnapshot: () => ({
          content: accumulatedText,
          toolCalls: [...toolCalls],
          contentSegments: [...segments],
          thinking: thinkingAccumulated || undefined,
        }),
      })
      let lastPersistTime = Date.now()
      const PERSIST_INTERVAL_MS = 15_000
      const debouncedPersist = () => {
        updateChatMessage(pendingAssistantMsg.id, {
          content: accumulatedText,
          toolCalls: [...toolCalls],
          contentSegments: [...segments],
          thinking: thinkingAccumulated || undefined,
        })
        persister.schedule()
        lastPersistTime = Date.now()
      }

      try {
        const lightScenes = st.scenes.map((s) => {
          if (scene && s.id === scene.id) return s
          const { sceneHTML, svgContent, canvasCode, sceneCode, lottieSource, ...rest } = s
          return {
            ...rest,
            svgContent: svgContent ? `[${svgContent.length} chars]` : '',
            canvasCode: canvasCode ? `[${canvasCode.length} chars]` : '',
            sceneCode: sceneCode ? `[${sceneCode.length} chars]` : '',
            lottieSource: lottieSource ? `[${lottieSource.length} chars]` : '',
            sceneHTML: '',
          }
        })

        const apiAgentOverride = forceAgentOverride ?? undefined

        // When local mode is on, override the model to the selected local model
        const effectiveModelOverride =
          st.localMode && st.localModelId ? st.localModelId : (st.modelOverride ?? undefined)

        // Snapshot the editor UI state once at run start so the agent can
        // answer "what am I looking at?" via `read_editor_state`. We do NOT
        // re-snapshot mid-run; that would race with the user's interactions.
        const editorStateSnapshot = {
          selectedSceneId: scene?.id ?? null,
          selectedClipIds: [...(st.selectedClipIds ?? [])],
          currentTime: st.timelineTransport?.globalTime ?? 0,
          isPlaying: st.timelineTransport?.isPlaying ?? false,
          totalDuration: st.timelineTransport?.totalDuration ?? 0,
          timelineZoom: st.timelineZoom ?? 0,
          capturedAt: new Date().toISOString(),
        }

        const agentRequest: Record<string, unknown> = {
          message: messageContent,
          agentOverride: apiAgentOverride,
          modelOverride: effectiveModelOverride,
          modelTier: st.modelTier,
          thinkingMode: st.localMode ? 'off' : st.thinkingMode,
          sceneContext: st.sceneContext,
          activeTools: st.activeTools,
          history: historyMsgs,
          projectId: st.project.id,
          branchId: st.projectActiveBranchId ?? null,
          // Thread audio settings so add_narration honors the user's default TTS
          // provider (e.g. pocket-tts) + local-server URLs — otherwise the
          // resolver only sees process.env and silently ignores the setting.
          audioSettings: st.audioSettings ?? null,
          conversationId: st.activeConversationId,
          scenes: lightScenes,
          globalStyle: st.globalStyle,
          projectName: st.project.name,
          outputMode: st.project.outputMode,
          sceneGraph: st.project.sceneGraph,
          // Seed the agent's world with the REAL project
          // timeline so clip-targeting tools (move/trim/remove) hit the user's
          // actual clips instead of a fabricated single-track world. The
          // editorStateSnapshot above only carries transport time/zoom (read-
          // only); this is the authoritative track/clip state. Null when the
          // user has never opened the timeline — init_timeline fabricates a
          // fallback only in that case (runner world seed → timeline-tools).
          timeline: st.project.timeline ?? null,
          selectedSceneId: scene?.id ?? null,
          editorState: editorStateSnapshot,
          previewMode: st.previewMode ?? 'off',
          runBudgetUsd: st.runBudgetUsd,
          audioProviderEnabled: st.audioProviderEnabled,
          mediaGenEnabled: st.mediaGenEnabled,
          mediaUnderstandingEngines: st.mediaUnderstandingEngines,
          webSearchEnabled: st.webSearchEnabled,
          webFetchEnabled: st.webFetchEnabled,
          autoAcceptWebSearch: st.autoAcceptWebSearch,
          researchProviderEnabled: st.researchProviderEnabled,
          researchModelId: st.researchModelId,
          ytDlpConsentedProjectIds: st.ytDlpConsentedProjectIds,
          enabledModelIds: st.modelConfigs
            .filter((m) => m.enabled)
            .flatMap((m) => (m.id !== m.modelId ? [m.modelId, m.id] : [m.modelId])),
          apiPermissions: st.project.apiPermissions,
          sessionPermissions: Object.fromEntries(st.sessionPermissions),
          generationOverrides: st.generationOverrides,
          autoChooseDefaults: st.autoChooseDefaults,
          localMode: st.localMode,
          mockMode: st.mockMode,
          mp4Settings: st.project.mp4Settings,
          planFirstMode: st.planFirstMode || forcePlanFirst === true,
          // Standing opt-in to sub-agents (Settings → Agents). Off by default; the
          // runner also enables them when the message explicitly asks.
          subAgents: st.subAgents,
          // Sandbox + permission posture derived from the run-mode picker (the
          // single source of truth). Before this, only planFirstMode was sent, so
          // selecting Sandbox/Ask in the picker was inert for the in-app agent —
          // the backend enforcement (asset-gateway / tool-executor posture gate)
          // was already live but never received the flags.
          ...runModeSpendFlags(st.agentRunMode),
          ...(st.localMode ? { modelConfigs: st.modelConfigs.filter((m) => m.provider === 'local') } : {}),
          ...(resumeToolCall ? { resumeToolCall } : {}),
          ...(extraBody ?? {}),
        }

        // Whether THIS run is a Plan-first run (agent stops for approval
        // after writing its plan). Drives whether the plan card shows an
        // Approve & build gate vs. a transparent live-progress plan.
        const isPlanFirstRun = agentRequest.planFirstMode === true

        // Remember the body that started this run so a post-run
        // cross-project dispatch (dispatch_to_projects) can fan it out as origin.
        // Clear any stale spec first — a crossproject_proposed left behind by a
        // non-handleSend run (e.g. an approve-plan turn that doesn't drain it)
        // must NOT fire here with this run's body + that run's instruction.
        lastAgentRequestRef.current = agentRequest
        crossProjectSpecRef.current = null

        // SSE stream — transport lives in src/lib/agent-transport.ts so
        // src/components/AgentChat.tsx stays agnostic to fetch vs IPC events.
        //
        // Capture the branch this run is scoped to (the request's branchId, set
        // above). A branch switch aborts the live run via _abortNonce
        // asynchronously, so late stream events that mutate project state can
        // land after the active branch flips. We gate those handlers on
        // shouldApplyRunEvent(runBranchId, currentActiveBranchId) so a branch-A
        // run never writes onto branch B.
        const runBranchId = (agentRequest.branchId as string | null) ?? null
        await streamAgentSse(agentRequest, {
          signal: controller.signal,
          // Capture the live runId so the composer can steer THIS run and
          // so each streaming partial carries it; also begin action-log
          // grouping under it so one Cmd+Z undoes the whole run via the action
          // stack.
          onRunId: (id) => {
            activeLocalRunIdRef.current = id
            persister.setRunId(id)
            setSteerReady(true) // composer hint flips to "steer" mode
            useVideoStore.getState().beginAgentRun(id)
          },
          onEvent: (event) => {
            switch (event.type) {
              case 'run_start':
                if (event.runId) {
                  activeLocalRunIdRef.current = event.runId // backup if onRunId was missed
                  persister.setRunId(event.runId)
                  setSteerReady(true) // idempotent backup
                  useVideoStore.getState().beginAgentRun(event.runId) // idempotent backup
                }
                break

              // A mid-run steer reached the model — the optimistic message stands as-is.
              case 'steer_consumed':
                break

              // A queued steer never reached the model before the run ended (cap /
              // abort / orchestration). Mark it so the user knows it wasn't applied
              // and can resend — never silently dropped.
              case 'steer_unconsumed':
                for (const id of event.ids ?? []) {
                  const existing = useVideoStore.getState().chatMessages.find((m) => m.id === id)
                  if (existing && typeof existing.content === 'string') {
                    updateChatMessage(id, { content: annotateUnconsumedSteer(existing.content) })
                  }
                }
                break

              case 'thinking_start':
                thinkingAccumulated = ''
                setIsThinkingStreaming(true)
                streamingRef.current?.resetThinking()
                break

              case 'thinking_token':
                if (event.token) {
                  thinkingAccumulated += event.token
                  streamingRef.current?.pushThinking(thinkingAccumulated)
                }
                break

              case 'thinking_complete': {
                setIsThinkingStreaming(false)
                const fullThinking = event.fullThinking
                if (fullThinking) {
                  thinkingAccumulated = fullThinking
                  // Commit this reasoning block as an interleaved segment so it
                  // renders BETWEEN the tool calls it happened between (not lumped
                  // at the end). Snapshot any pending text first to preserve
                  // chronological order, then clear the live thinking buffer so the
                  // committed segment doesn't also duplicate at the status line.
                  {
                    const newText = accumulatedText.slice(lastSegmentSnapshotText.length).trim()
                    if (newText) segments.push({ type: 'text', text: newText })
                    lastSegmentSnapshotText = accumulatedText
                    segments.push({ type: 'thinking', text: fullThinking })
                  }
                  setStreamingSegments((prev) => {
                    const next = [...prev]
                    const newText = accumulatedText.slice(lastSnapshotTextRef.current.length).trim()
                    if (newText) next.push({ type: 'text', text: newText })
                    lastSnapshotTextRef.current = accumulatedText
                    next.push({ type: 'thinking', text: fullThinking })
                    return next
                  })
                  streamingRef.current?.resetThinking()
                }
                break
              }

              case 'token':
                if (event.token) {
                  accumulatedText += event.token
                  streamingRef.current?.pushText(accumulatedText)
                  // Time-based incremental persist for long text-only streams
                  if (Date.now() - lastPersistTime > PERSIST_INTERVAL_MS) {
                    debouncedPersist()
                  }
                }
                break

              case 'iteration_start':
                if (event.iteration && event.maxIterations) {
                  setCurrentIteration({ iteration: event.iteration, max: event.maxIterations })
                }
                break

              case 'run_progress':
                if (event.runProgress) {
                  setRunProgress({
                    toolCallsUsed: event.runProgress.toolCallsUsed,
                    toolCallsMax: event.runProgress.toolCallsMax,
                    costUsd: event.runProgress.costUsd,
                    costMax: event.runProgress.costMax,
                    inputTokens: event.runProgress.inputTokens ?? 0,
                    outputTokens: event.runProgress.outputTokens ?? 0,
                  })
                  lastProgress = {
                    costUsd: event.runProgress.costUsd,
                    inputTokens: event.runProgress.inputTokens,
                    outputTokens: event.runProgress.outputTokens,
                  }
                }
                break

              case 'tool_start':
                setActiveToolName(event.toolName ?? null)
                break

              case 'capture_request': {
                // Server is asking us to render the scene and POST the image
                // back so it can be attached to the capture_frame tool_result.
                const capId = event.captureId
                const capSceneId = event.sceneId
                const capTime = typeof event.captureTime === 'number' ? event.captureTime : 0
                if (!capId || !capSceneId) break
                void (async () => {
                  try {
                    const dataUrl = await useVideoStore.getState().captureSceneFrame(capSceneId, capTime)
                    if (!dataUrl) {
                      await postAgentCaptureResponse({ captureId: capId, error: 'no capturer registered' })
                      return
                    }
                    const mimeMatch = dataUrl.match(/^data:([^;,]+)/)
                    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'
                    await postAgentCaptureResponse({ captureId: capId, dataUri: dataUrl, mimeType })
                  } catch (err) {
                    await postAgentCaptureResponse({
                      captureId: capId,
                      error: (err as Error).message || 'capture failed',
                    }).catch(() => {})
                  }
                })()
                break
              }

              case 'clip_request': {
                // Server is asking us to export ONE scene to a low-res MP4 and
                // POST the bytes back, so the agent's motion-review pass can watch
                // it actually play (motion A1) + hear its audio (sync A2). Mirrors
                // the whole-project export_request, but per-scene + bytes-inline
                // (small clip, sent straight to the video model — no temp file).
                const clipId = event.clipId
                const clipSceneId = event.sceneId
                if (!clipId || !clipSceneId) break
                const maxRes = typeof event.maxRes === 'number' ? event.maxRes : 720
                const clipFps = typeof event.fps === 'number' ? event.fps : 24
                void (async () => {
                  try {
                    // Bound the render work: a review clip never needs the full length of a
                    // pathologically long scene — motion/sync defects show in the opening
                    // seconds, and capping keeps the renderer inside the runner's clip
                    // timeout. Normal scenes (a few to ~20s) are unaffected.
                    const MAX_REVIEW_CLIP_SECONDS = 60
                    const buf = await renderSceneMp4(clipSceneId, {
                      maxRes,
                      fps: clipFps,
                      maxSeconds: MAX_REVIEW_CLIP_SECONDS,
                      profile: 'fast',
                    })

                    // Keep the clip under Gemini's ~20MB inline REQUEST ceiling.
                    // The bytes ride as base64, which inflates ~33%, so the raw cap
                    // must be ~14MB (14 × 1.34 ≈ 18.7MB encoded) to stay safely under
                    // 20MB. Low-res export should land well under this; if not, report
                    // an error so the runner degrades to frames rather than ship a
                    // payload Gemini will reject after a full render + IPC round-trip.
                    const CLIP_MAX_BYTES = 14 * 1024 * 1024
                    if (buf.byteLength > CLIP_MAX_BYTES) {
                      await postAgentClipResponse({
                        clipId,
                        error: `clip too large for inline review (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB > 14MB raw / ~20MB base64)`,
                      })
                      return
                    }
                    const dataUri = `data:video/mp4;base64,${arrayBufferToBase64(buf)}`
                    await postAgentClipResponse({ clipId, dataUri, mimeType: 'video/mp4' })
                  } catch (err) {
                    await postAgentClipResponse({
                      clipId,
                      error: (err as Error).message || 'clip export failed',
                    }).catch(() => {})
                  }
                })()
                break
              }

              case 'export_request': {
                // Server is asking us to produce the project and POST the result back,
                // so the agent reports the artifact instead of opening a modal. ONE event
                // for all three formats the `export` tool offers — the FCPXML writer and
                // the publish IPC both live here in the renderer, which is why they never
                // had an agent tool before.
                const expId = event.exportId
                if (!expId) break
                const exSettings = event.exportSettings ?? {}
                void (async () => {
                  try {
                    // Absent format === 'mp4': every replayed conversation and every
                    // pre-`export`-tool caller omits it.
                    const exFormat = (exSettings as { format?: string }).format ?? 'mp4'

                    if (exFormat === 'fcpxml') {
                      const st = useVideoStore.getState()
                      const dims = resolveExportDims(st)
                      const res = await window.electronAPI?.exportFcpxml?.({
                        timeline: st.project?.timeline,
                        fps: validateExportSettings(exSettings).fps,
                        width: dims.width,
                        height: dims.height,
                        name: st.project?.name ?? 'Dreambyte Timeline',
                      })
                      if (!res) {
                        await postAgentExportResponse({ exportId: expId, error: 'FCPXML export unavailable' })
                      } else if (res.canceled) {
                        await postAgentExportResponse({ exportId: expId, error: 'FCPXML export cancelled by the user' })
                      } else if (!res.saved || !res.path) {
                        await postAgentExportResponse({ exportId: expId, error: res.error || 'FCPXML export failed' })
                      } else {
                        await postAgentExportResponse({ exportId: expId, outputPath: res.path })
                      }
                      return
                    }

                    if (exFormat === 'embed') {
                      // publishProject() swallows its own errors into publishError, so read
                      // the outcome back rather than trusting the call to throw.
                      await useVideoStore.getState().publishProject?.()
                      const st = useVideoStore.getState()
                      if (st.publishedUrl) {
                        await postAgentExportResponse({ exportId: expId, outputPath: st.publishedUrl })
                      } else {
                        await postAgentExportResponse({
                          exportId: expId,
                          error: st.publishError || 'publish failed',
                        })
                      }
                      return
                    }

                    const dir = await window.electronAPI?.getDefaultExportDir?.()
                    if (!dir?.dirPath) {
                      await postAgentExportResponse({ exportId: expId, error: 'no export directory available' })
                      return
                    }
                    const outputPath = buildExportPath(useVideoStore.getState().project?.name, dir.dirPath, new Date())
                    const { resolution, fps } = validateExportSettings(exSettings)

                    // scope:'scene' — render just this scene through the SAME per-scene
                    // renderer the motion-review clip uses, then write the bytes out.
                    const oneSceneId = (exSettings as { sceneId?: string }).sceneId
                    if (oneSceneId) {
                      const st = useVideoStore.getState()
                      const dims = resolveExportDims(st)
                      const buf = await renderSceneMp4(oneSceneId, {
                        maxRes: Math.max(dims.width, dims.height),
                        fps: fps as number,
                        maxSeconds: Number.POSITIVE_INFINITY,
                        profile: (exSettings as { profile?: 'fast' | 'quality' }).profile ?? 'quality',
                      })
                      await window.electronAPI?.writeFile?.({ filePath: outputPath, bytes: buf })
                      await postAgentExportResponse({ exportId: expId, outputPath })
                      return
                    }

                    await useVideoStore.getState().exportVideo({
                      resolution,
                      fps: fps as ExportFPS,
                      format: 'mp4',
                      outputPath,
                      ...((exSettings as { profile?: 'fast' | 'quality' }).profile
                        ? { profile: (exSettings as { profile: 'fast' | 'quality' }).profile }
                        : {}),
                      ...((exSettings as { burnCaptions?: boolean }).burnCaptions != null
                        ? { burnCaptions: (exSettings as { burnCaptions: boolean }).burnCaptions }
                        : {}),
                    })
                    // exportVideo() THROWS on render failure,
                    // so the catch below handles the failure path. assertExportSucceeded
                    // is kept as a defense-in-depth check on the recorded outcome
                    // (e.g. an interrupted run left at 'rendering' without throwing),
                    // so a failed render is never reported back as a finished file.
                    assertExportSucceeded(useVideoStore.getState().exportProgress)
                    await postAgentExportResponse({ exportId: expId, outputPath })
                  } catch (err) {
                    // 11b: carry the failing-scene context (exportVideo's catch
                    // stamped it on the progress slot) so the in-app job gets
                    // the same structured errorSceneIndex/errorSceneId as the
                    // MCP path — not just the message prefix.
                    const failSlot = useVideoStore.getState().exportProgress
                    await postAgentExportResponse({
                      exportId: expId,
                      error: (err as Error).message || 'export failed',
                      ...(failSlot?.phase === 'error' && failSlot.errorSceneIndex != null
                        ? { sceneIndex: failSlot.errorSceneIndex, sceneId: failSlot.errorSceneId ?? undefined }
                        : {}),
                    }).catch(() => {})
                  }
                })()
                break
              }

              case 'tool_complete':
                if (event.toolResult) {
                  // Boundary flush: catch the leaf's throttled text up to
                  // accumulatedText BEFORE the snapshot advances below, so any
                  // trailing live text collapses cleanly into the committed
                  // segment instead of duplicating or flashing empty.
                  streamingRef.current?.flushText()
                  const callRecord: ToolCallRecord = {
                    id: crypto.randomUUID(),
                    toolName: event.toolName ?? 'unknown',
                    input: event.toolInput ?? {},
                    output: event.toolResult,
                  }
                  // Attach an inline diff for code-writing tools when the
                  // setting is on. Successful calls only — a failed write
                  // mutated nothing, so a diff would lie.
                  if (useVideoStore.getState().inlineDiffsEnabled && event.toolResult.success) {
                    const diff = computeToolCodeDiff(
                      callRecord.toolName,
                      callRecord.input,
                      useVideoStore.getState().scenes,
                      lastWrittenCode,
                    )
                    if (diff) callRecord.codeDiff = diff
                  }
                  toolCalls.push(callRecord)
                  setStreamingToolCalls((prev) => [...prev, callRecord])
                  // Build interleaved segments: snapshot any new text before this tool call
                  {
                    const newText = accumulatedText.slice(lastSegmentSnapshotText.length).trim()
                    if (newText) {
                      segments.push({ type: 'text', text: newText })
                    }
                    lastSegmentSnapshotText = accumulatedText
                    segments.push({ type: 'tool', toolCallId: callRecord.id })
                  }
                  setStreamingSegments((prev) => {
                    const newSegments = [...prev]
                    const newText = accumulatedText.slice(lastSnapshotTextRef.current.length).trim()
                    if (newText) {
                      newSegments.push({ type: 'text', text: newText })
                    }
                    lastSnapshotTextRef.current = accumulatedText
                    newSegments.push({ type: 'tool', call: callRecord })
                    return newSegments
                  })
                  if (event.toolResult.permissionNeeded) {
                    const pn = event.toolResult.permissionNeeded
                    const alreadyTracked = pendingPermissions.some((p) => p.api === pn.api && p.kind === pn.kind)
                    if (!alreadyTracked) {
                      pendingPermissions.push({
                        api: pn.api,
                        estimatedCost: pn.estimatedCost,
                        toolName: pn.toolName ?? event.toolName ?? 'unknown',
                        kind: pn.kind,
                        generationType: pn.generationType,
                        prompt: pn.prompt,
                        provider: pn.provider,
                        availableProviders: pn.availableProviders,
                        config: pn.config,
                        toolArgs: pn.toolArgs,
                        // Tier 3 Cast biometric_consent: fields the consent card + record-on-approve need.
                        destination: pn.destination,
                        consentVersion: pn.consentVersion,
                        voiceName: pn.voiceName,
                        reason: pn.reason,
                      })
                    }
                    if (event.toolName && event.toolInput) {
                      lastPausePersist = {
                        toolName: event.toolName,
                        toolInput: event.toolInput,
                        agentType: forceAgentOverride ?? null,
                        reason: `permission:${pn.api}`,
                        createdAt: new Date().toISOString(),
                      }
                      void persistPausedAgentRun(lastPausePersist)
                    }
                  }
                  // ask_user clarify pause — mirror the permission capture. Record
                  // the question for the card; persist the paused run so the answer
                  // resumes by re-issuing ask_user with `_answer` injected.
                  if (event.toolResult.clarificationNeeded && event.toolName && event.toolInput) {
                    const cn = event.toolResult.clarificationNeeded
                    // Carry the resume payload ON the message — answerClarification
                    // reads it from here (not the singular pausedAgentRun), so it
                    // survives a re-pause and multiple outstanding cards.
                    pendingClarification = {
                      id: cn.id,
                      question: cn.question,
                      options: cn.options,
                      toolName: event.toolName,
                      toolInput: event.toolInput,
                    }
                    // Also persist a paused-run record (resume-after-reload fallback);
                    // the live answer path reads from the message above.
                    lastPausePersist = {
                      toolName: event.toolName,
                      toolInput: event.toolInput,
                      agentType: forceAgentOverride ?? null,
                      reason: 'clarification',
                      createdAt: new Date().toISOString(),
                    }
                    void persistPausedAgentRun(lastPausePersist)
                  }
                }
                setActiveToolName(null)
                // Incremental persist after tool calls
                debouncedPersist()
                break

              // Gap 3.1: post-build cut review proposed whole-scene cuts. Open the
              // structural-cuts review card (the agent recommends; the user disposes).
              // 0015: the SERVER already persisted these to branch_proposals keyed
              // (projectId, branchId) and stamped branchId/version on the event, so
              // the client only updates in-memory state — no IPC write here. The
              // branch + version guard rejects a card meant for another branch or a
              // stale/late event after a switch-back.
              case 'structural_cuts_proposed':
                if (event.cuts && event.cuts.length > 0 && isProposalForActiveBranch(event)) {
                  useVideoStore.getState().setStructuralCutsProposed(event.cuts)
                  if (typeof event.version === 'number') {
                    useVideoStore.setState({ proposalsVersion: event.version })
                  }
                }
                break

              // Agentic plan surface. The plan card renders from these.
              // During an approved build (planBuildRun) we KEEP the approved plan
              // on screen and do not let a re-issued write_plan reset it — only
              // todos stream live so progress shows.
              case 'plan_proposed':
                if (event.plan && showPlanProposal) {
                  useVideoStore.getState().setPendingPlan(event.plan, isPlanFirstRun)
                  if (event.todos) useVideoStore.getState().setPlanTodos(event.todos)
                }
                break

              case 'todos_updated':
                if (event.todos) useVideoStore.getState().setPlanTodos(event.todos)
                break

              case 'state_change': {
                if (event.generationLogId) finalGenerationLogId = event.generationLogId
                // Branch gate: if the active branch flipped after
                // this run started, its scene mutations belong to the old branch —
                // drop them rather than write branch-A scenes onto branch B.
                const activeBranchNow = useVideoStore.getState().projectActiveBranchId ?? null
                if (
                  (event.updatedScenes || (event as any).incrementalScene) &&
                  !shouldApplyRunEvent(runBranchId, activeBranchNow)
                ) {
                  console.warn(
                    `[AgentChat] stale run event for branch ${runBranchId} dropped, active is ${activeBranchNow}`,
                  )
                  // Mark final sync received so trailing incrementals are also ignored.
                  if (event.updatedScenes) finalSyncReceived = true
                  break
                }
                if (event.updatedScenes) {
                  // Final sync — authoritative state replaces everything.
                  // Set flag to ignore any trailing incremental updates.
                  // updatedGlobalStyle may be null (e.g. Claude Code provider) — fall back to current.
                  finalSyncReceived = true
                  const finalSyncTask = (async (): Promise<Error | null> => {
                    try {
                      const { syncScenesFromAgent } = useVideoStore.getState()
                      const effectiveGlobalStyle = event.updatedGlobalStyle ?? useVideoStore.getState().globalStyle
                      // Compute the merged graph BEFORE the dispatch so the
                      // whole agent run (scenes + globalStyle + sceneGraph)
                      // flows through one action_log entry. Previously this
                      // was a separate `updateSceneGraph(mergedGraph)` call
                      // AFTER syncScenesFromAgent — that bypassed the action
                      // layer and on undo the scenes reverted while the graph
                      // stayed at post-agent state (dangling edge refs).
                      const mergedGraph = syncSceneGraphWithScenes(
                        event.updatedScenes!,
                        event.updatedSceneGraph ?? useVideoStore.getState().project.sceneGraph,
                      )
                      await syncScenesFromAgent(event.updatedScenes!, effectiveGlobalStyle, mergedGraph)
                      // The agent's add_watermark result reaches
                      // project.watermark here. updatedWatermark is only present when the tool ran;
                      // setWatermark persists it (project _isDirty) and
                      // regenerates all scene HTML, AFTER the final sync so it
                      // bakes into the run's scenes.
                      if (event.updatedWatermark !== undefined) {
                        useVideoStore.getState().setWatermark(event.updatedWatermark)
                      }
                      // Apply the run's timeline. Present only
                      // when a timeline tool ran (gated in the runner), so a
                      // scene-only run never reaches here. applyAgentTimeline
                      // MERGES (preserves markers/inPoint/outPoint) and schedules
                      // a save — AFTER the final scene sync so it composes with
                      // the run's scenes.
                      if (event.updatedTimeline != null) {
                        useVideoStore.getState().applyAgentTimeline(event.updatedTimeline)
                      }
                      return null
                    } catch (syncErr) {
                      return syncErr instanceof Error ? syncErr : new Error(String(syncErr))
                    }
                  })()
                  finalSyncTasks.push(finalSyncTask)
                }
                // Incremental scene update — merge a single scene into the store during streaming
                // so scenes appear in the timeline progressively as the agent creates them.
                // Skip if final sync already arrived (prevents race condition overwriting clean state).
                if ((event as any).incrementalScene && !event.updatedScenes && !finalSyncReceived) {
                  const scene = (event as any).incrementalScene
                  useVideoStore.setState((state) => {
                    const idx = state.scenes.findIndex((s) => s.id === scene.id)
                    const updated =
                      idx >= 0
                        ? state.scenes.map((s) => (s.id === scene.id ? { ...scene } : s))
                        : [...state.scenes, scene]
                    return { scenes: updated }
                  })
                }
                // Sync recording commands from agent tools
                if ((event as any).recordingCommand) {
                  const store = useVideoStore.getState()
                  if ((event as any).recordingConfig) store.setRecordingConfig((event as any).recordingConfig)
                  if ((event as any).recordingAttachSceneId !== undefined)
                    store.setRecordingAttachSceneId((event as any).recordingAttachSceneId)
                  store.setRecordingCommand((event as any).recordingCommand)
                }
                break
              }

              // The agent called dispatch_to_branches; this run is
              // terminal. Stash the spec — handleSend fans out after the stream.
              case 'fanout_proposed':
                if (event.fanout && event.fanout.count >= 2 && event.fanout.instruction) {
                  fanoutSpecRef.current = event.fanout
                }
                break
              case 'crossproject_proposed':
                // Agent called dispatch_to_projects. Stash the
                // instruction together with THIS run's origin body; the picker
                // opens after the stream closes. Bundling the body here (rather
                // than re-reading lastAgentRequestRef at drain time) guarantees
                // the picker dispatches under the project that produced the
                // proposal, even if another run starts before the drain.
                if (event.crossProject && event.crossProject.instruction) {
                  crossProjectSpecRef.current = {
                    instruction: event.crossProject.instruction,
                    originBody: lastAgentRequestRef.current,
                  }
                }
                break

              case 'done':
                setActiveToolName(null)
                finalAgentType = event.agentType
                finalModelId = event.modelId
                finalUsage = event.usage
                // Do NOT let `done` overwrite an error-tagged text. The runner
                // emits error THEN done; the model's last fullText (often empty or
                // upbeat) would otherwise mask the failure. Keep the error text.
                if (event.fullText && !errored) accumulatedText = event.fullText
                if (event.generationLogId) finalGenerationLogId = event.generationLogId
                // Clear the paused-run record on a COMPLETED resume — but NOT when
                // this resume re-paused (a new permission/clarification was captured
                // this stream): nulling it would orphan the new pause and the new
                // card's resume would no-op (run stuck). Only clear when nothing new paused.
                if (resumeToolCall && !pendingClarification && pendingPermissions.length === 0) {
                  void persistPausedAgentRun(null)
                } else if (lastPausePersist && typeof event.ledgerSpentUsd === 'number') {
                  // Stamp the cumulative chain spend onto the persisted pause so the
                  // resume seeds its cost ledger (carry-across-pause) instead of
                  // restarting at $0 and re-granting a full $cap each pause.
                  void persistPausedAgentRun({ ...lastPausePersist, spentUsd: event.ledgerSpentUsd })
                }
                break

              case 'sources':
                if (Array.isArray(event.sources)) {
                  for (const s of event.sources) {
                    if (!s?.url || seenSourceUrls.has(s.url)) continue
                    seenSourceUrls.add(s.url)
                    accumulatedSources.push(s)
                  }
                }
                break

              case 'warning':
                // Non-fatal warnings (80% budget, checkpoint load failure).
                if (event.message) {
                  useVideoStore.getState().showTransientStatus(event.message, 5000)
                }
                break

              case 'run_stopped':
                // Structural stop (cap / invalid args / checkpoint-save failure).
                // The permanent explanation line is already in the message text
                // (the runner appends it to fullText); this banner makes the WHY
                // visible at the moment it happens instead of a silent end.
                useVideoStore
                  .getState()
                  .showTransientStatus(event.message ?? 'The agent run stopped before finishing.', 6000)
                break

              case 'error': {
                const errText = event.error ?? 'Something went wrong'
                // The runner emits 429s/overloads as an error EVENT (after its own
                // retries are exhausted), not a thrown rejection — detect them here
                // too so the rate-limit banner + countdown fire.
                const rlNotice = buildRateLimitNotice(errText)
                if (rlNotice) {
                  accumulatedText = rlNotice.message
                  updateChatMessage(pendingAssistantMsg.id, { rateLimited: true })
                  setRateLimitCountdown({ msgId: pendingAssistantMsg.id, seconds: rlNotice.retryAfterSec })
                } else {
                  // Tag the run as errored so the following `done` event can't
                  // overwrite this text, push the error as a terminal segment so it
                  // survives in the transcript, and flag the message for the
                  // run-level error strip + status:'error' persist (in the finally).
                  accumulatedText = `Error: ${errText}`
                  errored = true
                  segments.push({ type: 'text', text: accumulatedText })
                  lastSegmentSnapshotText = accumulatedText
                  updateChatMessage(pendingAssistantMsg.id, { errored: true })
                }
                break
              }
            }
          },
        })
        if (finalSyncTasks.length > 0) {
          const syncErrors = (await Promise.all(finalSyncTasks)).filter((err): err is Error => !!err)
          if (syncErrors.length > 0) {
            throw new Error(`Agent final sync failed: ${syncErrors[0].message}`)
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // User-initiated Stop. Append a terminal "Stopped — N tool calls
          // completed" marker segment so the transcript states what happened (the
          // finalizer persists status:'aborted', which the incomplete banner
          // already matches). Sentinel text only when nothing else accumulated.
          if (!accumulatedText && toolCalls.length === 0) {
            accumulatedText = 'Stopped by user.'
          }
          const stoppedMarker = `⏹ Stopped — ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'} completed`
          segments.push({ type: 'text', text: stoppedMarker })
        } else {
          const msg = (err as Error).message ?? ''
          // 429 / provider overload: show the specific rate-limit
          // banner + retry-after countdown instead of a generic error. Checked
          // FIRST so a 429 isn't swallowed by the broader branches below.
          const rateLimitNotice = buildRateLimitNotice(msg)
          if (rateLimitNotice) {
            accumulatedText = rateLimitNotice.message
            updateChatMessage(pendingAssistantMsg.id, { content: accumulatedText, rateLimited: true })
            setRateLimitCountdown({ msgId: pendingAssistantMsg.id, seconds: rateLimitNotice.retryAfterSec })
          } else {
            if (msg.includes('timed out')) {
              accumulatedText = 'Connection timed out. The agent may still be processing — check back or try again.'
            } else if (msg.includes('409') || msg.includes('already running')) {
              accumulatedText = 'Agent is already running on this project. Wait for it to finish or stop it.'
            } else if (msg.includes('401') || msg.includes('authentication') || msg.includes('API key')) {
              accumulatedText =
                'Authentication failed. Check your API key in Settings or switch to Claude Code (uses your subscription).'
            } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
              accumulatedText = 'Network error. Check your connection and try again.'
            } else if (msg.includes('500') || msg.includes('Internal Server')) {
              accumulatedText = 'Server error. Try again in a moment.'
            } else {
              accumulatedText = `Failed: ${msg}`
            }
            // A thrown (non-rate-limit) error is a real failure — tag it so
            // the error strip renders and the finalizer persists status:'error'.
            errored = true
            segments.push({ type: 'text', text: accumulatedText })
            // Immediately update chat message so the error is visible even if finally block fails
            updateChatMessage(pendingAssistantMsg.id, { content: accumulatedText, errored: true })
          }
        }
      } finally {
        // Cancel the pending debounced partial-persist and await any in-flight
        // write to quiesce. The final persist below (status='complete', no seq)
        // supersedes every partial. dispose never rejects.
        await persister.dispose()

        // Clear the leaf's throttled text/thinking + cancel any pending flush
        // BEFORE unmount (setIsGenerating(false) below). This is the stream-
        // identity guard — no stale timer can flush into the next run.
        streamingRef.current?.resetAll()
        setIsGenerating(false)
        // A3: capture the live runId before nulling it so the post-run refresh
        // can wait for THIS run's persist_done signal.
        const finishedRunId = activeLocalRunIdRef.current
        activeLocalRunIdRef.current = null // no live run to steer once this one ends
        setSteerReady(false) // A2: composer hint back to idle
        useVideoStore.getState().endAgentRun() // close action-log runId grouping (idempotent)
        setStreamingMsgId(null)
        setIsThinkingStreaming(false)
        setStreamingToolCalls([])
        setStreamingSegments([])
        lastSnapshotTextRef.current = ''
        setCurrentIteration(null)
        setRunProgress(null)
        // Capture abort state before nulling so post-stream triggers can read it.
        lastRunAbortedRef.current = abortRef.current?.signal.aborted ?? false
        abortRef.current = null

        // Broadcast run end to other tabs
        if (projectId) broadcastAgentEnd(projectId)

        // If conversation switched during stream, skip final persist
        // to avoid polluting the new conversation's state
        const currentConvId = useVideoStore.getState().activeConversationId
        const conversationSwitched = Boolean(streamConversationId && currentConvId !== streamConversationId)
        if (conversationSwitched) {
          // Mark the orphaned message as aborted (best-effort)
          persistChatMessage(pendingAssistantMsg.id, { status: 'aborted' }).catch(() => {})
        } else {
          // Capture any trailing text after the last tool call as a final segment
          if (segments.length > 0) {
            const trailingText = accumulatedText.slice(lastSegmentSnapshotText.length).trim()
            if (trailingText) {
              segments.push({ type: 'text', text: trailingText })
            }
          }

          // finalizeRunMessage owns the outcome decision + ordering. One
          // place decides status/footer/flags for {completed, error, aborted}, so
          // the error/done/abort handlers above can't disagree about the result.
          const wasAborted = lastRunAbortedRef.current
          const outcome = resolveRunOutcome({ errored, aborted: wasAborted })
          // An aborted run never receives `done` (which carries the real usage),
          // so the cost/footer would read as $0 / blank. Synthesize usage from the
          // last run_progress snapshot so a stopped run still shows what it spent.
          if (!finalUsage && lastProgress) {
            finalUsage = {
              inputTokens: lastProgress.inputTokens ?? 0,
              outputTokens: lastProgress.outputTokens ?? 0,
              apiCalls: 0,
              costUsd: lastProgress.costUsd,
              totalDurationMs: 0,
            }
          }
          // finalUsage may be a SUB-AGENT's `done` (runner.ts sends its OWN token cost
          // for isSubAgent, not the chain total), captured because on a Stop mid-sub-agent
          // the parent's `done` (chainSpentUsd) never arrives. lastProgress.costUsd is the
          // live, monotonic ledger figure the cost chip shows; reconcile up to it so the
          // persisted messages.cost_usd matches the live display ($0.91) instead of dropping
          // to the sub-agent's slice ($0.06). Monotonic ledger → this never regresses a
          // clean run (the parent's `done` cost ≥ last run_progress).
          if (finalUsage && lastProgress && lastProgress.costUsd > finalUsage.costUsd) {
            finalUsage = { ...finalUsage, costUsd: lastProgress.costUsd }
          }
          // Append an honest run-facts footer rendered from RUN FACTS (the
          // accumulated tool calls + the done event's usage), never the model's
          // narration. Name any scene left in an errored verify state.
          const erroredScenes = useVideoStore
            .getState()
            .scenes.filter((s) => (s as { verifyStatus?: string }).verifyStatus === 'errored')
            .map((s) => s.name || s.id)
          const footer = buildRunFooter({ outcome, toolCalls, usage: finalUsage, erroredScenes })
          segments.push({ type: 'text', text: footer })
          const persistStatus = outcomeToPersistStatus(outcome)

          updateChatMessage(pendingAssistantMsg.id, {
            content: accumulatedText || (toolCalls.length > 0 || thinkingAccumulated ? '' : 'Done.'),
            generationLogId: finalGenerationLogId,
            usage: finalUsage,
            agentType: finalAgentType,
            modelId: finalModelId as any,
            ...(errored ? { errored: true } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(segments.length > 0 ? { contentSegments: segments } : {}),
            ...(pendingPermissions.length > 0 ? { pendingPermissions } : {}),
            ...(pendingClarification ? { pendingClarification } : {}),
            ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
            ...(accumulatedSources.length > 0 ? { sources: accumulatedSources } : {}),
          })
          // Final persist — awaited to ensure it completes before any page navigation
          // The persistChatMessage function already has retry logic built in.
          // persist the TRUE terminal status (aborted / error / complete) so a
          // reload renders the incomplete banner instead of a fake "complete".
          try {
            await persistChatMessage(pendingAssistantMsg.id, { status: persistStatus })
          } catch {
            // Last resort retry
            await new Promise((r) => setTimeout(r, 500))
            await persistChatMessage(pendingAssistantMsg.id, { status: persistStatus }).catch(() => {})
          }
          // Do NOT refresh immediately — that replaces the store's scenes
          // with whatever the DB holds RIGHT NOW, racing main's post-run persist
          // (which runs on error/abort too). On abort the transport
          // rejects instantly and an immediate refresh shows pre-run DB state,
          // wiping the half-built scenes the user just watched stream in. Wait
          // for the out-of-band persist_done signal (keyed by runId) or, as a
          // fallback, until the project version advances past the pre-run value
          // — then refresh from a settled DB. A hard timeout inside
          // waitForRunPersist guarantees the UI never freezes.
          const doRefresh = () =>
            useVideoStore
              .getState()
              .refreshProjectFromServer()
              .catch(() => {
                setTimeout(() => {
                  void useVideoStore.getState().refreshProjectFromServer()
                }, 2500)
              })
          // If main's post-run scene persist did NOT confirm success (persistOk
          // false = it failed / didn't run; null = we timed out waiting for the
          // signal), the renderer's store may be the ONLY place the just-built
          // scenes live (main autosave is gated off during runs). Push them
          // durably BEFORE pulling — otherwise refreshProjectFromServer reads an
          // empty DB and the scenes vanish on the next reload. This is the
          // renderer-side fallback the runner's persistOk signal is meant to
          // trigger (src/lib/services/agent-runner.ts). Only when persistOk===true do
          // we trust main's write and skip the push. Guarded on !isAgentRunning
          // so a NEW run started during the (up to 10s) settle window owns the
          // store — we must never push a fresh run's partial state.
          const settleAndRefresh = async (persistOk: boolean | null) => {
            const st = useVideoStore.getState()
            if (persistOk !== true && st.scenes.length > 0 && !st.isAgentRunning) {
              try {
                await st.saveProjectToDb()
              } catch {
                /* fall through to the refresh; the store still holds the scenes */
              }
            }
            await doRefresh()
          }
          if (finishedRunId && projectId) {
            void waitForRunPersist(finishedRunId, projectId, preRunVersion).then(({ persistOk }) =>
              settleAndRefresh(persistOk),
            )
          } else {
            void doRefresh()
          }
        }
      }
    },
    [scene?.id, updateChatMessage, persistChatMessage, persistStreamingChatMessage, persistPausedAgentRun],
  )

  return {
    isGenerating,
    setIsGenerating,
    streamingMsgId,
    setStreamingMsgId,
    rateLimitCountdown,
    setRateLimitCountdown,
    activeLocalRunIdRef,
    steerReady,
    setSteerReady,
    streamingRef,
    streamingSegments,
    setStreamingSegments,
    lastSnapshotTextRef,
    activeToolName,
    setActiveToolName,
    isThinkingStreaming,
    setIsThinkingStreaming,
    streamingToolCalls,
    setStreamingToolCalls,
    currentIteration,
    setCurrentIteration,
    runProgress,
    setRunProgress,
    abortRef,
    fanoutSpecRef,
    lastAgentRequestRef,
    crossProjectSpecRef,
    lastRunAbortedRef,
    runAgentStream,
  }
}
