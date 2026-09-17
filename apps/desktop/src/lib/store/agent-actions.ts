'use client'

import type { Scene, GlobalStyle, APIPermissions, AILayer } from '../types'
import type {
  ChatMessage,
  MessageContent,
  AgentType,
  ModelId,
  ModelTier,
  ThinkingMode,
  ConversationSummary,
  StructuralCut,
  AgentPlan,
  AgentTodo,
} from '../agents/types'
import { messageContentToText } from '../agents/types'
import type { ModelConfig, ProviderConfig } from '../agents/model-config'
import { DEFAULT_MODELS, DEFAULT_PROVIDER_CONFIGS } from '../agents/model-config'
import type { Set, Get, UndoableState } from './types'
import { MAX_UNDO, nextUndoSeq, normalizeScene, sceneHasRenderableContent } from './helpers'
import { stripCodeFields } from './undo-actions'
import { setPendingSaveMarker, clearPendingSaveMarker, DB_TIMESTAMP_TOLERANCE_MS } from './persistence-marker'
import { preserveUserHeldScenes, getEffectiveLock } from './scene-lock'
import { truncateConversationAfter, RewindError } from './conversation-rewind'
import { isStreamingRowOrphaned } from './orphan-detection'
import { createLogger } from '../logger'

const log = createLogger('store.agent')

/** Unsettled awaiter for the always-ask spend modal. Module-local (the store is a singleton) so
 *  `requestSpendApproval` and `resolveSpendApproval` can hand off a Promise without storing a
 *  non-serializable function in store state. */
let spendApprovalResolver: ((decision: import('../types/permissions').SpendApprovalDecision) => void) | null = null

/**
 * Conversation IPC adapter. Reads `window.dreambyteApi.conversations.*` from the
 * Electron preload bridge — desktop-only.
 */
function getConversationsIpc() {
  return typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
}

export function createAgentActions(set: Set, get: Get) {
  let switchConversationCounter = 0
  let renameDebounceTimer: ReturnType<typeof setTimeout> | null = null

  // Scene-lock for the agent (cursor model). On run start the agent acquires
  // an 'agent' lock on the selected scene so the user is blocked (and sees the badge / takeover);
  // a heartbeat touches it every 1.5s so the 3s idle timer doesn't release it mid-run (video gen
  // takes minutes). On run end the lock + heartbeat are torn down. Best-effort: if the user
  // already holds the scene the agent doesn't steal it — the agent/applyRun preserve is the
  // backstop. (Multi-scene runs lock only the focused scene; others rely on apply-time preserve.)
  let agentLockSceneId: string | null = null
  let agentHeartbeat: ReturnType<typeof setInterval> | null = null
  const AGENT_LOCK_HEARTBEAT_MS = 1500
  function startAgentLock() {
    const sid = get().selectedSceneId
    if (!sid) return
    const outcome = get().acquireSceneLock(sid, 'agent', 'in-app')
    if (!outcome.ok) return // user holds it → don't steal; apply-time preserve protects them
    agentLockSceneId = sid
    if (typeof window !== 'undefined' && !agentHeartbeat) {
      agentHeartbeat = setInterval(() => {
        if (agentLockSceneId) get().touchSceneLock(agentLockSceneId, 'agent')
      }, AGENT_LOCK_HEARTBEAT_MS)
    }
  }
  function stopAgentLock() {
    if (agentHeartbeat) {
      clearInterval(agentHeartbeat)
      agentHeartbeat = null
    }
    if (agentLockSceneId) {
      // Only release if WE still own it. If the user force-took-over a stale agent lock during
      // the run, the scene now holds a 'user' lock — releasing by id alone would wipe it.
      const scene = get().scenes.find((s) => s.id === agentLockSceneId)
      if (scene && getEffectiveLock(scene)?.owner === 'agent') {
        get().releaseSceneLock(agentLockSceneId)
      }
      agentLockSceneId = null
    }
  }

  // ── Pre-run undo snapshot ────────────────────────────────
  //
  // Captured once at agent-run start, BEFORE any tool mutations reach the store.
  // This is the safety net for the raw-set fallback in syncScenesFromAgent —
  // when the agent/applyRun dispatch succeeds, the action layer's typed inverse
  // is the primary Cmd+Z and this snapshot is a harmless older entry below it.
  //
  // structuredClone is always correct (no copy-on-write assumption about store
  // writers — d3Data is known to be mutated in place). The size guard bounds
  // the worst case: past the code-byte budget the snapshot strips code fields
  // via the same stripCodeFields the sessionStorage persistence uses (the
  // action layer's inverse still carries full code) instead of janking send on
  // huge projects.
  const SNAPSHOT_CODE_BUDGET_BYTES = 15 * 1024 * 1024
  // How many pre-run project snapshots to retain for checkpoint-coupled
  // rewind. Bounded so a long session doesn't pin unbounded scene-code clones in
  // memory; oldest evicted first (the same FIFO as the undo stack).
  const MAX_RUN_SNAPSHOTS = 12
  function estimateSceneCodeBytes(scenes: Scene[]): number {
    let total = 0
    for (const s of scenes) {
      const sc = s as Scene & { reactCode?: string; canvasBackgroundCode?: string; sceneStyles?: string }
      total +=
        (sc.svgContent?.length ?? 0) +
        (sc.canvasCode?.length ?? 0) +
        (sc.canvasBackgroundCode?.length ?? 0) +
        (sc.sceneCode?.length ?? 0) +
        (sc.reactCode?.length ?? 0) +
        (sc.sceneHTML?.length ?? 0) +
        (sc.sceneStyles?.length ?? 0) +
        (sc.lottieSource?.length ?? 0)
      // d3Data is part of what gets cloned (it's deep-copied into safeScenes
      // and again by structuredClone) — the budget must see it too, or a huge
      // dataset bypasses the guard entirely.
      if (s.d3Data !== null && s.d3Data !== undefined) {
        try {
          total += JSON.stringify(s.d3Data).length
        } catch {
          /* unserializable d3Data will throw in the clone path's own try */
        }
      }
    }
    return total
  }
  function captureAgentRunSnapshot(runMsgId?: string | null) {
    const { scenes, globalStyle, project, _undoStack } = get()
    const safeScenes = scenes.map((s) =>
      s.d3Data !== null && s.d3Data !== undefined ? { ...s, d3Data: JSON.parse(JSON.stringify(s.d3Data)) } : s,
    )
    try {
      const base: UndoableState = { scenes: safeScenes, globalStyle, project }
      const oversized = estimateSceneCodeBytes(scenes) > SNAPSHOT_CODE_BUDGET_BYTES
      if (oversized) {
        log.warn('agent-run snapshot over code budget — stripping code fields (action-layer undo still carries code)')
      }
      const snapshot: UndoableState = structuredClone(oversized ? stripCodeFields([base])[0] : base)
      // Cross-stack LIFO order key. Without it the undo router treats
      // this entry as oldest and action-stack entries pushed DURING the run
      // would be undone in the wrong order relative to it.
      snapshot._seq = nextUndoSeq()
      const newStack = [..._undoStack, snapshot]
      if (newStack.length > MAX_UNDO) newStack.shift()
      // Key this same pre-run snapshot by the run's streaming assistant
      // message id so a later conversation rewind can restore the project to
      // its pre-run state. structuredClone again so the run-snapshot copy is
      // independent of the undo-stack copy (undo mutates its entries on revert).
      let newRunSnapshots = get()._runSnapshots
      if (runMsgId) {
        newRunSnapshots = [
          ...newRunSnapshots.filter((r) => r.msgId !== runMsgId),
          { msgId: runMsgId, snapshot: structuredClone(snapshot) },
        ]
        if (newRunSnapshots.length > MAX_RUN_SNAPSHOTS) newRunSnapshots.shift()
      }
      set({
        _runSnapshots: newRunSnapshots,
        _undoStack: newStack,
        // Clear BOTH redo stacks — clearing only the legacy one leaves a
        // stale action-redo entry reachable via the cross-stack seq routing
        // (the cross-stack LIFO invariant action-dispatch documents).
        _redoStack: [],
        _actionRedoStack: [],
        isAgentRunning: true,
        _agentRunStartedAt: Date.now(),
        // Pin the run to its project + branch and reset the user-edit
        // conflict set. Project pin: a mid-run project switch must not
        // pour this run's scenes into another project's store.
        _agentRunProjectId: get().project?.id ?? null,
        _agentRunBranchId: get().projectActiveBranchId ?? null,
        _userEditedScenesDuringRun: new Set<string>(),
      })
    } catch (err) {
      log.error('structuredClone failed for agent-run undo snapshot, skipping undo capture', { error: err })
      set({
        isAgentRunning: true,
        _agentRunStartedAt: Date.now(),
        _agentRunProjectId: get().project?.id ?? null,
        _agentRunBranchId: get().projectActiveBranchId ?? null,
        _userEditedScenesDuringRun: new Set<string>(),
      })
    }
  }

  return {
    // ── Conversation actions ────────────────────────────────────────────────

    loadConversations: async (projectId: string) => {
      if (get().conversationsLoading) {
        log.debug('conversations: already loading, skipping duplicate call')
        return
      }
      set({ conversationsLoading: true })
      try {
        const ipc = getConversationsIpc()
        const data = ipc ? await ipc.list(projectId) : { conversations: [] }
        const convs: ConversationSummary[] = (data.conversations ?? []) as unknown as ConversationSummary[]
        set({ conversations: convs, conversationsLoading: false })

        if (convs.length === 0) {
          // Auto-create first conversation
          await get().newConversation(projectId)
        } else {
          // Auto-select most recent
          await get().switchConversation(convs[0].id)
        }
      } catch (err) {
        log.error('conversations: failed to load', { error: err })
        set({ conversationsLoading: false })
        // Fallback: create first conversation even if load failed
        if (get().conversations.length === 0) {
          await get().newConversation(projectId)
        }
      }
    },

    newConversation: async (projectId: string) => {
      try {
        const ipc = getConversationsIpc()
        if (!ipc) {
          log.error('newConversation: conversations IPC unavailable')
          return ''
        }
        const data = await ipc.create({ projectId })
        const conv: ConversationSummary = data.conversation as unknown as ConversationSummary
        // Cross-project corruption guard: if the user switched projects while
        // ipc.create was in flight, this conversation belongs to `projectId`,
        // NOT the now-active project. Prepending it (and wiping chatMessages)
        // would land the draft's conversation on the new project's state.
        if (get().project?.id !== projectId) return ''
        set((state) => ({
          conversations: [conv, ...state.conversations],
          activeConversationId: conv.id,
          chatMessages: [],
          _persistedMessageIds: new Set<string>(),
        }))
        return conv.id
      } catch (err) {
        log.error('conversations: failed to create', { error: err })
        return ''
      }
    },

    switchConversation: async (conversationId: string, opts?: { confirmedAbortRun?: boolean }) => {
      // Showcase auto-exit: restore the real transcript BEFORE any switch
      // so fixture messages can never bleed into another conversation.
      if (get().showcaseMode) get().exitShowcase()
      // Validate conversation belongs to the current project's list
      const validIds = new Set(get().conversations.map((c) => c.id))
      if (!validIds.has(conversationId)) return
      // Confirm gate: a live agent run would be aborted by the switch.
      // Require explicit confirmation ONLY then — otherwise silent. The
      // component renders the dialog and re-invokes with confirmedAbortRun:true.
      if (get().isAgentRunning && !opts?.confirmedAbortRun) {
        set({ branchSwitchNeedsConfirm: { kind: 'conversation', targetId: conversationId } })
        return
      }
      set({ branchSwitchNeedsConfirm: null })
      // Abort any in-flight agent stream before switching (user confirmed above).
      if (get().isAgentRunning) {
        get().abortAgentRun()
      }
      // Flush pending project edits BEFORE reloading messages, and
      // BLOCK loudly on failure — never switch over unsaved state. Cheap no-op
      // when nothing is dirty.
      const flush = await get().flushSaveProjectToDb()
      if (!flush.ok) {
        set({
          projectSaveStatus: 'error',
          projectSaveError:
            get().projectSaveError ?? 'Could not save before switching conversation — switch cancelled.',
        })
        log.error('switchConversation: pre-switch flush failed, blocking switch')
        return
      }
      const requestId = ++switchConversationCounter
      // Only update the active ID — don't clear messages yet to avoid flash
      set({ activeConversationId: conversationId })
      try {
        const ipc = getConversationsIpc()
        const data = ipc ? await ipc.listMessages(conversationId) : null
        if (!data) return
        // Bail if a newer switch happened while we were fetching
        if (requestId !== switchConversationCounter) return

        // Source-of-truth for orphan detection: ask the main process which
        // runs are actually in flight. When the renderer just booted, this
        // returns []. With messages.runId persisted (migration 0025) we
        // classify precisely:
        //   - A streaming row WITH a runId is orphaned iff its runId is NOT in
        //     activeRunIds() — regardless of how many other runs are live.
        //   - A streaming row with NULL runId (legacy) keeps the conservative
        //     any-active-run + 30s recency grace below.
        // No-op on the web build (no Electron API surface).
        let hasAnyActiveRun = true // safe default — preserves the legacy grace
        let activeRunIds = new Set<string>()
        // True when we couldn't trust the run probe (timeout/IPC error). In that
        // case activeRunIds is unknown, so a row WITH a runId must NOT be
        // orphaned on its absence — fall back to the conservative legacy grace
        // for every streaming row instead.
        let probeFailed = false
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dreambyteApi = (typeof window !== 'undefined' ? (window as any).dreambyteApi : null) as any
          if (dreambyteApi?.agent?.activeRunIds) {
            // Bounded probe. A hung main process used to block orphan
            // detection (and this whole conversation switch) indefinitely —
            // the await had no timeout. Timeout = "unknown": keep the safe
            // default so the 30s grace applies, never hang the switch.
            const ORPHAN_PROBE_TIMEOUT_MS = 3000
            const probe: Promise<{ runIds?: unknown }> = dreambyteApi.agent.activeRunIds()
            // A late settle after the timeout wins must not surface as an
            // unhandled rejection.
            void probe.catch(() => {})
            let probeTimer: ReturnType<typeof setTimeout> | undefined
            const raced = await Promise.race<{ runIds?: unknown } | null>([
              probe,
              new Promise<null>((resolve) => {
                probeTimer = setTimeout(() => resolve(null), ORPHAN_PROBE_TIMEOUT_MS)
              }),
            ])
            if (probeTimer) clearTimeout(probeTimer) // don't leave the loser dangling
            if (raced === null) {
              log.warn('activeRunIds probe timed out — treating run state as unknown (grace preserved)')
              probeFailed = true
            } else {
              const runIds = raced.runIds
              const ids = Array.isArray(runIds) ? runIds.filter((r): r is string => typeof r === 'string') : []
              activeRunIds = new Set(ids)
              hasAnyActiveRun = ids.length > 0
            }
          }
        } catch {
          // IPC failed — keep hasAnyActiveRun=true so we don't aggressively
          // orphan messages just because the bridge had a hiccup. activeRunIds
          // stays empty, but a NULL-runId row falls back to the grace and a
          // row WITH a runId would be misclassified as orphaned; so on a probe
          // failure we additionally suppress runId-based orphaning below.
          hasAnyActiveRun = true
          activeRunIds = new Set<string>()
          probeFailed = true
        }

        // Map DB messages to ChatMessage format
        const orphanedIds: string[] = []
        const orphanCtx = { activeRunIds, hasAnyActiveRun }
        const msgs: ChatMessage[] = (data.messages ?? []).map((m: any) => {
          // Precise orphan classification: a streaming row with a persisted
          // runId is orphaned iff that run is no longer live; NULL-runId legacy
          // rows keep the any-active-run + 30s grace. When the run probe failed
          // we can't trust activeRunIds, so suppress runId-based orphaning by
          // classifying every row via the legacy path (runId: null).
          const createdAt = m.createdAt ? new Date(m.createdAt).getTime() : 0
          const shouldOrphan = isStreamingRowOrphaned(
            { status: m.status, runId: probeFailed ? null : (m.runId ?? null), createdAtMs: createdAt },
            orphanCtx,
          )
          if (shouldOrphan) orphanedIds.push(m.id)
          // Explicit incomplete flag: a row freshly orphaned now, OR
          // one already persisted as 'aborted' on a prior interrupted run, is an
          // interrupted reply — render the banner instead of looking finished.
          // An 'error' row is also a non-clean terminal — treat it
          // like 'aborted' so it never renders as a finished reply on reload.
          const incomplete = shouldOrphan || m.status === 'aborted' || m.status === 'error'
          // Carry the errored flag through reload so the error strip renders.
          const erroredOnReload = m.status === 'error'
          return {
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: shouldOrphan ? m.content || 'Generation interrupted.' : m.content,
            incomplete: incomplete || undefined,
            errored: erroredOnReload || undefined,
            agentType: m.agentType ?? undefined,
            modelId: m.modelUsed ?? undefined,
            thinking: m.thinkingContent ?? undefined,
            toolCalls: m.toolCalls ?? [],
            contentSegments: m.contentSegments ?? undefined,
            // Restore inline permission card on reload (column added in
            // migration 0021). Without this, the chat lost its
            // permission card every Cmd+R while the user was still deciding.
            pendingPermissions: m.pendingPermissions ?? undefined,
            usage: m.inputTokens
              ? {
                  inputTokens: m.inputTokens,
                  outputTokens: m.outputTokens ?? 0,
                  apiCalls: m.apiCalls ?? 1,
                  costUsd: m.costUsd ?? 0,
                  totalDurationMs: m.durationMs ?? 0,
                  provider: m.modelUsed?.startsWith('claude-code:')
                    ? 'claude-code'
                    : m.modelUsed?.startsWith('codex-cli:')
                      ? 'codex-cli'
                      : undefined,
                }
              : undefined,
            userRating: m.userRating ?? undefined,
            generationLogId: m.generationLogId ?? undefined,
            timestamp: new Date(m.createdAt).getTime(),
          }
        })
        // Guard against stale switch (belt-and-suspenders with counter above)
        if (requestId !== switchConversationCounter) return
        if (get().activeConversationId === conversationId) {
          log.debug('switchConversation loaded messages', {
            extra: { count: msgs.length, conversationId: conversationId.slice(0, 8) },
          })
          // Track all loaded message IDs as persisted (for INSERT vs UPDATE discrimination)
          set({
            chatMessages: msgs,
            _persistedMessageIds: new Set(msgs.map((m) => m.id)),
          })
          // Background: mark orphaned 'streaming' messages as 'aborted' in DB
          for (const orphanId of orphanedIds) {
            const ipcInner = getConversationsIpc()
            ipcInner?.updateMessage({ conversationId, messageId: orphanId, status: 'aborted' }).catch(() => {})
          }
        }
      } catch (err) {
        log.error('conversations: failed to load messages', { error: err })
        // On error, clear messages so stale ones from previous conversation aren't shown
        if (get().activeConversationId === conversationId) {
          set({ chatMessages: [] })
        }
      }
    },

    renameConversation: async (id: string, title: string) => {
      // Optimistic UI update immediately
      set((state) => ({
        conversations: state.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
      }))
      // Debounce the API call to avoid firing on every keystroke
      if (renameDebounceTimer) clearTimeout(renameDebounceTimer)
      renameDebounceTimer = setTimeout(() => {
        renameDebounceTimer = null
        const ipc = getConversationsIpc()
        if (!ipc) return
        ipc
          .update({ id, updates: { title } })
          .catch((err) => log.error('conversations: failed to rename', { error: err }))
      }, 400)
    },

    pinConversation: async (id: string, pinned: boolean) => {
      set((state) => ({
        conversations: state.conversations.map((c) => (c.id === id ? { ...c, isPinned: pinned } : c)),
      }))
      const ipc = getConversationsIpc()
      ipc
        ?.update({ id, updates: { isPinned: pinned } })
        .catch((err) => log.error('conversations: failed to pin', { error: err }))
    },

    // Archive / unarchive — mirrors pinConversation. Optimistic store
    // update + the existing conversations.update IPC (isArchived column exists).
    archiveConversation: async (id: string, archived: boolean) => {
      set((state) => ({
        conversations: state.conversations.map((c) => (c.id === id ? { ...c, isArchived: archived } : c)),
      }))
      const ipc = getConversationsIpc()
      ipc
        ?.update({ id, updates: { isArchived: archived } })
        .catch((err) => log.error('conversations: failed to archive', { error: err }))
    },

    deleteConversation: async (id: string) => {
      const remaining = get().conversations.filter((c) => c.id !== id)
      set({ conversations: remaining })
      const ipc = getConversationsIpc()
      ipc?.delete(id).catch((err) => log.error('conversations: failed to delete', { error: err }))

      if (get().activeConversationId === id) {
        if (remaining.length > 0) {
          await get().switchConversation(remaining[0].id)
        } else {
          const projectId = get().project?.id
          if (projectId) await get().newConversation(projectId)
        }
      }
    },

    // ── Chat / Agent actions ───────────────────────────────────────────────

    setChatOpen: (open: boolean) => set({ isChatOpen: open }),

    addChatMessage: (msg: ChatMessage) => {
      const before = get().chatMessages.length
      set((state) => ({ chatMessages: [...state.chatMessages, msg] }))
      log.debug('chat: addChatMessage', {
        extra: { role: msg.role, id: msg.id.slice(0, 8), before, after: get().chatMessages.length },
      })
      // User messages are persisted via persistUserMessage (awaitable).
      // Assistant messages are persisted via persistChatMessage after the agent run.
    },

    // Insert a message BEFORE another by id (falls back to append if the anchor is
    // gone). Used for mid-run steering: a typed steer is shown above the
    // in-progress assistant reply it interrupts, not after it.
    insertChatMessageBefore: (msg: ChatMessage, beforeId: string) => {
      set((state) => {
        const i = state.chatMessages.findIndex((m) => m.id === beforeId)
        if (i < 0) return { chatMessages: [...state.chatMessages, msg] }
        const next = [...state.chatMessages]
        next.splice(i, 0, msg)
        return { chatMessages: next }
      })
    },

    /** Persist a user message to the DB. Returns a promise so callers can await it. */
    persistUserMessage: async (msg: ChatMessage) => {
      // Showcase fence: while the dev showcase is active, NOTHING
      // reaches the conversations DB. Guard lives at the persist boundary so
      // every present and future caller is covered.
      if (get().showcaseMode) return
      if (msg.role !== 'user' || !msg.content) return
      // Eager draft model: the project row + first conversation already exist
      // from createNewProject (status='draft'), so there is no promotion step
      // here — prompting the agent will promote it to 'ready' via the IPC
      // activity path. Read activeConversationId directly.
      const projectId = get().project?.id
      const conversationId = get().activeConversationId
      if (!projectId || !conversationId) return
      const textContent = typeof msg.content === 'string' ? msg.content : messageContentToText(msg.content)
      if (!textContent) return
      try {
        const ipc = getConversationsIpc()
        if (!ipc) {
          // Desktop-only: the IPC bridge is the only persistence path. The
          // legacy HTTP fallback (`POST /api/conversations/:id/messages`) was
          // removed alongside the rest of the web build. Throwing here is
          // loud — the message cache stays in-memory and the next reload
          // cleans up via the orphan path.
          throw new Error('conversations IPC unavailable; cannot persist message')
        }
        await ipc.addMessage({
          id: msg.id,
          conversationId,
          projectId,
          role: msg.role,
          content: textContent,
        })
        // Track that this message has been INSERTed
        const ids = new Set(get()._persistedMessageIds)
        ids.add(msg.id)
        set({ _persistedMessageIds: ids })
      } catch (err) {
        log.error('chat: failed to persist user message', { error: err })
      }
    },

    updateChatMessage: (id: string, updates: Partial<ChatMessage>) => {
      const contentLen = typeof updates.content === 'string' ? updates.content.length : 0
      const hasSegments = !!updates.contentSegments?.length
      const hasTools = !!updates.toolCalls?.length
      log.debug('chat: updateChatMessage', {
        extra: {
          id: id.slice(0, 8),
          contentLen,
          segments: hasSegments,
          tools: hasTools,
          msgCount: get().chatMessages.length,
        },
      })
      set((state) => ({
        chatMessages: state.chatMessages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      }))
    },

    /** Persist a chat message to DB. INSERT on first call, UPDATE on subsequent calls. */
    persistChatMessage: async (id: string, opts?: { status?: string }) => {
      if (get().showcaseMode) return // showcase fence — see persistUserMessage
      const msg = get().chatMessages.find((m) => m.id === id)
      const projectId = get().project?.id
      const conversationId = get().activeConversationId
      if (!msg || !projectId || !conversationId) return

      const textContent = typeof msg.content === 'string' ? msg.content : messageContentToText(msg.content)
      const persisted = get()._persistedMessageIds

      const isUpdate = persisted.has(id)
      const insertBody = {
        id,
        conversationId,
        projectId,
        role: msg.role,
        content: textContent || '',
        status: opts?.status ?? 'complete',
        agentType: msg.agentType,
        modelUsed: msg.modelId,
        thinkingContent: msg.thinking,
        toolCalls: msg.toolCalls,
        contentSegments: msg.contentSegments,
        pendingPermissions: msg.pendingPermissions,
        inputTokens: msg.usage?.inputTokens,
        outputTokens: msg.usage?.outputTokens,
        costUsd: msg.usage?.costUsd,
        durationMs: msg.usage?.totalDurationMs,
        apiCalls: msg.usage?.apiCalls,
        generationLogId: msg.generationLogId,
      }
      const updateBody = {
        conversationId,
        messageId: id,
        content: textContent || '',
        status: opts?.status ?? 'complete',
        agentType: msg.agentType,
        modelUsed: msg.modelId,
        thinkingContent: msg.thinking,
        toolCalls: msg.toolCalls,
        contentSegments: msg.contentSegments,
        pendingPermissions: msg.pendingPermissions,
        inputTokens: msg.usage?.inputTokens,
        outputTokens: msg.usage?.outputTokens,
        costUsd: msg.usage?.costUsd,
        durationMs: msg.usage?.totalDurationMs,
        apiCalls: msg.usage?.apiCalls,
        generationLogId: msg.generationLogId,
      }

      const doPersist = async () => {
        const ipc = getConversationsIpc()
        if (!ipc) {
          // Desktop-only — see the matching note above near addMessage.
          throw new Error('conversations IPC unavailable; cannot persist message')
        }
        if (isUpdate) await ipc.updateMessage(updateBody)
        else await ipc.addMessage(insertBody)
      }

      try {
        await doPersist()
        if (!persisted.has(id)) {
          const ids = new Set(get()._persistedMessageIds)
          ids.add(id)
          set({ _persistedMessageIds: ids })
        }
      } catch (err) {
        // Retry once — prevents message loss on transient DB or IPC hiccup.
        log.warn('chat: persistChatMessage failed, retrying', { error: err })
        try {
          await new Promise((r) => setTimeout(r, 1000))
          await doPersist()
          if (!persisted.has(id)) {
            const ids = new Set(get()._persistedMessageIds)
            ids.add(id)
            set({ _persistedMessageIds: ids })
          }
        } catch (retryErr) {
          log.error('chat: persistChatMessage retry failed', { error: retryErr })
        }
      }
    },

    /**
     * Seq-guarded streaming upsert for the incremental chat persist.
     * The stale-write guard is the monotonic `seq`: the persist layer
     * (queries/conversations.ts) rejects a write whose seq is older than the
     * row's current seq, so an out-of-order partial can never overwrite newer
     * streamed content. `runId` is now PERSISTED on the row (migration
     * 0025): it does not gate the write, but it ties the streaming row to a
     * specific run so orphan detection on reload can be precise — a streaming
     * row whose runId is not in activeRunIds() is an orphan regardless of other
     * live runs (see switchConversation). Always status='streaming' — the final
     * persist (no seq) supersedes partials. Returns `{ applied }`; throws only
     * on transport error (the StreamingChatPersister retries + swallows).
     */
    persistStreamingChatMessage: async (args: {
      messageId: string
      runId: string | null
      seq: number
      content: string
      toolCalls?: unknown[]
      contentSegments?: unknown[]
      thinking?: string
    }) => {
      if (get().showcaseMode) return { applied: false } // showcase fence — see persistUserMessage
      const projectId = get().project?.id
      const conversationId = get().activeConversationId
      if (!projectId || !conversationId) return { applied: false }
      const msg = get().chatMessages.find((m) => m.id === args.messageId)
      const ipc = getConversationsIpc()
      if (!ipc) return { applied: false }

      const persisted = get()._persistedMessageIds
      const isUpdate = persisted.has(args.messageId)

      if (isUpdate) {
        // Propagate the seq-gate verdict: `applied:false` means the DB rejected
        // this partial as stale (an out-of-order write) — not an error, but the
        // caller should know the row was NOT updated. Older mains that predate
        // the `applied` field fall back to true (the legacy always-applied path).
        const res = await ipc.updateMessage({
          conversationId,
          messageId: args.messageId,
          content: args.content,
          status: 'streaming',
          seq: args.seq,
          runId: args.runId,
          agentType: msg?.agentType,
          modelUsed: msg?.modelId,
          thinkingContent: args.thinking,
          toolCalls: args.toolCalls,
          contentSegments: args.contentSegments,
        })
        return { applied: (res as { applied?: boolean }).applied ?? true }
      } else {
        // First partial — INSERT. The placeholder row was inserted at run start
        // (status='streaming') so this normally takes the update branch; the
        // insert branch is the safety net when that placeholder write was lost.
        await ipc.addMessage({
          id: args.messageId,
          conversationId,
          projectId,
          role: 'assistant',
          content: args.content,
          status: 'streaming',
          seq: args.seq,
          runId: args.runId,
          agentType: msg?.agentType,
          modelUsed: msg?.modelId,
          thinkingContent: args.thinking,
          toolCalls: args.toolCalls,
          contentSegments: args.contentSegments,
        })
        const ids = new Set(get()._persistedMessageIds)
        ids.add(args.messageId)
        set({ _persistedMessageIds: ids })
      }
      return { applied: true }
    },

    removeChatMessage: (id: string) =>
      set((state) => ({
        chatMessages: state.chatMessages.filter((m) => m.id !== id),
      })),

    // Rewind primitive wrapper. Delegates the DB-first / store-splice
    // lockstep + guards to the pure-ish `truncateConversationAfter`; here we
    // only wire the store/IPC deps and keep `_persistedMessageIds` consistent
    // with the surviving message set. Conversation-only — no project mutation.
    truncateConversation: async (
      msgId: string,
      opts?: { newContent?: string; newStoreContent?: MessageContent; isGenerating?: boolean },
    ) => {
      const ipc = getConversationsIpc()
      if (!ipc) {
        throw new RewindError('Conversation IPC unavailable; cannot rewind.', 'db-failed')
      }
      const kept = await truncateConversationAfter(
        {
          getMessages: () => get().chatMessages,
          getConversationId: () => get().activeConversationId,
          // The agent-run flag is the caller's (AgentChat local state); fall back
          // to the store's scene/agent-run flags as a backstop.
          isGenerating: () => opts?.isGenerating ?? (get().isAgentRunning || get().isGenerating),
          deleteMessagesAfter: (args) => ipc.deleteMessagesAfter(args),
          setMessages: (messages) => {
            const keptIds = new Set(messages.map((m) => m.id))
            set((state) => ({
              chatMessages: messages,
              _persistedMessageIds: new Set([...state._persistedMessageIds].filter((id) => keptIds.has(id))),
            }))
          },
        },
        msgId,
        opts,
      )
      return kept
    },

    clearChat: () => {
      set({ chatMessages: [], _persistedMessageIds: new Set<string>() })
      const conversationId = get().activeConversationId
      if (conversationId) {
        const ipc = getConversationsIpc()
        ipc?.clearMessages(conversationId).catch((err) => log.error('chat: failed to clear messages', { error: err }))
      }
    },

    // The agent's run lifecycle hook, driven from the REAL run signal (AgentChat's
    // streamingMsgId effect) — it covers every send path. On run start: capture
    // the pre-run undo snapshot (see captureAgentRunSnapshot — sets
    // isAgentRunning + _agentRunStartedAt, read by the merge guard), then
    // acquire the agent scene lock + heartbeat. On run end: release the lock
    // and clear isAgentRunning. (The former setAgentRunning held the snapshot
    // logic but was never called.)
    setAgentRunSceneLock: (active: boolean, runMsgId?: string | null) => {
      if (active) {
        if (!get().isAgentRunning) captureAgentRunSnapshot(runMsgId)
        startAgentLock()
      } else {
        stopAgentLock()
        set({ isAgentRunning: false })
      }
    },

    // Does a pre-run project snapshot exist for this run message id? Drives
    // whether the rewind confirm offers "also restore project state".
    hasRunSnapshot: (msgId: string | null) => msgId != null && get()._runSnapshots.some((r) => r.msgId === msgId),
    setAgentType: (type: AgentType | null) => set({ agentType: type }),
    setAgentModelId: (id: ModelId | null) => set({ agentModelId: id }),
    setStructuralCutsProposed: (cuts: StructuralCut[] | null) => set({ structuralCutsProposed: cuts }),
    // Phase 3 agentic plan surface
    setPendingPlan: (plan: AgentPlan | null, awaitingApproval: boolean = false) =>
      set({ pendingPlan: plan, planAwaitingApproval: plan ? awaitingApproval : false }),
    setPlanTodos: (todos: AgentTodo[]) => set({ planTodos: todos }),
    setPlanAwaitingApproval: (v: boolean) => set({ planAwaitingApproval: v }),
    clearPlan: () => set({ pendingPlan: null, planTodos: [], planAwaitingApproval: false }),
    setPausedAgentRun: (
      v: {
        toolName: string
        toolInput: Record<string, unknown>
        agentType?: string | null
        reason?: string | null
        createdAt: string
      } | null,
    ) => set({ pausedAgentRun: v }),
    setRunCheckpoint: (v: import('../agents/types').RunCheckpoint | null) => set({ runCheckpoint: v }),
    // Sets the user's run-mode choice and SEEDS the per-run plan-first toggle
    // (true iff mode==='plan'). planFirstMode may later be cleared by the
    // plan→build state machine; sandboxMode/permissionPosture are derived from
    // agentRunMode at request-build (AgentChat), not stored here.
    setAgentRunMode: (m: import('../agents/types').AgentRunMode) =>
      set({ agentRunMode: m, planFirstMode: m === 'plan' }),
    setPlanFirstMode: (v: boolean) => set({ planFirstMode: v }),
    setPreviewMode: (v: 'off' | 'destructive-only' | 'always') => set({ previewMode: v }),
    setRunBudgetUsd: (v: number | null) => set({ runBudgetUsd: v }),
    setModelOverride: (id: ModelId | null) => set({ modelOverride: id }),
    setModelTier: (tier: ModelTier) => set({ modelTier: tier }),
    setThinkingMode: (mode: ThinkingMode) => set({ thinkingMode: mode }),
    setLocalMode: (enabled: boolean) => set({ localMode: enabled }),
    setLocalModelId: (id: string | null) => set({ localModelId: id }),
    setResearchModelId: (id: string | null) => set({ researchModelId: id }),
    setSceneContext: (ctx: 'all' | 'selected' | 'auto' | string) => set({ sceneContext: ctx }),
    setActiveTools: (tools: string[]) => set({ activeTools: tools }),

    toggleActiveTool: (toolId: string) => {
      set((state) => {
        const current = state.activeTools
        const isEnabling = !current.includes(toolId)
        const next = isEnabling ? [...current, toolId] : current.filter((t) => t !== toolId)
        // Auto-switch outputMode when interactions chip is toggled
        if (toolId === 'interactions') {
          const newOutputMode = isEnabling ? 'interactive' : 'mp4'
          return {
            activeTools: next,
            project: { ...state.project, outputMode: newOutputMode, updatedAt: new Date().toISOString() },
          }
        }
        return { activeTools: next }
      })
    },

    setChatInputValue: (v: string) => set({ chatInputValue: v }),

    syncScenesFromAgent: async (
      updatedScenes: Scene[],
      updatedGlobalStyle: GlobalStyle,
      updatedSceneGraph?: import('../types/project').SceneGraph,
    ) => {
      // Undo snapshot captured at run start by setAgentRunSceneLock(true)
      // (captureAgentRunSnapshot) — the safety net for the raw-set fallback below.
      log.debug('syncScenesFromAgent', { extra: { count: updatedScenes.length } })
      for (const s of updatedScenes) {
        log.debug('syncScenesFromAgent scene', {
          extra: {
            id: s.id.slice(0, 8),
            type: s.sceneType,
            html: s.sceneHTML?.length ?? 0,
            svg: s.svgContent?.length ?? 0,
            canvas: s.canvasCode?.length ?? 0,
            code: s.sceneCode?.length ?? 0,
            react: (s as any).reactCode?.length ?? 0,
            lottie: s.lottieSource?.length ?? 0,
          },
        })
      }

      // Auto-remove empty default scenes if the agent created new ones with content
      const hasContentScene = updatedScenes.some(sceneHasRenderableContent)

      // Compute merge against the current store state. Same logic as before — just
      // hoisted out of the inline `set((state) => {...})` callback so the result
      // can be dispatched through the action layer instead of raw-set, which
      // (1) records the run in action_log with source='agent' + runId, and
      // (2) puts an inverse on the action-stack so G1 Cmd+Z reverts the whole
      //     run as one unit instead of falling through to the legacy snapshot.
      const stateForMerge = get()
      const scenesWithMessages = new Set(stateForMerge.scenes.filter((s) => s.messages?.length).map((s) => s.id))
      const existingSceneIds = new Set(stateForMerge.scenes.map((s) => s.id))
      const existingScenesWithContent = new Set(
        stateForMerge.scenes.filter((s) => sceneHasRenderableContent(s) || s.prompt).map((s) => s.id),
      )

      const cleanedScenes = hasContentScene
        ? updatedScenes.filter((s) => {
            if (sceneHasRenderableContent(s)) return true
            if (s.prompt) return true
            if (scenesWithMessages.has(s.id)) return true
            if (existingScenesWithContent.has(s.id)) {
              log.debug('keeping pre-existing scene (had content)', {
                extra: { id: s.id.slice(0, 8), name: s.name },
              })
              return true
            }
            if (!existingSceneIds.has(s.id)) {
              log.debug('removing empty agent-created scene', {
                extra: { id: s.id.slice(0, 8), name: s.name },
              })
              return false
            }
            return true
          })
        : updatedScenes
      const finalScenes = cleanedScenes.length > 0 ? cleanedScenes : updatedScenes

      // Placeholder restoration: the agent request strips content for non-focused
      // scenes (replaced with "[N chars]" placeholders). When the agent returns,
      // those placeholders must NOT overwrite the real content in the store.
      const isPlaceholderContent = (val: string | undefined | null): boolean => !!val && /^\[\d+ chars\]$/.test(val)
      const agentRunStart = stateForMerge._agentRunStartedAt || 0
      // Scenes the USER touched (via dispatchAction, source='user')
      // while this run was live. Source-tagged — the precise signal. The
      // updatedAt comparison below stays as the fallback for legacy edit paths
      // that don't dispatch through the action layer.
      const userEditedDuringRun = stateForMerge._userEditedScenesDuringRun ?? new Set<string>()
      const preservedConflicts: { id: string; name: string }[] = []

      const mergedScenes = finalScenes.map((newScene) => {
        const existing = stateForMerge.scenes.find((s) => s.id === newScene.id)
        if (!existing) return normalizeScene(newScene as Scene)

        if (userEditedDuringRun.has(newScene.id)) {
          log.debug('preserving user-edited scene (source-tagged)', {
            extra: { id: existing.id.slice(0, 8), agentStartedAt: agentRunStart },
          })
          preservedConflicts.push({ id: existing.id, name: existing.name || existing.id.slice(0, 8) })
          return existing
        }

        // FRAGILITY WARNING: this fallback assumes only USER edit
        // paths stamp scene.updatedAt with a renderer-side Date.now(). That
        // holds today (only the layer/interaction/camera reducers stamp, and
        // they run on dispatched actions which the source-tagged set above
        // already captures; world-side agent mutations do NOT stamp). If any
        // agent-path write ever starts stamping updatedAt, this branch will
        // preserve the agent's own stale intermediate state and silently drop
        // the final payload. Prefer extending the source-tagged set over
        // adding timestamps.
        if (
          agentRunStart > 0 &&
          existing.updatedAt &&
          existing.updatedAt > agentRunStart &&
          sceneHasRenderableContent(existing)
        ) {
          log.debug('preserving user-edited scene (updatedAt fallback)', {
            extra: {
              id: existing.id.slice(0, 8),
              editedAt: existing.updatedAt,
              agentStartedAt: agentRunStart,
            },
          })
          preservedConflicts.push({ id: existing.id, name: existing.name || existing.id.slice(0, 8) })
          return existing
        }

        const hasPlaceholder =
          isPlaceholderContent(newScene.svgContent) ||
          isPlaceholderContent(newScene.canvasCode) ||
          isPlaceholderContent(newScene.sceneCode) ||
          isPlaceholderContent(newScene.lottieSource)

        if (hasPlaceholder) {
          log.debug('restoring real content for scene (had placeholder strings)', {
            extra: { id: newScene.id.slice(0, 8) },
          })
          return normalizeScene({
            ...newScene,
            svgContent: isPlaceholderContent(newScene.svgContent) ? existing.svgContent : newScene.svgContent,
            canvasCode: isPlaceholderContent(newScene.canvasCode) ? existing.canvasCode : newScene.canvasCode,
            sceneCode: isPlaceholderContent(newScene.sceneCode) ? existing.sceneCode : newScene.sceneCode,
            sceneHTML:
              isPlaceholderContent(newScene.sceneCode) ||
              isPlaceholderContent(newScene.svgContent) ||
              isPlaceholderContent(newScene.canvasCode)
                ? existing.sceneHTML
                : newScene.sceneHTML,
            lottieSource: isPlaceholderContent(newScene.lottieSource) ? existing.lottieSource : newScene.lottieSource,
            messages: existing.messages,
          } as Scene)
        }

        const agentHasContent = sceneHasRenderableContent(newScene)
        const storeHasContent = sceneHasRenderableContent(existing)
        if (storeHasContent && !agentHasContent) {
          log.debug('preserving existing content (agent returned empty)', {
            extra: { id: newScene.id.slice(0, 8) },
          })
          return normalizeScene({
            ...newScene,
            svgContent: existing.svgContent,
            canvasCode: existing.canvasCode,
            sceneCode: existing.sceneCode,
            reactCode: existing.reactCode,
            sceneHTML: existing.sceneHTML,
            lottieSource: existing.lottieSource,
            messages: existing.messages,
          } as Scene)
        }

        const merged = existing.messages?.length ? { ...newScene, messages: existing.messages } : newScene
        return normalizeScene(merged as Scene)
      })

      const mergedGlobalStyle = (() => {
        const g = stateForMerge.globalStyle
        const typ = g.uiTypography ?? 'app'
        return {
          ...updatedGlobalStyle,
          theme: g.theme ?? updatedGlobalStyle.theme,
          uiTypography: typ,
          uiFontFamily: typ === 'custom' ? (g.uiFontFamily ?? 'Inter') : null,
        }
      })()

      // Branch-identity guard. If the user switched branches while the
      // run was building, the live store now holds a DIFFERENT branch's scenes —
      // merging the run's scenes into it is cross-branch contamination. The run
      // is NOT lost: the main process already persisted it to ITS branch
      // (persistScenesFromAgentRun is branch-scoped), and the HTML writes below
      // are scene-id-keyed (branch-unique ids) so they're safe and wanted for
      // that branch's preview. We skip only the live-store apply and tell the
      // user where their results went.
      const runBranchId = stateForMerge._agentRunBranchId ?? null
      const activeBranchId = stateForMerge.projectActiveBranchId ?? null
      // Identity is project + branch. A mid-run PROJECT switch
      // with matching (e.g. both-default) branch ids would otherwise pour this
      // run's scenes into another project's store — same contamination class,
      // one level up.
      const runProjectId = stateForMerge._agentRunProjectId ?? null
      const activeProjectId = stateForMerge.project?.id ?? null
      const branchMismatch =
        runBranchId !== activeBranchId || (runProjectId !== null && runProjectId !== activeProjectId)
      if (branchMismatch) {
        log.warn('agent run finished on a different branch/project — skipping live-store merge', {
          extra: { runBranchId, activeBranchId, runProjectId, activeProjectId, sceneCount: finalScenes.length },
        })
        get().showTransientStatus?.(
          'The agent run finished on another branch — switch back to it to see the results.',
          8000,
        )
      }

      // Dispatch through the action layer. Reducer overwrites scenes,
      // globalStyle, and sceneGraph; reconciles selectedSceneId against the new
      // scenes; captures the pre-state as an inverse for Cmd+Z. Falls back to
      // raw set if there's no project id (tests, never-opened project) or the
      // dispatch is rejected for any reason.
      let appliedViaDispatch = false
      const dispatchFn = (
        get() as unknown as {
          dispatchAction?: (
            input: { type: string; params: Record<string, unknown> },
            options: { source: 'user' | 'agent' },
          ) => { success: boolean; error?: { code: string; message: string } } | undefined
        }
      ).dispatchAction
      // The run-start snapshot is the inverse's TRUE from-state. Without it,
      // the reducer would capture POST-stream `state.scenes` and Cmd+Z would no-op.
      // Pick the most recent run snapshot (highest _seq — the active run's, since
      // captureAgentRunSnapshot stamped it at run start). Deep-clone so a later
      // undo/redo mutating store entries can't alias the snapshot (
      // the comment promised this clone; the code did a by-reference pass).
      const preRunSnapshot = (() => {
        const snaps = stateForMerge._runSnapshots ?? []
        if (snaps.length === 0) return undefined
        let best = snaps[0].snapshot
        for (const r of snaps) {
          if ((r.snapshot._seq ?? -1) >= (best._seq ?? -1)) best = r.snapshot
        }
        return structuredClone({
          scenes: best.scenes,
          globalStyle: best.globalStyle,
          sceneGraph: best.project?.sceneGraph,
          timeline: best.project?.timeline ?? null,
        })
      })()
      if (!branchMismatch && stateForMerge.project?.id && typeof dispatchFn === 'function') {
        try {
          const result = dispatchFn(
            {
              type: 'agent/applyRun',
              params: {
                scenes: mergedScenes,
                globalStyle: mergedGlobalStyle,
                ...(updatedSceneGraph ? { sceneGraph: updatedSceneGraph } : {}),
                ...(preRunSnapshot ? { preRunSnapshot } : {}),
              },
            },
            { source: 'agent' },
          )
          appliedViaDispatch = !!result?.success
          if (!appliedViaDispatch) {
            log.warn('agent/applyRun dispatch rejected; falling back to raw set', {
              extra: { error: result?.error },
            })
          }
        } catch (err) {
          log.warn('agent/applyRun dispatch threw; falling back to raw set', { error: err })
        }
      }

      if (!branchMismatch && !appliedViaDispatch) {
        // Fallback path mirrors the reducer's logic (selectedSceneId
        // reconciliation + optional graph) so test environments and stores
        // without a project id stay consistent with the action path. Apply the
        // SAME cursor-model preserve the reducer does, against the LIVE store
        // scenes, so this degraded path can't clobber a user-held scene either.
        const preservedScenes = preserveUserHeldScenes(get().scenes, mergedScenes)
        const currentStillExists = preservedScenes.some((s) => s.id === stateForMerge.selectedSceneId)
        const firstScene = preservedScenes[0]
        const fallbackSelectedId = currentStillExists ? stateForMerge.selectedSceneId : (firstScene?.id ?? null)
        set((s: any) => ({
          scenes: preservedScenes,
          globalStyle: mergedGlobalStyle,
          selectedSceneId: fallbackSelectedId,
          ...(updatedSceneGraph
            ? { project: { ...s.project, sceneGraph: updatedSceneGraph, updatedAt: new Date().toISOString() } }
            : {}),
        }))
      }

      // Tell the user which scenes kept THEIR edits over the agent's.
      // Without this the skip is silent and the agent's claimed changes appear
      // to have mysteriously not happened.
      if (!branchMismatch && preservedConflicts.length > 0) {
        const names = preservedConflicts
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')
        const more = preservedConflicts.length > 3 ? ` (+${preservedConflicts.length - 3} more)` : ''
        log.warn('agent merge skipped user-edited scenes', {
          extra: { scenes: preservedConflicts.map((c) => c.name) },
        })
        get().showTransientStatus?.(
          `Kept your edits on ${names}${more} — the agent's changes for ${preservedConflicts.length > 1 ? 'those scenes' : 'that scene'} were skipped.`,
          6000,
        )
      }

      // sceneHtmlVersion is bumped AFTER the HTML writes land (below) — the
      // preview now reloads ALL scenes on a bump, so bumping before the writes
      // finish would race the reload against the file writes and refetch stale
      // or partial HTML. UI-only field, not tracked by the action layer.
      // Persist all updated scene HTMLs (awaited to prevent data loss on tab close).
      // Cursor-model: the in-memory store preserves a user-held scene (preserveUserHeldScenes),
      // but this loop would otherwise still write the AGENT's HTML for that same id to disk and
      // clobber the file. Skip user-held scenes here too — the user's own edits persist their HTML
      // through their own save path, so the agent must not overwrite it.
      const userHeldIds = new Set(
        get()
          .scenes.filter((s) => getEffectiveLock(s)?.owner === 'user')
          .map((s) => s.id),
      )
      // Scenes whose USER version won the merge must
      // not have the AGENT's HTML written over them on disk — the in-memory
      // preserve would be silently undone by the file on reload.
      for (const c of preservedConflicts) userHeldIds.add(c.id)
      // Durable crash marker: written SYNCHRONOUSLY before the HTML
      // writes start. ts = run start — the main process persists the run's
      // scenes to the DB before the done event reaches us, so at boot a DB row
      // with updatedAt > runStart proves the run landed; an older row means the
      // crash window hit and loadProject's reconciliation notifies the user
      // instead of silently loading pre-run scenes.
      // Times come from stateForMerge, NOT a fresh get(): a
      // back-to-back run can overwrite _agentRunStartedAt while this sync's
      // HTML writes are still in flight, which would stamp run 1's marker
      // with run 2's start time and corrupt the confirmation below.
      const runStartedAt = stateForMerge._agentRunStartedAt || 0
      const markerProjectId = runProjectId ?? stateForMerge.project?.id
      let runMarkerNonce: number | undefined
      if (markerProjectId) {
        runMarkerNonce = setPendingSaveMarker({
          projectId: markerProjectId,
          // The RUN's branch — that's where main persisted the scenes,
          // regardless of which branch the user is looking at now.
          branchId: runBranchId,
          sceneIds: updatedScenes.map((s) => s.id),
          ts: runStartedAt || Date.now(),
        })
      }
      const writeEntries: { sceneId: string; promise: Promise<void> }[] = []
      const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
      for (const scene of updatedScenes) {
        if (userHeldIds.has(scene.id)) {
          log.debug('skipping agent HTML write for user-held scene', { extra: { id: scene.id.slice(0, 8) } })
          continue
        }
        if (scene.sceneHTML) {
          // IPC: throws on failure, no HTTP status. Retry once on any error
          // with the same 100ms delay that the HTTP path used.
          if (!sceneIpc) {
            throw new Error('scene write requires the desktop runtime (window.dreambyteApi.scene unavailable).')
          }
          const p: Promise<void> = (async () => {
            try {
              await sceneIpc.writeHtml({ id: scene.id, html: scene.sceneHTML })
            } catch (err) {
              log.error('scene.writeHtml failed', { extra: { sceneId: scene.id }, error: err })
              await new Promise((resolve) => setTimeout(resolve, 100))
              try {
                await sceneIpc.writeHtml({ id: scene.id, html: scene.sceneHTML })
              } catch (retryErr) {
                throw new Error(`Save failed for scene ${scene.id}: ${(retryErr as Error).message}`, {
                  cause: retryErr,
                })
              }
            }
          })()
          writeEntries.push({ sceneId: scene.id, promise: p })
        } else {
          log.warn('scene has empty sceneHTML, skipping file write', { extra: { id: scene.id.slice(0, 8) } })
        }
      }
      // Await all writes — prevents data loss if browser closes before writes finish
      const results = await Promise.allSettled(writeEntries.map((e) => e.promise))
      const errorEntries: Record<string, string> = {}
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const sceneId = writeEntries[i].sceneId
          log.error('scene HTML write failed', {
            extra: { sceneId },
            error: (results[i] as PromiseRejectedResult).reason,
          })
          errorEntries[sceneId] = 'Scene file write failed after agent run'
        }
      }
      if (Object.keys(errorEntries).length > 0) {
        set({ sceneWriteErrors: { ...get().sceneWriteErrors, ...errorEntries } })
      }

      // Now that the scene HTML files are on disk, signal the preview to reload.
      // The bump fires here (not before the writes) so the reload never refetches
      // a file that hasn't been written yet. agentReloadSceneIds carries the exact
      // set of scenes this run rewrote (successful writes only) so the preview
      // refreshes ALL of them, not just the selected one — failed writes keep
      // their error overlay instead of reloading to stale content. Skip on branch
      // mismatch — nothing in the live branch's previews changed.
      if (!branchMismatch) {
        const reloadedIds = writeEntries.filter((_, i) => results[i].status === 'fulfilled').map((e) => e.sceneId)
        set((s) => ({
          sceneHtmlVersion: s.sceneHtmlVersion + 1,
          agentReloadNonce: s.agentReloadNonce + 1,
          agentReloadSceneIds: reloadedIds,
        }))
      }

      // When user edits won the merge, the DB still
      // holds the agent's versions (main persisted them before the done
      // event). Persist the conflict winners explicitly — the debounced save
      // path no-ops while a run is live, and waiting for the next user edit
      // leaves a window where a reload resurrects the agent's version.
      if (!branchMismatch && preservedConflicts.length > 0) {
        try {
          await get().saveProjectToDb()
        } catch (err) {
          log.warn('failed to persist conflict-winner scenes after merge', { error: err })
        }
      }

      // Confirm the DB row actually carries this run, then clear the marker.
      // getVersion is the lightweight version/updatedAt probe (no scene blobs).
      // If the probe fails or the row is stale, the marker stays — boot-time
      // reconciliation in loadProject owns the user-facing notice.
      // Tolerance: DB updatedAt is second-precision; without the
      // slack a run completing within the marker's wall-clock second reads as
      // stale and triggers a false "changes missing" notice at next boot.
      if (markerProjectId) {
        try {
          const projIpc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          const dbVer = projIpc?.getVersion ? await projIpc.getVersion(markerProjectId).catch(() => null) : null
          if (dbVer && new Date(dbVer.updatedAt).getTime() + DB_TIMESTAMP_TOLERANCE_MS >= runStartedAt) {
            clearPendingSaveMarker(markerProjectId, runBranchId, runMarkerNonce)
          } else {
            log.warn('agent run persisted to disk but DB row looks stale — keeping pending-save marker', {
              extra: { projectId: markerProjectId, dbUpdatedAt: dbVer ? String(dbVer.updatedAt) : 'unavailable' },
            })
          }
        } catch (err) {
          log.warn('pending-save marker confirmation failed — keeping marker for boot reconciliation', {
            error: err,
          })
        }
      }
    },

    // ── Model configuration ────────────────────────────────────────────────
    setModelConfigs: (configs: ModelConfig[]) => set({ modelConfigs: configs }),

    toggleModelEnabled: (modelId: string) => {
      set((state) => ({
        modelConfigs: state.modelConfigs.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m)),
      }))
    },

    updateProviderConfig: (provider: string, updates: Partial<ProviderConfig>) => {
      set((state) => ({
        providerConfigs: state.providerConfigs.map((p) => (p.provider === provider ? { ...p, ...updates } : p)),
      }))
    },

    addCustomModel: (config: ModelConfig) => {
      set((state) => ({
        modelConfigs: [...state.modelConfigs, { ...config, isDefault: false }],
      }))
    },

    removeCustomModel: (modelId: string) => {
      set((state) => ({
        modelConfigs: state.modelConfigs.filter((m) => m.id !== modelId || m.isDefault),
      }))
    },

    // ── Permission actions ────────────────────────────────────────────────────
    updateAPIPermissions: (updates: Partial<APIPermissions>) => {
      set((state) => ({
        project: {
          ...state.project,
          apiPermissions: { ...state.project.apiPermissions, ...updates },
          updatedAt: new Date().toISOString(),
        },
      }))
    },

    setPendingPermissionRequest: (req: import('../types').PermissionRequest | null) =>
      set({ pendingPermissionRequest: req }),

    // Always-ask spend modal — Promise bridge between an in-app media gen-action (which awaits a
    // decision on a `permissionNeeded` block) and PermissionDialog (which settles it). The resolver
    // is module-local (`spendApprovalResolver`, declared at the top of this slice's closure) so it
    // doesn't churn store state; only `pendingPermissionRequest` drives the dialog's visibility.
    requestSpendApproval: (req: import('../types').PermissionRequest) => {
      // A new request supersedes any unsettled one — settle the old as denied so its awaiter unblocks.
      if (spendApprovalResolver) {
        const stale = spendApprovalResolver
        spendApprovalResolver = null
        stale({ decision: 'denied' })
      }
      set({ pendingPermissionRequest: req })
      return new Promise<import('../types/permissions').SpendApprovalDecision>((resolve) => {
        spendApprovalResolver = resolve
      })
    },

    resolveSpendApproval: (decision: import('../types/permissions').SpendApprovalDecision) => {
      set({ pendingPermissionRequest: null })
      const resolver = spendApprovalResolver
      spendApprovalResolver = null
      resolver?.(decision)
    },

    markSpendApproved: (api: string) =>
      set((state) => {
        const next = new Set(state.spendApprovedThisSession)
        next.add(api)
        return { spendApprovedThisSession: next }
      }),

    setSessionPermission: (api: string, decision: string) => {
      set((state) => {
        const newMap = new Map(state.sessionPermissions)
        newMap.set(api, decision)
        return { sessionPermissions: newMap }
      })
    },

    // Layered permission rules are persisted in `permission_rules` via the
    // `dreambyte:permissions.{listRules,createRule,deleteRule}` IPC handlers.
    // The desktop user row is seeded lazily by `getDesktopUserId()` on the
    // main side, so these calls work without a real auth session.
    refreshPermissionRules: async () => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.permissions : undefined
      if (!ipc?.listRules) return
      try {
        const { rules } = await ipc.listRules()
        set({ permissionRules: rules as import('../types/permissions').PermissionRule[] })
      } catch (err) {
        log.error('refreshPermissionRules failed', { error: err })
      }
    },

    createPermissionRule: async (
      input: Omit<import('../types/permissions').PermissionRule, 'id' | 'userId' | 'createdAt'>,
    ) => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.permissions : undefined
      if (!ipc?.createRule) return null
      try {
        const { rule } = await ipc.createRule({
          scope: input.scope,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          decision: input.decision,
          api: input.api,
          specifier: input.specifier,
          costCapUsd: input.costCapUsd,
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          createdBy: input.createdBy,
          notes: input.notes,
        })
        const created = rule as import('../types/permissions').PermissionRule
        set((state) => ({ permissionRules: [...state.permissionRules, created] }))
        return created
      } catch (err) {
        log.error('createPermissionRule failed', { error: err })
        return null
      }
    },

    deletePermissionRule: async (id: string) => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.permissions : undefined
      if (!ipc?.deleteRule) return false
      try {
        const { ok } = await ipc.deleteRule(id)
        if (ok) {
          set((state) => ({ permissionRules: state.permissionRules.filter((r) => r.id !== id) }))
        }
        return ok
      } catch (err) {
        log.error('deletePermissionRule failed', { error: err })
        return false
      }
    },

    setGenerationOverride: (
      api: string,
      overrides: { provider?: string; prompt?: string; config?: Record<string, any> },
    ) => {
      set((state) => ({
        generationOverrides: { ...state.generationOverrides, [api]: overrides },
      }))
    },
    clearGenerationOverride: (api: string) => {
      set((state) => {
        const { [api]: _, ...rest } = state.generationOverrides
        return { generationOverrides: rest }
      })
    },
    setAutoChooseDefault: (genType: string, defaults: { provider: string; config: Record<string, any> }) => {
      set((state) => ({
        autoChooseDefaults: { ...state.autoChooseDefaults, [genType]: defaults },
      }))
    },

    openAgentWithContext: (context: NonNullable<import('./types').VideoStore['agentEditContext']>) => {
      set({
        agentEditContext: context,
        isChatOpen: true,
        chatInputValue:
          context.type === 'element'
            ? `Edit the "${context.elementType}" element "${context.elementId}": `
            : `Edit this layer: `,
      })
    },
  }
}
