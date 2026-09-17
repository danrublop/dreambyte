'use client'

import type {
  Scene,
  SceneUsage,
  GlobalStyle,
  ExportProgress,
  ExportSettings,
  TextOverlay,
  SvgObject,
  SvgBranch,
  SceneType,
  Project,
  SceneGraph,
  SceneNode,
  SceneEdge,
  InteractionElement,
  SceneVariable,
  AILayer,
  AvatarLayer,
  APIPermissions,
  PermissionRequest,
  PermissionResponse,
  APIName,
  SceneStyleOverride,
  AudioSettings,
  TTSTrack,
  SFXTrack,
  MusicTrack,
  Timeline,
  Track,
  TrackType,
  Clip,
  Keyframe,
} from '../types'
import type { GridConfig } from '../grid'
import type {
  ChatMessage,
  AgentType,
  ModelId,
  ModelTier,
  ThinkingMode,
  ConversationSummary,
  StructuralCut,
  ImageAttachment,
} from '../agents/types'
import type { ModelConfig, ProviderConfig } from '../agents/model-config'
import type { AgentConfig } from '../agents/agent-config'
import type { LayersTabSectionId } from '../layers-tab-header'
import type { LayersStripTabId } from '../layers-strip-dock'

// ── Branch operations ─────────────────────────────────────────────────────────

/** The card-driving atoms enterShowcase swaps (storyboard is no longer one). */
export interface ShowcaseSnapshot {
  chatMessages: ChatMessage[]
  pendingPlan: import('../agents/types').AgentPlan | null
  planTodos: import('../agents/types').AgentTodo[]
  planAwaitingApproval: boolean
  structuralCutsProposed: StructuralCut[] | null
}

export type BranchOperation =
  | { kind: 'switch'; branchId: string; branchName?: string }
  | { kind: 'create'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'restore'; versionNumber: number }
  | { kind: 'promote'; branchId: string }

// ── Undo/Redo ─────────────────────────────────────────────────────────────────

export interface UndoableState {
  scenes: Scene[]
  globalStyle: GlobalStyle
  project: Project
  /** Monotonic order key for cross-stack LIFO undo routing. Absent on
   *  entries restored from a prior session → sorts oldest, which is correct. */
  _seq?: number
}

/** A pre-run project snapshot tagged with the run's streaming assistant message
 *  id, for checkpoint-coupled rewind (S3). */
export interface RunSnapshot {
  msgId: string
  snapshot: UndoableState
}

// ── Set / Get type aliases ───────────────────────────────────────────────────

export type Set = (partial: Partial<VideoStore> | ((state: VideoStore) => Partial<VideoStore>)) => void
export type Get = () => VideoStore

// ── VideoStore interface ─────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
}

/** Built-in center tabs (Electron). */
export type CoreCenterTabId =
  | 'preview'
  | 'settings'
  | 'workspace'
  | 'customize'
  | 'welcome'
  | 'history'
  | 'models'
  | 'media'
  | 'code'

/** Layers strip sub-tab opened as its own center tab (drag from left Layers). */
export type LayersDockCenterTabId = `layers:${LayersStripTabId}`

/** Ephemeral tabs that only appear when explicitly opened (not in always-available core set). */
export type ExportCenterTabId = 'export'

/** A pinned read-only preview of a specific branch: `preview:${branchId}` */
export type PreviewCenterTabId = `preview:${string}`

export type CenterTabId = CoreCenterTabId | LayersDockCenterTabId | ExportCenterTabId | PreviewCenterTabId

export interface ExportFormDraft {
  platformId: import('../export/platform-profiles').PlatformProfileId
  resolution: import('../types').ExportResolution
  fps: import('../types').ExportFPS
  profile: 'fast' | 'quality'
  os: 'mac' | 'windows' | 'linux' | 'unknown'
  filename: string
  /** Absolute filesystem path (Electron) or empty string (web fallback). */
  saveDirPath: string
  /** Display name for the save folder (basename of saveDirPath). */
  saveDirName: string
}

export type LastExportStatus = 'idle' | 'success' | 'error' | 'cancelled'

/** Settings overlay sections. Canonical source; SettingsPanel re-exports as `Section`. */
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'usage'
  | 'agents'
  | 'models'
  | 'plugins'
  | 'rules-skills'
  | 'tools'
  | 'dev'

/** Mutually-exclusive content-area overlay shown over the home/project content.
 *  'none' = the underlying home/chat/editor content shows through. */
export type ContentView = 'none' | 'settings' | 'library' | 'workspaces'

export interface VideoStore {
  scenes: Scene[]
  selectedSceneId: string | null
  globalStyle: GlobalStyle

  // Auth
  currentUser: AuthUser | null
  setCurrentUser: (user: AuthUser | null) => void

  // Undo/Redo
  _undoStack: UndoableState[]
  _redoStack: UndoableState[]
  _pushUndo: () => void
  _pushUndoDebounced: () => void
  undo: () => void
  redo: () => void

  // Checkpoint-coupled rewind (S3). Pre-run project snapshots keyed by the run's
  // streaming assistant message id, so a conversation rewind can optionally
  // restore the project to its state BEFORE the run(s) it removes (not just trim
  // the transcript). In-memory only + bounded; cleared on branch switch.
  _runSnapshots: RunSnapshot[]
  /** Whether a pre-run snapshot exists for this run message id. */
  hasRunSnapshot: (msgId: string | null) => boolean
  /** Restore the project to the snapshot captured before `msgId`'s run. Prunes
   *  that snapshot and any captured after it. Returns false when none / mid-run. */
  restoreRunSnapshot: (msgId: string) => boolean

  // ── Action layer ─────────────────────────────────
  // Coexists with snapshot-based undo above (strangler-fig). Dispatching
  // through the action layer is opt-in; ripping the legacy paths happens in
  // P1b once every callsite has migrated.
  _actionUndoStack: import('@/lib/actions').Action[]
  _actionRedoStack: import('@/lib/actions').Action[]
  currentAgentRunId: string | null
  uiEditingLayerId: string | null
  setUiEditingLayerId: (id: string | null) => void
  beginAgentRun: (runId: string) => void
  endAgentRun: () => void
  dispatchAction: (
    input: import('@/lib/actions').ActionInput,
    options?: { source?: 'user' | 'agent' },
  ) => import('@/lib/actions').ActionResult
  recordUserAction: (input: import('@/lib/actions').ActionInput) => import('@/lib/actions').Action
  actionUndo: () => boolean
  actionRedo: () => boolean
  isGenerating: boolean
  generatingSceneId: string | null
  lastGenerationError: string | null
  isExporting: boolean
  /**
   * Set by cancelExport() to request a graceful abort of the in-flight WebCodecs
   * export. exportVideo checks it at every renderer-side scene/finalize
   * boundary and bails to phase 'cancelled' — never reporting success. Reset at
   * the start of each export run. FFmpeg/render-server cancel is out of scope.
   */
  exportCancelRequested: boolean
  isExportModalOpen: boolean
  isNewProjectModalOpen: boolean
  openNewProjectModal: () => void
  closeNewProjectModal: () => void
  /**
   * Last multi-variant spawn result (v0.3.9 — side-by-side comparison).
   * Set when spawnAgentVariants resolves; null when no recent variants
   * exist or the user dismissed the comparison. Drives the "Compare N
   * variants" entry button in GitBranchesPanel.
   */
  lastVariantsSpawn: {
    branchIds: string[]
    sourceBranchId: string
    createdAt: number
  } | null
  setLastVariantsSpawn: (spawn: { branchIds: string[]; sourceBranchId: string; createdAt: number } | null) => void
  /** Is the variant comparison modal currently open? */
  isVariantComparisonOpen: boolean
  openVariantComparison: () => void
  closeVariantComparison: () => void
  /** Phase C.2 — cross-project dispatch. When set, the project-picker modal is
   *  open; it carries the broadcast instruction + the origin agent body to fan
   *  out (the user confirms which target projects it applies to). */
  crossProjectPicker: { instruction: string; originBody: Record<string, unknown> } | null
  openCrossProjectPicker: (p: { instruction: string; originBody: Record<string, unknown> }) => void
  closeCrossProjectPicker: () => void
  /** The in-flight cross-project dispatch group (drives the run view). `outcomes`
   *  is the authoritative per-leg result from dispatchProjects (post dedupe +
   *  exclude-origin), used to SEED leg status — early slot-busy/unreadable/aborted
   *  legs emit their error before the run view subscribes, so we can't rely on
   *  live events alone for the initial state. */
  crossProjectRun: {
    groupId: string
    instruction: string
    outcomes: Array<{ targetProjectId: string; runId: string; status: string }>
  } | null
  setCrossProjectRun: (
    run: {
      groupId: string
      instruction: string
      outcomes: Array<{ targetProjectId: string; runId: string; status: string }>
    } | null,
  ) => void
  exportProgress: ExportProgress | null
  exportFormDraft: ExportFormDraft | null
  setExportFormDraft: (patch: Partial<ExportFormDraft>) => void
  clearExportFormDraft: () => void
  lastExportStatus: LastExportStatus
  markExportStatusSeen: () => void

  // Recording (agent/API-driven)
  recordingState: import('@/types/electron').RecordingStoreState
  recordingConfig: import('@/types/electron').RecordingConfig
  recordingCommand: import('@/types/electron').RecordingCommand
  recordingCommandNonce: number
  recordingResult: import('@/types/electron').RecordingSessionManifest | null
  recordingError: string | null
  recordingElapsed: number
  recordingAttachSceneId: string | null
  setRecordingCommand: (cmd: import('@/types/electron').RecordingCommand) => void
  setRecordingConfig: (config: Partial<import('@/types/electron').RecordingConfig>) => void
  setRecordingState: (state: import('@/types/electron').RecordingStoreState) => void
  setRecordingResult: (result: import('@/types/electron').RecordingSessionManifest | null) => void
  setRecordingError: (error: string | null) => void
  setRecordingElapsed: (ms: number) => void
  setRecordingAttachSceneId: (sceneId: string | null) => void
  timelineHeight: number
  timelineTransport: { globalTime: number; totalDuration: number; isPlaying: boolean }
  isPreviewFullscreen: boolean
  /** Grading UI hover-preview (transient, non-undoable): complete filter list
   *  the target clip renders with while a grade/curve is being previewed. */
  gradePreviewOverride: { clipId: string; filters: import('../types').ClipFilter[] } | null
  setGradePreviewOverride: (o: { clipId: string; filters: import('../types').ClipFilter[] } | null) => void
  /** Scene-layer grade hover-preview (transient): CSS filter on the scene's
   *  preview iframe; `grade` drives a structured SVG filter (id
   *  "dreambyte-grade-preview") for temp/tint/curve previews the css
   *  references via url(#…). */
  sceneGradePreview: {
    sceneId: string
    css: string
    grade?: import('../edit-engines/layer-grade').LayerColorGrade
  } | null
  setSceneGradePreview: (
    p: {
      sceneId: string
      css: string
      grade?: import('../edit-engines/layer-grade').LayerColorGrade
    } | null,
  ) => void
  /** Grade clipboard (transient, in-session). */
  copiedGrade: { lookCss?: string; grade?: import('../edit-engines/layer-grade').LayerColorGrade } | null
  setCopiedGrade: (
    g: { lookCss?: string; grade?: import('../edit-engines/layer-grade').LayerColorGrade } | null,
  ) => void
  /** Preview canvas scale (1 = 100%); synced from PreviewPlayer for header display */
  previewZoom: number
  setPreviewZoom: (z: number) => void
  timelineZoom: number // pixels per second (0 = fit-to-width)
  timelineScrollX: number
  timelineAutoScroll: boolean
  /** Transient: set true when user manually scrolls the timeline during playback, suppresses auto-follow until next play-start */
  timelineFollowPaused: boolean
  /** Magnetic timeline: when true, plain Delete acts like ripple-delete (gap closes automatically). FCP-style. */
  timelineMagnetic: boolean
  setTimelineMagnetic: (v: boolean) => void
  /** Snap toggle (default on). Disables all snap targets when off — clips
   * can be placed sub-frame and across edit points freely. */
  timelineSnapEnabled: boolean
  setTimelineSnapEnabled: (v: boolean) => void
  sceneHtmlVersion: number
  /** Bumped once per agent run AFTER its rewritten scene HTML files land on
   *  disk. Drives a precise multi-scene preview reload (agentReloadSceneIds) so
   *  an agent build that rewrites several scenes refreshes all of their iframes,
   *  not just the selected one. */
  agentReloadNonce: number
  /** The exact set of scene ids the latest agent run rewrote — the scenes the
   *  preview refetches when agentReloadNonce bumps. */
  agentReloadSceneIds: string[]
  /** Per-scene HTML write errors — shown in preview when a scene file failed to save */
  sceneWriteErrors: Record<string, string>
  /** Per-scene save lifecycle, drives the Layers panel footer status bar */
  sceneSaveStatus: Record<string, 'saving' | 'saved' | 'error'>
  /** Per-scene last successful save timestamp (Date.now()) */
  sceneLastSavedAt: Record<string, number>
  /** Project DB autosave lifecycle, shown in the app footer */
  projectSaveStatus: 'idle' | 'saving' | 'saved' | 'error'
  /** Last successful project DB save timestamp (Date.now()) */
  projectLastSavedAt: number | null
  /** Last project DB save error, if any */
  projectSaveError: string | null
  /** True when the initial project load failed after all retries */
  projectLoadFailed: boolean
  gridConfig: GridConfig
  project: Project
  isPublishing: boolean
  publishError: string | null
  publishedUrl: string | null
  showPublishPanel: boolean

  // Conversation state
  conversations: ConversationSummary[]
  activeConversationId: string | null
  conversationsLoading: boolean

  // Conversation actions
  loadConversations: (projectId: string) => Promise<void>
  newConversation: (projectId: string) => Promise<string>
  switchConversation: (conversationId: string, opts?: { confirmedAbortRun?: boolean }) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  pinConversation: (id: string, pinned: boolean) => Promise<void>
  /** Archive / unarchive a conversation. Archived chats are hidden from the
   *  default conversation list and from search unless an "Archived" toggle is on. */
  archiveConversation: (id: string, archived: boolean) => Promise<void>
  deleteConversation: (id: string) => Promise<void>

  // Chat / Agent state
  chatMessages: ChatMessage[]
  /**
   * Image attachments staged on the home composer before a project
   * exists. createNewProject is fired on submit; AgentChat drains these into its
   * composer's pendingImages on mount so the file carries into the new project's
   * chat. Cleared once drained. (Full auto-seed of the first message — text +
   * attachments sent as one turn — is a separate seam; see HomeStage.)
   */
  pendingComposerAttachments: ImageAttachment[]
  setPendingComposerAttachments: (atts: ImageAttachment[]) => void
  /**
   * Home-composer text staged for the new project's chat composer (COMMIT 2a).
   * Drained into the chat input on AgentChat mount alongside attachments — NOT
   * auto-sent (no submit pipeline exists from home; the user presses Enter).
   */
  pendingComposerText: string
  setPendingComposerText: (text: string) => void
  isChatOpen: boolean
  isAgentRunning: boolean
  /** Monotonically increasing nonce — increment to signal abort to AgentChat SSE stream */
  _abortNonce: number
  /** Abort any in-flight agent SSE stream (increments _abortNonce) */
  abortAgentRun: () => void
  /** True when another browser tab has an agent run in progress (via BroadcastChannel) */
  isAgentRunningRemote: boolean
  /** Timestamp when the current agent run started — used to detect user edits during a run */
  _agentRunStartedAt: number
  /** Branch the current agent run started on. If the user switches
   *  branches mid-run, syncScenesFromAgent must NOT merge the run's scenes into
   *  the live store (a different branch's timeline) — the main process already
   *  persisted them to the run's branch; the renderer only notifies. */
  _agentRunBranchId: string | null
  /** Project the current agent run started on. A mid-run PROJECT
   *  switch with matching branch ids (e.g. both default/null) would otherwise
   *  pass the branch guard and pour the run's scenes into another project. */
  _agentRunProjectId: string | null
  /** Scene ids touched by USER-sourced dispatches during the current run
   *  Source-tagged — unlike scene.updatedAt, which agent reducers
   *  also bump with Date.now(), so timestamps alone misclassify agent writes
   *  as user edits. The merge guard preserves these scenes and reports the
   *  conflict. Reset at each run start. */
  _userEditedScenesDuringRun: globalThis.Set<string>
  agentType: AgentType | null
  agentModelId: ModelId | null
  modelOverride: ModelId | null
  modelTier: ModelTier
  thinkingMode: ThinkingMode
  /** When true, all LLM calls route through Ollama and TTS uses free providers */
  localMode: boolean
  /** When true, agent uses mock SSE stream (no API credits spent) */
  mockMode: boolean
  /** Dev-only chat UI showcase: fixture transcript swapped in, persistence
   *  fenced at the persist boundaries (showcase-actions.ts). Composer blocks
   *  sends while true. */
  showcaseMode: boolean
  /** Pre-showcase state held for restore. Internal to showcase-actions. */
  _showcaseSnapshot: ShowcaseSnapshot | null
  /** Snapshot the 6 card-driving atoms, inject the showcase fixture, set the flag. */
  enterShowcase: () => void
  /** Restore the snapshot and clear the flag. No-op when not in showcase. */
  exitShowcase: () => void
  /** Selected local model ID (e.g. Ollama model) when localMode is on */
  localModelId: string | null
  /** Model the deep-research sub-agent runs on. null → inherit the run's model
   *  (the costly frontier model does research). Set to a model id (e.g. a local
   *  Ollama Tongyi model) → research runs there instead, for $0 tokens. */
  researchModelId: string | null
  setResearchModelId: (id: string | null) => void
  sceneContext: 'all' | 'selected' | 'auto' | string
  activeTools: string[]
  chatInputValue: string
  settingsTab: 'models' | 'agents' | 'general' | null
  setSettingsTab: (tab: 'models' | 'agents' | 'general' | null) => void
  /** Top-level app view: 'home' = chat-first landing, 'project' = inside a project. Owns AppShell routing. */
  appView: 'home' | 'project'
  /** When appView==='project', which face of the project is showing. */
  projectView: 'chat' | 'editor'
  /** The project the AppShell is focused on (sidebar-selected / opened from home). */
  activeProjectId: string | null
  setAppView: (v: 'home' | 'project') => void
  setProjectView: (v: 'chat' | 'editor') => void
  /** Open a project into the shell (sets active + project view + loads it). */
  openProject: (id: string, view?: 'chat' | 'editor', conversationId?: string) => void
  /** Return to the chat-first home (keeps activeProjectId for resume). */
  goAppHome: () => void
  /** Which content-area overlay is open (settings/customize/library/workspaces),
   *  or 'none'. Mutually exclusive by construction. Persisted so a refresh
   *  resumes the same panel — being in Settings survives a reload. */
  contentView: ContentView
  setContentView: (v: ContentView) => void
  /** Active section within the Settings overlay. Persisted alongside contentView. */
  settingsSection: SettingsSection
  setSettingsSection: (s: SettingsSection) => void
  /** Left sidebar collapsed state. Persisted across refresh. */
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  /** Command palette open state. Lifted to the store so the
   *  shell-scoped Search button and the editor's Cmd+K both drive one palette. */
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (v: boolean) => void
  /** Which center tabs are open (Electron center strip). */
  centerOpenTabs: CenterTabId[]
  /** Active center tab content; null when all tabs are closed. */
  centerTab: CenterTabId | null
  setCenterTab: (tab: CenterTabId | null) => void
  /** Add a tab to centerOpenTabs without activating it (used for background tab restore). */
  openCenterTab: (tab: CenterTabId) => void
  closeCenterTab: (tab: CenterTabId) => void
  /** Code-editor center tab: which slot to focus when it opens (set by the
   *  "Edit code" action on layer-stack rows). null = let the editor pick. */
  codeEditorFocusKey: string | null
  /** Open the rich code editor center tab, optionally focused on a slot key. */
  openCodeEditor: (focusKey?: string | null) => void
  /** Set while dragging a Layers strip tab — center UI shows a drop catcher above the preview iframe. */
  layersStripDragTabId: LayersStripTabId | null
  setLayersStripDragTabId: (id: LayersStripTabId | null) => void
  rightPanelTab: 'prompt' | 'layers' | 'media' | 'inspector' | null
  setRightPanelTab: (tab: 'prompt' | 'layers' | 'media' | 'inspector' | null) => void
  /** Unified text editor: slot key from src/lib/text-slots (overlay:…, svg:…, ix:…, phys:…) */
  textEditorSlotKey: string | null
  setTextEditorSlotKey: (key: string | null) => void
  /** When set, Layers tab switches to this sub-section once (e.g. Text after double-click in layer stack). */
  layersTabSectionPending: LayersTabSectionId | null
  /** With {@link layersTabSectionPending} `avatar`: select this AI avatar layer id in the Avatar tab. */
  layersTabAvatarLayerIdPending: string | null
  /** Incremented when an action needs the Layers pane to become visible. */
  layersPanelRequestNonce: number
  clearLayersTabSectionPending: () => void
  openTextTabForSlot: (slotKey: string) => void
  /** Open Layers panel and activate a sub-tab once (e.g. Elements after clicking a scene element). */
  openLayersSection: (section: LayersTabSectionId, opts?: { avatarLayerId?: string }) => void
  /** Layer stack row key (e.g. `bg:stage`, `scene:motion`) for the Properties sub-tab. */
  layerStackPropertiesKey: string | null
  setLayerStackPropertiesKey: (key: string | null) => void
  /** Opens Layers → Properties for a stack row (double-click in layer stack). */
  openLayerStackProperties: (stackKey: string) => void
  /**
   * Which scenes have their layer tree expanded, by scene id. Lives here rather
   * than in SceneLayersStackPanel because drilling into Properties swaps that
   * component out entirely — component state would reset on every trip back.
   * Absent id = collapsed. Nothing populates this but the user's own chevron.
   */
  layerTreeExpanded: Record<string, boolean>
  toggleLayerTreeExpanded: (sceneId: string) => void

  // Media library
  projectAssets: import('../types').ProjectAsset[]
  assetsLoading: boolean
  loadProjectAssets: (projectId: string) => Promise<void>
  addProjectAsset: (asset: import('../types').ProjectAsset) => void
  updateProjectAsset: (assetId: string, updates: Partial<import('../types').ProjectAsset>) => void
  removeProjectAsset: (assetId: string) => void
  setWatermark: (watermark: import('../types').WatermarkConfig | null) => void

  // Brand Kit
  brandKit: import('../types/media').BrandKit | null
  updateBrandKit: (updates: Partial<import('../types/media').BrandKit>) => Promise<void>
  applyBrandToStyle: () => void

  // Chat Actions
  setChatOpen: (open: boolean) => void
  addChatMessage: (msg: ChatMessage) => void
  /** Insert a message before another by id (append if the anchor is gone). For
   *  mid-run steering — show the steer above the in-progress assistant reply. */
  insertChatMessageBefore: (msg: ChatMessage, beforeId: string) => void
  /** Persist a user message to the DB. Awaitable — call before starting the agent stream. */
  persistUserMessage: (msg: ChatMessage) => Promise<void>
  updateChatMessage: (id: string, updates: Partial<ChatMessage>) => void
  /** Persist a chat message to DB. INSERT on first call, UPDATE on subsequent. Awaitable. */
  persistChatMessage: (id: string, opts?: { status?: string }) => Promise<void>
  /** Seq-guarded streaming upsert. Carries runId + monotonic seq so the
   *  persist layer rejects stale/out-of-order partials. Throws only on transport
   *  error; the StreamingChatPersister catches + retries once + swallows. */
  persistStreamingChatMessage: (args: {
    messageId: string
    runId: string | null
    seq: number
    content: string
    toolCalls?: unknown[]
    contentSegments?: unknown[]
    thinking?: string
  }) => Promise<{ applied: boolean }>
  /** Track which message IDs have been persisted to DB (INSERT vs UPDATE discrimination) */
  _persistedMessageIds: globalThis.Set<string>
  removeChatMessage: (id: string) => void
  /**
   * Rewind primitive: tail-delete the active conversation after a
   * message in the DB, then splice the store in lockstep. Optional content swap
   * on the anchor (the edit case). Rejects with a RewindError (without mutating)
   * while generating, on an unknown id, or on a DB failure. Conversation-only —
   * never touches project state.
   *
   * `isGenerating` is the live agent-run flag from the caller (AgentChat owns it
   * as local state; the store's isAgentRunning is legacy/unreliable). Pass it so
   * the "refuse mid-run" guard is meaningful.
   */
  truncateConversation: (
    msgId: string,
    opts?: {
      /** DB content swap — always the plain-text form (the messages table stores text). */
      newContent?: string
      /** In-memory content swap — may carry image blocks the DB form strips. */
      newStoreContent?: import('@/lib/agents/types').MessageContent
      isGenerating?: boolean
    },
  ) => Promise<ChatMessage[]>
  clearChat: () => void
  /** Agent run lifecycle hook: acquire (true) / release (false) the agent's scene lock
   *  AND, on the first true of a run, capture the pre-run undo snapshot + set
   *  isAgentRunning/_agentRunStartedAt. Driven by AgentChat's streaming lifecycle
   *  (cursor model). */
  setAgentRunSceneLock: (active: boolean, runMsgId?: string | null) => void
  setAgentType: (type: AgentType | null) => void
  setAgentModelId: (id: ModelId | null) => void
  /** Gap 3.1: whole-scene-redundancy cut candidates from the post-build cut
   *  review, shown in the structural-cuts card. Persisted project-scoped;
   *  cleared on apply or dismiss. */
  structuralCutsProposed: StructuralCut[] | null
  setStructuralCutsProposed: (cuts: StructuralCut[] | null) => void
  /** Version of the active branch's branch_proposals row (0015). Hydrated by
   *  loadBranchProposals; the SSE handler applies a proposal event only when its
   *  stamped version is newer, rejecting late/out-of-order updates after a
   *  branch switch-back. */
  proposalsVersion: number
  /** Phase 3 agentic plan surface: the written plan shown in the chat plan card. */
  pendingPlan: import('../agents/types').AgentPlan | null
  /** When true, the plan card shows an Approve & build gate (Plan-first mode). */
  planAwaitingApproval: boolean
  /** Live todo checklist rendered in the plan card and as "building N/M". */
  planTodos: import('../agents/types').AgentTodo[]
  setPendingPlan: (plan: import('../agents/types').AgentPlan | null, awaitingApproval?: boolean) => void
  setPlanTodos: (todos: import('../agents/types').AgentTodo[]) => void
  setPlanAwaitingApproval: (v: boolean) => void
  clearPlan: () => void
  pausedAgentRun: {
    toolName: string
    toolInput: Record<string, unknown>
    agentType?: string | null
    reason?: string | null
    createdAt: string
    /** Cumulative chain spend at the pause (from done.ledgerSpentUsd) — sent as
     *  resumeSpentUsd on resume so the cost ledger seeds instead of restarting. */
    spentUsd?: number
  } | null
  setPausedAgentRun: (
    v: {
      toolName: string
      toolInput: Record<string, unknown>
      agentType?: string | null
      reason?: string | null
      createdAt: string
      spentUsd?: number
    } | null,
  ) => void
  /** Run checkpoint for resuming interrupted multi-scene builds */
  runCheckpoint: import('../agents/types').RunCheckpoint | null
  setRunCheckpoint: (v: import('../agents/types').RunCheckpoint | null) => void
  /**
   * Canonical agent run mode — the user's chevron-picker choice.
   * 'auto' | 'ask' | 'plan' | 'sandbox'. At request-build (AgentChat) the run's
   * sandboxMode/permissionPosture/initial planFirstMode are DERIVED from this.
   */
  agentRunMode: import('../agents/types').AgentRunMode
  setAgentRunMode: (m: import('../agents/types').AgentRunMode) => void
  /**
   * Per-run plan-first toggle. setAgentRunMode SEEDS it (true iff mode==='plan'),
   * but it is ALSO cleared mid-run by the plan→build state machine (approve-plan
   * flow), so it is NOT a pure mirror of agentRunMode — it
   * is downstream run-state. Request-build derives plan-first from agentRunMode, not
   * from this field, so a mid-run clear here never contradicts the user's choice.
   */
  planFirstMode: boolean
  setPlanFirstMode: (v: boolean) => void
  /**
   * Diff-preview mode (Phase 3.2). When 'destructive-only' or 'always', tools
   * tagged with `mutates` pause for user approval before executing.
   * Default: 'off'.
   */
  previewMode: 'off' | 'destructive-only' | 'always'
  setPreviewMode: (v: 'off' | 'destructive-only' | 'always') => void
  /**
   * Per-run cost circuit breaker in USD. A number is the cap; `null` means
   * Unlimited (no cost-based stop). Threaded to the runner as
   * AgentAPIRequest.runBudgetUsd. Default: 25.
   */
  runBudgetUsd: number | null
  setRunBudgetUsd: (v: number | null) => void
  setModelOverride: (id: ModelId | null) => void
  setModelTier: (tier: ModelTier) => void
  setThinkingMode: (mode: ThinkingMode) => void
  setLocalMode: (enabled: boolean) => void
  setLocalModelId: (id: string | null) => void
  setSceneContext: (ctx: 'all' | 'selected' | 'auto' | string) => void
  setActiveTools: (tools: string[]) => void
  toggleActiveTool: (toolId: string) => void
  setChatInputValue: (v: string) => void
  // Sync scenes from agent tool execution
  syncScenesFromAgent: (
    updatedScenes: Scene[],
    updatedGlobalStyle: GlobalStyle,
    updatedSceneGraph?: SceneGraph,
  ) => Promise<void>

  // Actions
  setTimelineHeight: (height: number) => void
  setTimelineTransport: (transport: Partial<{ globalTime: number; totalDuration: number; isPlaying: boolean }>) => void
  setPreviewFullscreen: (full: boolean) => void
  setTimelineZoom: (zoom: number) => void
  setTimelineScrollX: (x: number) => void
  /** Atomic write — see comment in store index.ts. Prevents 1-frame jump on pinch-zoom. */
  setTimelineZoomAndScroll: (zoom: number, x: number) => void
  setTimelineAutoScroll: (v: boolean) => void
  setTimelineFollowPaused: (v: boolean) => void
  addScene: (prompt?: string) => string
  updateScene: (id: string, updates: Partial<Scene>) => void
  deleteScene: (id: string) => void
  // Scene-level mutual exclusion lock. Returns the outcome so callers
  // can branch on held-by-other (read-only mode) vs ok (proceed with edit).
  acquireSceneLock: (
    sceneId: string,
    owner: 'agent' | 'user',
    source?: 'in-app' | 'mcp-stdio' | 'mcp-http' | 'unknown',
  ) => import('./scene-lock').AcquireOutcome
  touchSceneLock: (sceneId: string, owner: 'agent' | 'user') => import('./scene-lock').TouchOutcome
  releaseSceneLock: (sceneId: string) => void
  forceTakeoverSceneLock: (
    sceneId: string,
    newOwner: 'agent' | 'user',
    source?: 'in-app' | 'mcp-stdio' | 'mcp-http' | 'unknown',
  ) => import('./scene-lock').TakeoverOutcome
  duplicateScene: (id: string) => void
  reorderScenes: (fromIndex: number, toIndex: number) => void
  moveScene: (id: string, direction: 'up' | 'down') => void
  selectScene: (id: string) => void
  updateGlobalStyle: (updates: Partial<GlobalStyle>) => void
  updateGridConfig: (updates: Partial<GridConfig>) => void

  // Project actions
  setOutputMode: (mode: 'mp4' | 'interactive') => void
  updateProject: (updates: Partial<Project>) => void
  updateSceneGraph: (graph: SceneGraph) => void
  publishProject: () => Promise<void>
  setShowPublishPanel: (show: boolean) => void

  // ── Transient UI feedback ────────────────────────────────────────
  /** One-line status message shown in the bottom status bar; auto-clears. */
  transientStatus: { text: string; expiresAt: number } | null
  showTransientStatus: (text: string, durationMs?: number) => void
  /** Map of clipId → expiresAt for the "just-added" highlight ring. */
  recentlyAddedClipIds: Record<string, number>
  flashClip: (clipId: string, durationMs?: number) => void

  // Timeline / Track / Clip (NLE model)
  selectedClipIds: string[]
  setSelectedClipIds: (ids: string[]) => void
  toggleClipSelection: (clipId: string, multi?: boolean) => void
  getTimeline: () => Timeline | null
  /** B2 (v6 TIMELINE): apply (merge + save) the timeline an agent run produced. */
  applyAgentTimeline: (timeline: Timeline | null | undefined) => void
  initTimeline: (force?: boolean) => void
  syncTimelineFromScenes: () => void
  addTrack: (type: TrackType, name?: string) => string
  removeTrack: (trackId: string) => void
  updateTrack: (
    trackId: string,
    updates: Partial<Pick<Track, 'name' | 'muted' | 'locked' | 'position' | 'solo' | 'hidden'>>,
  ) => void
  addClip: (trackId: string, clip: Omit<Clip, 'id' | 'trackId'>) => string
  removeClip: (clipId: string) => void
  removeClipRipple: (clipId: string) => void
  updateClip: (clipId: string, updates: Partial<Clip>) => void
  splitClip: (
    clipId: string,
    atTime: number,
    opts?: { skipUndo?: boolean },
  ) => { leftId: string; rightId: string } | null
  moveClip: (clipId: string, toTrackId: string, startTime: number) => void
  batchUpdateClips: (batch: Array<{ id: string; updates: Partial<Clip> }>) => void
  /** Break a NLE-style link group; siblings become independent. */
  unlinkGroup: (clipId: string) => void
  /** Join 2+ clips into a fresh link group. */
  linkClips: (clipIds: string[]) => void
  /** Group selected clips so they move together (Cmd+G). */
  groupClips: (clipIds: string[]) => void
  /** Dissolve the group containing this clip (Cmd+Shift+G). */
  ungroupClip: (clipId: string) => void
  /** Clipboard of cut/copied clip snapshots. Anchored on the earliest startTime
   * so paste re-applies the original relative offsets. */
  clipClipboard: { clips: Clip[]; anchorTime: number } | null
  /** Copy selected clips to the in-app clipboard (does not touch the system clipboard). */
  copyClips: (clipIds: string[]) => void
  /** Copy + remove. */
  cutClips: (clipIds: string[]) => void
  /** Paste clipboard contents anchored at `atTime` (defaults to playhead).
   * When `insert` is true, downstream clips on each affected track shift
   * by the pasted range's length to make room (Paste Insert).
   * Returns the ids of the newly-pasted clips so callers can select them. */
  pasteClips: (atTime?: number, opts?: { insert?: boolean }) => string[]
  /** Add a marker at the given time (returns its id). */
  addMarker: (time: number, label?: string) => string
  /** Remove a marker by id. */
  removeMarker: (markerId: string) => void
  /** Patch a marker's label/color/time. */
  updateMarker: (markerId: string, updates: Partial<{ time: number; label: string; color: string }>) => void
  /** Set / clear the sequence in-point (`I`). */
  setSequenceInPoint: (time: number | null) => void
  /** Set / clear the sequence out-point (`O`). */
  setSequenceOutPoint: (time: number | null) => void
  /** Add an edit (split) at `time` on every clip whose range covers it.
   * When `trackIds` is provided, only those tracks are affected; otherwise
   * all unlocked tracks. Returns the new clip ids on the trailing side. */
  addEditAtTime: (time: number, trackIds?: string[]) => string[]

  // Variable actions
  addSceneVariable: (sceneId: string, variable: SceneVariable) => void
  removeSceneVariable: (sceneId: string, variableName: string) => void
  /** Runtime variable values for preview (not persisted to DB — used by PreviewPlayer) */
  runtimeVariables: Record<string, Record<string, unknown>> // sceneId => name => value
  setRuntimeVariable: (sceneId: string, name: string, value: unknown) => void
  getRuntimeVariables: (sceneId: string) => Record<string, unknown>

  // Interaction actions
  addInteraction: (sceneId: string, element: InteractionElement) => void
  updateInteraction: (sceneId: string, elementId: string, updates: Partial<InteractionElement>) => void
  /** Replace whole element (e.g. when switching interaction type). */
  replaceInteraction: (sceneId: string, elementId: string, next: InteractionElement) => void
  removeInteraction: (sceneId: string, elementId: string) => void

  // Overlay actions
  addTextOverlay: (sceneId: string) => string
  updateTextOverlay: (sceneId: string, overlayId: string, updates: Partial<TextOverlay>) => void
  removeTextOverlay: (sceneId: string, overlayId: string) => void

  // SVG Object actions
  updateSvgObject: (sceneId: string, objectId: string, updates: Partial<SvgObject>) => void

  // Branch navigation
  switchBranch: (sceneId: string, branchId: string) => void

  // Generation
  generateSVG: (sceneId: string, onToken?: (svg: string) => void) => Promise<void>
  generateCanvas: (sceneId: string, onToken?: (code: string) => void) => Promise<void>
  generateMotion: (sceneId: string) => Promise<void>
  generateD3: (sceneId: string) => Promise<void>
  generateThree: (sceneId: string) => Promise<void>
  generateLottie: (sceneId: string, onToken?: (svg: string) => void) => Promise<void>
  generateReact: (sceneId: string) => Promise<void>
  editSVG: (sceneId: string, instruction: string, onToken?: (svg: string) => void) => Promise<void>
  enhancePrompt: (sceneId: string) => Promise<void>
  saveSceneHTML: (sceneId: string, quiet?: boolean) => Promise<void>
  /** Scene HTML self-heal: regenerate any scene whose on-disk HTML is
   *  missing or stale, via the same save path. Healthy scenes untouched. */
  healProjectScenes: () => Promise<void>

  // Export
  openExportModal: () => void
  closeExportModal: () => void
  exportVideo: (settings: ExportSettings) => Promise<void>
  /** Request cancellation of the in-flight WebCodecs export. */
  cancelExport: () => void
  setExportProgress: (progress: ExportProgress | null) => void

  // Thumbnail
  captureSceneThumbnail: (sceneId: string, dataUrl: string) => void
  captureSceneFilmstrip: (sceneId: string, frames: string[]) => void
  setSceneFilmstripFrame: (sceneId: string, slot: number, dataUri: string, total: number) => void

  // Agent visual feedback — capture a frame from the preview iframe
  registerFrameCapturer: (capturer: ((sceneId: string, time: number) => Promise<string | null>) | null) => void
  captureSceneFrame: (sceneId: string, time: number) => Promise<string | null>

  // AI Layer actions
  addAILayer: (sceneId: string, layer: AILayer) => void
  updateAILayer: (sceneId: string, layerId: string, updates: Partial<AILayer>) => void
  removeAILayer: (sceneId: string, layerId: string) => void

  // Permission actions
  updateAPIPermissions: (updates: Partial<APIPermissions>) => void
  pendingPermissionRequest: PermissionRequest | null
  setPendingPermissionRequest: (req: PermissionRequest | null) => void
  /** Open the always-ask spend modal and resolve when the user decides. The in-app media
   *  gen-actions await this on a `permissionNeeded` block, then act on the scope. */
  requestSpendApproval: (req: PermissionRequest) => Promise<import('../types/permissions').SpendApprovalDecision>
  /** Called by PermissionDialog to settle the pending `requestSpendApproval` promise. No-op when
   *  the dialog was opened by a non-spend path (no waiter registered). */
  resolveSpendApproval: (decision: import('../types/permissions').SpendApprovalDecision) => void
  /** APIs the user approved for 'this session' — the gen-actions pass approvedAsk for these without
   *  re-prompting. Cleared on reload (not persisted). (`globalThis.Set` — the module's `Set` alias
   *  is the zustand setter type.) */
  spendApprovedThisSession: globalThis.Set<string>
  /** Add an api to the session-approved set ('once'/'session' scope). */
  markSpendApproved: (api: string) => void
  sessionPermissions: Map<string, string>
  setSessionPermission: (api: string, decision: string) => void
  /** Layered permission rules (user/workspace/project/session) — DB-backed
   *  source of truth for allow/deny evaluation. `sessionPermissions` above is
   *  kept as a compat read-through for callers that still consult the Map. */
  permissionRules: import('../types/permissions').PermissionRule[]
  /** Fetch rules from /api/permissions/rules into the store. Call on login,
   *  project switch, and after the dialog writes a new rule. */
  refreshPermissionRules: () => Promise<void>
  /** Persist a new rule via the API and splice it into the store. Used by
   *  the permission dialog (Session/Always) and Settings → Permissions. */
  createPermissionRule: (
    input: Omit<import('../types/permissions').PermissionRule, 'id' | 'userId' | 'createdAt'>,
  ) => Promise<import('../types/permissions').PermissionRule | null>
  /** Delete a rule by id through the API. */
  deletePermissionRule: (id: string) => Promise<boolean>

  // Generation overrides — set from the universal confirmation card
  generationOverrides: Record<string, { provider?: string; prompt?: string; config?: Record<string, any> }>
  setGenerationOverride: (
    api: string,
    overrides: { provider?: string; prompt?: string; config?: Record<string, any> },
  ) => void
  clearGenerationOverride: (api: string) => void
  autoChooseDefaults: Record<string, { provider: string; config: Record<string, any> }>
  setAutoChooseDefault: (genType: string, defaults: { provider: string; config: Record<string, any> }) => void

  // Media generation
  generateAIImage: (
    sceneId: string,
    opts: {
      prompt: string
      model?: string
      style?: string | null
      aspectRatio?: string
      removeBackground?: boolean
      seed?: number | null
      strength?: number | null
      x?: number
      y?: number
      width?: number
      height?: number
      label?: string
    },
  ) => Promise<void>
  generateCharacterImage: (
    sceneId: string,
    opts: { characterId: string; characterName?: string; model?: string | null; prompt: string; aspectRatio?: string },
  ) => Promise<void>
  generateAIVideo: (
    sceneId: string,
    opts: {
      prompt: string
      model?: string
      aspectRatio?: string
      duration?: number
      seed?: number | null
      imageUrl?: string | null
      // Tier 2 (#5): keyframe END frame (with imageUrl as the start) + extend source clip.
      endImageUrl?: string | null
      extendVideoUrl?: string | null
      // Tier 2 (#4): in-video edit (v2v / Aleph) source clip + operation.
      editVideoUrl?: string | null
      edit?: import('../media/video-edit').VideoEditSpec | null
      camera?: import('../media/camera').CameraSpec | null
      /** Tier 2 (#8): a VFX effect preset id, compiled into the prompt by startVideo. */
      effect?: string | null
      /** Phase 3: a cinematic optics preset id, resolved to OpticsSpec + compiled by startVideo. */
      lensPreset?: string | null
    },
  ) => Promise<void>
  generateLipsync: (
    sceneId: string,
    opts: { provider: string; imageUrl: string; text: string; ttsProvider?: string; voiceId?: string },
  ) => Promise<void>
  pollVeo3Status: (sceneId: string, layerId: string, operationName: string, projectId?: string, prompt?: string) => void
  /** Apply a reactive generation-job status push from the main-process runner
   *  (channel `dreambyte:generation.update`): lands the finished asset on the timeline the
   *  instant the runner finalizes it, reusing the renderer-poll completion path. Idempotent. */
  applyGenerationUpdate: (update: {
    jobId: string
    kind: string
    status: string
    sceneId?: string | null
    layerId?: string | null
    resultUrl?: string | null
    error?: string | null
  }) => void
  /** Start a poll loop for every video layer still 'generating' (dedup by operationName).
   *  Completes agent-inserted clips and resumes clips after reload/restart. Idempotent. */
  reconcilePendingVideoPolls: () => void
  /** Renderer-side HeyGen avatar poll (dedup by heygenVideoId): completes a processing
   *  avatar with the SAME scene-fit as get_avatar_status, and flips a wedged render to
   *  error past the 15-min deadline even after the agent run ends. */
  pollAvatarStatus: (sceneId: string, layerId: string, heygenVideoId: string) => void
  /** Keep a renderer poll alive for every avatar layer still 'processing' (the durable
   *  half of the avatar timeout). Idempotent — dedupes by heygenVideoId. */
  reconcilePendingAvatarPolls: () => void

  // Audio
  audioSettings: AudioSettings
  updateAudioSettings: (updates: Partial<AudioSettings>) => void
  audioProviderEnabled: Record<string, boolean>
  toggleAudioProvider: (id: string) => void

  // Media Gen
  mediaGenEnabled: Record<string, boolean>
  toggleMediaGen: (id: string) => void

  // Media Understanding (Phase 2 multimodal intake)
  /** Per-modality engine choice for reference-media intake (`auto`/concrete id).
   *  Keyed by ReferenceMediaKind ('image'|'audio'|'video'|'doc'). */
  mediaUnderstandingEngines: Record<string, string>
  setMediaUnderstandingEngine: (kind: string, engineId: string) => void

  // Web research (three independent switches — Settings ▸ Agents).
  /** Web Search Tool. Gates web_search (native, model-gated) + find_stock_videos /
   *  find_stock_images / find_archival_footage (our APIs, all models). Default ON. */
  webSearchEnabled: boolean
  setWebSearchEnabled: (enabled: boolean) => void
  /** AI quality review (Gap D): run the single-scene aesthetic slop rubric after a
   *  direct build and surface notes in chat. Advisory, ~one vision call per built
   *  scene. Default ON. The deterministic blank/broken render gate is separate and
   *  always runs regardless of this toggle. */
  aiQualityReview: boolean
  setAiQualityReview: (enabled: boolean) => void
  /** Use sub-agents (Settings → Agents). OFF by default: the agent builds every scene
   *  itself, in one loop. ON routes a multi-scene build to the whole-video "director".
   *  Sent as `subAgents` on the agent request;
   *  a user can also ask for it per-message ("use sub-agents", "build in parallel"). */
  subAgents: boolean
  setSubAgents: (enabled: boolean) => void
  /** Inline diffs in chat tool cards (Settings → Agents; default off). */
  inlineDiffsEnabled: boolean
  setInlineDiffsEnabled: (enabled: boolean) => void
  /** Web Fetch Tool. Gates fetch_url_content + fetch_video_from_url (our client-side
   *  code, works on ANY tool-capable model). Default ON. */
  webFetchEnabled: boolean
  setWebFetchEnabled: (enabled: boolean) => void
  /** Auto-Accept Web Search. When OFF, the first native web_search per chat run is
   *  withheld until the user approves once (native server-side search can't be paused
   *  mid-stream, so we gate at tool-injection time). Default ON. */
  autoAcceptWebSearch: boolean
  setAutoAcceptWebSearch: (enabled: boolean) => void
  /** Per-provider enabled map for media providers (pexels, pixabay, unsplash, archive-org…). */
  researchProviderEnabled: Record<string, boolean>
  toggleResearchProvider: (id: string) => void
  /** Per-project consent for yt-dlp downloads. Persisted to localStorage so the one-time
   *  legal disclaimer modal doesn't keep reappearing. */
  ytDlpConsentedProjectIds: string[]
  grantYtDlpConsent: (projectId: string) => void
  revokeYtDlpConsent: (projectId: string) => void
  generateNarration: (
    sceneId: string,
    text: string,
    provider?: string,
    voiceId?: string,
    instructions?: string,
  ) => Promise<void>
  addSFXToScene: (sceneId: string, sfx: SFXTrack) => void
  removeSFXFromScene: (sceneId: string, sfxId: string) => void
  setSceneMusic: (sceneId: string, music: MusicTrack | null) => void
  generateSfx: (sceneId: string, opts: { prompt: string; provider?: string; duration?: number }) => Promise<void>
  generateMusic: (sceneId: string, opts: { prompt: string; provider?: string; duration?: number }) => Promise<void>

  // Workspace management
  workspaces: import('../types').WorkspaceListItem[]
  activeWorkspaceId: string | null
  isLoadingWorkspaces: boolean
  fetchWorkspaces: () => Promise<void>
  createWorkspace: (name: string, opts?: { color?: string; icon?: string }) => Promise<string>
  updateWorkspace: (id: string, updates: Partial<import('../types').Workspace>) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setActiveWorkspace: (id: string | null) => void
  moveProjectToWorkspace: (projectId: string, workspaceId: string | null) => Promise<void>

  // Project management
  projectList: {
    id: string
    name: string
    updatedAt: string
    thumbnailUrl?: string
    outputMode?: string
    createdAt?: string
    workspaceId?: string | null
  }[]
  isLoadingProjects: boolean
  fetchProjectList: () => Promise<void>
  /** Create a new project. Under the EAGER draft model this always
   *  persists a real DB row with status='draft' immediately; `opts.draft` only
   *  controls UX shortcuts (e.g. the editor-pill mint skips the live list
   *  fetch). The startup sweep soft-hides untouched empties; first activity
   *  promotes the row to 'ready'. */
  createNewProject: (
    name?: string,
    aspectRatio?: import('../dimensions').AspectRatio,
    opts?: { draft?: boolean },
  ) => Promise<void>
  /** The branch currently shown in the timeline and main preview. null = default branch. */
  projectActiveBranchId: string | null
  /** The default (main) branch for this project — used to decide which tab ID to open. */
  projectDefaultBranchId: string | null
  /** In-flight branch operation — set at entry, cleared in finally. Prevents concurrent ops. */
  branchOperation: BranchOperation | null
  /** Set when a branch/conversation switch is blocked pending confirmation that
   *  it will abort a live agent run. The component renders a confirm
   *  dialog and re-invokes the switch with the confirmed flag. null = no gate. */
  branchSwitchNeedsConfirm: { kind: 'branch' | 'conversation'; targetId: string } | null
  /** Clear the confirm gate (user cancelled). */
  clearBranchSwitchConfirm: () => void
  /** Switch the editor to a different branch — reloads scenes from that branch.
   *  Awaits a pre-switch flush and blocks loudly on failure. When a
   *  live agent run is active it gates on confirmation unless confirmedAbortRun. */
  switchProjectBranch: (branchId: string, opts?: { confirmedAbortRun?: boolean }) => Promise<void>
  /** Re-load the active branch's scenes from the DB (e.g. after a history
   *  restore mutates them in place). switchProjectBranch no-ops on the active
   *  branch, so this is the way to force a refresh without switching. */
  reloadActiveBranch: () => Promise<void>
  /**
   * Promote a variant branch's content onto the target branch (default = main):
   * clones the winner's scenes with fresh ids, replaces the target's content via
   * an inverse-able agent/applyRun (Cmd+Z restores main's prior content), and
   * optionally discards the losing variant branches. Phase B of branch dispatch.
   */
  promoteBranch: (
    sourceBranchId: string,
    targetBranchId?: string | null,
    opts?: { discardBranchIds?: string[] },
  ) => Promise<void>
  /** Open/close the branch picker modal (shared across AgentChat + Editor). */
  branchPickerOpen: boolean
  setBranchPickerOpen: (v: boolean) => void
  /** Increment to invalidate useBranches cache after create/rename/delete. */
  branchListVersion: number
  incrementBranchListVersion: () => void
  /** Reload project row + scenes from API (e.g. after agent run when SSE may have dropped). */
  refreshProjectFromServer: () => Promise<void>
  /** Hydrate the branch-scoped proposal/handoff state (0015) for one branch. */
  loadBranchProposals: (projectId: string, branchId: string | null) => Promise<void>
  /** Persist one proposal field to the active branch's row (0015) and sync version. */
  persistBranchProposalField: (
    field: 'structuralCutsProposed' | 'pausedAgentRun' | 'runCheckpoint',
    value: unknown,
  ) => Promise<void>
  /** Clear all proposal/handoff state in the store (called before hydrating another branch). */
  resetBranchProposals: () => void
  loadProject: (projectId: string) => Promise<void>
  saveProjectToDb: () => Promise<void>
  /** INTERNAL — the unchained save body. Always call saveProjectToDb (the
   *  serialized wrapper); a direct call re-opens the concurrent-save
   *  crash-marker race the chain closes (TODOS item 8c). */
  _saveProjectToDbUnchained: () => Promise<void>
  scheduleSaveProjectToDb: () => void
  /** Synchronous-enqueue save for unload/visibilitychange AND the pre-switch
   *  flush. Skips the conflict roundtrip. Returns a Promise<{ ok }>
   *  so a branch/conversation switch can await it and block on failure; unload
   *  callers fire-and-forget. */
  flushSaveProjectToDb: () => Promise<{ ok: boolean }>
  deleteProjectFromDb: (projectId: string) => Promise<void>
  _dbLoadComplete: boolean
  _setDbLoadComplete: (v: boolean) => void
  _isDirty: boolean
  _lastDbLoadTimestamp: number

  // Font favorites (user preference, persisted to localStorage)
  favoriteFonts: string[]
  toggleFavoriteFont: (family: string) => void

  // Dev
  seedReactShowcaseScenes: () => Promise<void>
  seedCapabilityShowcaseScenes: () => Promise<void>
  seedThreeEnvironmentShowcaseScenes: () => Promise<void>

  // ── Model configuration ────────────────────────────────────────────────────
  modelConfigs: ModelConfig[]
  providerConfigs: ProviderConfig[]
  setModelConfigs: (configs: ModelConfig[]) => void
  toggleModelEnabled: (modelId: string) => void
  updateProviderConfig: (provider: string, updates: Partial<ProviderConfig>) => void
  addCustomModel: (config: ModelConfig) => void
  removeCustomModel: (modelId: string) => void

  // ── Inspector ──────────────────────────────────────────────────────────────
  inspectorSelectedElement: import('../types/elements').SceneElement | null
  inspectorSelectedLayerId: string | null
  inspectorElements: Record<string, import('../types/elements').SceneElement>
  inspectorPendingChanges: Record<string, Record<string, unknown>>
  selectInspectorElement: (element: import('../types/elements').SceneElement | null, layerId?: string | null) => void
  selectInspectorLayer: (layerId: string | null) => void
  setInspectorElements: (elements: Record<string, import('../types/elements').SceneElement>) => void
  patchInspectorElement: (elementId: string, property: string, value: unknown) => void
  clearInspector: () => void
  applyInspectorChanges: (sceneId: string) => Promise<void>
  agentEditContext: {
    type: 'element' | 'layer'
    elementId?: string
    elementType?: string
    layerId?: string
    sceneId?: string
    prompt?: string
    code?: string | null
    elementDefinition?: unknown
  } | null
  openAgentWithContext: (context: NonNullable<VideoStore['agentEditContext']>) => void
}
