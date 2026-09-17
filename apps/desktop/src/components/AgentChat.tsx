'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, ChevronDown, MoreHorizontal, X, Pin, ToggleLeft, ToggleRight } from 'lucide-react'

import { MODEL_OPTIONS } from '@/components/chat/composer-shared'
import { panelToolChips } from '@/lib/agent-tools'
import { useAgentRun } from '@/lib/hooks/use-agent-run'
import { useComposerInput } from '@/lib/hooks/use-composer-input'
import { useGenerateComposer } from '@/lib/hooks/use-generate-composer'
import { ChatComposer } from './chat/ChatComposer'
import type { PastedText } from './chat/ComposerAttachmentChips'
import { ChatMessageList } from './chat/ChatMessageList'
import { ImageLightbox, type PreviewImage } from './chat/ImageLightbox'
import { buildMentionNote } from '@/lib/scene-mentions'
import { AUDIO_PROVIDERS } from '@/lib/audio/provider-registry'
import { MEDIA_PROVIDERS } from '@/lib/media/provider-registry'
import { useConfiguredProviders } from '@/lib/hooks/useConfiguredProviders'
import { useBranches } from '@/lib/hooks/use-branches'
import {
  useConversationRewind,
  findPrecedingUserIndex,
  findRestoreSnapshotMsgId,
} from '@/lib/hooks/use-conversation-rewind'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'
import type {
  AgentType,
  ModelTier,
  ChatMessage,
  MessageContent,
  ImageAttachment,
  ContentBlock,
  ReferenceMedia,
  ReferenceMediaKind,
} from '@/lib/agents/types'
import { messageContentToText } from '@/lib/agents/types'
import { PASTE_DELIM } from '@/lib/agents/pasted-text'
import { buildDenialResumeMessage } from '@/lib/agents/permission-resume'
import { parseCommand, type CommandContext } from '@/lib/agents/commands'
import { spawnAgentVariants, type VariantResult } from '@/lib/agents/spawn-variants'
import { resizeImage, validateImage, MAX_IMAGE_DIMENSION } from '@/lib/image-utils'
import BranchCard from './branches/BranchCard'
import { StreamingMessage } from './chat/StreamingMessage'
import StructuralCutsReviewCard from './StructuralCutsReviewCard'
import { PlanCard } from './chat/PlanCard'
import { RewindConfirmDialog } from './chat/RewindConfirmDialog'
import { ConversationContextMenu } from './chat/ConversationContextMenu'
import { visibleConversations } from '@/lib/store/conversation-list'
import { v4 as uuidv4 } from 'uuid'
import { resolveAgentModelDisplayName } from '@/lib/agents/model-config'
import { initTabSync } from '@/lib/store/tab-sync'
import { serializeConversationToMarkdown, exportFilename, type ExportMessage } from '@/lib/chat-export'
import { postAgentSteer } from '@/lib/agent-transport'
import {
  shouldRouteToSteer,
  stripUnconsumedSteerMarker,
  historyCliffNote,
  filterConversations,
  STEER_NOT_READY_NOTICE,
} from '@/lib/agents/steer-ui'
import { resolveCrossProjectPicker } from '@/lib/cross-project/post-run-triggers'

// ── Thinking dots animation (. .. ... .. . ...) ──────────────────────────────

// ThinkingDots moved to ./chat/ThinkingDots (used by StreamingMessage)

// ── Tool Call Display ──────────────────────────────────────────────────────────

// ── Usage Badge — used only for the live in-stream progress counter. The
// per-message footer was retired; token / cost / duration are available from
// the Details menu on each assistant message (see handleDetails).

// ── Keyword guard map ────────────────────────────────────────────────────────────

// ── Props ────────────────────────────────────────────────────────────────────────

interface Props {
  scene?: Scene | null
  onOpenEditor?: () => void
}

export default function AgentChat({ scene, onOpenEditor }: Props) {
  const {
    updateScene,
    scenes,
    project,
    selectedSceneId,
    modelTier,
    modelOverride,
    modelConfigs,
    activeTools,
    toggleActiveTool,
    setContentView,
    setSettingsSection,
    audioProviderEnabled,
    toggleAudioProvider,
    mediaGenEnabled,
    toggleMediaGen,
    setSessionPermission,
    setGenerationOverride,
    setAutoChooseDefault,
    updateAPIPermissions,
    setPlanFirstMode,
    pausedAgentRun,
    setPausedAgentRun,
    localMode,
    localModelId,
    runCheckpoint,
    setRunCheckpoint,
    chatMessages,
    showcaseMode,
    structuralCutsProposed,
    pendingPlan,
    planTodos,
    planAwaitingApproval,
    clearPlan,
    addChatMessage,
    insertChatMessageBefore,
    persistUserMessage,
    updateChatMessage,
    persistChatMessage,
    clearChat,
    conversations,
    activeConversationId,
    newConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
    pinConversation,
    archiveConversation,
    addProjectAsset,
    projectActiveBranchId,
    switchProjectBranch,
    reloadActiveBranch,
    incrementBranchListVersion,
    openProject,
  } = useVideoStore()
  const branches = useBranches(project?.id)
  const activeBranch =
    branches.find((b) => b.id === projectActiveBranchId) ?? branches.find((b) => b.isDefault) ?? branches[0]

  // The branch card renders inline in the chat (toggled by the chip / its own
  // close button), so no outside-click-to-close listener is needed.
  const [showBranchDropdown, setShowBranchDropdown] = useState(false)

  // ── Cinema Studio (Generate toggle) ──────────────────────────────────────────
  // A composer-level toggle (like Research): when on, the agent pills become media-generation
  // controls and Send routes to the gated generation pipeline instead of an agent run.
  const generateAIImage = useVideoStore((s) => s.generateAIImage)
  const generateCharacterImage = useVideoStore((s) => s.generateCharacterImage)
  const generateAIVideo = useVideoStore((s) => s.generateAIVideo)
  const generateNarration = useVideoStore((s) => s.generateNarration)
  const generateSfx = useVideoStore((s) => s.generateSfx)
  const generateMusic = useVideoStore((s) => s.generateMusic)
  const generateLipsync = useVideoStore((s) => s.generateLipsync)
  const gen = useGenerateComposer()
  // Fields AgentChat itself still uses (handleSend generate routing + currentModel);
  // the composer-only fields are consumed inside <ChatComposer> via the gen prop.
  const {
    generateMode,
    genFormat,
    genModel,
    effectiveGenModel,
    genSceneAgentLocked,
    genDuration,
    genAspect,
    effectiveGenAspect,
    videoModelSupportsI2v,
    videoModelSupportsKeyframes,
    videoModelSupportsExtend,
    videoModelSupportsV2v,
    genCharacterId,
    genSeedText,
    genCharacters,
    genAudioKind,
    effectiveAudioModel,
    genVoiceId,
    genInFlightRef,
    genVideoSrc,
    genVideoUpload,
    genVideoEndSrc,
    genVideoEndUpload,
    genExtendSrc,
    genExtendUpload,
    genEditSrc,
    genEditUpload,
    genEditOp,
    genCameraMove,
    genCameraIntensity,
    genEffect,
    genLensPreset,
    genLipsyncModel,
    effectiveLipsyncTts,
  } = gen
  /**
   * Multi-variant agent runs (v0.3.7). When > 1, the next send spawns N
   * branches off the current one and runs the agent on each in sequence
   * via src/lib/agents/spawn-variants.ts. User compares takes by switching
   * branches in the existing selector. Cycles 1/2/3/4 on the picker.
   */
  const [variantsCount, setVariantsCount] = useState(1)
  // History-dropdown conversation search (filtered via steer-ui helper)
  const [convSearch, setConvSearch] = useState('')
  /** Chronologically ordered segments of text and tool calls for interleaved display */
  const [showHistory, setShowHistory] = useState(false)
  const [showEllipsisMenu, setShowEllipsisMenu] = useState(false)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const configuredProviders = useConfiguredProviders()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Conversation pin/archive context menu + the History "Archived" toggle.
  const [convMenu, setConvMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null)
  const [pendingAssetRefs, setPendingAssetRefs] = useState<
    Array<{ id: string; name: string; type: string; publicUrl: string }>
  >([])
  // Reference media (Phase 2 multimodal intake): audio/doc the user attaches as
  // inspiration/source, pre-digested into an understanding brief before the run.
  const [pendingReferenceMedia, setPendingReferenceMedia] = useState<ReferenceMedia[]>([])
  // Large pasted blocks held as editable chips (Claude-style) instead of
  // flooding the composer; drained into the message text on send.
  const [pendingPastedTexts, setPendingPastedTexts] = useState<PastedText[]>([])
  const [uploadingAssets, setUploadingAssets] = useState<Record<string, { name: string; pct: number }>>({})
  const imageInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // Scroll the inline branch card into view when it opens.
  useEffect(() => {
    if (showBranchDropdown) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [showBranchDropdown])

  useEffect(() => {
    return () => {
      try {
        speechRecognitionRef.current?.abort()
      } catch {}
      speechRecognitionRef.current = null
    }
  }, [])

  // Multi-tab sync — prevent concurrent runs across browser tabs
  const isAgentRunningRemote = useVideoStore((s) => s.isAgentRunningRemote)
  useEffect(() => {
    const projectId = useVideoStore.getState().project?.id
    if (!projectId) return
    return initTabSync(projectId)
  }, [useVideoStore((s) => s.project?.id)])

  const messages = chatMessages

  // Derived once per render — the cliff note renders in the composer footer,
  // the filtered list drives the History dropdown (memoized: this component
  // re-renders far more often than conversations/search change).
  const cliffNote = historyCliffNote(messages.length)
  // NOTE: search is applied over the pin/archive-filtered history list at the
  // render site (searchedHistoryConversations) — composing A2 search with the
  // Pin/archive sort/filter — so no standalone filteredConversations memo here.

  const handleRate = useCallback(
    (msgId: string, rating: number) => {
      const freshMessages = useVideoStore.getState().chatMessages
      const msg = freshMessages.find((m) => m.id === msgId)
      if (!msg) return

      const effectiveRating = rating === 0 ? undefined : rating
      updateChatMessage(msgId, { userRating: effectiveRating })

      // Persist rating to generation log
      if (msg.generationLogId && rating > 0) {
        const logIpc = typeof window !== 'undefined' ? window.dreambyteApi?.generationLog : undefined
        logIpc
          ?.update({ logId: msg.generationLogId, userRating: rating })
          .catch((err) => console.error('[AgentChat] Failed to send feedback:', err))
      }

      // Persist rating to message in DB
      const conversationId = useVideoStore.getState().activeConversationId
      if (conversationId) {
        const convIpc = typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
        convIpc
          ?.updateMessage({
            conversationId,
            messageId: msgId,
            userRating: effectiveRating ?? null,
          })
          .catch((err) => console.error('[AgentChat] Failed to persist rating:', err))
      }
    },
    [updateChatMessage],
  )

  const persistPausedAgentRun = useCallback(
    async (
      paused: {
        toolName: string
        toolInput: Record<string, unknown>
        agentType?: string | null
        reason?: string | null
        createdAt: string
      } | null,
    ) => {
      setPausedAgentRun(paused)
      if (!project?.id) return
      // 0015: pausedAgentRun is branch-scoped — persist to the active branch's
      // branch_proposals row, not the (removed) projects column.
      await useVideoStore.getState().persistBranchProposalField('pausedAgentRun', paused)
    },
    [project?.id, setPausedAgentRun],
  )

  const handlePermission = useCallback(
    (msgId: string, api: string, decision: 'allow' | 'deny') => {
      setSessionPermission(api, decision)
      const freshMessages = useVideoStore.getState().chatMessages
      const msg = freshMessages.find((m) => m.id === msgId)
      if (!msg?.pendingPermissions) return
      // Tier 3 Cast: approving a biometric_consent card records consent for (project, destination)
      // so the resumed clone_voice run finds it and proceeds (the user then clicks Continue). The
      // spend 'allow' is handled by setSessionPermission above, same as any permission.
      if (decision === 'allow') {
        const consentPerm = msg.pendingPermissions.find(
          (p) => p.api === api && p.kind === 'biometric_consent' && p.destination && p.consentVersion,
        )
        if (consentPerm && project?.id) {
          const ttsIpc = typeof window !== 'undefined' ? window.dreambyteApi?.tts : undefined
          void ttsIpc?.recordVoiceConsent({
            projectId: project.id,
            destination: consentPerm.destination as string,
            version: consentPerm.consentVersion as string,
          })
        }
      }
      const updated = msg.pendingPermissions.map((p) => (p.api === api ? { ...p, resolved: decision } : p))
      updateChatMessage(msgId, { pendingPermissions: updated })
      if (decision === 'deny') {
        void persistPausedAgentRun(null)
      }
    },
    [setSessionPermission, updateChatMessage, persistPausedAgentRun, project?.id],
  )

  const agentRun = useAgentRun({ scene, persistPausedAgentRun })
  const {
    isGenerating,
    setIsGenerating,
    streamingMsgId,
    setStreamingMsgId,
    rateLimitCountdown,
    setRateLimitCountdown,
    activeLocalRunIdRef,
    steerReady,
    streamingRef,
    streamingSegments,
    lastSnapshotTextRef,
    activeToolName,
    isThinkingStreaming,
    runProgress,
    abortRef,
    fanoutSpecRef,
    crossProjectSpecRef,
    lastRunAbortedRef,
    runAgentStream,
  } = agentRun
  const composerInput = useComposerInput({ isGenerating, generateMode })
  const {
    input,
    setInput,
    setShowModelMenu,
    setShowAgentMenu,
    setShowSpeechLangMenu,
    keywordWarning,
    setKeywordWarning,
    checkKeywordGuard,
    speechRecognitionRef,
    setIsListening,
  } = composerInput

  // Drain home-composer attachments into this composer's pendingImages
  // once, so a file picked on the home stage carries into the new project's chat.
  useEffect(() => {
    const staged = useVideoStore.getState().pendingComposerAttachments
    if (staged.length > 0) {
      setPendingImages((prev) => [...prev, ...staged])
      useVideoStore.getState().setPendingComposerAttachments([])
    }
    // Drain the home-composer text into the input. NOT auto-sent —
    // the user reviews + presses Enter, so the typed text is never discarded.
    const stagedText = useVideoStore.getState().pendingComposerText
    if (stagedText) {
      setInput((prev) => (prev ? prev : stagedText))
      useVideoStore.getState().setPendingComposerText('')
    }
  }, [])

  const handleDetails = useCallback(
    (msg: ChatMessage) => {
      const freshMessages = useVideoStore.getState().chatMessages
      const detailTag = `details:${msg.id}`
      if (freshMessages.some((m) => m.id === detailTag)) return

      const u = msg.usage
      const lines: string[] = ['--- Generation Details ---']
      if (msg.agentType) lines.push(`Agent: ${msg.agentType}`)
      if (msg.modelId) {
        const st = useVideoStore.getState()
        lines.push(`Model: ${resolveAgentModelDisplayName(msg.modelId, st.modelConfigs)}`)
      }
      if (u) {
        lines.push(`Input tokens: ${u.inputTokens.toLocaleString()}`)
        lines.push(`Output tokens: ${u.outputTokens.toLocaleString()}`)
        lines.push(`Total tokens: ${(u.inputTokens + u.outputTokens).toLocaleString()}`)
        const cacheRead = u.cacheReadTokens ?? 0
        const cacheCreated = u.cacheCreationTokens ?? 0
        if (cacheRead > 0 || cacheCreated > 0) {
          const denom = cacheRead + (u.inputTokens ?? 0)
          const hitPct = denom > 0 ? (cacheRead / denom) * 100 : 0
          lines.push(
            `Cache: ${cacheRead.toLocaleString()} read / ${cacheCreated.toLocaleString()} created (${hitPct.toFixed(0)}% hit rate)`,
          )
          if (hitPct < 50) {
            lines.push(`  ↳ Low cache hit — system prompt likely changed mid-conversation`)
          }
        }
        if (u.provider === 'claude-code' || u.provider === 'codex-cli') {
          lines.push(`Billing: Claude Code subscription (not per-token)`)
        } else {
          lines.push(`Cost: $${u.costUsd.toFixed(4)}`)
        }
        lines.push(`API calls: ${u.apiCalls}`)
        lines.push(`Duration: ${(u.totalDurationMs / 1000).toFixed(1)}s`)
      }
      if (!u && !msg.agentType) lines.push('No usage data available for this message.')

      addChatMessage({
        id: detailTag,
        role: 'assistant' as const,
        content: lines.join('\n'),
        timestamp: Date.now(),
      })
    },
    [addChatMessage],
  )

  const scrollRafRef = useRef<number | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  /** True when the user has manually scrolled away from the bottom */
  const userScrolledUpRef = useRef(false)
  /**
   * First scroll-to-bottom after mount or conversation switch needs to be
   * instant — otherwise the user opens the project and watches a smooth
   * animation crawl from the top of a long conversation down to the
   * latest message. Flip to false after the first run; subsequent
   * incremental scrolls (new message arrives while you're chatting) keep
   * the smooth easing.
   */
  const isFirstScrollRef = useRef(true)

  const scrollToBottom = useCallback((force?: boolean) => {
    if (!force && userScrolledUpRef.current) return
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = scrollContainerRef.current

      // While `isFirstScrollRef` is set, every auto-scroll lands at the
      // bottom synchronously with NO animation. The flag stays set across
      // all the load-time message-array churn (persist hydration, IPC
      // fill, streaming-row reconciliation) and only flips off when the
      // user actually does something — sends a message, scrolls up, etc.
      // (handleSend, handleScroll). After that, smooth scroll resumes
      // for in-session new messages, which IS the right feel.
      if (isFirstScrollRef.current) {
        if (!el) return
        // Direct scrollTop assign instead of `scrollIntoView({ behavior:
        // 'instant' })` — the latter still paints a top frame before
        // jumping. Synchronous scrollTop updates the position before the
        // user sees anything.
        el.scrollTop = el.scrollHeight
        return
      }

      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }, [])

  const [showScrollButton, setShowScrollButton] = useState(false)

  /** Detect if user scrolled away from bottom */
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // Consider "near bottom" if within 80px of the bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    userScrolledUpRef.current = !nearBottom
    setShowScrollButton(!nearBottom)
    // User-initiated scroll up = real interaction. From here on, future
    // auto-scrolls can use smooth easing because the user has acknowledged
    // the chat. Don't flip on near-bottom scrolls — those happen as a
    // side-effect of our own sync scrollTop write during initial load.
    if (!nearBottom) isFirstScrollRef.current = false
  }, [])

  // Switching conversations counts as a "first scroll" — jump instantly to
  // the bottom of the newly-loaded thread instead of smooth-scrolling from
  // wherever we were in the previous conversation.
  useEffect(() => {
    isFirstScrollRef.current = true
  }, [activeConversationId])

  // Force-scroll + clear the scroll-up lock ONLY when the USER sends a new
  // message. For streaming / assistant / tool-call updates (which also mutate
  // `messages`), respect the lock — otherwise every streamed chunk yanked the
  // view back to the bottom while the user was scrolled up reading (the bug).
  const userMsgCountRef = useRef(0)
  useEffect(() => {
    const userMsgCount = messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0)
    const userJustSent = userMsgCount > userMsgCountRef.current
    userMsgCountRef.current = userMsgCount
    if (userJustSent) {
      userScrolledUpRef.current = false
      scrollToBottom(true)
    } else {
      scrollToBottom() // non-force: follows only when still near the bottom
    }
  }, [messages, isGenerating, scrollToBottom])

  // Streaming auto-scroll is driven by StreamingMessage's onContentGrow callback
  // (scrollToBottom already rAF-coalesces, so it stays cheap).

  // ── Persist on page unload ──────────────────────────────────────────────────
  // Best-effort flush via the conversations IPC. addMessage is upsert-idempotent
  // (uses _method:'PUT'); main writes the aborted-state row, and the SQL WHERE
  // status='streaming' guard prevents overwriting a message that the finally
  // block already marked 'complete'.
  useEffect(() => {
    const flushInFlight = () => {
      if (!isGenerating) return
      const st = useVideoStore.getState()
      if (!st.activeConversationId || !st.project?.id) return
      const lastAssistant = [...st.chatMessages].reverse().find((m) => m.role === 'assistant')
      if (!lastAssistant) return
      const textContent =
        typeof lastAssistant.content === 'string' ? lastAssistant.content : messageContentToText(lastAssistant.content)
      const payload = {
        _method: 'PUT' as const,
        messageId: lastAssistant.id,
        conversationId: st.activeConversationId,
        projectId: st.project.id,
        role: 'assistant' as const,
        content: textContent || 'Interrupted — page closed during generation.',
        status: 'aborted' as const,
        agentType: lastAssistant.agentType,
        modelUsed: lastAssistant.modelId,
        toolCalls: lastAssistant.toolCalls,
        contentSegments: lastAssistant.contentSegments,
      }
      const convIpc = typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
      // Fire-and-forget: beforeunload doesn't guarantee async completion in
      // Electron, but addMessage is upsert-idempotent so a retry on next
      // boot is safe. Better than losing the aborted-state flag entirely.
      // The upsert's `setWhere status='streaming'` gate means this never
      // clobbers a message the stream's finally block already finalized.
      convIpc?.addMessage(payload).catch(() => {})
    }
    window.addEventListener('beforeunload', flushInFlight)
    // The main process nudges every renderer on `before-quit` so a
    // Cmd-Q mid-stream still flushes (pagehide/beforeunload don't reliably fire
    // for an app quit). The incremental seq-guarded write is the durable path;
    // this is the final best-effort safety net.
    const unsubscribeQuit = window.dreambyteApi?.app?.onFlushBeforeQuit?.(flushInFlight)
    return () => {
      window.removeEventListener('beforeunload', flushInFlight)
      unsubscribeQuit?.()
    }
  }, [isGenerating])

  const handleImageFile = useCallback(async (file: File) => {
    const validation = validateImage(file)
    if (!validation.valid) return // silently skip invalid files
    try {
      const resized = await resizeImage(file, MAX_IMAGE_DIMENSION)
      setPendingImages((prev) => [
        ...prev,
        {
          dataUri: resized.dataUri,
          mimeType: resized.mimeType as ImageAttachment['mimeType'],
          fileName: file.name,
          width: resized.width,
          height: resized.height,
        },
      ])
    } catch {
      // Failed to process image — skip
    }
  }, [])

  /**
   * Upload SVG / video (or any non-image-for-vision asset) to the project's
   * media library so the agent can reference it by URL in generated scenes.
   *
   * Unlike `handleImageFile` (which attaches the image as a vision input for
   * the model to *see*), this path promotes the file to a project asset so
   * scene HTML can <img>-load the SVG, feed it to Three.js SVGLoader for
   * extrusion, or embed video via <video>. The asset is injected into the
   * agent's system context automatically (src/lib/agents/context-builder.ts:935).
   */
  const handleAssetFile = useCallback(
    async (file: File) => {
      if (!project?.id) return
      const tempId = `upload-${Date.now()}-${file.name}`
      // IPC invoke is unary, no streaming progress events. Show indeterminate
      // 0 → 100 around the call instead of byte-level progress; per-file caps
      // (10MB image / 100MB video) keep this fast enough to feel snappy.
      setUploadingAssets((prev) => ({ ...prev, [tempId]: { name: file.name, pct: 0 } }))
      try {
        const ipc = window.dreambyteApi?.projects
        if (!ipc?.uploadAsset) throw new Error('uploadAsset requires the desktop runtime.')
        const data = await file.arrayBuffer()
        const result = (await ipc.uploadAsset({
          projectId: project.id,
          data,
          mimeType: file.type,
          originalName: file.name,
        })) as { asset: { id: string; name: string; type: string; publicUrl: string } }
        addProjectAsset(result.asset as Parameters<typeof addProjectAsset>[0])
        setPendingAssetRefs((prev) => [
          ...prev,
          {
            // Original filename (with extension) so the chip can show the file
            // type — result.asset.name has the extension stripped for display.
            id: result.asset.id,
            name: file.name,
            type: result.asset.type,
            publicUrl: result.asset.publicUrl,
          },
        ])
      } catch (err) {
        console.error('[AgentChat] Asset upload failed:', err)
        // toast surfaces separately via GalleryPanel pattern
      } finally {
        setUploadingAssets((prev) => {
          const next = { ...prev }
          delete next[tempId]
          return next
        })
      }
    },
    [project?.id, addProjectAsset],
  )

  /**
   * Attach a file as reference media for understanding. Uploads via
   * the same IPC as project assets (gets a dreambyte:// URI), then records a
   * ReferenceMedia entry the run sends as `referenceMedia` so the agent digests
   * it into an understanding brief before building.
   */
  const handleReferenceMediaFile = useCallback(
    async (file: File, kind: ReferenceMediaKind) => {
      if (!project?.id) return
      const tempId = `refmedia-${Date.now()}-${file.name}`
      setUploadingAssets((prev) => ({ ...prev, [tempId]: { name: file.name, pct: 0 } }))
      try {
        const ipc = window.dreambyteApi?.projects
        if (!ipc?.uploadAsset) throw new Error('uploadAsset requires the desktop runtime.')
        const data = await file.arrayBuffer()
        const result = (await ipc.uploadAsset({
          projectId: project.id,
          data,
          mimeType: file.type,
          originalName: file.name,
        })) as { asset: { id: string; name: string; publicUrl: string; contentHash?: string } }
        setPendingReferenceMedia((prev) => [
          ...prev,
          {
            id: result.asset.id,
            kind,
            uri: result.asset.publicUrl,
            mimeType: file.type,
            // Original filename (with extension) — result.asset.name is stripped.
            fileName: file.name,
            contentHash: result.asset.contentHash,
          },
        ])
      } catch (err) {
        console.error('[AgentChat] Reference media upload failed:', err)
      } finally {
        setUploadingAssets((prev) => {
          const next = { ...prev }
          delete next[tempId]
          return next
        })
      }
    },
    [project?.id],
  )

  /**
   * Attach a video as BOTH a project asset (usable as b-roll IN the video) AND
   * reference media (understood into the brief). One upload, two references.
   */
  const handleVideoFile = useCallback(
    async (file: File) => {
      if (!project?.id) return
      const tempId = `video-${Date.now()}-${file.name}`
      setUploadingAssets((prev) => ({ ...prev, [tempId]: { name: file.name, pct: 0 } }))
      try {
        const ipc = window.dreambyteApi?.projects
        if (!ipc?.uploadAsset) throw new Error('uploadAsset requires the desktop runtime.')
        const data = await file.arrayBuffer()
        const result = (await ipc.uploadAsset({
          projectId: project.id,
          data,
          mimeType: file.type,
          originalName: file.name,
        })) as { asset: { id: string; name: string; type: string; publicUrl: string; contentHash?: string } }
        addProjectAsset(result.asset as Parameters<typeof addProjectAsset>[0])
        setPendingAssetRefs((prev) => [
          ...prev,
          { id: result.asset.id, name: result.asset.name, type: result.asset.type, publicUrl: result.asset.publicUrl },
        ])
        setPendingReferenceMedia((prev) => [
          ...prev,
          {
            id: result.asset.id,
            kind: 'video',
            uri: result.asset.publicUrl,
            mimeType: file.type,
            fileName: result.asset.name,
            contentHash: result.asset.contentHash,
          },
        ])
      } catch (err) {
        console.error('[AgentChat] Video upload failed:', err)
      } finally {
        setUploadingAssets((prev) => {
          const next = { ...prev }
          delete next[tempId]
          return next
        })
      }
    },
    [project?.id, addProjectAsset],
  )

  /** Route a dropped/picked file to the right handler by MIME type. Audio + docs
   *  become reference media; video becomes asset + reference; images stay inline
   *  vision; svg stays a project asset. */
  const routeAttachedFile = useCallback(
    (file: File) => {
      // Steers are text-only. While a run is active the button is disabled,
      // but paste/drop can still deliver a file — drop it here too so it can't be
      // silently queued for the next normal turn while the user is steering.
      if (isGenerating) return
      const t = file.type
      const name = file.name.toLowerCase()
      if (t.startsWith('audio/')) return handleReferenceMediaFile(file, 'audio')
      if (t === 'application/pdf' || t === 'text/plain' || t === 'text/markdown' || name.endsWith('.md')) {
        return handleReferenceMediaFile(file, 'doc')
      }
      if (t.startsWith('video/')) return handleVideoFile(file)
      if (t === 'image/svg+xml') return handleAssetFile(file)
      if (t.startsWith('image/')) return handleImageFile(file)
      // Everything else (.htm, .docx, .csv, .json, unknown types) is a reference
      // document for the agent — NOT a media asset. Routing it here keeps it out
      // of the project media library + timeline (was handleAssetFile → gallery).
      return handleReferenceMediaFile(file, 'doc')
    },
    [isGenerating, handleReferenceMediaFile, handleVideoFile, handleAssetFile, handleImageFile],
  )

  // Drain a pending cross-project proposal after a run ends.
  // Shared by EVERY runAgentStream caller (main send, approve-plan,
  // resume paths) so a dispatch_to_projects call opens the picker no matter which
  // path the run took — not just the main handleSend tail. Reads refs only
  // (closure-stable) + a store action, so it has no dependencies. The fan-out
  // (dispatch_to_branches) trigger stays in handleSend: it needs runVariantsFlow,
  // which is declared later, so it can't be hoisted here without a TDZ.
  const drainCrossProjectProposal = useCallback(() => {
    const spec = crossProjectSpecRef.current
    crossProjectSpecRef.current = null
    const payload = resolveCrossProjectPicker(spec, lastRunAbortedRef.current)
    if (payload) useVideoStore.getState().openCrossProjectPicker(payload)
  }, [])

  /**
   * Re-run the agent on an EXISTING user turn (no new user message appended) —
   * the conversation-rewind primitive already kept that turn and dropped the
   * stale tail. Mirrors handleSend's tail (pending assistant + runAgentStream)
   * but skips the user-message add/persist. Conversation-only: runs
   * against CURRENT project state. */
  const rerunUserTurn = useCallback(
    async (userContent: MessageContent) => {
      if (isGenerating) return
      const pendingAssistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      }
      addChatMessage(pendingAssistantMsg)
      await runAgentStream({ messageContent: userContent, pendingAssistantMsg })
      drainCrossProjectProposal()
    },
    [isGenerating, addChatMessage, runAgentStream, drainCrossProjectProposal],
  )

  /**
   * Resend an unconsumed steer. The steer never reached the model (the run
   * ended before it was read); the marker-stripped original text is resubmitted
   * as a NORMAL new turn — a fresh user message + assistant placeholder + run.
   */
  const handleResendSteer = useCallback(
    async (steerText: string) => {
      if (isGenerating) return
      const text = stripUnconsumedSteerMarker(steerText)
      if (!text) return
      const userMsg: ChatMessage = { id: uuidv4(), role: 'user', content: text, timestamp: Date.now() }
      addChatMessage(userMsg)
      void persistUserMessage(userMsg)
      const pendingAssistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      }
      addChatMessage(pendingAssistantMsg)
      await runAgentStream({ messageContent: text, pendingAssistantMsg })
      drainCrossProjectProposal()
    },
    [isGenerating, addChatMessage, persistUserMessage, runAgentStream, drainCrossProjectProposal],
  )

  // Rewind actions: retry, regenerate, edit. The hook owns the
  // DB-first tail-delete + lockstep store splice (via the store primitive) and
  // the rerun; AgentChat only wires the rerun side effect + error surface.
  const rewind = useConversationRewind({
    isGenerating,
    rerun: rerunUserTurn,
    onError: (m) => useVideoStore.getState().showTransientStatus?.(m, 4000),
  })

  // Pending rewind awaiting the confirm dialog. `kind` drives the wording;
  // `run` is the already-bound rewind action to fire on confirm; `canRestore`
  // gates the "also restore project state" checkbox.
  const [rewindConfirm, setRewindConfirm] = useState<{
    kind: 'edit' | 'regenerate'
    canRestore: boolean
    run: (opts: { restore: boolean }) => void | Promise<void>
  } | null>(null)

  /** Snapshot current project state onto a new branch before a rewind ("create
   *  a branch first" escape hatch). Reuses the existing branch-create flow. */
  const createBranchBeforeRewind = useCallback(async () => {
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
    const projectId = useVideoStore.getState().project?.id
    if (!ipc || !projectId) return
    const sourceBranchId = useVideoStore.getState().projectActiveBranchId ?? undefined
    const name = `before edit ${new Date().toLocaleString()}`
    try {
      await ipc.create({ projectId, name, sourceBranchId })
      incrementBranchListVersion()
    } catch (err) {
      console.error('[AgentChat] Failed to create branch before rewind:', err)
    }
  }, [incrementBranchListVersion])

  // Rate-limit countdown ticker. Ticks once a second until it hits 0,
  // then stops; the bubble swaps the countdown text for an active Retry button.
  useEffect(() => {
    if (!rateLimitCountdown || rateLimitCountdown.seconds <= 0) return
    const t = setTimeout(() => {
      setRateLimitCountdown((prev) =>
        prev && prev.msgId === rateLimitCountdown.msgId ? { ...prev, seconds: prev.seconds - 1 } : prev,
      )
    }, 1000)
    return () => clearTimeout(t)
  }, [rateLimitCountdown])

  /** Does a pre-run snapshot exist for the run removed when rewinding to the
   *  user message preceding `assistantMsgId`? Drives the restore-project option. */
  const canRestoreForAssistant = useCallback((assistantMsgId: string): boolean => {
    const msgs = useVideoStore.getState().chatMessages
    const userIdx = findPrecedingUserIndex(msgs, assistantMsgId)
    if (userIdx < 0) return false
    return findRestoreSnapshotMsgId(msgs, msgs[userIdx].id, (id) => useVideoStore.getState().hasRunSnapshot(id)) != null
  }, [])

  /** Retry: confirm-gated rewind to the preceding user message + rerun. */
  const handleRetry = useCallback(
    (assistantMsgId: string) => {
      if (isGenerating || useVideoStore.getState().showcaseMode) return // showcase fence
      setRewindConfirm({
        kind: 'regenerate',
        canRestore: canRestoreForAssistant(assistantMsgId),
        run: (opts) => rewind.retryAssistant(assistantMsgId, opts),
      })
    },
    [isGenerating, rewind, canRestoreForAssistant],
  )

  /**
   * Retry after a rate limit. Same rewind-and-rerun as handleRetry. The
   * confirm dialog is skipped ONLY when the failed run produced ZERO tool calls
   * (a pure 429 before any work — nothing to lose). If the run got far enough to
   * make tool calls before the rate limit, those are real project changes the
   * rerun would discard, so route through the RewindConfirmDialog like a normal
   * regenerate. Clears the countdown either way.
   */
  const handleRateLimitRetry = useCallback(
    (assistantMsgId: string) => {
      if (isGenerating || useVideoStore.getState().showcaseMode) return // showcase fence
      setRateLimitCountdown(null)
      const failed = useVideoStore.getState().chatMessages.find((m) => m.id === assistantMsgId)
      const segs = (failed?.contentSegments ?? []) as Array<{ type?: string }>
      const producedToolCalls = (failed?.toolCalls?.length ?? 0) > 0 || segs.some((s) => s?.type === 'tool')
      if (producedToolCalls) {
        setRewindConfirm({
          kind: 'regenerate',
          canRestore: canRestoreForAssistant(assistantMsgId),
          run: (opts) => rewind.retryAssistant(assistantMsgId, opts),
        })
        return
      }
      void rewind.retryAssistant(assistantMsgId)
    },
    [isGenerating, rewind, canRestoreForAssistant],
  )

  /** Regenerate: same as retry; distinct entry point on assistant messages. */
  const handleRegenerate = useCallback(
    (assistantMsgId: string) => {
      if (isGenerating || useVideoStore.getState().showcaseMode) return // showcase fence
      setRewindConfirm({
        kind: 'regenerate',
        canRestore: canRestoreForAssistant(assistantMsgId),
        run: (opts) => rewind.regenerateAssistant(assistantMsgId, opts),
      })
    },
    [isGenerating, rewind, canRestoreForAssistant],
  )

  /** Edit: swap a user message's content, drop the tail, rerun.
   *  Opens the revert confirm — editing a PAST message rewinds the chat to
   *  that point (Cursor-style), optionally restoring project state. */
  const handleEditMessage = useCallback(
    (userMsgId: string, newText: string) => {
      // Showcase fence: fixture messages must never reach the DB-first
      // truncate or fire a real agent rerun.
      if (isGenerating || useVideoStore.getState().showcaseMode) return
      const msgs = useVideoStore.getState().chatMessages
      const canRestore =
        findRestoreSnapshotMsgId(msgs, userMsgId, (id) => useVideoStore.getState().hasRunSnapshot(id)) != null
      setRewindConfirm({ kind: 'edit', canRestore, run: (opts) => rewind.editUserMessage(userMsgId, newText, opts) })
    },
    [isGenerating, rewind],
  )

  const continueAfterPermission = useCallback(
    async (msg: ChatMessage, api: string) => {
      if (isGenerating) return
      const perm = msg.pendingPermissions?.find((p) => p.api === api)
      if (!perm?.toolName || !perm.toolArgs) return

      await persistPausedAgentRun(null)

      const pendingAssistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      }
      addChatMessage(pendingAssistantMsg)

      // web_search: don't replay the proxy tool call — once approved, the context-builder
      // drops request_web_search and injects native web_search, so replaying the proxy
      // would resolve to a now-missing tool and silently skip. Instead resume with a plain
      // instruction; sessionPermissions['web_search'] is already 'allow', so the new request
      // carries the real search tool and the model proceeds.
      if (perm.kind === 'web_search') {
        await runAgentStream({
          messageContent: 'Web search approved for this session. Continue and search the web as needed.',
          pendingAssistantMsg,
          forceAgentOverride: (msg.agentType ?? 'scene-maker') as AgentType,
        })
        drainCrossProjectProposal()
        return
      }

      // For mutation_preview gates we mark the args so the executor's preview check
      // short-circuits on the resumed call (otherwise we'd pause forever). For paid_api
      // gates the args pass through as-is.
      const resumeArgs =
        perm.kind === 'mutation_preview' ? { ...perm.toolArgs, __previewApproved: true } : perm.toolArgs

      await runAgentStream({
        messageContent: 'Continue after permission approval.',
        pendingAssistantMsg,
        forceAgentOverride: (msg.agentType ?? 'scene-maker') as AgentType,
        resumeToolCall: { toolName: perm.toolName, toolInput: resumeArgs },
        // Carry the pre-pause spend so the resumed ledger seeds (no fresh $cap).
        ...(typeof pausedAgentRun?.spentUsd === 'number'
          ? { extraBody: { resumeSpentUsd: pausedAgentRun.spentUsd } }
          : {}),
      })
      drainCrossProjectProposal()
    },
    [isGenerating, addChatMessage, runAgentStream, persistPausedAgentRun, drainCrossProjectProposal, pausedAgentRun],
  )

  // DENY resumes the run too — without it, denying a permission left the run
  // permanently paused (only the paused-run record was cleared), so the agent
  // never reacted and the build silently stalled. Mirror the approve path but
  // with NO resumeToolCall (the model must NOT replay the denied call) and a
  // denial instruction telling it to adapt. The session-deny was already
  // recorded by handlePermission(...,'deny'), so the permission gate refuses any
  // retry of the same call.
  const denyAndContinue = useCallback(
    async (msg: ChatMessage, api: string) => {
      if (isGenerating) return
      const perm = msg.pendingPermissions?.find((p) => p.api === api)
      if (!perm?.toolName) return

      await persistPausedAgentRun(null)

      const pendingAssistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      }
      addChatMessage(pendingAssistantMsg)

      await runAgentStream({
        messageContent: buildDenialResumeMessage(perm.toolName, api),
        pendingAssistantMsg,
        forceAgentOverride: (msg.agentType ?? 'scene-maker') as AgentType,
        // No resumeToolCall — the denied call must not be replayed. Still carry the
        // pre-pause spend so the continued run's ledger seeds (no fresh $cap).
        ...(typeof pausedAgentRun?.spentUsd === 'number'
          ? { extraBody: { resumeSpentUsd: pausedAgentRun.spentUsd } }
          : {}),
      })
      drainCrossProjectProposal()
    },
    [isGenerating, addChatMessage, runAgentStream, persistPausedAgentRun, drainCrossProjectProposal, pausedAgentRun],
  )

  // ask_user: the user answered the clarify card → resume the paused run by
  // re-issuing the SAME ask_user call with the answer threaded in as `_answer`.
  // The handler then returns the answer as the tool result and the loop continues.
  const answerClarification = useCallback(
    async (msg: ChatMessage, answer: string) => {
      if (isGenerating) return
      // Read the resume payload from the MESSAGE (not the singular pausedAgentRun)
      // so multiple cards / a re-paused run resume correctly. Ignore an already-
      // answered card (prevents a double-fire on a stale click).
      const clar = msg.pendingClarification
      if (!clar?.toolName || clar.answered) return
      // Carry the pre-pause spend before nulling the paused record, so the resumed
      // ledger seeds instead of restarting at $0.
      const priorSpend = pausedAgentRun?.spentUsd
      updateChatMessage(msg.id, { pendingClarification: { ...clar, answered: true } })
      await persistPausedAgentRun(null)
      const pendingAssistantMsg: ChatMessage = { id: uuidv4(), role: 'assistant', content: '', timestamp: Date.now() }
      addChatMessage(pendingAssistantMsg)
      await runAgentStream({
        // Carry the answer IN the message: the re-executed ask_user returns the
        // answer to the event stream, but it is NOT in the model's `messages` —
        // so without this the model is told "continue" but never sees the answer.
        messageContent: `The user answered your question "${clar.question}": "${answer}". Continue, applying that.`,
        pendingAssistantMsg,
        forceAgentOverride: (msg.agentType ?? 'scene-maker') as AgentType,
        resumeToolCall: { toolName: clar.toolName, toolInput: { ...clar.toolInput, _answer: answer } },
        ...(typeof priorSpend === 'number' ? { extraBody: { resumeSpentUsd: priorSpend } } : {}),
      })
      drainCrossProjectProposal()
    },
    [
      isGenerating,
      updateChatMessage,
      persistPausedAgentRun,
      addChatMessage,
      runAgentStream,
      drainCrossProjectProposal,
      pausedAgentRun,
    ],
  )

  const handleResumeCheckpoint = useCallback(async () => {
    if (!runCheckpoint || isGenerating) return
    const pendingAssistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    addChatMessage(pendingAssistantMsg)
    await runAgentStream({
      messageContent: `Resume interrupted build (${runCheckpoint.completedSceneIds.length} scenes done).`,
      pendingAssistantMsg,
      forceAgentOverride: runCheckpoint.agentType as AgentType,
      extraBody: { resumeCheckpoint: true },
    })
    drainCrossProjectProposal()
    setRunCheckpoint(null)
  }, [runCheckpoint, isGenerating, addChatMessage, runAgentStream, setRunCheckpoint, drainCrossProjectProposal])

  const handleDiscardCheckpoint = useCallback(async () => {
    if (!runCheckpoint) return
    // 0015: runCheckpoint is branch-scoped — clear it on the active branch's row.
    await useVideoStore.getState().persistBranchProposalField('runCheckpoint', null)
    setRunCheckpoint(null)
  }, [runCheckpoint, setRunCheckpoint])

  // Phase 3 — approve the written plan and kick off the build run. The plan is
  // the ONLY user-facing planning artifact; the build derives its internal scene specs itself,
  // updating the plan's todo checklist live. We do NOT force an agent override — this respects
  // the Master-Builder default (the user's chosen agent dispatches the build).
  const handleApprovePlan = useCallback(async () => {
    if (isGenerating) return
    const plan = useVideoStore.getState().pendingPlan
    if (!plan) return

    // Drop the approval gate but keep the plan + todos on screen for the build.
    useVideoStore.getState().setPlanAwaitingApproval(false)
    setPlanFirstMode(false)

    // Embed the approved plan body in the build message. The plan lives in the
    // write_plan tool-call input, which is NOT carried in chat history (history
    // sends message.content only) — so without this the build agent would build
    // blind. This is the structured plan→build handoff.
    const buildText =
      'I approve this plan. Build it now: create the scenes and layers as planned (derive the structure yourself — no need to ask), and keep the todo checklist updated as you go.\n\n' +
      `## Approved plan${plan.title && plan.title !== 'Plan' ? ` — ${plan.title}` : ''}\n${plan.body}`
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: buildText,
      timestamp: Date.now(),
    }
    addChatMessage(userMsg)
    await persistUserMessage(userMsg)
    const pendingAssistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    addChatMessage(pendingAssistantMsg)
    await runAgentStream({
      messageContent: buildText,
      pendingAssistantMsg,
      // This run EXECUTES the approved plan — a re-issued write_plan during the
      // build must update todos in place, never re-open the approval gate.
      planBuildRun: true,
      currentUserMsgId: userMsg.id, // buildText travels as `message` — don't double-send via history
    })
    drainCrossProjectProposal()
  }, [isGenerating, addChatMessage, persistUserMessage, runAgentStream, setPlanFirstMode, drainCrossProjectProposal])

  // Dismiss the plan card (user declines the approval gate). The conversation
  // stays — the user can reply with changes (reply-to-revise) and the agent will
  // re-issue write_plan.
  const handleRejectPlan = useCallback(() => {
    clearPlan()
  }, [clearPlan])

  /**
   * Multi-variant agent runs (v0.3.7). Builds a base agent request body
   * (mirrors the essentials runAgentStream sends) and hands one branchId
   * at a time to spawnAgentVariants. Each variant lives on its own branch
   * created off the user's current branch; the renderer's view stays put
   * during the runs. Sequential — per-project run lock prevents parallel
   * agent runs today.
   */
  const runVariantsFlow = useCallback(
    async (opts: {
      messageContent: MessageContent
      pendingAssistantMsg: ChatMessage
      n: number
      promptText: string
      referenceMedia?: ReferenceMedia[]
      /** Cap the WHOLE fan-out (reserved evenly per branch). Set on the
       *  agent-driven path so dispatch_to_branches can't N×overspend; omitted
       *  on the manual variant picker (each take keeps the full run budget). */
      groupBudgetUsd?: number | null
    }) => {
      const { messageContent, pendingAssistantMsg, n, promptText, referenceMedia, groupBudgetUsd } = opts
      const st = useVideoStore.getState()
      // Mirrors the guard in runAgentStream. Without it, variants would
      // create branches and then fail at reserveRunSlot — leaving orphan
      // branches behind alongside a confusing error in another tab.
      if (st.isAgentRunningRemote) {
        updateChatMessage(pendingAssistantMsg.id, { content: 'Agent is already running in another tab.' })
        return
      }
      if (!st.project?.id) {
        updateChatMessage(pendingAssistantMsg.id, {
          content: 'Variants need a project — open or create one first.',
        })
        return
      }
      const sourceBranchId = st.projectActiveBranchId
      if (!sourceBranchId) {
        updateChatMessage(pendingAssistantMsg.id, {
          content: 'Variants need an active branch. Try again once the project finishes loading.',
        })
        return
      }

      setIsGenerating(true)
      setStreamingMsgId(pendingAssistantMsg.id)

      const controller = new AbortController()
      abortRef.current = controller

      const effectiveModelOverride = st.localMode && st.localModelId ? st.localModelId : (st.modelOverride ?? undefined)

      // Snapshot editor UI state once at the variants flow start so each
      // variant agent gets the same "what was the user looking at?" answer.
      // Matches the snapshot runAgentStream takes; without it the variant
      // agent's `read_editor_state` tool returns undefined fields and may
      // make worse layout decisions.
      const editorStateSnapshot = {
        selectedSceneId: scene?.id ?? null,
        selectedClipIds: [...(st.selectedClipIds ?? [])],
        currentTime: st.timelineTransport?.globalTime ?? 0,
        isPlaying: st.timelineTransport?.isPlaying ?? false,
        totalDuration: st.timelineTransport?.totalDuration ?? 0,
        timelineZoom: st.timelineZoom ?? 0,
        capturedAt: new Date().toISOString(),
      }

      // Build the per-variant agent request. branchId is swapped in by the
      // orchestrator per variant. Note: history is intentionally fresh per
      // variant so each take starts from the same chat context, not from
      // whatever the prior variant's run added.
      const buildAgentRequest = (branchId: string): Record<string, unknown> => ({
        message: messageContent,
        modelOverride: effectiveModelOverride,
        modelTier: st.modelTier,
        thinkingMode: st.localMode ? 'off' : st.thinkingMode,
        sceneContext: st.sceneContext,
        activeTools: st.activeTools,
        history: [],
        projectId: st.project.id,
        branchId,
        // A variant run must not itself fan out (would terminate with an empty
        // branch — its SSE events are ignored by spawnAgentVariants).
        disableFanout: true,
        conversationId: null, // Variants don't share the source chat's conversation
        // Send NO client scenes for a variant run. The variant branch is a fresh
        // CLONE of the source branch (createBranch gives the clones NEW scene ids),
        // so mergeServerScenes populates the body from the variant branch's OWN
        // scenes. Sending the SOURCE branch's scenes here (source ids) would carry
        // them into the variant run and, on persist under the variant branchId,
        // MOVE those rows off the source branch (scenes PK is `id` alone) — stealing
        // the source branch's scenes. Empty client + branch-scoped merge avoids that.
        scenes: [],
        globalStyle: st.globalStyle,
        projectName: st.project.name,
        outputMode: st.project.outputMode,
        sceneGraph: st.project.sceneGraph,
        selectedSceneId: scene?.id ?? null,
        // editorState: required by the agent's `read_editor_state` tool to
        // answer "what am I looking at?". Snapshotted once for all variants.
        editorState: editorStateSnapshot,
        previewMode: st.previewMode ?? 'off',
        runBudgetUsd: st.runBudgetUsd,
        audioProviderEnabled: st.audioProviderEnabled,
        mediaGenEnabled: st.mediaGenEnabled,
        mediaUnderstandingEngines: st.mediaUnderstandingEngines,
        ...(referenceMedia && referenceMedia.length > 0 ? { referenceMedia } : {}),
        webSearchEnabled: st.webSearchEnabled,
        aiQualityReview: st.aiQualityReview,
        subAgents: st.subAgents,
        webFetchEnabled: st.webFetchEnabled,
        autoAcceptWebSearch: st.autoAcceptWebSearch,
        researchProviderEnabled: st.researchProviderEnabled,
        ytDlpConsentedProjectIds: st.ytDlpConsentedProjectIds,
        enabledModelIds: st.modelConfigs
          .filter((m) => m.enabled)
          .flatMap((m) => (m.id !== m.modelId ? [m.modelId, m.id] : [m.modelId])),
        // apiPermissions + sessionPermissions: required for the agent's
        // permission gate. Without sessionPermissions the agent would
        // re-prompt for every API the user already approved this session.
        apiPermissions: st.project.apiPermissions,
        sessionPermissions: Object.fromEntries(st.sessionPermissions),
        generationOverrides: st.generationOverrides,
        autoChooseDefaults: st.autoChooseDefaults,
        localMode: st.localMode,
        mockMode: st.mockMode,
        mp4Settings: st.project.mp4Settings,
        planFirstMode: false, // Variants always build (no plan-only mode)
        ...(st.localMode ? { modelConfigs: st.modelConfigs.filter((m) => m.provider === 'local') } : {}),
      })

      const STATUS_LABEL: Record<string, string> = {
        creating: 'Creating branch',
        running: 'Generating',
        done: 'Done',
        failed: 'Failed',
      }
      // Per-variant status table. Re-rendered into the assistant message
      // after every progress event so the user sees live progress.
      const statusByIdx = new Map<number, { status: string; detail?: string }>()
      const renderProgress = () => {
        const lines: string[] = [`Spawning ${n} variants on new branches:`]
        for (let i = 0; i < n; i++) {
          const s = statusByIdx.get(i)
          const label = s ? (STATUS_LABEL[s.status] ?? s.status) : 'Queued'
          const detail = s?.detail ? ` — ${s.detail}` : ''
          lines.push(`  ${i + 1}. ${label}${detail}`)
        }
        return lines.join('\n')
      }

      // Initial render before anything starts.
      updateChatMessage(pendingAssistantMsg.id, { content: renderProgress() })

      let results: VariantResult[] = []
      try {
        results = await spawnAgentVariants({
          projectId: st.project.id,
          sourceBranchId,
          prompt: promptText,
          n,
          buildAgentRequest,
          signal: controller.signal,
          ...(groupBudgetUsd !== undefined ? { groupBudgetUsd } : {}),
          onProgress: (idx, status, detail) => {
            statusByIdx.set(idx, { status, detail })
            updateChatMessage(pendingAssistantMsg.id, { content: renderProgress() })
            // Variant-spawn progress shares the live region. Infrequent (one per
            // variant status change); pushText surfaces it within one ~33ms tick.
            streamingRef.current?.pushText(renderProgress())
          },
        })

        const successResults = results.filter((r) => r.status === 'success')
        const successCount = successResults.length

        // Stash the spawn result on the store so the branch selector's
        // "Compare N variants" entry button (v0.3.9) appears immediately.
        // Only counts successes — failed variants have nothing renderable
        // to compare.
        if (successResults.length >= 2) {
          useVideoStore.getState().setLastVariantsSpawn({
            branchIds: successResults.map((r) => r.branchId),
            sourceBranchId,
            createdAt: Date.now(),
          })
        }

        const summaryLines = [
          `${successCount} of ${n} variant${n === 1 ? '' : 's'} ready.`,
          ...(successCount >= 2 ? ['', 'Open the branch selector to compare them side by side.'] : []),
          '',
          ...results.map((r) =>
            r.status === 'success'
              ? `  ${r.index + 1}. ${r.branchName} (${Math.round(r.durationMs / 1000)}s)`
              : `  ${r.index + 1}. ${r.branchName} — failed: ${r.error ?? 'unknown'}`,
          ),
        ]
        updateChatMessage(pendingAssistantMsg.id, { content: summaryLines.join('\n') })
        await persistChatMessage(pendingAssistantMsg.id, { status: 'complete' })
      } catch (err) {
        const msg = (err as Error).message ?? 'unknown'
        updateChatMessage(pendingAssistantMsg.id, { content: `Variant spawn failed: ${msg}` })
        await persistChatMessage(pendingAssistantMsg.id, { status: 'complete' })
      } finally {
        streamingRef.current?.resetAll()
        setIsGenerating(false)
        setStreamingMsgId(null)
        abortRef.current = null
      }
    },
    [scene, updateChatMessage, persistChatMessage],
  )

  const handleSend = useCallback(async () => {
    // Showcase fence: no sends, no runs while fixtures are displayed.
    // The banner above the composer is the affordance to exit.
    if (showcaseMode) return
    const hasContent =
      input.trim().length > 0 ||
      pendingImages.length > 0 ||
      pendingAssetRefs.length > 0 ||
      pendingReferenceMedia.length > 0 ||
      pendingPastedTexts.length > 0
    if (!hasContent) return

    // Mid-run STEER: a local run is active and we know its runId → fold this
    // message into the live run instead of starting a new one. Text-only (attach
    // controls are disabled during a run). On reject (run ended / over cap) the
    // text is left in the composer so the user can resend as a normal turn.
    if (shouldRouteToSteer(isGenerating, activeLocalRunIdRef.current)) {
      const steerText = input.trim()
      if (steerText.length === 0) return // text-only steer; nothing to send
      const runId = activeLocalRunIdRef.current as string
      const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `steer-${Date.now()}`
      const ok = await postAgentSteer({ runId, id, text: steerText })
      if (!ok) return // run ended before we could steer — keep the text for a normal resend
      // Show the steer ABOVE the in-progress assistant reply it interrupts (not after it).
      const steerMsg: ChatMessage = { id, role: 'user', content: steerText, timestamp: Date.now() }
      if (streamingMsgId) insertChatMessageBefore(steerMsg, streamingMsgId)
      else addChatMessage(steerMsg)
      void persistUserMessage(steerMsg)
      setInput('')
      return
    }

    // A run is active but not steerable (no runId yet) — refuse the submit,
    // but never silently: the text stays in the composer and a transient
    // status says so (the placeholder must not promise more).
    if (isGenerating) {
      useVideoStore.getState().showTransientStatus?.(STEER_NOT_READY_NOTICE, 2800)
      return
    }

    // Cinema Studio: the Generate toggle reroutes Send to the gated media-generation pipeline
    // instead of an agent run. Image-first; a chosen character renders i2i (its bundled seed), else
    // raw t2i with the manual model + seed.
    if (generateMode) {
      const sid = selectedSceneId
      if (!sid || !input.trim()) return
      // Block a concurrent paid Send (re-typing mid-generation). The `await`s below resolve when
      // the paid call completes (or, for video, once the job is kicked off), so the lock spans the
      // billable window.
      if (genInFlightRef.current) return
      // Don't fire paid generation while an agent run owns this scene — in another tab
      // (isAgentRunningRemote) or via the scene lock. The paid IPC fires regardless of the
      // lock-rejected layer write, so we must gate here.
      if (isAgentRunningRemote || genSceneAgentLocked) {
        useVideoStore.getState().showTransientStatus?.('An agent is editing this scene — wait for it to finish.', 2800)
        return
      }
      const prompt = input.trim()
      setInput('')
      const n = parseInt(genSeedText, 10)
      const seed = Number.isFinite(n) && n >= 0 ? n : null
      genInFlightRef.current = true
      try {
        if (genFormat === 'image') {
          const char = genCharacters.find((c) => c.id === genCharacterId)
          if (char) {
            await generateCharacterImage(sid, {
              characterId: char.id,
              characterName: char.name,
              model: char.model,
              prompt,
              aspectRatio: effectiveGenAspect,
            })
          } else {
            await generateAIImage(sid, { prompt, model: effectiveGenModel, aspectRatio: effectiveGenAspect, seed })
          }
        } else if (genFormat === 'video') {
          // i2v: resolve the chosen source to an image reference. Don't silently fall back to t2v
          // when a source was picked but can't be resolved — surface it.
          let imageUrl: string | undefined
          if (videoModelSupportsI2v && genVideoSrc !== 'none') {
            if (genVideoSrc === 'frame') {
              imageUrl = (await useVideoStore.getState().captureSceneFrame(sid, 0)) ?? undefined
            } else if (genVideoSrc === 'upload') {
              imageUrl = genVideoUpload?.dataUrl
            } else if (genVideoSrc.startsWith('layer:')) {
              const lid = genVideoSrc.slice('layer:'.length)
              const sc = useVideoStore.getState().scenes.find((x) => x.id === sid)
              const layer = sc?.aiLayers?.find((l) => l.id === lid) as { imageUrl?: string } | undefined
              imageUrl = layer?.imageUrl
            }
            if (!imageUrl) {
              useVideoStore.getState().showTransientStatus?.('Could not read the selected image source.', 3000)
              genInFlightRef.current = false
              return
            }
          }
          // Tier 2 (#5) keyframes: resolve the END frame. Requires a start frame (imageUrl) — startVideo
          // enforces it too, but fail early in the UI with a clear message instead of a server error.
          let endImageUrl: string | undefined
          if (videoModelSupportsKeyframes && genVideoEndSrc !== 'none') {
            if (!imageUrl) {
              useVideoStore.getState().showTransientStatus?.('Pick a start image before adding an end frame.', 3000)
              genInFlightRef.current = false
              return
            }
            if (genVideoEndSrc === 'frame') {
              endImageUrl = (await useVideoStore.getState().captureSceneFrame(sid, 0)) ?? undefined
            } else if (genVideoEndSrc === 'upload') {
              endImageUrl = genVideoEndUpload?.dataUrl
            } else if (genVideoEndSrc.startsWith('layer:')) {
              const lid = genVideoEndSrc.slice('layer:'.length)
              const sc = useVideoStore.getState().scenes.find((x) => x.id === sid)
              const layer = sc?.aiLayers?.find((l) => l.id === lid) as { imageUrl?: string } | undefined
              endImageUrl = layer?.imageUrl
            }
            if (!endImageUrl) {
              useVideoStore.getState().showTransientStatus?.('Could not read the selected end frame.', 3000)
              genInFlightRef.current = false
              return
            }
          }
          // Tier 2 (#5) extend: resolve the source CLIP (a video layer or an uploaded clip).
          let extendVideoUrl: string | undefined
          if (videoModelSupportsExtend && genExtendSrc !== 'none') {
            if (genExtendSrc === 'upload') {
              extendVideoUrl = genExtendUpload?.dataUrl
            } else if (genExtendSrc.startsWith('layer:')) {
              const lid = genExtendSrc.slice('layer:'.length)
              const sc = useVideoStore.getState().scenes.find((x) => x.id === sid)
              const layer = sc?.aiLayers?.find((l) => l.id === lid) as { videoUrl?: string } | undefined
              extendVideoUrl = layer?.videoUrl
            }
            if (!extendVideoUrl) {
              useVideoStore.getState().showTransientStatus?.('Could not read the selected source clip.', 3000)
              genInFlightRef.current = false
              return
            }
          }
          // Tier 2 (#4) edit (v2v / Aleph): resolve the source clip to transform; the chosen operation
          // frames the prompt as an in-video edit (compiled by startVideo).
          let editVideoUrl: string | undefined
          if (videoModelSupportsV2v && genEditSrc !== 'none') {
            if (genEditSrc === 'upload') {
              editVideoUrl = genEditUpload?.dataUrl
            } else if (genEditSrc.startsWith('layer:')) {
              const lid = genEditSrc.slice('layer:'.length)
              const sc = useVideoStore.getState().scenes.find((x) => x.id === sid)
              const layer = sc?.aiLayers?.find((l) => l.id === lid) as { videoUrl?: string } | undefined
              editVideoUrl = layer?.videoUrl
            }
            if (!editVideoUrl) {
              useVideoStore.getState().showTransientStatus?.('Could not read the clip to edit.', 3000)
              genInFlightRef.current = false
              return
            }
          }
          const camera =
            genCameraMove === 'none' ? undefined : { moves: [{ type: genCameraMove, intensity: genCameraIntensity }] }
          await generateAIVideo(sid, {
            prompt,
            model: effectiveGenModel,
            aspectRatio: effectiveGenAspect,
            duration: genDuration,
            seed,
            imageUrl,
            endImageUrl,
            extendVideoUrl,
            editVideoUrl,
            edit: editVideoUrl ? { operation: genEditOp } : undefined,
            camera,
            effect: genEffect || undefined,
            lensPreset: genLensPreset || undefined,
          })
        } else if (genFormat === 'audio') {
          // Voice = narration (replaces the scene's one TTS track), SFX = appended to sfx[],
          // Music = the scene's single music track. Provider = the selected audio model.
          if (genAudioKind === 'tts') {
            await generateNarration(sid, prompt, effectiveAudioModel, genVoiceId || undefined)
          } else if (genAudioKind === 'sfx') {
            await generateSfx(sid, { prompt, provider: effectiveAudioModel })
          } else {
            await generateMusic(sid, { prompt, provider: effectiveAudioModel })
          }
        } else if (genFormat === 'lipsync') {
          // Resolve the FACE source (required) — same picker/resolver as i2v.
          let faceUrl: string | undefined
          if (genVideoSrc === 'frame') {
            faceUrl = (await useVideoStore.getState().captureSceneFrame(sid, 0)) ?? undefined
          } else if (genVideoSrc === 'upload') {
            faceUrl = genVideoUpload?.dataUrl
          } else if (genVideoSrc.startsWith('layer:')) {
            const lid = genVideoSrc.slice('layer:'.length)
            const sc = useVideoStore.getState().scenes.find((x) => x.id === sid)
            const layer = sc?.aiLayers?.find((l) => l.id === lid) as { imageUrl?: string } | undefined
            faceUrl = layer?.imageUrl
          }
          if (!faceUrl) {
            useVideoStore.getState().showTransientStatus?.('Pick a face image for lipsync.', 3000)
            return
          }
          await generateLipsync(sid, {
            provider: genLipsyncModel,
            imageUrl: faceUrl,
            text: prompt,
            ttsProvider: effectiveLipsyncTts,
            voiceId: genVoiceId || undefined,
          })
        }
      } finally {
        genInFlightRef.current = false
      }
      return
    }

    // User interaction — from here forward, auto-scrolls can animate.
    // (Initial load + IPC reflow uses synchronous scrollTop instead.)
    isFirstScrollRef.current = false

    try {
      speechRecognitionRef.current?.stop()
    } catch {}
    speechRecognitionRef.current = null
    setIsListening(false)

    const warning = checkKeywordGuard(input)
    if (warning && !keywordWarning) {
      setKeywordWarning(warning)
      return
    }
    setKeywordWarning(null)

    // A fresh user turn supersedes any prior plan card. If this turn is itself a
    // plan-first run, a new plan_proposed event will repopulate it; the approve
    // build path bypasses handleSend, so it keeps the plan on screen.
    clearPlan()

    const rawUserText = input.trim()
    const images = [...pendingImages]
    const assetRefs = [...pendingAssetRefs]
    const refMedia = [...pendingReferenceMedia]
    const pastedTexts = [...pendingPastedTexts]
    setInput('')
    setPendingImages([])
    setPendingAssetRefs([])
    setPendingReferenceMedia([])
    setPendingPastedTexts([])
    setShowModelMenu(false)
    setShowAgentMenu(false)
    setShowSpeechLangMenu(false)

    // Inline attached-asset note so CC links "this SVG" / "the video I dropped"
    // to the specific files. Full URLs still come from the project-assets block
    // the context builder injects (src/lib/agents/context-builder.ts:935) — we only
    // need to name them here.
    const assetNote =
      assetRefs.length > 0
        ? `\n\n[Just uploaded to this project: ${assetRefs.map((a) => `${a.name} (${a.type})`).join(', ')}. See Project Assets in context for URLs.]`
        : ''
    // Resolve @-mentions to scene ids — same inline-note precedent as
    // assetNote above. The model has all scenes in world state; the note pins
    // WHICH scene the user means (duplicates resolve to every match).
    const mentionNote = buildMentionNote(rawUserText, scenes) ?? ''
    // The user-facing text (no paste) — used for the conversation auto-title and
    // the scene prompt record so neither becomes a wall of pasted content.
    const userText = rawUserText + assetNote + mentionNote
    // Pasted blocks are appended to the SENT/STORED content with a stable
    // delimiter (PASTE_DELIM). The model reads them verbatim; the transcript
    // renderer splits them back out into chips via splitPastedContent — so the
    // chips survive reload (content is the single source of truth, no schema
    // change) instead of flooding the bubble.
    const pastedNote = pastedTexts.map((p) => `${PASTE_DELIM}${p.text}`).join('')
    const fullText = userText + pastedNote

    // Slash-command interception. Skip when images/assets are attached — those
    // require a full agent turn regardless of any leading "/text".
    const slashCommand =
      images.length === 0 &&
      assetRefs.length === 0 &&
      refMedia.length === 0 &&
      pastedTexts.length === 0 &&
      rawUserText.startsWith('/')
        ? parseCommand(rawUserText)
        : null

    // `content` carries the pasted blocks inlined (single source of truth: the
    // model reads them, persistence stores them, and the renderer splits them
    // back into chips so the bubble never floods).
    let messageContent: MessageContent
    if (images.length > 0) {
      const blocks: ContentBlock[] = []
      for (const img of images) {
        blocks.push({ type: 'image', image: img })
      }
      if (fullText) blocks.push({ type: 'text', text: fullText })
      messageContent = blocks
    } else {
      messageContent = fullText
    }

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
    }
    addChatMessage(userMsg)
    // Await user message persistence — ensures it's in the DB before the agent starts,
    // so it survives page refresh/kill during long agent runs.
    await persistUserMessage(userMsg)

    // Read the conversation id fresh from the store: persistUserMessage above
    // promotes a fresh draft and assigns activeConversationId, but the
    // render-captured `activeConversationId` is still null for the first draft
    // message. chatMessages.length is the pre-send count (correct here).
    const freshConversationId = useVideoStore.getState().activeConversationId
    if (chatMessages.length === 0 && freshConversationId) {
      const autoTitle = userText.slice(0, 40) + (userText.length > 40 ? '...' : '')
      renameConversation(freshConversationId, autoTitle)
    }

    // Immediate slash command — synthesize a local assistant reply, no agent run.
    if (slashCommand?.type === 'immediate') {
      const ctx: CommandContext = {
        scenes: scenes.map((s) => ({ id: s.id, name: s.name ?? '' })),
        projectName: project?.name ?? 'Untitled',
        messageHistory: chatMessages.map((m) => ({ role: m.role, content: m.content })),
      }
      const replyText = await Promise.resolve(slashCommand.execute(ctx))
      const assistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: replyText,
        timestamp: Date.now(),
      }
      addChatMessage(assistantMsg)
      await persistChatMessage(assistantMsg.id, { status: 'complete' })
      return
    }

    const pendingAssistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    addChatMessage(pendingAssistantMsg)
    if (scene) updateScene(scene.id, { prompt: userText })

    // Agent slash command — substitute the expanded prompt and route to the
    // command's preferred agent. The user message above keeps the literal
    // "/cmd args" they typed so the chat history stays readable.
    if (slashCommand?.type === 'agent') {
      await runAgentStream({
        messageContent: slashCommand.message,
        pendingAssistantMsg,
        forcePlanFirst: slashCommand.planFirstMode,
      })
      drainCrossProjectProposal()
      return
    }

    // Multi-variant path (v0.3.7). When the user picks N > 1, spawn N
    // branches off the current one and run the agent on each in sequence.
    // The chat shows progress; user switches branches in the existing
    // selector to compare takes.
    if (variantsCount > 1) {
      await runVariantsFlow({
        messageContent,
        pendingAssistantMsg,
        n: variantsCount,
        promptText: rawUserText,
        ...(refMedia.length > 0 ? { referenceMedia: refMedia } : {}),
      })
      // No drainCrossProjectProposal() here: runVariantsFlow goes through the
      // variant pipeline (not runAgentStream), and variant legs set
      // disableFanout, which gates the crossproject_proposed emit — so this path
      // can't leave a pending spec. (crossProjectSpecRef is also cleared at the
      // next runAgentStream start, so a stale spec can't survive to fire later.)
      return
    }

    await runAgentStream({
      messageContent,
      pendingAssistantMsg,
      // This turn's user message travels as `message` — exclude its history copy.
      // (Slash-command path above intentionally omits this: the literal "/cmd"
      // in history is NOT what's sent, so it isn't a duplicate.)
      currentUserMsgId: userMsg.id,
      ...(refMedia.length > 0 ? { extraBody: { referenceMedia: refMedia } } : {}),
    })

    // If that run ended by calling dispatch_to_branches, fan out now —
    // the stream has closed, so it's safe to open the N variant runs. The group
    // budget is the user's run budget (reserved evenly per branch) so the agent
    // can't N×overspend it.
    const fanoutSpec = fanoutSpecRef.current
    fanoutSpecRef.current = null
    // Don't fan out if the user aborted the originating run. runAgentStream
    // swallows AbortError internally (never re-throws), so without this guard a
    // Stop pressed right after fanout_proposed would still spawn N branches.
    if (fanoutSpec && !lastRunAbortedRef.current) {
      const fanoutMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: `Generating ${fanoutSpec.count} alternative takes on separate branches…`,
        timestamp: Date.now(),
      }
      addChatMessage(fanoutMsg)
      await persistChatMessage(fanoutMsg.id, { status: 'streaming' })
      await runVariantsFlow({
        messageContent: fanoutSpec.instruction,
        pendingAssistantMsg: fanoutMsg,
        n: fanoutSpec.count,
        promptText: fanoutSpec.instruction,
        groupBudgetUsd: useVideoStore.getState().runBudgetUsd ?? null,
      })
    }

    // If that run ended by calling dispatch_to_projects, open the
    // project picker now (stream closed). Shared drain — see drainCrossProjectProposal.
    drainCrossProjectProposal()
  }, [
    input,
    pendingImages,
    pendingAssetRefs,
    pendingReferenceMedia,
    pendingPastedTexts,
    isGenerating,
    showcaseMode,
    chatMessages,
    scene,
    scene?.id,
    scenes,
    project?.name,
    keywordWarning,
    checkKeywordGuard,
    addChatMessage,
    persistUserMessage,
    persistChatMessage,
    updateChatMessage,
    renameConversation,
    activeConversationId,
    updateScene,
    runAgentStream,
    runVariantsFlow,
    variantsCount,
    clearPlan,
    drainCrossProjectProposal,
    // Cinema Studio generate-mode routing
    generateMode,
    selectedSceneId,
    genFormat,
    genModel,
    genAspect,
    genCharacterId,
    genSeedText,
    genCharacters,
    genDuration,
    effectiveGenModel,
    effectiveGenAspect,
    videoModelSupportsI2v,
    genVideoSrc,
    genVideoUpload,
    videoModelSupportsKeyframes,
    videoModelSupportsExtend,
    genVideoEndSrc,
    genVideoEndUpload,
    genExtendSrc,
    genExtendUpload,
    videoModelSupportsV2v,
    genEditSrc,
    genEditUpload,
    genEditOp,
    genCameraMove,
    genCameraIntensity,
    genLensPreset,
    genLipsyncModel,
    effectiveLipsyncTts,
    genAudioKind,
    effectiveAudioModel,
    genVoiceId,
    isAgentRunningRemote,
    genSceneAgentLocked,
    generateAIImage,
    generateCharacterImage,
    generateAIVideo,
    generateNarration,
    generateSfx,
    generateMusic,
    generateLipsync,
  ])

  const handleAbort = () => {
    // Just signal the abort — the catch/finally in runAgentStream handles
    // setting "Stopped by user." text and persisting with status:'complete'.
    // No manual persist here avoids race conditions and duplicates.
    abortRef.current?.abort()

    try {
      speechRecognitionRef.current?.abort()
    } catch {}
    speechRecognitionRef.current = null
    setIsListening(false)
    setShowSpeechLangMenu(false)
  }

  // If user picked a specific model override, show that; otherwise show tier
  const localModel = localMode && localModelId ? modelConfigs.find((m) => m.id === localModelId) : null
  const overrideModel = !localMode && modelOverride ? modelConfigs.find((m) => m.modelId === modelOverride) : null
  const currentModel = localMode
    ? { id: 'local' as any, modelName: localModel?.displayName ?? 'Local', tierLabel: 'Free' }
    : modelOverride === 'codex-cli'
      ? { id: 'codex-cli' as ModelTier, modelName: 'Codex CLI', tierLabel: 'Local CLI' }
      : modelOverride === 'claude-code'
        ? { id: 'claude-code' as ModelTier, modelName: 'Claude Code', tierLabel: 'Local CLI' }
        : overrideModel
          ? { id: 'override' as ModelTier, modelName: overrideModel.displayName, tierLabel: 'Override' }
          : (MODEL_OPTIONS.find((m) => m.id === modelTier) ?? MODEL_OPTIONS[0])

  const handleNewChat = () => {
    try {
      speechRecognitionRef.current?.abort()
    } catch {}
    speechRecognitionRef.current = null
    setIsListening(false)
    setShowSpeechLangMenu(false)
    if (project?.id) newConversation(project.id)
    setInput('')
    setKeywordWarning(null)
    setPlanFirstMode(false)
  }

  // Conversation list views: the tab strip always hides archived; the
  // History modal honors the "Archived" toggle. Both float pinned to the top.
  // The active conversation stays visible even if archived, so archiving the
  // open chat doesn't make its own tab vanish out from under the user.
  const tabConversations = visibleConversations(conversations, { includeArchived: false }).filter(
    (c) => !c.isArchived || c.id === activeConversationId,
  )
  const historyConversations = visibleConversations(conversations, { includeArchived: showArchived })
  // A2 text search applied over the sorted/filtered history list (see History tab).
  const searchedHistoryConversations = filterConversations(historyConversations, convSearch)
  const menuConv = convMenu ? conversations.find((c) => c.id === convMenu.id) : null

  // Export a conversation transcript to Markdown. Uses the in-memory
  // chatMessages when the target is the active conversation; otherwise fetches
  // the full message list via the conversations.get IPC. Download follows the
  // blob + anchor pattern used by ExportPanel.
  const exportConversation = async (conversationId: string, title: string) => {
    try {
      let exportMessages: ExportMessage[]
      if (conversationId === activeConversationId) {
        exportMessages = useVideoStore.getState().chatMessages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
          modelId: m.modelId ?? null,
          costUsd: m.usage?.costUsd ?? null,
        }))
      } else {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
        const data = ipc ? await ipc.get(conversationId) : null
        const rows = data?.messages ?? []
        exportMessages = rows.map((m) => ({
          role: (m.role as 'user' | 'assistant') ?? 'assistant',
          content: m.content ?? '',
          toolCalls: Array.isArray(m.toolCalls)
            ? (m.toolCalls as Array<Record<string, unknown>>).map((tc) => ({
                toolName: typeof tc.toolName === 'string' ? tc.toolName : undefined,
                input: (tc.input as Record<string, unknown>) ?? null,
              }))
            : undefined,
          modelId: m.modelUsed ?? null,
          costUsd: m.costUsd ?? null,
        }))
      }

      const md = serializeConversationToMarkdown({ title, messages: exportMessages })
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFilename(title)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      // Best-effort — a failed export should never throw into the menu handler.
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--panel)] overflow-hidden relative">
      {/* ── Chat Header: conversation tabs ── */}
      <div className="flex items-center px-2 py-1 flex-shrink-0 bg-[var(--panel)]">
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {tabConversations.map((conv) => (
            <span
              key={conv.id}
              onClick={() => conv.id !== activeConversationId && switchConversation(conv.id)}
              onDoubleClick={() => {
                setRenamingId(conv.id)
                setRenameValue(conv.title)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setConvMenu({ id: conv.id, x: e.clientX, y: e.clientY })
              }}
              className={`chat-tab relative overflow-hidden px-3 py-1.5 rounded-md text-sm whitespace-nowrap cursor-pointer select-none transition-all flex-shrink-0 outline-none ${
                conv.id === activeConversationId
                  ? 'bg-[var(--agent-chat-user-surface)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--kbd-text)] hover:bg-[var(--color-panel)]/50'
              }`}
              style={
                {
                  maxWidth: 200,
                  '--tab-bg': conv.id === activeConversationId ? 'var(--agent-chat-user-surface)' : 'var(--color-bg)',
                } as React.CSSProperties
              }
            >
              {conv.isPinned && <Pin size={10} className="opacity-40 inline mr-1" style={{ verticalAlign: '-1px' }} />}
              {renamingId === conv.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => {
                    renameConversation(conv.id, renameValue)
                    setRenamingId(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      renameConversation(conv.id, renameValue)
                      setRenamingId(null)
                    }
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-transparent border-b border-[var(--color-accent)] outline-none text-sm text-[var(--color-text-primary)] w-32"
                />
              ) : (
                <span
                  className="inline-block align-bottom overflow-hidden whitespace-nowrap"
                  style={{
                    maxWidth: conv.id === activeConversationId ? '140px' : '150px',
                    WebkitMaskImage:
                      conv.id === activeConversationId
                        ? 'linear-gradient(to right, black 110px, transparent 150px)'
                        : 'linear-gradient(to right, black 120px, transparent 160px)',
                    maskImage:
                      conv.id === activeConversationId
                        ? 'linear-gradient(to right, black 110px, transparent 150px)'
                        : 'linear-gradient(to right, black 120px, transparent 160px)',
                  }}
                >
                  {conv.title}
                </span>
              )}
              {renamingId !== conv.id && (
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm('Delete this conversation? This cannot be undone.')) {
                      deleteConversation(conv.id)
                    }
                  }}
                  className="chat-tab-x"
                >
                  <X size={14} />
                </span>
              )}
            </span>
          ))}
        </div>

        {/* New chat button */}
        <span
          onClick={handleNewChat}
          className="flex items-center justify-center w-8 h-8 rounded text-[var(--color-text-muted)] hover:text-[var(--kbd-text)] hover:bg-[var(--color-panel)]/50 cursor-pointer transition-all flex-shrink-0 ml-1 outline-none"
          data-tooltip="New Chat"
          data-tooltip-pos="bottom"
        >
          <Plus size={20} />
        </span>

        {/* Ellipsis menu */}
        <div className="relative flex-shrink-0 ml-1 mr-1">
          <span
            onClick={() => setShowEllipsisMenu((o) => !o)}
            className="flex items-center justify-center w-8 h-8 rounded text-[var(--color-text-muted)] hover:text-[var(--kbd-text)] hover:bg-[var(--color-panel)]/50 cursor-pointer transition-all outline-none"
          >
            <MoreHorizontal size={20} />
          </span>
          {showEllipsisMenu && (
            <>
              <div className="fixed inset-0 z-[90]" onClick={() => setShowEllipsisMenu(false)} />
              <div
                className="absolute right-0 top-full mt-1 z-[100] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-lg py-1 min-w-[120px]"
                style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
              >
                <span
                  onClick={() => {
                    setShowConfigModal(true)
                    setShowEllipsisMenu(false)
                  }}
                  className="flex items-center px-3 py-1.5 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border)]/30 cursor-pointer transition-colors"
                >
                  Configure
                </span>
                <span
                  onClick={() => {
                    setConvSearch('') // Fresh search each open
                    setShowHistory(true)
                    setShowEllipsisMenu(false)
                  }}
                  className="flex items-center px-3 py-1.5 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border)]/30 cursor-pointer transition-colors"
                >
                  History
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* History floating modal */}
      {showHistory && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setShowHistory(false)} />
          <div
            className="fixed top-[62px] right-4 z-[9999] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-2xl shadow-2xl w-[340px] max-h-[480px] flex flex-col animate-in fade-in zoom-in-95 duration-200 pointer-events-auto"
            style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] flex-shrink-0">
              <span className="text-[12px] font-bold text-[var(--kbd-text)] flex-1 uppercase tracking-widest">
                History
              </span>
              <span
                onClick={() => setShowArchived((v) => !v)}
                className={`text-[11px] px-2 py-0.5 rounded cursor-pointer border transition-all ${
                  showArchived
                    ? 'bg-[var(--agent-chat-user-surface)] border-[var(--color-border)] text-[var(--color-text-primary)]'
                    : 'bg-transparent border-[var(--kbd-border)] text-[var(--color-text-muted)] hover:text-[var(--kbd-text)]'
                }`}
              >
                Archived
              </span>
              <span
                onClick={() => {
                  handleNewChat()
                  setShowHistory(false)
                }}
                className="text-[11px] px-2 py-0.5 rounded cursor-pointer bg-[var(--kbd-bg)] border border-[var(--kbd-border)] text-[var(--kbd-text)] hover:brightness-110 transition-all"
              >
                New Chat
              </span>
            </div>
            {/* Conversation search — titles + latest-message preview (the list
                IPC ships one message per conversation; steer-ui.filterConversations) */}
            <div className="px-2 pt-2 flex-shrink-0">
              <input
                type="text"
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="Search chats..."
                aria-label="Search chats"
                autoFocus
                className="w-full bg-[var(--color-bg)]/50 border border-[var(--color-border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]/60 outline-none focus:border-[var(--color-text-muted)] transition-colors"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {historyConversations.length === 0 && (
                <div className="flex items-center justify-center h-20 text-[11px] text-[var(--color-text-muted)]">
                  {showArchived ? 'No archived chats' : 'No chats yet'}
                </div>
              )}
              {/* Search composes OVER the pin/archive sort-filter: search
                  within what the toggle shows, never resurrecting archived chats. */}
              {historyConversations.length > 0 && searchedHistoryConversations.length === 0 && (
                <div className="flex items-center justify-center h-20 text-[11px] text-[var(--color-text-muted)]">
                  No chats match &ldquo;{convSearch}&rdquo;
                </div>
              )}
              {searchedHistoryConversations.map((conv) => {
                const preview = conv.messages?.[0]
                const isActive = conv.id === activeConversationId
                return (
                  <div
                    key={conv.id}
                    onClick={() => {
                      switchConversation(conv.id)
                      setShowHistory(false)
                    }}
                    className={`group/hist rounded-lg px-3 py-2 cursor-pointer transition-all ${
                      isActive
                        ? 'bg-[var(--agent-chat-user-surface)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[12px] overflow-hidden whitespace-nowrap flex-1 ${isActive ? 'font-medium' : ''}`}
                        style={{
                          WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 20px), transparent 100%)',
                          maskImage: 'linear-gradient(to right, black calc(100% - 20px), transparent 100%)',
                        }}
                      >
                        {conv.title}
                      </span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm('Delete this conversation? This cannot be undone.')) {
                            deleteConversation(conv.id)
                          }
                        }}
                        className="hidden group-hover/hist:flex items-center justify-center w-4 h-4 rounded hover:bg-[var(--color-border)]/50 flex-shrink-0"
                      >
                        <X size={9} className="text-[var(--color-text-muted)]" />
                      </span>
                    </div>
                    {preview && (
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 truncate opacity-50">
                        {/* content can be ContentBlock[] for image-first messages — same
                            guard filterConversations applies (review fix) */}
                        {typeof preview.content === 'string' ? preview.content.slice(0, 50) : '[image]'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* Configure modal — Audio, Media, Animation */}
      {showConfigModal && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setShowConfigModal(false)} />
          <div
            className="fixed top-[62px] right-4 z-[9999] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-4 w-[760px] pointer-events-auto"
            style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          >
            <div className="flex gap-6">
              {/* Presets — category-level batch toggles */}
              <div className="flex-1">
                <div className="px-1 mb-3 border-b border-[var(--color-border)] pb-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
                    Presets
                  </span>
                </div>
                <div className="space-y-1">
                  {(() => {
                    const presets = [
                      {
                        label: 'Narration',
                        audioIds: [
                          'elevenlabs',
                          'openai-tts',
                          'gemini-tts',
                          'google-tts',
                          'openai-edge-tts',
                          'puter',
                          'web-speech',
                        ],
                        mediaIds: ['heygen'],
                      },
                      {
                        label: 'Media Gen',
                        audioIds: [] as string[],
                        mediaIds: ['veo3', 'googleImageGen', 'imageGen', 'dall-e'],
                      },
                      {
                        label: 'SFX & Music',
                        audioIds: ['elevenlabs-sfx', 'freesound', 'pixabay', 'pixabay-music', 'freesound-music'],
                        mediaIds: [] as string[],
                      },
                      {
                        label: 'Avatar',
                        audioIds: [] as string[],
                        mediaIds: ['musetalk', 'fabric', 'aurora', 'heygen'],
                      },
                    ]
                    // Filter preset IDs to only include providers that are actually configured
                    const configuredAudioIds = configuredProviders.audio
                    const configuredMediaIds = configuredProviders.media
                    return presets
                      .map((preset) => ({
                        ...preset,
                        audioIds: preset.audioIds.filter((id) => configuredAudioIds.has(id)),
                        mediaIds: preset.mediaIds.filter((id) => configuredMediaIds.has(id)),
                      }))
                      .filter((preset) => preset.audioIds.length > 0 || preset.mediaIds.length > 0)
                      .map((preset) => {
                        const allOn =
                          preset.audioIds.every((id) => audioProviderEnabled[id] ?? true) &&
                          preset.mediaIds.every((id) => mediaGenEnabled[id] ?? true)
                        return (
                          <span
                            key={preset.label}
                            onClick={() => {
                              const target = !allOn
                              const audioUpdate = { ...audioProviderEnabled }
                              preset.audioIds.forEach((id) => {
                                audioUpdate[id] = target
                              })
                              const mediaUpdate = { ...mediaGenEnabled }
                              preset.mediaIds.forEach((id) => {
                                mediaUpdate[id] = target
                              })
                              useVideoStore.setState({
                                audioProviderEnabled: audioUpdate,
                                mediaGenEnabled: mediaUpdate,
                              })
                            }}
                            className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                          >
                            <span
                              className={`text-[12px] font-medium ${allOn ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
                            >
                              {preset.label}
                            </span>
                            {allOn ? (
                              <ToggleRight size={18} className="text-[var(--color-accent)]" />
                            ) : (
                              <ToggleLeft size={18} className="text-[var(--color-text-muted)]" />
                            )}
                          </span>
                        )
                      })
                  })()}
                </div>
              </div>

              {/* Audio */}
              <div className="flex-1 border-l border-[var(--color-border)] pl-4">
                <div className="px-1 mb-3 border-b border-[var(--color-border)] pb-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
                    Audio
                  </span>
                </div>
                <div className="space-y-1">
                  {AUDIO_PROVIDERS.filter(
                    (p) => configuredProviders.audio.has(p.id) && (audioProviderEnabled[p.id] ?? p.defaultEnabled),
                  ).map((p) => (
                    <span
                      key={p.id}
                      onClick={() => toggleAudioProvider(p.id)}
                      className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                    >
                      <span className="text-[12px] font-medium text-[var(--color-text-primary)]">{p.name}</span>
                      <ToggleRight size={18} className="text-[var(--color-accent)]" />
                    </span>
                  ))}
                  {AUDIO_PROVIDERS.filter(
                    (p) => configuredProviders.audio.has(p.id) && !(audioProviderEnabled[p.id] ?? p.defaultEnabled),
                  ).length > 0 && (
                    <div className="pt-1 border-t border-[var(--color-border)] mt-1">
                      {AUDIO_PROVIDERS.filter(
                        (p) => configuredProviders.audio.has(p.id) && !(audioProviderEnabled[p.id] ?? p.defaultEnabled),
                      ).map((p) => (
                        <span
                          key={p.id}
                          onClick={() => toggleAudioProvider(p.id)}
                          className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                        >
                          <span className="text-[12px] font-medium text-[var(--color-text-muted)]">{p.name}</span>
                          <ToggleLeft size={18} className="text-[var(--color-text-muted)]" />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span
                  onClick={() => {
                    setShowConfigModal(false)
                    setContentView('settings')
                    setSettingsSection('models')
                  }}
                  className="inline-block mt-3 text-[11px] text-[var(--color-accent)] hover:underline cursor-pointer"
                >
                  + Add audio model
                </span>
              </div>

              {/* Media — all media gen providers (image, video, avatar, utility) */}
              <div className="flex-1 border-x border-[var(--color-border)] px-4">
                <div className="px-1 mb-3 border-b border-[var(--color-border)] pb-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
                    Media
                  </span>
                </div>
                <div className="space-y-1">
                  {MEDIA_PROVIDERS.filter(
                    (p) => configuredProviders.media.has(p.id) && (mediaGenEnabled[p.id] ?? p.defaultEnabled),
                  ).map((p) => (
                    <span
                      key={p.id}
                      onClick={() => toggleMediaGen(p.id)}
                      className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                    >
                      <span className="text-[12px] font-medium text-[var(--color-text-primary)]">{p.name}</span>
                      <ToggleRight size={18} className="text-[var(--color-accent)]" />
                    </span>
                  ))}
                  {MEDIA_PROVIDERS.filter(
                    (p) => configuredProviders.media.has(p.id) && !(mediaGenEnabled[p.id] ?? p.defaultEnabled),
                  ).length > 0 && (
                    <div className="pt-1 border-t border-[var(--color-border)] mt-1">
                      {MEDIA_PROVIDERS.filter(
                        (p) => configuredProviders.media.has(p.id) && !(mediaGenEnabled[p.id] ?? p.defaultEnabled),
                      ).map((p) => (
                        <span
                          key={p.id}
                          onClick={() => toggleMediaGen(p.id)}
                          className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                        >
                          <span className="text-[12px] font-medium text-[var(--color-text-muted)]">{p.name}</span>
                          <ToggleLeft size={18} className="text-[var(--color-text-muted)]" />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span
                  onClick={() => {
                    setShowConfigModal(false)
                    setContentView('settings')
                    setSettingsSection('models')
                  }}
                  className="inline-block mt-3 text-[11px] text-[var(--color-accent)] hover:underline cursor-pointer"
                >
                  + Add media model
                </span>
              </div>

              {/* Animation — scene rendering styles (tool filter chips) */}
              <div className="flex-1 pl-4">
                <div className="px-1 mb-3 border-b border-[var(--color-border)] pb-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
                    Animation
                  </span>
                </div>
                <div className="space-y-1">
                  {panelToolChips().map((chip) => {
                    const isOn = activeTools.includes(chip.id)
                    return (
                      <span
                        key={chip.id}
                        onClick={() => toggleActiveTool(chip.id)}
                        className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                      >
                        <span
                          className={`text-[12px] font-medium ${isOn ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
                        >
                          {chip.label}
                        </span>
                        {isOn ? (
                          <ToggleRight size={18} className="text-[var(--color-accent)]" />
                        ) : (
                          <ToggleLeft size={18} className="text-[var(--color-text-muted)]" />
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Messages Area — centered column (Cursor-style), not iMessage L/R lanes */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4 scrollbar-hide"
      >
        <div className="mx-auto w-full max-w-2xl space-y-4">
          {/* No paused-run banner here: the inline permission card in the
           *  message bubble carries the action. `pausedAgentRun` persists
           *  across reloads via IPC; a resume affordance belongs inside the
           *  relevant message bubble, not a top-of-chat banner. */}
          {runCheckpoint && !isGenerating && (
            <div className="mx-2 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="text-sm font-medium text-amber-200 mb-1">Interrupted run detected</div>
              <div className="text-sm text-[var(--color-text-muted)] mb-2">
                {runCheckpoint.completedSceneIds.length} of {runCheckpoint.scenePlan?.scenes.length ?? '?'} scenes were
                built before the run was interrupted.
              </div>
              <div className="flex gap-2">
                <span
                  onClick={handleResumeCheckpoint}
                  className="text-sm px-3 py-1 rounded bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 cursor-pointer transition-colors"
                >
                  Resume
                </span>
                <span
                  onClick={handleDiscardCheckpoint}
                  className="text-sm px-3 py-1 rounded bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:bg-[var(--color-border)] cursor-pointer transition-colors"
                >
                  Discard
                </span>
              </div>
            </div>
          )}
          <ChatMessageList
            messages={messages}
            streamingMsgId={streamingMsgId}
            isGenerating={isGenerating}
            activeConversationId={activeConversationId}
            project={project}
            rateLimitCountdown={rateLimitCountdown}
            setPreviewImage={setPreviewImage}
            handleEditMessage={handleEditMessage}
            handleResendSteer={handleResendSteer}
            handlePermission={handlePermission}
            continueAfterPermission={continueAfterPermission}
            answerClarification={answerClarification}
            denyAndContinue={denyAndContinue}
            setGenerationOverride={setGenerationOverride}
            setAutoChooseDefault={setAutoChooseDefault}
            setSessionPermission={setSessionPermission}
            updateAPIPermissions={updateAPIPermissions}
            handleRate={handleRate}
            handleRetry={handleRetry}
            handleRegenerate={handleRegenerate}
            handleRateLimitRetry={handleRateLimitRetry}
            handleDetails={handleDetails}
          />

          {/* Structural-cuts review card (Gap 3.1): appears after a build run ends
              when the cut review proposed whole-scene cuts. Independent of the
              plan/generating gate — it lives past the run. */}
          {!!structuralCutsProposed && structuralCutsProposed.length > 0 && (
            <div className="flex w-full justify-center">
              <div className="w-full">
                <StructuralCutsReviewCard />
              </div>
            </div>
          )}

          {/* Live stream: same column as assistant, after your messages (feels
           *  like one reply). The plan card is NO LONGER here — it's pinned above
           *  the composer (below) so it stays visible while the stream scrolls.
           *  Text + thinking live INSIDE this memoized leaf (throttled ~30fps),
           *  so per-token pushes re-render only it. Driven imperatively via
           *  streamingRef from the SSE onEvent handler. */}
          {isGenerating && (
            <div className="flex w-full justify-center">
              <div className="w-full space-y-3">
                <StreamingMessage
                  ref={streamingRef}
                  segments={streamingSegments}
                  snapshotLen={lastSnapshotTextRef.current.length}
                  activeToolName={activeToolName}
                  isThinkingStreaming={isThinkingStreaming}
                  onContentGrow={scrollToBottom}
                />
              </div>
            </div>
          )}

          {/* Branch management card — inline in the chat column, like the
              permission/generation cards (Branches / History tabs) */}
          {showBranchDropdown && branches.length > 0 && project?.id && (
            <div className="w-full">
              <BranchCard
                projectId={project.id}
                branches={branches}
                activeBranchId={projectActiveBranchId}
                onSwitch={(id) => switchProjectBranch(id)}
                onReload={() => reloadActiveBranch()}
                onClose={() => setShowBranchDropdown(false)}
                onChanged={() => incrementBranchListVersion()}
                onOpenProject={(id) => openProject(id)}
              />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Scroll-to-bottom floating button */}
        {showScrollButton && (
          <div className="sticky bottom-2 flex justify-center pointer-events-none z-10">
            <span
              onClick={() => {
                scrollToBottom(true)
                setShowScrollButton(false)
              }}
              className="pointer-events-auto px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] cursor-pointer shadow-lg hover:bg-[var(--color-border)]/30 transition-all duration-200"
            >
              <ChevronDown size={12} className="inline mr-1" />
              Scroll to bottom
            </span>
          </div>
        )}
      </div>

      {/* Phase 3 agentic plan surface (the only planning UI — T9), PINNED above
          the composer so it stays continuously visible while the chat stream
          scrolls behind it. Collapse via the card's own chevron. Mirrors the
          keyword-warning pin pattern (flex-shrink-0 · max-w-2xl column). */}
      {pendingPlan && (
        <div className="flex-shrink-0 px-4">
          <div className="mx-auto w-full max-w-2xl">
            <PlanCard
              plan={pendingPlan}
              todos={planTodos}
              awaitingApproval={planAwaitingApproval && !isGenerating}
              building={isGenerating}
              onApprove={handleApprovePlan}
              onReject={handleRejectPlan}
              disabled={isGenerating}
            />
          </div>
        </div>
      )}

      <ChatComposer
        composer={composerInput}
        gen={gen}
        isGenerating={isGenerating}
        runProgress={runProgress}
        isAgentRunningRemote={isAgentRunningRemote}
        steerReady={steerReady}
        handleSend={handleSend}
        handleAbort={handleAbort}
        routeAttachedFile={routeAttachedFile}
        imageInputRef={imageInputRef}
        pendingImages={pendingImages}
        setPendingImages={setPendingImages}
        pendingAssetRefs={pendingAssetRefs}
        setPendingAssetRefs={setPendingAssetRefs}
        pendingReferenceMedia={pendingReferenceMedia}
        setPendingReferenceMedia={setPendingReferenceMedia}
        pendingPastedTexts={pendingPastedTexts}
        setPendingPastedTexts={setPendingPastedTexts}
        uploadingAssets={uploadingAssets}
        setPreviewImage={setPreviewImage}
        variantsCount={variantsCount}
        setVariantsCount={setVariantsCount}
        branches={branches}
        activeBranch={activeBranch}
        setShowBranchDropdown={setShowBranchDropdown}
        cliffNote={cliffNote}
        currentModel={currentModel}
      />

      {/* Image preview lightbox */}
      {previewImage && <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />}

      {/* Conversation pin/archive context menu */}
      {convMenu && menuConv && (
        <ConversationContextMenu
          x={convMenu.x}
          y={convMenu.y}
          isPinned={menuConv.isPinned}
          isArchived={menuConv.isArchived}
          onClose={() => setConvMenu(null)}
          onRename={() => {
            setRenamingId(menuConv.id)
            setRenameValue(menuConv.title)
            setConvMenu(null)
          }}
          onPin={() => {
            void pinConversation(menuConv.id, !menuConv.isPinned)
            setConvMenu(null)
          }}
          onArchive={() => {
            void archiveConversation(menuConv.id, !menuConv.isArchived)
            setConvMenu(null)
          }}
          onExport={() => {
            void exportConversation(menuConv.id, menuConv.title)
            setConvMenu(null)
          }}
          onClear={() => {
            if (menuConv.id === activeConversationId) clearChat()
            setConvMenu(null)
          }}
          onDelete={() => {
            if (window.confirm('Delete this conversation? This cannot be undone.')) {
              void deleteConversation(menuConv.id)
            }
            setConvMenu(null)
          }}
        />
      )}

      {/* Conversation-rewind confirm — edit + regenerate */}
      {rewindConfirm && (
        <RewindConfirmDialog
          kind={rewindConfirm.kind}
          canRestore={rewindConfirm.canRestore}
          onConfirm={(opts) => {
            const run = rewindConfirm.run
            setRewindConfirm(null)
            void run(opts)
          }}
          onCreateBranchFirst={createBranchBeforeRewind}
          onCancel={() => setRewindConfirm(null)}
        />
      )}
    </div>
  )
}
