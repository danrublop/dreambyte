'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_AUDIO_SETTINGS } from '../types'
import { DEFAULT_AUDIO_PROVIDER_ENABLED } from '../audio/provider-registry'
import { DEFAULT_MEDIA_PROVIDER_ENABLED } from '../media/provider-registry'
import { DEFAULT_RESEARCH_PROVIDER_ENABLED } from '../research/provider-registry'
import { DEFAULT_GRID_CONFIG } from '../grid'
import type { ModelTier, ThinkingMode } from '../agents/types'
import { DEFAULT_MODELS, DEFAULT_PROVIDER_CONFIGS } from '../agents/model-config'
import { createDefaultAPIPermissions } from '../permissions'
import type { LayersTabSectionId } from '../layers-tab-header'

import type { VideoStore, CenterTabId } from './types'
import type { LayersStripTabId } from '../layers-strip-dock'
import {
  createDefaultProject,
  ensureValidProjectId,
  createDefaultScene,
  DEFAULT_GLOBAL_STYLE,
  sceneHasRenderableContent,
  setPersistedTheme,
} from './helpers'

import { createUndoActions, restoreUndoStacks } from './undo-actions'
import { createActionDispatch } from './action-dispatch'
import { createSceneActions } from './scene-actions'
import { createGenerationActions } from './generation-actions'
import { createProjectActions } from './project-actions'
import { createAgentActions } from './agent-actions'
import { createTimelineActions } from './timeline-actions'
import { createAudioActions } from './audio-actions'
import { createExportActions } from './export-actions'
import { createInspectorActions } from './inspector-actions'
import { createWorkspaceActions } from './workspace-actions'
import { createDevActions } from './dev-actions'
import { createShowcaseActions } from './showcase-actions'
import { createLogger } from '../logger'

const log = createLogger('store')

function _persistBranchTabs(tabs: CenterTabId[], projectId?: string) {
  if (typeof localStorage === 'undefined' || !projectId) return
  const branchTabs = tabs.filter((t) => t === 'preview' || t.startsWith('preview:'))
  localStorage.setItem(`dreambyte:openBranchTabs:${projectId}`, JSON.stringify(branchTabs))
}

export type { VideoStore, CenterTabId } from './types'
export type { UndoableState, Set, Get } from './types'

export const useVideoStore = create<VideoStore>()(
  persist(
    (set, get) => ({
      scenes: (() => {
        const s = createDefaultScene()
        s.name = 'Scene 1'
        return [s]
      })(),
      selectedSceneId: null,
      globalStyle: DEFAULT_GLOBAL_STYLE,
      _dbLoadComplete: false,
      _setDbLoadComplete: (v: boolean) => set({ _dbLoadComplete: v }),
      _isDirty: false,
      _lastDbLoadTimestamp: 0,

      // Auth
      currentUser: null,
      setCurrentUser: (user) => set({ currentUser: user }),

      // Undo/Redo (restored from sessionStorage if available)
      _undoStack: typeof sessionStorage !== 'undefined' ? restoreUndoStacks().undoStack : [],
      _redoStack: typeof sessionStorage !== 'undefined' ? restoreUndoStacks().redoStack : [],
      _runSnapshots: [], // in-memory pre-run snapshots for checkpoint-coupled rewind

      // Agent abort + multi-tab
      _abortNonce: 0,
      abortAgentRun: () => set({ _abortNonce: get()._abortNonce + 1 }),
      isAgentRunningRemote: false,

      ...createUndoActions(set, get),
      ...createActionDispatch(set, get),

      isGenerating: false,
      generatingSceneId: null,
      lastGenerationError: null,
      isExporting: false,
      exportCancelRequested: false,
      isExportModalOpen: false,
      isNewProjectModalOpen: false,
      openNewProjectModal: () => set({ isNewProjectModalOpen: true }),
      closeNewProjectModal: () => set({ isNewProjectModalOpen: false }),
      // Multi-variant comparison.
      lastVariantsSpawn: null,
      setLastVariantsSpawn: (spawn) => set({ lastVariantsSpawn: spawn }),
      isVariantComparisonOpen: false,
      openVariantComparison: () => set({ isVariantComparisonOpen: true }),
      closeVariantComparison: () => set({ isVariantComparisonOpen: false }),
      // Cross-project dispatch.
      crossProjectPicker: null,
      openCrossProjectPicker: (p) => set({ crossProjectPicker: p }),
      closeCrossProjectPicker: () => set({ crossProjectPicker: null }),
      crossProjectRun: null,
      setCrossProjectRun: (run) => set({ crossProjectRun: run }),
      exportProgress: null,
      exportFormDraft: null,
      setExportFormDraft: (patch) =>
        set((s) => ({
          exportFormDraft: { ...(s.exportFormDraft ?? ({} as any)), ...patch },
        })),
      clearExportFormDraft: () => set({ exportFormDraft: null }),
      lastExportStatus: 'idle',
      markExportStatusSeen: () => set({ lastExportStatus: 'idle' }),

      // Recording
      recordingState: 'idle' as const,
      recordingConfig: {
        micEnabled: true,
        micDeviceId: null,
        systemAudioEnabled: true,
        webcamEnabled: false,
        webcamDeviceId: null,
        fps: 30,
        resolution: '1080p' as const,
      },
      recordingCommand: null,
      recordingCommandNonce: 0,
      recordingResult: null,
      recordingError: null,
      recordingElapsed: 0,
      recordingAttachSceneId: null,
      setRecordingCommand: (cmd) =>
        set((s) => ({
          recordingCommand: cmd,
          // Only increment nonce for real commands, not for null (consuming)
          recordingCommandNonce: cmd ? s.recordingCommandNonce + 1 : s.recordingCommandNonce,
        })),
      setRecordingConfig: (config) => set((s) => ({ recordingConfig: { ...s.recordingConfig, ...config } })),
      setRecordingState: (state) => set({ recordingState: state }),
      setRecordingResult: (result) => set({ recordingResult: result }),
      setRecordingError: (error) => set({ recordingError: error }),
      setRecordingElapsed: (ms) => set({ recordingElapsed: ms }),
      setRecordingAttachSceneId: (sceneId) => set({ recordingAttachSceneId: sceneId }),
      timelineHeight: 200,
      timelineTransport: { globalTime: 0, totalDuration: 30, isPlaying: false },
      isPreviewFullscreen: false,
      // Clip grade hover-preview (transient): while set, the DOM media preview
      // (PreviewPlayer, via applyGradePreview) renders the clip with this
      // complete filter list instead of its committed one. No UI currently
      // calls setGradePreviewOverride, so it stays null. Never
      // persisted, never undoable — by design.
      gradePreviewOverride: null as { clipId: string; filters: import('../types').ClipFilter[] } | null,
      setGradePreviewOverride: (o: { clipId: string; filters: import('../types').ClipFilter[] } | null) =>
        set({ gradePreviewOverride: o }),
      // Scene-layer grade hover-preview (transient): applies a CSS filter to
      // the scene's preview iframe while a grade row is hovered in the layer
      // properties panel. Approximates the committed render (which writes the
      // filter into the scene HTML on the media element itself). Never
      // persisted, never undoable.
      sceneGradePreview: null as {
        sceneId: string
        css: string
        grade?: import('../edit-engines/layer-grade').LayerColorGrade
      } | null,
      setSceneGradePreview: (
        p: { sceneId: string; css: string; grade?: import('../edit-engines/layer-grade').LayerColorGrade } | null,
      ) => set({ sceneGradePreview: p }),
      // Grade clipboard (transient): copy a layer's whole grade, paste onto
      // another layer — in-session only, like an NLE's paste-attributes.
      copiedGrade: null as {
        lookCss?: string
        grade?: import('../edit-engines/layer-grade').LayerColorGrade
      } | null,
      setCopiedGrade: (g: { lookCss?: string; grade?: import('../edit-engines/layer-grade').LayerColorGrade } | null) =>
        set({ copiedGrade: g }),
      previewZoom: 1,
      setPreviewZoom: (z) => set({ previewZoom: z }),
      timelineZoom: 0,
      timelineScrollX: 0,
      timelineAutoScroll: true,
      timelineFollowPaused: false,
      timelineMagnetic: false,
      timelineSnapEnabled: true,
      clipClipboard: null,
      selectedClipIds: [],
      // Transient UI feedback
      transientStatus: null as { text: string; expiresAt: number } | null,
      showTransientStatus: (text: string, durationMs = 1500) => {
        const expiresAt = Date.now() + durationMs
        set({ transientStatus: { text, expiresAt } })
        // Schedule clear; if a newer status arrives we no-op since expiresAt won't match.
        setTimeout(() => {
          const cur = (get() as { transientStatus: { expiresAt: number } | null }).transientStatus
          if (cur && cur.expiresAt === expiresAt) set({ transientStatus: null })
        }, durationMs)
      },
      recentlyAddedClipIds: {} as Record<string, number>,
      flashClip: (clipId: string, durationMs = 250) => {
        const expiresAt = Date.now() + durationMs
        set((s) => {
          const map = s.recentlyAddedClipIds as Record<string, number>
          return { recentlyAddedClipIds: { ...map, [clipId]: expiresAt } }
        })
        setTimeout(() => {
          set((s) => {
            const map = s.recentlyAddedClipIds as Record<string, number>
            if (map[clipId] !== expiresAt) return s
            const { [clipId]: _, ...rest } = map
            return { recentlyAddedClipIds: rest }
          })
        }, durationMs)
      },
      sceneHtmlVersion: 0,
      agentReloadNonce: 0,
      agentReloadSceneIds: [],
      sceneWriteErrors: {},
      sceneSaveStatus: {},
      sceneLastSavedAt: {},
      projectActiveBranchId: null as string | null,
      projectDefaultBranchId: null as string | null,
      branchOperation: null as import('./types').BranchOperation | null,
      branchSwitchNeedsConfirm: null as { kind: 'branch' | 'conversation'; targetId: string } | null,
      clearBranchSwitchConfirm: () => set({ branchSwitchNeedsConfirm: null }),
      branchPickerOpen: false,
      setBranchPickerOpen: (v: boolean) => set({ branchPickerOpen: v }),
      branchListVersion: 0,
      incrementBranchListVersion: () => set((s) => ({ branchListVersion: s.branchListVersion + 1 })),
      projectSaveStatus: 'idle' as const,
      projectLastSavedAt: null,
      projectSaveError: null,
      projectLoadFailed: false,
      gridConfig: DEFAULT_GRID_CONFIG,
      project: createDefaultProject(),
      isPublishing: false,
      publishError: null,
      publishedUrl: null,
      showPublishPanel: false,

      // Audio
      audioSettings: DEFAULT_AUDIO_SETTINGS,
      audioProviderEnabled: { ...DEFAULT_AUDIO_PROVIDER_ENABLED },
      mediaGenEnabled: { ...DEFAULT_MEDIA_PROVIDER_ENABLED },

      // Media Understanding — empty means "auto" per modality (best available engine).
      mediaUnderstandingEngines: {},

      // Web research — native, on by default. Search rides native provider search
      // (Anthropic/OpenAI/Gemini); fetch is our own client-side code. Auto-accept on
      // so the agent searches freely; turn it off in Settings for a once-per-run approval.
      webSearchEnabled: true,
      aiQualityReview: true,
      // Sub-agents are OPT-IN. Default single-agent: one agent builds the whole video
      // in one loop. A user can also ask for sub-agents per-message without this
      // toggle. Store version 17 migrates returning users onto the new default.
      subAgents: false,
      webFetchEnabled: true,
      autoAcceptWebSearch: true,
      researchProviderEnabled: { ...DEFAULT_RESEARCH_PROVIDER_ENABLED },

      // yt-dlp consent — populated as the user acknowledges the legal disclaimer per project.
      ytDlpConsentedProjectIds: [],

      // Conversation initial state
      conversations: [],
      activeConversationId: null,
      conversationsLoading: false,

      // Chat / Agent initial state
      chatMessages: [],
      _persistedMessageIds: new Set<string>(),
      pendingComposerAttachments: [],
      setPendingComposerAttachments: (atts) => set({ pendingComposerAttachments: atts }),
      pendingComposerText: '',
      setPendingComposerText: (text) => set({ pendingComposerText: text }),
      isChatOpen: false,
      isAgentRunning: false,
      _agentRunStartedAt: 0,
      _agentRunBranchId: null,
      _agentRunProjectId: null,
      _userEditedScenesDuringRun: new Set<string>(),
      agentType: null,
      agentModelId: null,
      structuralCutsProposed: null,
      proposalsVersion: 0,
      pendingPlan: null,
      planAwaitingApproval: false,
      planTodos: [],
      pausedAgentRun: null,
      runCheckpoint: null,
      agentRunMode: 'auto' as import('../agents/types').AgentRunMode,
      planFirstMode: false,
      previewMode: 'off' as 'off' | 'destructive-only' | 'always',
      // Inline diffs in chat tool cards. Off by default — opt-in via
      // Settings → Agents.
      inlineDiffsEnabled: false,
      runBudgetUsd: 25 as number | null,
      modelOverride: null,
      modelTier: 'auto' as ModelTier,
      thinkingMode: 'adaptive' as ThinkingMode,
      localMode: false,
      mockMode: false,
      localModelId: null,
      // 'auto' = use DeepSeek V4 Flash + SearXNG for research when both are
      // configured, else inherit the run model. See resolveResearchModelId.
      researchModelId: 'auto',
      sceneContext: 'auto',
      // 'zdog' is deliberately OFF by default. It is a legacy renderer the planner
      // cannot emit (sceneType is react-only), and context-builder already gates its
      // 4 tools on this list — a gate whose own comment said they should "stop
      // advertising on every build" while this default kept them on, costing ~976
      // tokens every turn for a renderer no plan can reach. Still toggleable via the
      // Zdog chip for an existing zdog scene. Users with persisted state keep their
      // current selection; this only changes the default.
      activeTools: ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video'],
      chatInputValue: '',
      settingsTab: null,
      setSettingsTab: (tab) => set({ settingsTab: tab }),
      // ── Top-level app view (Claude-style home vs in-project) — AppShell routing ──
      appView: 'home' as 'home' | 'project',
      projectView: 'chat' as 'chat' | 'editor',
      activeProjectId: null as string | null,
      setAppView: (v) => set({ appView: v }),
      setProjectView: (v) => {
        // Flipping to Editor with no project open (e.g. from the chat-first
        // home) mints a fresh project — zero friction. Under the eager draft
        // model the project is a real DB row with status='draft' immediately;
        // the startup sweep soft-hides it if it stays untouched, and the first
        // real activity promotes it to 'ready'. (createNewProject({ draft })
        // just skips the live list fetch for a snappier editor open.)
        if (v === 'editor') {
          const s = get()
          if (s.appView !== 'project' || !s.activeProjectId) {
            set({ projectView: 'editor' })
            void s.createNewProject(undefined, undefined, { draft: true })
            return
          }
        }
        set({ projectView: v })
      },
      openProject: (id, view = 'chat', conversationId?: string) => {
        set({ activeProjectId: id, appView: 'project', projectView: view })
        // Honor a requested conversation only AFTER the project load settles, so
        // the background load can't overwrite activeConversationId afterward
        // (clicking a chat in a non-active project must land on that exact chat).
        void get()
          .loadProject(id)
          .then(() => {
            if (conversationId) void get().switchConversation(conversationId)
          })
      },
      // Home IS the chat composer — landing there resets the pill to Chat so
      // the view and the Chat/Editor switcher can't disagree.
      goAppHome: () => set({ appView: 'home', projectView: 'chat' }),
      contentView: 'none' as import('./types').ContentView,
      setContentView: (v) => set({ contentView: v }),
      settingsSection: 'general' as import('./types').SettingsSection,
      setSettingsSection: (s) => set({ settingsSection: s }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      commandPaletteOpen: false,
      setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
      centerOpenTabs: ['preview'] as CenterTabId[],
      centerTab: 'preview' as CenterTabId | null,
      setCenterTab: (tab) => {
        if (tab === null) {
          set({ centerTab: null, centerOpenTabs: [] })
          _persistBranchTabs([], get().project?.id)
          return
        }
        set((s) => {
          const newTabs = s.centerOpenTabs.includes(tab) ? s.centerOpenTabs : [...s.centerOpenTabs, tab]
          _persistBranchTabs(newTabs, s.project?.id)
          return { centerOpenTabs: newTabs, centerTab: tab }
        })
      },
      openCenterTab: (tab) =>
        set((s) => {
          if (s.centerOpenTabs.includes(tab)) return {}
          const newTabs = [...s.centerOpenTabs, tab]
          _persistBranchTabs(newTabs, s.project?.id)
          return { centerOpenTabs: newTabs }
        }),
      closeCenterTab: (tab) =>
        set((s) => {
          const prevOpen = s.centerOpenTabs
          const open = prevOpen.filter((t) => t !== tab)
          if (open.length === 0) {
            _persistBranchTabs([], s.project?.id)
            return { centerOpenTabs: [], centerTab: null }
          }
          let nextActive: CenterTabId | null = s.centerTab
          if (s.centerTab === tab) {
            const idx = prevOpen.indexOf(tab)
            const neighbor = prevOpen[idx - 1] ?? prevOpen[idx + 1]
            nextActive = neighbor && open.includes(neighbor) ? neighbor : (open[open.length - 1] ?? open[0] ?? null)
          }
          if (nextActive == null || !open.includes(nextActive)) {
            nextActive = open[open.length - 1] ?? open[0] ?? null
          }
          _persistBranchTabs(open, s.project?.id)
          return { centerOpenTabs: open, centerTab: nextActive }
        }),
      codeEditorFocusKey: null as string | null,
      openCodeEditor: (focusKey = null) =>
        set((s) => {
          const codeTab: CenterTabId = 'code'
          const newTabs = s.centerOpenTabs.includes(codeTab) ? s.centerOpenTabs : [...s.centerOpenTabs, codeTab]
          _persistBranchTabs(newTabs, s.project?.id)
          return { centerOpenTabs: newTabs, centerTab: codeTab, codeEditorFocusKey: focusKey }
        }),
      layersStripDragTabId: null as LayersStripTabId | null,
      setLayersStripDragTabId: (id) => set({ layersStripDragTabId: id }),
      rightPanelTab: 'prompt' as const,
      setRightPanelTab: (tab: 'prompt' | 'layers' | 'media' | 'inspector' | null) => set({ rightPanelTab: tab }),
      textEditorSlotKey: null as string | null,
      setTextEditorSlotKey: (key) => set({ textEditorSlotKey: key }),
      layersTabSectionPending: null as LayersTabSectionId | null,
      layersTabAvatarLayerIdPending: null as string | null,
      layersPanelRequestNonce: 0,
      clearLayersTabSectionPending: () => set({ layersTabSectionPending: null, layersTabAvatarLayerIdPending: null }),
      openTextTabForSlot: (slotKey) =>
        set((state) => ({
          layersTabSectionPending: 'text',
          textEditorSlotKey: slotKey,
          layersTabAvatarLayerIdPending: null,
          layersPanelRequestNonce: state.layersPanelRequestNonce + 1,
        })),

      openLayersSection: (section) =>
        set((state) => ({
          layersTabSectionPending: section,
          layersTabAvatarLayerIdPending: null,
          layersPanelRequestNonce: state.layersPanelRequestNonce + 1,
        })),

      layerStackPropertiesKey: null as string | null,
      setLayerStackPropertiesKey: (key) => set({ layerStackPropertiesKey: key }),
      layerTreeExpanded: {} as Record<string, boolean>,
      toggleLayerTreeExpanded: (sceneId) =>
        set((state) => ({
          layerTreeExpanded: { ...state.layerTreeExpanded, [sceneId]: !state.layerTreeExpanded[sceneId] },
        })),
      openLayerStackProperties: (stackKey) =>
        set((state) => ({
          layersTabSectionPending: 'properties',
          layerStackPropertiesKey: stackKey,
          layersTabAvatarLayerIdPending: null,
          layersPanelRequestNonce: state.layersPanelRequestNonce + 1,
        })),

      // Media library
      projectAssets: [],
      assetsLoading: false,
      loadProjectAssets: async (projectId: string) => {
        set({ assetsLoading: true })
        try {
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          const data = ipc ? await ipc.listAssets({ projectId }) : null
          if (data) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            set({ projectAssets: ((data as { assets?: unknown[] }).assets ?? []) as any })
          }
        } catch (e) {
          log.error('loadProjectAssets failed', { error: e })
        } finally {
          set({ assetsLoading: false })
        }
      },
      addProjectAsset: (asset) => {
        set((s) => ({ projectAssets: [asset, ...s.projectAssets] }))
        // Eager draft model: the project row already exists (status='draft'),
        // so the asset has a valid project reference with no promotion step.
      },
      updateProjectAsset: (assetId, updates) =>
        set((s) => ({
          projectAssets: s.projectAssets.map((a) => (a.id === assetId ? { ...a, ...updates } : a)),
        })),
      removeProjectAsset: (assetId) =>
        set((s) => ({
          projectAssets: s.projectAssets.filter((a) => a.id !== assetId),
        })),
      setWatermark: (watermark) => {
        // _isDirty: a watermark change on a draft is real activity — it must
        // qualify the draft for lazy persistence (see saveProjectToDb).
        set((s) => ({
          _isDirty: true,
          project: { ...s.project, watermark },
        }))
        // Regenerate all scene HTML to include/remove watermark
        const { scenes } = get()
        scenes.forEach((s) => get().saveSceneHTML(s.id, true))
      },

      // Brand Kit
      brandKit: null,
      updateBrandKit: async (updates) => {
        const { project, brandKit: current } = get()
        const merged = {
          ...(current ?? {
            brandName: null,
            logoAssetIds: [],
            palette: [],
            fontPrimary: null,
            fontSecondary: null,
            guidelines: null,
          }),
          ...updates,
        }
        set((s) => ({ _isDirty: true, brandKit: merged, project: { ...s.project, brandKit: merged } }))
        try {
          // Eager draft model: the project row already exists (status='draft'),
          // so the direct updateBrandKit IPC below has a row to target.
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          if (ipc) {
            await ipc.updateBrandKit({ projectId: project.id, updates: updates as Record<string, unknown> })
          }
        } catch (e) {
          log.error('updateBrandKit failed', { error: e })
        }
      },
      applyBrandToStyle: () => {
        const { brandKit, updateGlobalStyle } = get()
        if (!brandKit) return
        const updates: Record<string, unknown> = {}
        if (brandKit.palette.length >= 4) {
          updates.paletteOverride = brandKit.palette.slice(0, 4) as [string, string, string, string]
        }
        if (brandKit.fontPrimary) {
          updates.fontOverride = brandKit.fontPrimary
        }
        updateGlobalStyle(updates as any)
      },

      // ── Inspector ──────────────────────────────────────────────────────────
      inspectorSelectedElement: null,
      inspectorSelectedLayerId: null,
      inspectorElements: {},
      inspectorPendingChanges: {},
      agentEditContext: null,

      ...createInspectorActions(set, get),

      // Workspace management
      workspaces: [],
      activeWorkspaceId: null,
      isLoadingWorkspaces: false,
      ...createWorkspaceActions(set, get),

      // Project management
      projectList: [],
      isLoadingProjects: false,

      // ── Model configuration ────────────────────────────────────────────────
      modelConfigs: DEFAULT_MODELS,
      providerConfigs: DEFAULT_PROVIDER_CONFIGS,

      setTimelineHeight: (height: number) => set({ timelineHeight: height }),
      setTimelineTransport: (transport) =>
        set((state) => ({
          timelineTransport: { ...state.timelineTransport, ...transport },
        })),
      setPreviewFullscreen: (full: boolean) => set({ isPreviewFullscreen: full }),
      setTimelineZoom: (zoom: number) => set({ timelineZoom: zoom }),
      setTimelineScrollX: (x: number) => set({ timelineScrollX: x }),
      // Atomic zoom + scroll for pinch / wheel-zoom: writing them through
      // separate setters produces a 1-frame render at the new zoom with the
      // old scroll, which the user perceives as a jump under the cursor.
      setTimelineZoomAndScroll: (zoom: number, x: number) => set({ timelineZoom: zoom, timelineScrollX: x }),
      setTimelineAutoScroll: (v: boolean) => set({ timelineAutoScroll: v }),
      setTimelineMagnetic: (v: boolean) => set({ timelineMagnetic: v }),
      setTimelineSnapEnabled: (v: boolean) => set({ timelineSnapEnabled: v }),
      setTimelineFollowPaused: (v: boolean) => set({ timelineFollowPaused: v }),

      setSelectedClipIds: (ids: string[]) => set({ selectedClipIds: ids }),
      toggleClipSelection: (clipId: string, multi?: boolean) => {
        set((s) => {
          // NLE-style: clicking a linked OR grouped clip selects the
          // whole group. Shift- / Cmd-click (passed as multi=true) toggles only
          // the single clip, letting users add to the selection or break out of
          // the group selection.
          const tl = s.project.timeline
          const target = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
          const linkId = target?.linkGroupId
          const grpId = target?.groupId
          const groupIds =
            linkId || grpId
              ? tl!.tracks
                  .flatMap((t) => t.clips)
                  .filter((c) => (linkId && c.linkGroupId === linkId) || (grpId && c.groupId === grpId))
                  .map((c) => c.id)
              : [clipId]

          if (multi) {
            const idx = s.selectedClipIds.indexOf(clipId)
            if (idx >= 0) return { selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId) }
            return { selectedClipIds: [...s.selectedClipIds, clipId] }
          }
          return { selectedClipIds: groupIds }
        })
      },

      updateGlobalStyle: (updates) => {
        get()._pushUndoDebounced()
        if (updates.theme) setPersistedTheme(updates.theme)
        const current = get().globalStyle
        const merged = { ...current, ...updates }
        const typ = merged.uiTypography ?? 'app'
        const resolvedFontFamily = typ !== 'custom' ? null : (merged.uiFontFamily ?? 'Inter')
        const patch = { ...updates } as Partial<typeof current>
        if (resolvedFontFamily !== current.uiFontFamily) {
          patch.uiFontFamily = resolvedFontFamily
        }
        get().dispatchAction({ type: 'style/setGlobal', params: { patch } }, { source: 'user' })
      },

      updateGridConfig: (updates) => {
        set((state) => ({
          gridConfig: { ...state.gridConfig, ...updates },
        }))
      },

      // ── Permission state ────────────────────────────────────────────────────
      pendingPermissionRequest: null,
      spendApprovedThisSession: new Set<string>(),
      sessionPermissions: new Map<string, string>(),
      permissionRules: [],
      generationOverrides: {},
      autoChooseDefaults: {},

      // ── Font favorites ──────────────────────────────────────────────────────
      favoriteFonts: [],
      toggleFavoriteFont: (family) => {
        set((state) => ({
          favoriteFonts: state.favoriteFonts.includes(family)
            ? state.favoriteFonts.filter((f) => f !== family)
            : [...state.favoriteFonts, family],
        }))
      },

      // Spread in actions from each domain
      ...createSceneActions(set, get),
      ...createGenerationActions(set, get),
      ...createProjectActions(set, get),
      ...createAgentActions(set, get),
      ...createTimelineActions(set, get),
      ...createAudioActions(set, get),
      ...createExportActions(set, get),
      ...createDevActions(set, get),
      ...createShowcaseActions(set, get),
    }),
    {
      name: 'dreambyte-storage',
      version: 17,
      migrate: (persistedState: any, version: number) => {
        if (version < 2) {
          persistedState.scenes = (persistedState.scenes ?? []).map((s: any) => ({
            ...s,
            sceneType: s.sceneType ?? 'svg',
            canvasCode: s.canvasCode ?? '',
          }))
        }
        if (version < 3) {
          persistedState.scenes = (persistedState.scenes ?? []).map((s: any) => ({
            ...s,
            sceneCode: s.sceneCode ?? '',
            sceneHTML: s.sceneHTML ?? '',
            sceneStyles: s.sceneStyles ?? '',
            lottieSource: s.lottieSource ?? '',
            d3Data: s.d3Data ?? null,
          }))
        }
        if (version < 4) {
          // Add interactions/variables to scenes
          persistedState.scenes = (persistedState.scenes ?? []).map((s: any) => ({
            ...s,
            interactions: s.interactions ?? [],
            variables: s.variables ?? [],
          }))
          // Create project wrapper if missing
          if (!persistedState.project) {
            persistedState.project = createDefaultProject(persistedState.scenes ?? [])
          }
        }
        if (version < 5) {
          // Add aiLayers to scenes
          persistedState.scenes = (persistedState.scenes ?? []).map((s: any) => ({
            ...s,
            aiLayers: s.aiLayers ?? [],
          }))
          // Add apiPermissions to project
          if (persistedState.project && !persistedState.project.apiPermissions) {
            persistedState.project.apiPermissions = createDefaultAPIPermissions()
          }
        }
        if (version < 6) {
          // Seed model/agent configs with defaults if absent
          if (!persistedState.modelConfigs) {
            persistedState.modelConfigs = DEFAULT_MODELS
          }
          if (!persistedState.providerConfigs) {
            persistedState.providerConfigs = DEFAULT_PROVIDER_CONFIGS
          }
        }
        if (version < 8) {
          // Reset modelConfigs to current DEFAULT_MODELS (removes stale 2.5 models, adds 3/3.1)
          // The settings panel useEffect preserves user's enabled/disabled prefs
          persistedState.modelConfigs = DEFAULT_MODELS
        }
        if (version < 9) {
          // Add chatMessages to persisted state
          if (!persistedState.chatMessages) {
            persistedState.chatMessages = []
          }
        }
        if (version < 10) {
          // Migrate old 4-tier system to new 3-tier system (auto/premium/budget)
          const oldTier = persistedState.modelTier
          if (oldTier === 'fast') persistedState.modelTier = 'budget'
          else if (oldTier === 'balanced') persistedState.modelTier = 'auto'
          else if (oldTier === 'performance') persistedState.modelTier = 'premium'
          // Reset modelConfigs to pick up new models (Sonnet 3.5, GPT-4.1 family, Gemini 2.5)
          persistedState.modelConfigs = DEFAULT_MODELS
        }
        if (version < 11) {
          if (!persistedState.favoriteFonts) {
            persistedState.favoriteFonts = []
          }
        }
        // v12: presetId is now nullable (null = no preset, full style autonomy)
        // No data migration needed — existing projects keep their preset.
        if (version < 13) {
          persistedState.scenes = (persistedState.scenes ?? []).map((s: any) => ({
            ...s,
            canvasBackgroundCode: s.canvasBackgroundCode ?? '',
          }))
        }
        if (version < 14) {
          const gs = persistedState.globalStyle
          if (gs && gs.uiTypography == null) {
            persistedState.globalStyle = { ...gs, uiTypography: 'app' }
          }
        }
        if (version < 15) {
          const gs = persistedState.globalStyle
          if (gs && gs.uiFontFamily === undefined) {
            persistedState.globalStyle = { ...gs, uiFontFamily: null }
          }
        }
        if (version < 16) {
          // Director loop is now the default build path (the blind fan-out is retired
          // to an explicit opt-out). Flip existing persisted state that never toggled
          // it, so returning users get the director instead of the old fan-out.
          persistedState.directorLoop = true
        }
        if (version < 17) {
          // `directorLoop` → `subAgents`, and the default flips to OFF (single-agent).
          // The persisted `directorLoop` value carries NO user intent to respect: the
          // v16 migration above force-set it to true for every existing user, whether
          // or not they had ever opened the toggle. A persisted `true` therefore means
          // "v16 did this", not "the user chose orchestration" — so it must not silently
          // keep spawning sub-agents under the new default. A persisted `false` was a
          // deliberate opt-out and lands on false too. Everyone starts single-agent and
          // opts back in via Settings → Agents (or by asking for it in a message).
          persistedState.subAgents = false
          delete persistedState.directorLoop
        }
        return persistedState
      },
      // If async rehydration runs after loadProject() filled scenes from the DB, do not let
      // stripped localStorage scenes (no code/HTML) overwrite rich in-memory state.
      merge: (persisted, current) => {
        const p = persisted as any
        const base = { ...current, ...p }

        // Heal a legacy/degenerate persisted project whose id is blank or
        // non-UUID. `{ ...current, ...p }` would otherwise carry the stale blank
        // (older builds persisted project.id:'') forward forever, re-persisting
        // it and tripping the UUID-validated project IPCs on every boot. Prefer
        // the persisted activeProjectId so the transient project carries the
        // real id loadProject() hydrates next — keeps branches.list etc. from
        // querying a fresh non-DB default during the boot reconcile window.
        base.project = ensureValidProjectId(base.project, (current as any).project, base.activeProjectId)
        const pcs = p?.scenes
        const ccs = (current as any)?.scenes

        // If DB loaded recently, never let localStorage overwrite it
        const dbLoadedRecently = ((current as any)?._lastDbLoadTimestamp ?? 0) > Date.now() - 5000

        if (Array.isArray(pcs) && Array.isArray(ccs)) {
          if (dbLoadedRecently || (ccs.some(sceneHasRenderableContent) && !pcs.some(sceneHasRenderableContent))) {
            base.scenes = ccs
          } else {
            // Check project match — if current scenes are from a different project, prefer current
            const sameProject =
              pcs.length > 0 && ccs.length > 0 && ccs.every((s: any) => pcs.some((ps: any) => ps.id === s.id))
            if (!sameProject && ccs.some(sceneHasRenderableContent)) {
              base.scenes = ccs
            }
          }
        }
        // Never let persisted localStorage timeline overwrite a freshly synced one
        if (dbLoadedRecently && (current as any)?.project?.timeline) {
          base.project = { ...base.project, timeline: (current as any).project.timeline }
        }
        // Never let persist rehydration clobber loaded chat messages.
        // chatMessages is not in partialize so p won't have it, but the spread
        // { ...current, ...p } can still lose it if p has undefined fields.
        const cur = current as any
        if (cur?.chatMessages?.length > 0) {
          base.chatMessages = cur.chatMessages
          base.activeConversationId = cur.activeConversationId
          base.conversations = cur.conversations
          base._persistedMessageIds = cur._persistedMessageIds
        }
        return base
      },
      partialize: (state) => ({
        // Strip large generated code fields from persisted scenes to prevent
        // localStorage overflow. Full scene data is reloaded from DB via loadProject().
        scenes: state.scenes.map((s) => ({
          ...s,
          svgContent: '',
          canvasCode: '',
          canvasBackgroundCode: '',
          sceneCode: '',
          reactCode: '',
          sceneHTML: '',
          sceneStyles: '',
          lottieSource: '',
        })),
        selectedSceneId: state.selectedSceneId,
        globalStyle: state.globalStyle,
        project: { ...state.project, timeline: undefined },
        publishedUrl: state.publishedUrl,
        showPublishPanel: state.showPublishPanel,
        modelConfigs: state.modelConfigs,
        providerConfigs: state.providerConfigs,
        audioProviderEnabled: state.audioProviderEnabled,
        mediaGenEnabled: state.mediaGenEnabled,
        mediaUnderstandingEngines: state.mediaUnderstandingEngines,
        webSearchEnabled: state.webSearchEnabled,
        aiQualityReview: state.aiQualityReview,
        subAgents: state.subAgents,
        inlineDiffsEnabled: state.inlineDiffsEnabled,
        webFetchEnabled: state.webFetchEnabled,
        autoAcceptWebSearch: state.autoAcceptWebSearch,
        researchProviderEnabled: state.researchProviderEnabled,
        researchModelId: state.researchModelId,
        ytDlpConsentedProjectIds: state.ytDlpConsentedProjectIds,
        favoriteFonts: state.favoriteFonts,
        // UI layout state — preserves editor layout across reloads
        timelineHeight: state.timelineHeight,
        isPreviewFullscreen: state.isPreviewFullscreen,
        centerTab: state.centerTab,
        centerOpenTabs: state.centerOpenTabs,
        appView: state.appView,
        projectView: state.projectView,
        activeProjectId: state.activeProjectId,
        contentView: state.contentView,
        settingsSection: state.settingsSection,
        sidebarCollapsed: state.sidebarCollapsed,
        rightPanelTab: state.rightPanelTab,
        timelineZoom: state.timelineZoom,
        timelineScrollX: state.timelineScrollX,
        previewZoom: state.previewZoom,
      }),
    },
  ),
)

// Expose store for headless/API export access
if (typeof window !== 'undefined') {
  ;(window as any).__dreambyteStore = useVideoStore
}
