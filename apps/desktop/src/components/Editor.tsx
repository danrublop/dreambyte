'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { usePersistedState } from '@/lib/hooks/use-persisted-state'
import { useViewScopedState } from '@/lib/hooks/use-view-scoped-state'
import { useVideoStore } from '@/lib/store'
import { createDefaultProject } from '@/lib/store/helpers'
import SceneList from './SceneList'
import { CommandPalette } from './CommandPalette'
import { ShortcutsHelpModal } from './ShortcutsHelpModal'
import { ChangelogHost } from './ChangelogHost'
import ProjectPanel from './ProjectPanel'
import WorkspaceView from './WorkspaceView'
import CustomizeView from './CustomizeView'
import PreviewPlayer from './PreviewPlayer'
import SceneEditor from './SceneEditor'
import ExportModal from './ExportModal'
import VariantComparisonModal from './branches/VariantComparisonModal'
import CrossProjectPickerModal from './cross-project/CrossProjectPickerModal'
import CrossProjectRunView from './cross-project/CrossProjectRunView'
import ExportPanel from './ExportPanel'
import PublishPanel from './PublishPanel'
import PermissionDialog from './PermissionDialog'
import EditorStatusBar from './EditorStatusBar'
import SettingsPanel from './SettingsPanel'
import VersionHistoryDrawer from './branches/VersionHistoryDrawer'
import { useRecordingBridge } from '@/hooks/useRecordingBridge'
import MediaLibrary from './MediaLibrary'
import CodeEditorTab from './code/CodeEditorTab'
import WelcomePageContent from './WelcomePage'
import LayersTab from './tabs/LayersTab'
import SceneLayersStackPanel from './layers/SceneLayersStackPanel'
import LayerStackPropertiesPanel from './layers/LayerStackPropertiesPanel'
import Timeline from './timeline'
import {
  Settings,
  PanelLeft,
  Plus,
  X,
  FolderOpen,
  Layers,
  Package2,
  Download,
  Globe,
  Loader2,
  Search,
  Briefcase,
  Film,
  Volume2,
  Type,
  Code2,
  GitBranch,
  Check,
  History,
  ArrowLeft,
} from 'lucide-react'
import { DreambyteLogo as AgentIcon } from './icons/DreambyteLogo'

function ChatIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 9V7.2C18 6.0799 18 5.51984 17.782 5.09202C17.5903 4.71569 17.2843 4.40973 16.908 4.21799C16.4802 4 15.9201 4 14.8 4H7.2C6.0799 4 5.51984 4 5.09202 4.21799C4.71569 4.40973 4.40973 4.71569 4.21799 5.09202C4 5.51984 4 6.0799 4 7.2V18L8 16M20 20L17.8062 18.5374C17.5065 18.3377 17.3567 18.2378 17.1946 18.167C17.0507 18.1042 16.9 18.0586 16.7454 18.031C16.5713 18 16.3912 18 16.0311 18H11.2C10.0799 18 9.51984 18 9.09202 17.782C8.71569 17.5903 8.40973 17.2843 8.21799 16.908C8 16.4802 8 15.9201 8 14.8V12.2C8 11.0799 8 10.5198 8.21799 10.092C8.40973 9.71569 8.71569 9.40973 9.09202 9.21799C9.51984 9 10.0799 9 11.2 9H16.8C17.9201 9 18.4802 9 18.908 9.21799C19.2843 9.40973 19.5903 9.71569 19.782 10.092C20 10.5198 20 11.0799 20 12.2V20Z" />
    </svg>
  )
}
import type { LayersStripTabId } from '@/lib/layers-strip-dock'
import {
  LAYERS_TAB_DRAG_TYPE,
  LAYERS_STRIP_TAB_LABELS,
  isLayersStripTabId,
  layersStripToCenterTabId,
  parseLayersStripCenterTabId,
} from '@/lib/layers-strip-dock'
import { useBranches } from '@/lib/hooks/use-branches'
import PreviewBranchButton from '@/components/branches/PreviewBranchButton'
import GitBranchesPanel from '@/components/branches/GitBranchesPanel'
import GitDiffViewer from '@/components/branches/GitDiffViewer'

function LayerDockTabIcon({ id, size = 14 }: { id: LayersStripTabId; size?: number }) {
  const p = { size, strokeWidth: 1.5 as const }
  switch (id) {
    case 'nodemap':
      return <Layers {...p} />
    case 'studio':
      return <Film {...p} />
    case 'audio':
      return <Volume2 {...p} />
    case 'text':
      return <Type {...p} />
    default:
      return <Layers {...p} />
  }
}
// Custom SVG icon for media tab
function MediaIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.1935 16.793C20.8437 19.2739 20.6689 20.5143 19.7717 21.2572C18.8745 22 17.5512 22 14.9046 22H9.09536C6.44881 22 5.12553 22 4.22834 21.2572C3.33115 20.5143 3.15626 19.2739 2.80648 16.793L2.38351 13.793C1.93748 10.6294 1.71447 9.04765 2.66232 8.02383C3.61017 7 5.29758 7 8.67239 7H15.3276C18.7024 7 20.3898 7 21.3377 8.02383C22.0865 8.83268 22.1045 9.98979 21.8592 12" />
      <path d="M19.5617 7C19.7904 5.69523 18.7863 4.5 17.4617 4.5H6.53788C5.21323 4.5 4.20922 5.69523 4.43784 7" />
      <path d="M17.4999 4.5C17.5283 4.24092 17.5425 4.11135 17.5427 4.00435C17.545 2.98072 16.7739 2.12064 15.7561 2.01142C15.6497 2 15.5194 2 15.2588 2H8.74099C8.48035 2 8.35002 2 8.24362 2.01142C7.22584 2.12064 6.45481 2.98072 6.45704 4.00434C6.45727 4.11135 6.47146 4.2409 6.49983 4.5" />
      <circle cx="16.5" cy="11.5" r="1.5" />
      <path d="M19.9999 20L17.1157 17.8514C16.1856 17.1586 14.8004 17.0896 13.7766 17.6851L13.5098 17.8403C12.7984 18.2542 11.8304 18.1848 11.2156 17.6758L7.37738 14.4989C6.6113 13.8648 5.38245 13.8309 4.5671 14.4214L3.24316 15.3803" />
    </svg>
  )
}

function PreviewIcon({ size = 16, strokeWidth = 1.5 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M10 8.5V15.5L16 12L10 8.5Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BranchPickerModal({
  branches,
  activeBranchId,
  onClose,
  onSelect,
}: {
  branches: import('@/types/dreambyte-api').BranchRecord[]
  activeBranchId: string | null
  onClose: () => void
  onSelect: (branchId: string) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = branches.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <>
      <div className="fixed inset-0 z-[9999] bg-transparent" onClick={onClose} />
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[10000] w-[min(480px,90vw)] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
          <GitBranch size={14} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search branches..."
            className="flex-1 bg-transparent border-none outline-none text-xs font-medium text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>
        <div className="px-1.5 pb-1.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)] px-3 pb-2">
          Branches
        </div>
        <div className="max-h-[280px] overflow-y-auto px-1.5 pb-2 custom-scrollbar">
          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">No branches found</p>
          )}
          {filtered.map((b) => {
            const isActive = b.id === activeBranchId || (activeBranchId === null && b.isDefault)
            return (
              <div
                key={b.id}
                onClick={() => onSelect(b.id)}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors rounded-md hover:bg-white/[0.08]"
              >
                <GitBranch size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-xs font-medium text-[var(--color-text-primary)] flex-1">{b.name}</span>
                {b.isDefault && (
                  <span className="text-[9px] text-[var(--color-text-muted)] opacity-60 uppercase tracking-wider font-bold">
                    default
                  </span>
                )}
                {isActive && <Check size={12} className="shrink-0 text-[var(--color-text-primary)]" />}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// The timeline can be resized but never fully collapsed — it always keeps at
// least this height (except in preview-fullscreen, which hides it on purpose).
const MIN_TIMELINE_HEIGHT = 140

export default function Editor({
  showWelcome,
  onEnterEditor,
  onGoHome,
  embedded,
}: {
  showWelcome?: boolean
  onEnterEditor?: () => void
  onGoHome?: () => void
  /**
   * When true, the editor renders inside the AppShell content
   * card. It drops `h-screen` (fills the slot), suppresses its own titlebar
   * (the shell header owns it), and hides its left scene/layer panel (the shell
   * sidebar hosts scenes/layers). Default false renders the standalone
   * full-screen layout.
   */
  embedded?: boolean
}) {
  const LEFT_RAIL_WIDTH = 52
  const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)
  const useElectronLayout = true
  // AppShell view switch: lets the editor titlebar flip back to the project's Chat view.
  const projectView = useVideoStore((s) => s.projectView)
  const setProjectView = useVideoStore((s) => s.setProjectView)
  // Bridge store-driven recording commands to the useScreenRecorder hook
  useRecordingBridge()
  const {
    scenes,
    addScene,
    updateScene,
    isExportModalOpen,
    openExportModal,
    openNewProjectModal,
    project,
    publishProject,
    showPublishPanel,
    setShowPublishPanel,
    publishedUrl,
    selectedSceneId,
    settingsTab,
    setSettingsTab,
    isPreviewFullscreen,
    rightPanelTab: rightPanelTabFromStore,
    setRightPanelTab: setRightPanelTabFromStore,
    projectLoadFailed,
    lastGenerationError,
    timelineHeight: timelineHeightFromStore,
    setTimelineHeight: setTimelineHeightFromStore,
    timelineTransport,
    centerTab,
    centerOpenTabs,
    setCenterTab,
    closeCenterTab,
    layersStripDragTabId,
    setLayersStripDragTabId,
    layersPanelRequestNonce,
    isExporting,
    lastExportStatus,
    branchPickerOpen,
    setBranchPickerOpen,
    switchProjectBranch,
    projectActiveBranchId,
  } = useVideoStore()

  // Trigger export — opens as a center tab in Electron, falls back to modal
  // in web layout. Centralized so both the Download button and command
  // palette stay in sync.
  const triggerExport = () => {
    if (project.outputMode !== 'mp4') {
      publishProject()
      return
    }
    if (useElectronLayout) {
      setCenterTab('export')
    } else {
      openExportModal()
    }
  }

  // Tier 2 file mirror — pick a folder, set, export.
  const runTier2Mirror = async () => {
    const tier2 = typeof window !== 'undefined' ? window.dreambyteApi?.tier2 : undefined
    if (!tier2 || !project?.id) return
    const picked = await tier2.pickFolder()
    if (picked.canceled || !picked.tier2Path) return
    try {
      await tier2.setPath({ projectId: project.id, tier2Path: picked.tier2Path })
      await tier2.export({ projectId: project.id })
    } catch (err) {
      console.error('[tier2] mirror failed', err)
    }
  }

  const runTier2Export = async () => {
    const tier2 = typeof window !== 'undefined' ? window.dreambyteApi?.tier2 : undefined
    if (!tier2 || !project?.id) return
    try {
      await tier2.export({ projectId: project.id })
    } catch (err) {
      console.error('[tier2] update failed — set a folder first via "Mirror project to folder…"', err)
    }
  }

  const runTier2Reveal = async () => {
    const tier2 = typeof window !== 'undefined' ? window.dreambyteApi?.tier2 : undefined
    if (!tier2 || !project?.id) return
    await tier2.revealInFinder({ projectId: project.id })
  }
  const [mounted, setMounted] = useState(false)
  const [isDraggingTimeline, setIsDraggingTimeline] = useState(false)
  const timelineDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const lastLayersPanelRequestNonceRef = useRef(0)
  const [leftWidth, setLeftWidth] = usePersistedState('dreambyte:ui:leftWidth', 260)
  const [rightWidth, setRightWidth] = usePersistedState('dreambyte:ui:rightWidth', 340)
  // In Electron, the 'welcome' center tab can be active while showWelcome is
  // still false (user navigated to it from within the editor). Treat both
  // cases as home mode so panel state resets to clean defaults either way.
  const isHomeView = !!showWelcome || centerTab === 'welcome'

  const branches = useBranches(project?.id)

  function parseBranchPreviewTabId(tabId: string): string | null {
    return tabId.startsWith('preview:') ? tabId.slice('preview:'.length) : null
  }

  // Editor-mode UI state is persisted; welcome-mode UI state is transient
  // and resets to clean defaults on every (re-)entry to the home view.
  const [persistedIsLeftCollapsed, setPersistedIsLeftCollapsed] = usePersistedState('dreambyte:ui:leftCollapsed', false)
  const [persistedShowProjectPanel, setPersistedShowProjectPanel] = usePersistedState(
    'dreambyte:ui:showProjectPanel',
    false,
  )
  const [persistedElectronLeftTab, setPersistedElectronLeftTab] = usePersistedState<'media' | 'layers'>(
    'dreambyte:ui:electronLeftTab',
    'layers',
  )
  const [persistedLastLeftPanel, setPersistedLastLeftPanel] = usePersistedState<'projects' | 'layers' | 'media'>(
    'dreambyte:ui:lastLeftPanel',
    'projects',
  )
  const [isLeftCollapsed, setIsLeftCollapsed] = useViewScopedState(
    isHomeView,
    persistedIsLeftCollapsed,
    setPersistedIsLeftCollapsed,
    true,
  )
  const [showProjectPanel, setShowProjectPanel] = useViewScopedState(
    isHomeView,
    persistedShowProjectPanel,
    setPersistedShowProjectPanel,
    false,
  )
  const [electronLeftTab, setElectronLeftTab] = useViewScopedState<'media' | 'layers'>(
    isHomeView,
    persistedElectronLeftTab,
    setPersistedElectronLeftTab,
    'layers',
  )
  const [lastLeftPanel, setLastLeftPanel] = useViewScopedState<'projects' | 'layers' | 'media'>(
    isHomeView,
    persistedLastLeftPanel,
    setPersistedLastLeftPanel,
    'projects',
  )
  // Command palette open state is lifted to the store so the
  // shell-scoped Search button and this view's Cmd+K drive one palette.
  const showCommandPalette = useVideoStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useVideoStore((s) => s.setCommandPaletteOpen)
  const setShowCommandPalette = (v: boolean | ((prev: boolean) => boolean)) =>
    setCommandPaletteOpen(typeof v === 'function' ? v(useVideoStore.getState().commandPaletteOpen) : v)
  const [showGitPanel, setShowGitPanel] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false) // T17
  const showSettings = settingsTab !== null
  const selectedScene = scenes.find((s) => s.id === selectedSceneId)
  // A scene-LESS project can still hold dropped media/audio CLIPS. When it does, the
  // Layers panel shows the standalone-clip stack (+ clip inspector) instead of the
  // "No scenes yet" placeholder, so dropped footage is visible and gradable.
  const layerStackPropertiesKey = useVideoStore((s) => s.layerStackPropertiesKey)
  const hasStandaloneClips = useVideoStore((s) =>
    (s.project.timeline?.tracks ?? []).some((t) =>
      t.clips.some(
        (c) =>
          c.sourceType === 'video' ||
          c.sourceType === 'image' ||
          (c.sourceType === 'audio' && !/^(aud-|tts-|mus-)/.test(c.sourceId)),
      ),
    ),
  )

  // Timeline / agent panel — view-scoped: editor uses the persisted store
  // value (so refresh resumes the user's layout); welcome always starts
  // closed and toggles there don't leak into the editor.
  const [timelineHeight, setTimelineHeight] = useViewScopedState(
    isHomeView,
    timelineHeightFromStore,
    setTimelineHeightFromStore,
    0,
  )
  const [rightPanelTab, setRightPanelTab] = useViewScopedState<'prompt' | 'layers' | 'media' | 'inspector' | null>(
    isHomeView,
    rightPanelTabFromStore,
    setRightPanelTabFromStore,
    null,
  )

  // In the electron layout, Settings opens as a center tab — it doesn't
  // need the side panel. Only force the sidebar open in the legacy
  // non-electron layout where Settings does live in the side panel.
  const wantsLeftPanelOpen = showSettings && !useElectronLayout
  // Floor the timeline height so it can't be fully closed — except in
  // fullscreen, where the preview intentionally hides it (height 0).
  const effectiveTimelineHeight = isPreviewFullscreen ? timelineHeight : Math.max(timelineHeight, MIN_TIMELINE_HEIGHT)
  const effectiveRightPanelTab = rightPanelTab
  // Auto-expand only when a panel is explicitly wanted by another action.
  // Pane selection (Projects/Layers/Media) does not force-pin the sidebar,
  // so the toggle button can always close it.
  const effectiveIsLeftCollapsed = wantsLeftPanelOpen ? false : isLeftCollapsed

  const showLeftPane = useCallback(
    (pane: 'projects' | 'layers' | 'media') => {
      setLastLeftPanel(pane)
      setIsLeftCollapsed(false)
      setSettingsTab(null)
      if (pane === 'projects') {
        setShowProjectPanel(true)
      } else {
        setShowProjectPanel(false)
        setElectronLeftTab(pane)
      }
    },
    [setElectronLeftTab, setIsLeftCollapsed, setLastLeftPanel, setSettingsTab, setShowProjectPanel],
  )

  const toggleSidebar = () => {
    if (effectiveIsLeftCollapsed) {
      showLeftPane(lastLeftPanel)
    } else {
      setIsLeftCollapsed(true)
    }
  }

  useEffect(() => {
    if (layersPanelRequestNonce === 0) return
    if (lastLayersPanelRequestNonceRef.current === layersPanelRequestNonce) return
    lastLayersPanelRequestNonceRef.current = layersPanelRequestNonce
    if (isHomeView) return
    if (useElectronLayout) {
      showLeftPane('layers')
    } else {
      setRightPanelTab('layers')
    }
  }, [layersPanelRequestNonce, setRightPanelTab, showLeftPane, useElectronLayout, isHomeView])

  // Ensure async video clips finish even when the agent (or a prior session) started
  // them. The agent inserts a 'generating' veo3 layer + operationName but never runs a
  // renderer poll; loadProject rehydrates 'generating' layers after a reload. This walks
  // the current scenes and starts a poll loop for any generating clip that lacks one
  // (dedup is handled inside pollVeo3Status). Firing on every scenes change is cheap and
  // idempotent. Without it, agent-generated clips spin forever — the Phase-1 demo-killer.
  const reconcilePendingVideoPolls = useVideoStore((s) => s.reconcilePendingVideoPolls)
  const reconcilePendingAvatarPolls = useVideoStore((s) => s.reconcilePendingAvatarPolls)
  useEffect(() => {
    reconcilePendingVideoPolls()
    // Same for HeyGen avatars: a wedged render gets a durable 15-min deadline instead of
    // sitting 'processing' forever once the agent run ends.
    reconcilePendingAvatarPolls()
  }, [scenes, reconcilePendingVideoPolls, reconcilePendingAvatarPolls])

  // Reactive generation jobs: subscribe ONCE to the main-process generation runner's status
  // push (`dreambyte:generation.update`). When the runner finalizes a job, this lands the finished
  // asset on the timeline immediately — no agent polling, and faster than waiting for the next
  // reconcile tick. The store action is idempotent with the reconcile poll (whichever resolves the
  // layer first wins), so this is purely additive.
  const applyGenerationUpdate = useVideoStore((s) => s.applyGenerationUpdate)
  useEffect(() => {
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
    if (!ipc?.onUpdate) return
    const unsubscribe = ipc.onUpdate((update) => applyGenerationUpdate(update))
    return unsubscribe
  }, [applyGenerationUpdate])

  // Window-level file drop fallback. The timeline accepts file drops
  // directly, but it's a ~200px strip at the bottom of the editor. Drops
  // anywhere else in the editor would otherwise be silently rejected. This
  // effect adds a full-window catcher so the user can drop on the preview,
  // the right rail, or the project panel and still have the file land on
  // the timeline.
  const [windowDropError, setWindowDropError] = useState<string | null>(null)
  useEffect(() => {
    if (showWelcome) return
    const isFileDragEvt = (e: DragEvent): boolean => {
      const dt = e.dataTransfer
      if (!dt) return false
      const types = dt.types ? Array.from(dt.types) : []
      if (types.some((t) => t === 'Files' || t === 'application/x-moz-file')) return true
      if (dt.items && dt.items.length > 0) {
        for (let i = 0; i < dt.items.length; i++) {
          if (dt.items[i].kind === 'file') return true
        }
      }
      return false
    }
    const onOver = (e: DragEvent) => {
      if (!isFileDragEvt(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = async (e: DragEvent) => {
      if (!isFileDragEvt(e)) return
      // This window listener is the CATCH-ALL for files dropped on editor chrome
      // OUTSIDE the timeline. If a more specific React handler already took the drop
      // (the timeline's onDrop calls preventDefault before the event bubbles to
      // window), `defaultPrevented` is set — bail so the file isn't imported TWICE.
      if (e.defaultPrevented) return
      e.preventDefault()
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : []
      if (files.length === 0) return
      // Lazy-import so the helper isn't part of the editor's initial chunk.
      const { importFilesToTimeline } = await import('@/lib/utils/timeline-import')
      await importFilesToTimeline(files, (msg) => setWindowDropError(msg))
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [showWelcome])
  // Auto-dismiss window-level error toast.
  useEffect(() => {
    if (!windowDropError) return
    const t = window.setTimeout(() => setWindowDropError(null), 4000)
    return () => window.clearTimeout(t)
  }, [windowDropError])

  // Inject the 'welcome' center tab when we land on the home view. The
  // *cleanup* path (welcome → editor) is owned by loadProject /
  // createNewProject in the store — those actions reset centerOpenTabs to
  // ['preview'] atomically with the project change, so there's no separate
  // effect to race against the projectId flip.
  useEffect(() => {
    if (!showWelcome) return
    const s = useVideoStore.getState()
    if (s.centerOpenTabs.includes('welcome')) return
    useVideoStore.setState({
      centerOpenTabs: ['welcome', ...s.centerOpenTabs.filter((t) => t !== 'preview')],
      centerTab: 'welcome',
    })
  }, [showWelcome])

  // In Electron, navigating to the welcome center tab from within the editor
  // (e.g. clicking the home tab) bypasses onGoHome(), so the persisted appView
  // stays 'project' and a refresh sends the user back to the project. Detect
  // this and trigger the proper home transition so the persisted view stays
  // in sync.
  useEffect(() => {
    if (centerTab === 'welcome' && !showWelcome) {
      onGoHome?.()
    }
  }, [centerTab, showWelcome, onGoHome])

  // Welcome → editor transition. The home view shows a fresh in-memory
  // draft project. Two events promote it to a real, opened project:
  //   1. Adding a scene (anything that lands on the timeline). The draft
  //      gets a unique name and is committed to the DB.
  //   2. Loading or creating a different project (project.id changes —
  //      handled by the Projects panel and New Project modal).
  // Baselines are captured after the initial DB load so a reload doesn't
  // trigger a false transition before the user has done anything.
  const dbLoadComplete = useVideoStore((s) => s._dbLoadComplete)
  const baselineProjectIdRef = useRef<string | null>(null)
  const baselineSceneCountRef = useRef<number | null>(null)
  const transitionInFlightRef = useRef(false)

  // Editor → home transition. When the user returns to the home view from a
  // project (Cmd+Shift+H), the persisted project's scenes / id are still
  // sitting in the store from the editor session. Reset to a fresh draft so
  // the home view starts clean, and re-baseline the transition refs so the
  // next "add scene" can promote a brand new project. The very first mount
  // is handled by loadInitialProject — skip it here to avoid double-write.
  const isFirstWelcomeEnterRef = useRef(true)
  useEffect(() => {
    if (!showWelcome) {
      isFirstWelcomeEnterRef.current = false
      return
    }
    if (isFirstWelcomeEnterRef.current) {
      isFirstWelcomeEnterRef.current = false
      return
    }
    useVideoStore.setState({
      project: createDefaultProject([]),
      scenes: [],
      selectedSceneId: null,
    })
    baselineProjectIdRef.current = useVideoStore.getState().project?.id ?? null
    baselineSceneCountRef.current = 0
    transitionInFlightRef.current = false
  }, [showWelcome])
  useEffect(() => {
    if (!dbLoadComplete) return
    if (baselineProjectIdRef.current === null) {
      baselineProjectIdRef.current = project?.id ?? null
      baselineSceneCountRef.current = scenes.length
      return
    }
    if (!showWelcome) return
    if (transitionInFlightRef.current) return
    if (project?.id && project.id !== baselineProjectIdRef.current) {
      onEnterEditor?.()
      return
    }
    if (scenes.length > (baselineSceneCountRef.current ?? 0)) {
      transitionInFlightRef.current = true
      void (async () => {
        try {
          // Auto-name the new project so it doesn't collide with existing
          // "Untitled Project N" rows.
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          let name = 'Untitled Project'
          if (ipc) {
            try {
              const raw = (await ipc.list()) as unknown
              const list = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] })?.items ?? [])
              const existing = new Set((list as Array<{ name: string }>).map((p) => p.name))
              let n = 1
              while (existing.has(`Untitled Project ${n}`)) n++
              name = `Untitled Project ${n}`
            } catch {
              /* fall back to plain "Untitled Project" */
            }
          }
          useVideoStore.getState().updateProject({ name })
          await useVideoStore.getState().saveProjectToDb()
        } finally {
          transitionInFlightRef.current = false
          onEnterEditor?.()
        }
      })()
    }
  }, [dbLoadComplete, showWelcome, project?.id, scenes.length, onEnterEditor])

  const panelDrag = useRef<{
    side: 'left' | 'right'
    startX: number
    startW: number
  } | null>(null)
  const [isDraggingPanel, setIsDraggingPanel] = useState(false)
  const showSettingsRef = useRef(showSettings)
  const electronLeftTabRef = useRef(electronLeftTab)
  showSettingsRef.current = showSettings
  electronLeftTabRef.current = electronLeftTab

  // Cmd+K to open command palette; Cmd+Shift+H to return to the home view.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette((v) => !v)
        return
      }
      // Cmd+S — manual save flush. Browsers map Cmd+S to "save page"; we
      // preventDefault and trigger the project flush. The save status enum
      // (idle/saving/saved/error) drives the visible SceneSaveStatusIndicator,
      // so the user sees Saving… → Saved (or Save failed) without a new widget.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        if (!showWelcome) void useVideoStore.getState().flushSaveProjectToDb()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault()
        if (!showWelcome) onGoHome?.()
        return
      }
      // "?" — open the keyboard shortcuts help sheet. Guard against typing
      // (the only unmodified-key shortcut wired at this global level), matching
      // the input-focus guards on the preview/timeline handlers.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null
        const typing =
          t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable === true
        if (typing) return
        e.preventDefault()
        setShowShortcutsHelp(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showWelcome, onGoHome])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = panelDrag.current
      if (!d) return
      e.preventDefault()
      const dx = e.clientX - d.startX
      if (d.side === 'left') {
        const minW = showSettingsRef.current ? 240 : 140
        setLeftWidth(Math.max(minW, Math.min(520, d.startW + dx)))
      } else if (d.side === 'right') {
        setRightWidth(Math.max(340, Math.min(600, d.startW - dx)))
      }
    }
    const onUp = () => {
      if (!panelDrag.current) return
      panelDrag.current = null
      setIsDraggingPanel(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Timeline resize drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = timelineDragRef.current
      if (!d) return
      e.preventDefault()
      setTimelineHeight(
        Math.max(
          MIN_TIMELINE_HEIGHT,
          Math.min(Math.round(window.innerHeight * 0.75), d.startH + (d.startY - e.clientY)),
        ),
      )
    }
    const onUp = () => {
      if (!timelineDragRef.current) return
      timelineDragRef.current = null
      setIsDraggingTimeline(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setTimelineHeight])

  useEffect(() => {
    if (showSettings && !useElectronLayout) {
      setIsLeftCollapsed(false)
      if (leftWidth < 240) {
        setLeftWidth(240)
      }
    }
  }, [showSettings, useElectronLayout, electronLeftTab, leftWidth])

  const startPanelDrag = (e: React.MouseEvent, side: 'left' | 'right') => {
    e.preventDefault()
    panelDrag.current = {
      side,
      startX: e.clientX,
      startW: side === 'left' ? leftWidth : rightWidth,
    }
    setIsDraggingPanel(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const { saveProjectToDb, flushSaveProjectToDb, loadProject, projectList } = useVideoStore()
  const projectSaveStatus = useVideoStore((s) => s.projectSaveStatus)
  const projectSaveError = useVideoStore((s) => s.projectSaveError)

  // Autosave-failure toast. The inline SceneSaveStatusIndicator already
  // shows "Save failed" with a retry, but a silent autosave failure is easy to
  // miss — surface it once per error edge via the app's existing sonner toaster
  // (reusing the pattern in PreviewPlayer/Timeline; no new toast library). The
  // ref de-dupes so a status that stays 'error' across renders toasts only once.
  const lastSaveErrorToastRef = useRef<string | null>(null)
  useEffect(() => {
    if (projectSaveStatus === 'error') {
      const msg = projectSaveError ?? 'Project save failed'
      if (lastSaveErrorToastRef.current !== msg) {
        lastSaveErrorToastRef.current = msg
        toast.error('Couldn’t save your changes', {
          description: msg,
          action: { label: 'Retry', onClick: () => void saveProjectToDb() },
        })
      }
    } else if (projectSaveStatus === 'saved') {
      // Reset so the next failure (even with the same message) toasts again.
      lastSaveErrorToastRef.current = null
    }
  }, [projectSaveStatus, projectSaveError, saveProjectToDb])

  useEffect(() => {
    setMounted(true)
    // Prefer the project id from persisted Zustand state so we don't swap to a different
    // "most recent" list item and lose agent-written scenes in the DB for this project.
    // On the welcome screen (no persisted project), don't auto-load list[0] — the user
    // is on the home view and should choose a project explicitly.
    const loadInitialProject = async () => {
      // Welcome: discard any persisted project state and start with a clean
      // in-memory draft. The user can preview/scrub/play with the empty
      // timeline; only when they add their first scene does the draft get
      // committed to the DB as a real project (see scene-count effect).
      // Panel chrome (timeline height, agent visibility, sidebar collapse)
      // is owned by the user's persisted preferences — don't reset them
      // here, otherwise toggling on welcome wouldn't survive a refresh.
      if (showWelcome) {
        useVideoStore.setState({
          project: createDefaultProject([]),
          scenes: [],
          selectedSceneId: null,
        })
        try {
          await useVideoStore.getState().fetchProjectList()
        } catch {
          /* keep going; recent list will just be empty */
        }
        useVideoStore.getState()._setDbLoadComplete(true)
        return
      }
      // Eager draft model: a persisted project id always has a real DB row
      // (status='draft' or 'ready'), so there is no in-memory-only draft to
      // reconcile here — fall straight through to the normal load below.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const persistedId = useVideoStore.getState().project?.id
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw: any = ipc ? await ipc.list() : []
          const list: { id: string }[] = Array.isArray(raw) ? raw : (raw?.items ?? [])
          if (list.length === 0) {
            // A soft-hidden (swept) project is excluded from list() but still
            // loadable — and loading it un-hides it (promoteDraftToReady in
            // ipc.get). NEVER strand a persisted project in localStorage-only
            // mode: its rebuilt-empty timeline would autosave over the DB.
            if (persistedId) {
              await useVideoStore.getState().loadProject(persistedId)
              if (useVideoStore.getState()._dbLoadComplete) return
            }
            useVideoStore.getState()._setDbLoadComplete(true)
            return
          }
          if (!persistedId) {
            // No persisted project — stay on welcome and just hydrate the list.
            await useVideoStore.getState().fetchProjectList()
            useVideoStore.getState()._setDbLoadComplete(true)
            return
          }
          const ids = new Set(list.map((p: { id: string }) => p.id))
          const targetId = ids.has(persistedId) ? persistedId : list[0].id
          await useVideoStore.getState().loadProject(targetId)
          if (useVideoStore.getState()._dbLoadComplete) return
        } catch {
          // fetch itself failed
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000))
      }
      console.warn('Failed to load project from DB after 3 attempts — auto-save disabled until next successful load')
      useVideoStore.setState({ projectLoadFailed: true })
    }
    loadInitialProject()
  }, [])

  // Safety-net auto-save: every 30s. Timeline edits already persist within
  // ~1.5s via scheduleSaveProjectToDb; this poll covers other mutations that
  // don't go through that path and acts as a last line of defense.
  useEffect(() => {
    if (!mounted) return
    const interval = setInterval(async () => {
      const state = useVideoStore.getState()
      if (state.projectLoadFailed && !state._dbLoadComplete && state.project?.id) {
        // Attempt to recover from load failure. In the packaged Electron app
        // there's no HTTP server to ping, so route the reachability check
        // through the IPC `projects.get`. Web build keeps the HEAD probe.
        try {
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
          let reachable = false
          if (ipc) {
            const row = await ipc.get(state.project.id)
            reachable = !!row
          }
          if (reachable) {
            useVideoStore.setState({ _dbLoadComplete: true, projectLoadFailed: false })
            console.log('[Editor] Server reachable — auto-save re-enabled')
          }
        } catch {
          /* still offline */
        }
        return
      }
      saveProjectToDb()
    }, 30000)
    return () => clearInterval(interval)
  }, [mounted, saveProjectToDb])

  // Save on unload. We use flushSaveProjectToDb (fire-and-forget) instead of
  // saveProjectToDb because the latter awaits a conflict-resolution roundtrip
  // (ipc.get) that doesn't complete during Cmd+R reload — the renderer
  // navigates before the await resolves and the subsequent ipc.update never
  // gets queued. flushSaveProjectToDb queues the update IPC synchronously so
  // main writes to SQLite regardless of what the renderer does next.
  //
  // We listen on three events because they cover different scenarios:
  //   pagehide        — Cmd+R reload, in-app navigation (most reliable)
  //   beforeunload    — same as pagehide, kept for older Electron/Chromium
  //   visibilitychange (→ hidden) — Cmd+Q quit, Cmd+H hide, Cmd+Tab away
  useEffect(() => {
    if (!mounted) return
    const flush = () => flushSaveProjectToDb()
    const visibilityFlush = () => {
      if (document.visibilityState === 'hidden') flushSaveProjectToDb()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', visibilityFlush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', visibilityFlush)
    }
  }, [mounted, flushSaveProjectToDb])

  // Stale-thumbnail cleanup on mount. Deliberately does NOT auto-add a scene
  // when the timeline is empty: an empty timeline is a supported state, and a
  // user-source scene/create here would promote pristine DRAFT projects to
  // saved ones (defeating lazy persistence) and orphan action_log rows for
  // projects with no DB row yet.
  useEffect(() => {
    if (!mounted) return
    if (showWelcome) return
    scenes.forEach((scene) => {
      if (!scene.svgContent && scene.thumbnail) {
        updateScene(scene.id, { thumbnail: null })
      }
    })
  }, [mounted, showWelcome])

  if (!mounted) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--color-bg)]">
        <div className="flex items-center gap-2 text-[var(--color-text-muted)] animate-pulse">
          <span className="text-sm">loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col ${embedded ? 'h-full' : 'h-screen'} bg-[var(--color-bg)] text-[var(--color-text-primary)] [font-family:var(--font-ui)] overflow-hidden relative`}
      style={{ zoom: 'var(--ui-zoom, 1)' }}
    >
      {/* File dropped anywhere on editor chrome still lands on the timeline via
          the window catch-all listener — but with no dashed overlay. The timeline
          shows its own insertion line for precise placement. */}
      {windowDropError && (
        <div
          className="absolute top-0 left-0 right-0 z-[9001] flex items-center justify-between px-3 py-1.5 text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-panel))',
            color: 'var(--color-text-primary)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span>{windowDropError}</span>
          <span
            onClick={() => setWindowDropError(null)}
            className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] ml-3"
          >
            Dismiss
          </span>
        </div>
      )}
      {projectLoadFailed && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-sm shrink-0">
          <span>Could not connect to server. Changes won't be saved.</span>
          <span
            className="underline cursor-pointer hover:text-red-300"
            onClick={async () => {
              useVideoStore.setState({ projectLoadFailed: false })
              const persistedId = useVideoStore.getState().project?.id
              try {
                const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const raw: any = ipc ? await ipc.list() : []
                const list: { id: string }[] = Array.isArray(raw) ? raw : (raw?.items ?? [])
                if (list.length > 0) {
                  const ids = new Set(list.map((p: { id: string }) => p.id))
                  const targetId = persistedId && ids.has(persistedId) ? persistedId : list[0].id
                  await useVideoStore.getState().loadProject(targetId)
                } else {
                  useVideoStore.getState()._setDbLoadComplete(true)
                }
              } catch {
                useVideoStore.setState({ projectLoadFailed: true })
              }
            }}
          >
            Retry
          </span>
        </div>
      )}
      {lastGenerationError && (
        <div className="flex items-center justify-between px-4 py-2 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-sm shrink-0">
          <span>Generation failed: {lastGenerationError}</span>
          <span
            className="underline cursor-pointer hover:text-orange-300"
            onClick={() => useVideoStore.setState({ lastGenerationError: null })}
          >
            Dismiss
          </span>
        </div>
      )}
      {useElectronLayout && !embedded && (
        <header
          className={`h-12 border-b-[1.5px] border-[var(--color-border)] bg-[var(--color-panel)] grid grid-cols-[auto_1fr_auto] items-center px-3 gap-2 ${isElectron ? 'pl-20' : 'pl-3'}`}
          style={{
            color: 'var(--color-text-muted)',
            ...(isElectron ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : {}),
          }}
        >
          <div className="w-8 h-8" />
          <div
            className="justify-self-center flex min-w-0 max-w-[min(60vw,360px)] items-center justify-center gap-2 px-2 h-full"
            style={isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
          >
            <button
              type="button"
              onClick={() => setShowCommandPalette(true)}
              className="no-style flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.06] hover:text-[var(--color-text-primary)]"
              aria-label="Search"
              data-tooltip="Search"
              style={isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
            >
              <Search size={18} strokeWidth={2} />
            </button>
            <span
              className="min-w-0 truncate text-sm font-normal text-[var(--color-text-muted)]"
              title={showWelcome ? 'Dreambyte' : project?.name?.trim() || 'Untitled project'}
            >
              {showWelcome ? 'Dreambyte' : project?.name?.trim() || 'Untitled project'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 justify-self-end">
            <div
              className="inline-flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] p-0.5"
              style={{
                background: 'var(--color-input-bg)',
                ...(isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : {}),
              }}
            >
              {(['chat', 'editor'] as const).map((v) => {
                const sel = projectView === v
                return (
                  <button
                    key={v}
                    onClick={() => setProjectView(v)}
                    className="no-style"
                    style={{
                      height: 24,
                      padding: '0 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      border: 'none',
                      borderRadius: 'calc(var(--radius-md) - 2px)',
                      cursor: 'pointer',
                      background: sel ? 'var(--color-panel)' : 'transparent',
                      color: sel ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                    }}
                  >
                    {v === 'chat' ? 'Chat' : 'Editor'}
                  </button>
                )
              })}
            </div>
            {useElectronLayout && (
              <PreviewBranchButton
                branches={branches}
                openTabIds={centerOpenTabs}
                activeTabId={centerTab}
                isElectron={!!isElectron}
                onSelectBranch={(branchId) => {
                  // Same guard problem as onOpenDefault: if this branch is already
                  // active, switchProjectBranch early-returns and never (re)opens
                  // its preview tab. Open it directly in that case.
                  if (projectActiveBranchId === branchId) {
                    const b = branches.find((x) => x.id === branchId)
                    setCenterTab(b?.isDefault ? 'preview' : (`preview:${branchId}` as const))
                  } else {
                    switchProjectBranch(branchId)
                  }
                }}
                onOpenDefault={() => {
                  // switchProjectBranch opens+activates the preview tab as a side
                  // effect, but early-returns when we're ALREADY on that branch —
                  // so when the preview tab was closed on the default branch it
                  // would never reopen. Open it directly in that case.
                  const defBranch = branches.find((b) => b.isDefault)
                  if (defBranch && projectActiveBranchId !== defBranch.id) {
                    switchProjectBranch(defBranch.id)
                  } else {
                    setCenterTab('preview')
                  }
                }}
              />
            )}
            <button
              onClick={() => setRightPanelTab(rightPanelTab === 'prompt' ? null : 'prompt')}
              className={`${useElectronLayout ? 'no-style electron-titlebar-icon' : 'kbd'} w-8 h-8 rounded-md flex items-center justify-center transition-colors`}
              data-tooltip="Agent"
              style={isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
            >
              <ChatIcon size={22} />
            </button>
            <button
              onClick={() => {
                if (useElectronLayout) {
                  if (!centerOpenTabs.includes('settings')) {
                    setCenterTab('settings')
                    setSettingsTab('general')
                  } else if (centerTab === 'settings') {
                    setCenterTab('preview')
                  } else {
                    setCenterTab('settings')
                  }
                  return
                }
                setSettingsTab(showSettings ? null : 'general')
                if (!showSettings) setShowProjectPanel(false)
              }}
              className={`${useElectronLayout ? 'no-style electron-titlebar-icon' : 'kbd'} w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors`}
              data-tooltip="Settings"
              style={isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
            >
              <Settings size={20} strokeWidth={1.5} />
            </button>
          </div>
        </header>
      )}

      {/* Main layout: left+center column beside right panel */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Drag overlay — prevents iframes from stealing mouse events during resize */}
        {isDraggingPanel && <div className="fixed inset-0 z-[9999]" style={{ cursor: 'col-resize' }} />}
        {isDraggingTimeline && <div className="fixed inset-0 z-[9999]" style={{ cursor: 'row-resize' }} />}

        {/* Left + Center column (timeline spans full width of this column) */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Upper area: left panel + preview */}
          <div className="flex flex-1 overflow-hidden relative min-h-0">
            {/* Left — Scene List */}
            <div
              className={`flex-shrink-0 border-r-[1.5px] border-[var(--color-border)] bg-[var(--color-panel)] flex transition-all duration-200 ease-in-out relative z-[101] ${
                isPreviewFullscreen || embedded ? 'overflow-hidden' : ''
              }`}
              style={{
                width:
                  isPreviewFullscreen || embedded
                    ? 0
                    : effectiveIsLeftCollapsed
                      ? LEFT_RAIL_WIDTH
                      : LEFT_RAIL_WIDTH + leftWidth,
                visibility: isPreviewFullscreen || embedded ? 'hidden' : 'visible',
              }}
            >
              <div
                className={`w-[52px] shrink-0 flex flex-col items-center py-2 gap-1 ${
                  effectiveIsLeftCollapsed ? '' : 'border-r-[1.5px] border-[var(--color-border)]'
                }`}
              >
                {useElectronLayout && (
                  <>
                    <button
                      onClick={toggleSidebar}
                      className={`no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                        effectiveIsLeftCollapsed ? 'text-[var(--color-accent)] electron-titlebar-icon-active' : ''
                      }`}
                      data-tooltip={effectiveIsLeftCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <PanelLeft size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => showLeftPane('projects')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Projects"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <FolderOpen size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => showLeftPane('layers')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Scenes & layers"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <Layers size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => setCenterTab('media')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Library"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <MediaIcon size={19} />
                    </button>
                    <button
                      onClick={triggerExport}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip={project.outputMode === 'mp4' ? 'Export' : 'Publish'}
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      {project.outputMode === 'mp4' ? (
                        <Download size={19} strokeWidth={1.5} />
                      ) : (
                        <Globe size={19} strokeWidth={1.5} />
                      )}
                    </button>
                    <button
                      onClick={() => setCenterTab('workspace')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Workspaces"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <Package2 size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => setCenterTab('customize')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Customize"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <Briefcase size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => setCenterTab('history')}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="Version history"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <History size={19} strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={openNewProjectModal}
                      className="no-style electron-titlebar-icon w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors"
                      data-tooltip="New Project"
                      data-tooltip-pos="right"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    >
                      <Plus size={19} strokeWidth={1.5} />
                    </button>
                  </>
                )}
              </div>

              {!effectiveIsLeftCollapsed && (
                <div className="flex-1 min-w-0 relative flex flex-col overflow-hidden">
                  {!useElectronLayout && (
                    <div className="h-12 flex-shrink-0 flex justify-between gap-2 items-center px-3">
                      <div className="flex gap-2 flex-row items-center flex-1">
                        <button
                          onClick={() => setIsLeftCollapsed(!isLeftCollapsed)}
                          data-tooltip={isLeftCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
                          data-tooltip-pos={isLeftCollapsed ? 'right' : 'bottom-right'}
                          className="kbd w-8 h-8 p-0 flex items-center justify-center shrink-0"
                        >
                          <PanelLeft size={17} style={{ color: 'var(--kbd-text)' }} />
                        </button>

                        <button
                          onClick={() => {
                            setShowProjectPanel(!showProjectPanel)
                            if (!showProjectPanel) setSettingsTab(null)
                          }}
                          className={`kbd w-8 h-8 p-0 flex items-center justify-center shrink-0 transition-all duration-200 ${showProjectPanel ? 'border-[var(--color-accent)]' : ''}`}
                          data-tooltip="Projects"
                          data-tooltip-pos={isLeftCollapsed ? 'right' : 'bottom'}
                        >
                          <FolderOpen size={17} style={{ color: 'var(--kbd-text)' }} />
                        </button>

                        <button
                          onClick={() => {
                            setSettingsTab(showSettings ? null : 'general')
                            if (!showSettings) setShowProjectPanel(false)
                          }}
                          className={`kbd w-7 h-7 p-0 flex items-center justify-center shrink-0 transition-all duration-200 ${showSettings ? 'border-[var(--color-accent)]' : ''}`}
                          data-tooltip="Settings"
                          data-tooltip-pos={isLeftCollapsed ? 'right' : 'bottom'}
                        >
                          <Settings size={15} style={{ color: 'var(--kbd-text)' }} />
                        </button>

                        <button
                          onClick={() => {
                            if (showSettings) {
                              setSettingsTab(null)
                            } else if (showProjectPanel) {
                              setShowProjectPanel(false)
                            } else {
                              addScene()
                            }
                          }}
                          className={`kbd h-7 !py-0 gap-2 text-sm font-medium shadow-black/40 transition-all duration-200 relative flex items-center justify-center overflow-hidden ${
                            isLeftCollapsed ? 'w-7 px-0 cursor-copy' : 'flex-1 px-3'
                          }`}
                          {...(isLeftCollapsed
                            ? {
                                'data-tooltip': showSettings || showProjectPanel ? 'Close' : 'New Scene',
                                'data-tooltip-pos': 'right',
                              }
                            : {})}
                        >
                          {isLeftCollapsed &&
                            (showSettings || showProjectPanel ? (
                              <X size={14} className="flex-shrink-0" />
                            ) : (
                              <Plus size={14} className="flex-shrink-0" />
                            ))}
                          <span
                            className={`whitespace-nowrap overflow-hidden ${isLeftCollapsed ? 'hidden' : 'inline'}`}
                          >
                            {showSettings || showProjectPanel ? 'Close' : 'New Scene'}
                          </span>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex-1 overflow-hidden relative">
                    {showProjectPanel && !effectiveIsLeftCollapsed ? (
                      <ProjectPanel
                        onClose={() => setShowProjectPanel(false)}
                        homeMode={showWelcome}
                        onProjectOpened={showWelcome ? () => onEnterEditor?.() : undefined}
                      />
                    ) : useElectronLayout && electronLeftTab === 'layers' ? (
                      scenes.length === 0 ? (
                        hasStandaloneClips ? (
                          // Scene-less project with dropped media/audio clips: show the
                          // standalone-clip stack + clip inspector (master-detail), so the
                          // clips are visible and gradable without a scene wrapper.
                          <div className="flex min-h-0 h-full flex-col overflow-hidden">
                            {layerStackPropertiesKey ? (
                              <div className="min-h-0 flex-1 overflow-y-auto">
                                <LayerStackPropertiesPanel />
                              </div>
                            ) : (
                              <SceneLayersStackPanel fillAvailableHeight />
                            )}
                          </div>
                        ) : (
                          <div className="flex min-h-0 h-full flex-col gap-2 overflow-hidden p-3">
                            <button
                              type="button"
                              onClick={() => addScene()}
                              className="kbd flex h-8 w-full items-center justify-center gap-2 px-3 text-sm font-medium shadow-black/40"
                            >
                              <Plus size={14} strokeWidth={1.5} />
                              New Scene
                            </button>
                            <p className="text-center text-[11px] text-[var(--color-text-muted)]">No scenes yet.</p>
                          </div>
                        )
                      ) : (
                        <div className="flex min-h-0 h-full flex-col overflow-hidden">
                          <LayersTab
                            scene={selectedScene ?? scenes[0]!}
                            showScenesSection
                            isLeftCollapsed={isLeftCollapsed}
                          />
                        </div>
                      )
                    ) : (
                      <SceneList
                        isCollapsed={isLeftCollapsed}
                        onToggleCollapse={() => setIsLeftCollapsed(!isLeftCollapsed)}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Left resize handle (Absolute) */}
            {!embedded && !effectiveIsLeftCollapsed && !isPreviewFullscreen && (
              <div
                className="absolute top-0 bottom-0 w-3 -translate-x-1/2 hover:bg-[var(--color-accent)]/30 active:bg-[var(--color-accent)]/50 transition-colors z-[200]"
                style={{
                  cursor: 'col-resize',
                  left: effectiveIsLeftCollapsed ? LEFT_RAIL_WIDTH : LEFT_RAIL_WIDTH + leftWidth,
                }}
                onMouseDown={(e) => startPanelDrag(e, 'left')}
                onDoubleClick={() => setIsLeftCollapsed(true)}
              />
            )}

            {/* Center — Preview / Settings tabs */}
            <div className="flex-1 flex flex-col bg-[var(--color-panel)] min-w-0 relative z-[90] overflow-visible">
              {useElectronLayout && layersStripDragTabId != null && (
                <div
                  className="absolute inset-0 z-[500] bg-black/5 pointer-events-auto"
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    let raw: LayersStripTabId | null = useVideoStore.getState().layersStripDragTabId
                    if (!raw) {
                      const a = e.dataTransfer.getData(LAYERS_TAB_DRAG_TYPE)
                      if (a && isLayersStripTabId(a)) raw = a
                    }
                    if (!raw) {
                      const plain = e.dataTransfer.getData('text/plain')
                      const m = plain.startsWith('dreambyte-layers-tab:')
                        ? plain.slice('dreambyte-layers-tab:'.length)
                        : plain
                      if (isLayersStripTabId(m)) raw = m
                    }
                    if (raw) setCenterTab(layersStripToCenterTabId(raw))
                    setLayersStripDragTabId(null)
                  }}
                />
              )}
              {/* Tab bar — VS Code style */}
              {useElectronLayout && !embedded && centerOpenTabs.length > 0 && centerTab !== 'settings' && (
                <div className="relative flex h-[35px] shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                  {centerOpenTabs
                    .filter((id) => id !== 'settings')
                    .map((id) => {
                      const isActive = centerTab === id
                      const dockStripId = parseLayersStripCenterTabId(id)
                      const branchPreviewId = parseBranchPreviewTabId(id)
                      const isWelcome = id === 'welcome'
                      const branchName = branchPreviewId
                        ? (branches.find((b) => b.id === branchPreviewId)?.name ?? branchPreviewId.slice(0, 6))
                        : null
                      return (
                        <div
                          key={id}
                          onClick={() => {
                            const bId = parseBranchPreviewTabId(id)
                            if (bId) {
                              switchProjectBranch(bId)
                            } else if (id === 'preview') {
                              const defBranch = branches.find((b) => b.isDefault)
                              if (defBranch) switchProjectBranch(defBranch.id)
                            }
                            setCenterTab(id)
                          }}
                          className={`relative flex items-center gap-1.5 h-full px-3 cursor-pointer select-none border-r border-[var(--color-border)] transition-colors ${
                            isActive
                              ? 'bg-[var(--color-input-bg)] text-[var(--color-text-primary)]'
                              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border-b border-b-[var(--color-border)]'
                          }`}
                        >
                          {dockStripId != null ? (
                            <LayerDockTabIcon id={dockStripId} />
                          ) : (
                            <>
                              {(id === 'preview' || branchPreviewId != null) && <PreviewIcon size={14} />}
                              {id === 'workspace' && <Package2 size={14} />}
                              {id === 'customize' && <Briefcase size={14} />}
                              {id === 'history' && <History size={14} />}
                              {id === 'export' && <Download size={14} />}
                              {id === 'media' && <MediaIcon size={14} />}
                              {id === 'code' && <Code2 size={14} />}
                              {id === 'welcome' && <AgentIcon size={14} />}
                            </>
                          )}
                          <span className="text-xs font-medium whitespace-nowrap">
                            {dockStripId != null
                              ? LAYERS_STRIP_TAB_LABELS[dockStripId]
                              : branchPreviewId != null
                                ? branchName
                                : id === 'preview'
                                  ? (branches.find((b) => b.isDefault)?.name ?? 'main')
                                  : id === 'workspace'
                                    ? 'Workspaces'
                                    : id === 'customize'
                                      ? 'Customize'
                                      : id === 'history'
                                        ? 'Version history'
                                        : id === 'export'
                                          ? 'Export'
                                          : id === 'media'
                                            ? 'Library'
                                            : id === 'code'
                                              ? 'Code'
                                              : id === 'welcome'
                                                ? 'Welcome'
                                                : id}
                          </span>
                          {id === 'export' && isExporting && (
                            <Loader2 size={11} className="animate-spin text-[var(--color-text-muted)]" />
                          )}
                          {id === 'export' && !isExporting && !isActive && lastExportStatus === 'success' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-label="Export complete" />
                          )}
                          {id === 'export' && !isExporting && !isActive && lastExportStatus === 'error' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400" aria-label="Export failed" />
                          )}
                          {!isWelcome && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                closeCenterTab(id)
                              }}
                              className="flex items-center justify-center w-5 h-5 rounded-sm hover:bg-white/[0.1] transition-colors cursor-pointer"
                            >
                              <X size={14} strokeWidth={1.5} className="text-[var(--color-text-muted)]" />
                            </span>
                          )}
                        </div>
                      )
                    })}
                  <div className="flex-1 border-b border-[var(--color-border)]" />
                </div>
              )}
              {(() => {
                const layerDockId = centerTab != null ? parseLayersStripCenterTabId(centerTab) : null
                if (layerDockId != null) {
                  if (!selectedScene) {
                    return (
                      <div className="flex flex-1 items-center justify-center bg-[var(--color-input-bg)] text-sm text-[var(--color-text-muted)]">
                        Select a scene
                      </div>
                    )
                  }
                  return (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-input-bg)]">
                      <LayersTab
                        scene={selectedScene}
                        lockedStripMode={layerDockId}
                        showScenesSection={false}
                        isLeftCollapsed={effectiveIsLeftCollapsed}
                      />
                    </div>
                  )
                }
                if (centerTab === 'welcome') {
                  return (
                    <div className="flex-1 overflow-auto bg-[var(--color-input-bg)]">
                      <WelcomePageContent
                        onEnterEditor={onEnterEditor ?? (() => {})}
                        onOpenSearch={() => setShowCommandPalette(true)}
                      />
                    </div>
                  )
                }
                if (centerTab === 'preview') {
                  return (
                    <>
                      <PreviewPlayer />
                    </>
                  )
                }
                const branchTabId = centerTab != null ? parseBranchPreviewTabId(centerTab) : null
                if (branchTabId != null) {
                  return (
                    <>
                      <PreviewPlayer />
                    </>
                  )
                }
                if (centerTab === 'settings') {
                  return (
                    <div className="flex h-full flex-col bg-[var(--bg)]">
                      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-4">
                        <button
                          onClick={() => closeCenterTab('settings')}
                          className="no-style inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-[13px] text-[var(--graphite)] transition-colors hover:text-[var(--ink)]"
                        >
                          <ArrowLeft size={15} /> Back
                        </button>
                        <span className="text-[13px] font-medium text-[var(--ink)]">Settings</span>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <SettingsPanel onClose={() => closeCenterTab('settings')} />
                      </div>
                    </div>
                  )
                }
                if (centerTab === 'workspace') {
                  return <WorkspaceView onClose={() => closeCenterTab('workspace')} />
                }
                if (centerTab === 'customize') {
                  return <CustomizeView onClose={() => closeCenterTab('customize')} />
                }
                if (centerTab === 'history') {
                  if (!project?.id || !selectedScene || !projectActiveBranchId) {
                    return (
                      <div className="flex flex-1 items-center justify-center bg-[var(--color-input-bg)] text-sm text-[var(--color-text-muted)]">
                        Select a scene to see its version history
                      </div>
                    )
                  }
                  return (
                    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-input-bg)]">
                      <VersionHistoryDrawer
                        projectId={project.id}
                        sceneId={selectedScene.id}
                        branchId={projectActiveBranchId}
                        onRestored={() => loadProject(project.id)}
                      />
                    </div>
                  )
                }
                if (centerTab === 'export') {
                  return (
                    <div className="flex-1 overflow-y-auto bg-[var(--color-input-bg)]">
                      <ExportPanel inTab />
                    </div>
                  )
                }
                if (centerTab === 'media') {
                  return (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel)]">
                      <MediaLibrary />
                    </div>
                  )
                }
                if (centerTab === 'code') {
                  return (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg)]">
                      <CodeEditorTab />
                    </div>
                  )
                }
                return <div className="flex flex-1 bg-[var(--color-panel)]" />
              })()}
            </div>
          </div>
          {/* end upper area */}

          {/* Timeline section — full width of left+center column */}
          <div
            className="h-px flex-shrink-0 bg-[var(--color-border)] cursor-row-resize z-[100] relative before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-['']"
            onMouseDown={(e) => {
              e.preventDefault()
              timelineDragRef.current = { startY: e.clientY, startH: effectiveTimelineHeight }
              setIsDraggingTimeline(true)
              document.body.style.cursor = 'row-resize'
              document.body.style.userSelect = 'none'
            }}
          />
          {effectiveTimelineHeight > 0 && (
            <Timeline
              currentTime={timelineTransport.globalTime}
              totalDuration={timelineTransport.totalDuration}
              onSeek={(t: number) =>
                window.dispatchEvent(
                  new CustomEvent('dreambyte-preview-command', { detail: { action: 'seek', time: t } }),
                )
              }
              onScrubStart={() =>
                window.dispatchEvent(
                  new CustomEvent('dreambyte-preview-command', { detail: { action: 'scrub_start' } }),
                )
              }
              onScrubEnd={() =>
                window.dispatchEvent(new CustomEvent('dreambyte-preview-command', { detail: { action: 'scrub_end' } }))
              }
              trackHeight={effectiveTimelineHeight}
            />
          )}
        </div>
        {/* end left+center column */}

        {/* Right resize handle (Absolute) */}
        {!isPreviewFullscreen && effectiveRightPanelTab && (
          <div
            className="absolute top-0 bottom-0 w-2 translate-x-1/2 hover:bg-[var(--color-accent)]/30 active:bg-[var(--color-accent)]/50 transition-colors z-[200]"
            style={{
              cursor: 'col-resize',
              right: rightWidth,
            }}
            onMouseDown={(e) => startPanelDrag(e, 'right')}
          />
        )}

        {/* Right — Editor (full height, UNCHANGED) */}
        {!isPreviewFullscreen && effectiveRightPanelTab && (
          <div
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l-[1.5px] border-[var(--color-border)] bg-[var(--color-panel)] relative z-[101]"
            style={{ width: rightWidth }}
          >
            <SceneEditor />
          </div>
        )}
      </div>

      {/* Modals (NewProjectModal is mounted once in AppShell so it also works
          from the Projects gate, where the editor isn't mounted) */}
      <PermissionDialog />
      {isExportModalOpen && !useElectronLayout && <ExportModal />}
      <VariantComparisonModal />
      <CrossProjectPickerModal />
      <CrossProjectRunView />

      {showPublishPanel && publishedUrl && (
        <PublishPanel url={publishedUrl} onClose={() => setShowPublishPanel(false)} />
      )}

      {useElectronLayout && !embedded && <EditorStatusBar />}

      {/* Command Palette */}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          projects={showWelcome ? projectList : []}
          onAction={(a) => {
            setShowCommandPalette(false)
            if (a.type === 'open-project') {
              loadProject(a.projectId)
              onEnterEditor?.()
            } else if (a.type === 'open-conversation') {
              // Jump to the project's chat view + that conversation.
              useVideoStore.getState().openProject(a.projectId, 'chat', a.conversationId)
            } else {
              const action = a.action
              if (action === 'settings') setSettingsTab('general')
              else if (action === 'projects') setShowProjectPanel(true)
              else if (action === 'media') setCenterTab('media')
              else if (action === 'layers') setElectronLeftTab('layers')
              else if (action === 'export') triggerExport()
              else if (action === 'agents') setSettingsTab('agents')
              else if (action === 'new-scene') addScene()
              else if (action === 'tier2-mirror') void runTier2Mirror()
              else if (action === 'tier2-export') void runTier2Export()
              else if (action === 'tier2-reveal') void runTier2Reveal()
              else if (action === 'git-panel') setShowGitPanel(true)
              else if (action === 'shortcuts') setShowShortcutsHelp(true)
            }
          }}
        />
      )}

      {/* Keyboard shortcuts help sheet */}
      {showShortcutsHelp && <ShortcutsHelpModal onClose={() => setShowShortcutsHelp(false)} />}

      {/* Per-version "What's new" overlay (once per version after update) */}
      <ChangelogHost />

      {/* Branch Picker Modal */}
      {branchPickerOpen && project?.id && (
        <BranchPickerModal
          branches={branches}
          activeBranchId={projectActiveBranchId}
          onClose={() => setBranchPickerOpen(false)}
          onSelect={async (branchId) => {
            setBranchPickerOpen(false)
            await switchProjectBranch(branchId)
          }}
        />
      )}

      {/* Tier 2 git drawer */}
      {showGitPanel && project?.id && <GitPanelDrawer projectId={project.id} onClose={() => setShowGitPanel(false)} />}
    </div>
  )
}

/**
 * Drawer hosting the git branches + diff panels side-by-side.
 * Opens via Command Palette → "Git: branches & history". The diff viewer
 * compares `main..HEAD`.
 */
function GitPanelDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-[9999] bg-black/40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-[10000] flex w-[min(720px,95vw)] flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
          <span className="text-[12px] text-[var(--color-text-primary)]">Tier 2 git</span>
          <button
            type="button"
            onClick={onClose}
            className="no-style text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            Close
          </button>
        </header>
        <div className="grid flex-1 grid-cols-2 overflow-hidden">
          <div className="overflow-y-auto border-r border-[var(--color-border)]">
            <GitBranchesPanel projectId={projectId} />
          </div>
          <div className="overflow-y-auto">
            <GitDiffViewer projectId={projectId} fromRef="main" toRef="HEAD" />
          </div>
        </div>
      </div>
    </>
  )
}
