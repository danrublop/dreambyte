'use client'

import type { Scene, GlobalStyle, Project, SceneGraph } from '../types'
import type { StructuralCut } from '../agents/types'
import { v4 as uuidv4 } from 'uuid'
import { remapSceneIds, remapSceneGraphIds } from '../scene-id-remap'
import { DEFAULT_AUDIO_SETTINGS } from '../types'
import { DEFAULT_AUDIO_PROVIDER_ENABLED } from '../audio/provider-registry'
import { DEFAULT_MEDIA_PROVIDER_ENABLED } from '../media/provider-registry'
import { createDefaultAPIPermissions } from '../permissions'
import { preserveLocalTimelineMeta } from './timeline-actions'
import { isValidUuid } from '../utils/uuid'
import type { Set, Get } from './types'
import {
  createDefaultProject,
  DEFAULT_GLOBAL_STYLE,
  normalizeScene,
  sceneHasRenderableContent,
  getPersistedTheme,
} from './helpers'
import {
  setPendingSaveMarker,
  clearPendingSaveMarker,
  readAllPendingSaveMarkers,
  reconcilePendingSaveMarker,
} from './persistence-marker'
import { clearPersistedUndoStacks } from './undo-actions'
import {
  scheduleDurablePersistFromState,
  flushDurableUndoPersist,
  hydrateUndoStacks,
  getUndoStacksIpc,
} from './undo-persistence'
import { createLogger } from '../logger'
import { buildSceneBaseline, reconcileScenesForRetry, type SceneBaseline } from './scene-reconcile'

const log = createLogger('store.project')

/** Checkpoints saved before the ScenePlan rename carry `storyboard`. */
function normalizeCheckpointKeys<T extends Record<string, unknown> | null>(cp: T): T {
  if (
    cp &&
    (cp as Record<string, unknown>).scenePlan === undefined &&
    (cp as Record<string, unknown>).storyboard !== undefined
  ) {
    return { ...(cp as Record<string, unknown>), scenePlan: (cp as Record<string, unknown>).storyboard } as unknown as T
  }
  return cp
}

// IPC bridges — prefer `window.dreambyteApi.*` when Electron's preload has
// attached it (both dev and packaged). Fall back to the legacy Next route
// only when running in pure browser preview during the migration window.
// Once the rest of Week 2 lands and the /api routes are all deleted, these
// fallbacks collapse to the `throw` path.
const projectsIpc = () => (typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined)
const publishIpc = () => (typeof window !== 'undefined' ? window.dreambyteApi?.publish : undefined)

// Module-level debounce timer for scheduleSaveProjectToDb. Mirrors the pattern
// used by undo-actions._persistTimer — module-scoped so all callers share one
// pending write per tab.
let _scheduledSaveTimer: ReturnType<typeof setTimeout> | null = null
// Re-entrancy chain for saveProjectToDb (TODOS "saveProjectToDb conflict
// retry", part c): the 30s poll, branch switches, and manual callers can all
// call save concurrently. Two interleaved saves race the shared crash-marker
// key — one call's clear deletes the other's IN-FLIGHT marker, so a crash
// between them records the wrong sceneIds at next boot. NOTE the unload path
// (flushSaveProjectToDb) deliberately BYPASSES this chain — it must enqueue
// synchronously while the renderer is dying, where queued microtasks may
// never run; flush-vs-chain marker races are covered by the per-write NONCE
// in persistence-marker.ts ("newer writer owns the key"), not by this chain.
// Serialize: every call chains strictly after the previous one (a queued
// call re-reads fresh store state when it runs, so nothing is lost by
// waiting). The version-CAS already kept the DB consistent; this fixes the
// marker bookkeeping. Chain (not a boolean latch) so 3+ stacked callers
// can't pair up and re-race once the first completes. The UNCONTENDED case
// starts the save synchronously in the same tick (no microtask defer) — the
// stale-capture guards in the save body rely on capturing state before its
// first await, and the write-freshness tests pin that timing.
let _saveChain: Promise<unknown> = Promise.resolve()
let _activeSaves = 0
// Per-scene conflict-reconciliation baseline :
// content hashes of the scenes as of the last moment local state and the DB
// were KNOWN to agree (successful save / project load / server refresh).
// Keyed by project+branch — any path that replaces scenes without refreshing
// the baseline (switchProjectBranch, restoreToPoint reloads, …) simply
// MISMATCHES the key and the conflict retry degrades to the old agent-wins
// substitution. Safe fallback, never a guess. One deliberate exception: UNDO
// keeps the same project+branch key, so it leaves a stale-but-valid baseline —
// undone scenes then hash dirty and a later conflict resolves LOCAL-wins,
// which preserves the user's visible (undone) state. Also safe.
let _sceneBaseline: { projectId: string; branchId: string | null; map: SceneBaseline } | null = null
function setSceneBaseline(projectId: string, branchId: string | null, scenes: ReadonlyArray<{ id: string }>): void {
  _sceneBaseline = { projectId, branchId, map: buildSceneBaseline(scenes) }
}
/** @internal test-only — module state would otherwise leak between tests. */
export function resetSceneBaseline(): void {
  _sceneBaseline = null
}

// The `projects.version` this renderer last OBSERVED, and the compare-and-swap
// baseline every scene-bearing save sends to main. Without it main re-read the
// row's own version and CAS'd against that — last-writer-wins dressed up as
// optimistic locking, which is how a 30s-poll save or a visibilitychange flush
// (Cmd+Tab / Cmd+Q / Cmd+H) could overwrite 20 scenes an agent had just
// written and still report 'saved'. Main now REJECTS a scene write whose
// baseline is stale (IpcConflictError → the retry/merge path below).
//
// Module state, deliberately NOT part of the persisted store: a version
// rehydrated from localStorage after a restart would be a lie. Null means "we
// have no baseline" — saveProjectToDb fetches one before writing;
// flushSaveProjectToDb can't (it must enqueue synchronously during unload), so
// it sends null and main fails the save loudly instead of writing blind.
let _dbVersion: { projectId: string; version: number } | null = null
function noteDbVersion(projectId: string, version: unknown): void {
  if (typeof version === 'number' && Number.isFinite(version)) _dbVersion = { projectId, version }
}
function baseVersionFor(projectId: string): number | null {
  return _dbVersion && _dbVersion.projectId === projectId ? _dbVersion.version : null
}
/** @internal test-only — module state would otherwise leak between tests. */
export function resetDbVersion(): void {
  _dbVersion = null
}
// 500ms keeps the in-flight loss window short enough that close/refresh
// within ~half a second of an edit isn't catastrophic. Saves are cheap
// (one IPC + one SQLite write) and saveProjectToDb retries on 409, so
// going lower than the previous 1500ms is safe.
const SCHEDULED_SAVE_DEBOUNCE_MS = 500

export function createProjectActions(set: Set, get: Get) {
  return {
    // These project mutations mark the project dirty so an edit (rename, output
    // mode, graph change) flushes through the normal save path. Under the eager
    // draft model the row already exists (status='draft'); the save just updates
    // it (and the first real activity promotes it to 'ready').
    setOutputMode: (mode: 'mp4' | 'interactive') => {
      set((state) => ({
        _isDirty: true,
        project: { ...state.project, outputMode: mode, updatedAt: new Date().toISOString() },
      }))
    },

    updateProject: (updates: Partial<Project>) => {
      set((state) => ({
        _isDirty: true,
        project: { ...state.project, ...updates, updatedAt: new Date().toISOString() },
      }))
    },

    updateSceneGraph: (graph: SceneGraph) => {
      set((state) => ({
        _isDirty: true,
        project: { ...state.project, sceneGraph: graph, updatedAt: new Date().toISOString() },
      }))
    },

    publishProject: async () => {
      const { project, scenes } = get()
      set({ isPublishing: true, publishError: null })
      try {
        // Ensure all scene HTML files exist on disk before publishing
        await Promise.all(scenes.map((s) => get().saveSceneHTML(s.id, true)))

        const payload = {
          project: {
            id: project.id,
            name: project.name,
            interactiveSettings: project.interactiveSettings,
            sceneGraph: project.sceneGraph,
          },
          scenes: scenes.map((s) => ({
            id: s.id,
            sceneType: s.sceneType,
            duration: s.duration,
            interactions: s.interactions,
            variables: s.variables,
            transition: s.transition,
          })),
        }

        const ipc = publishIpc()
        if (!ipc) throw new Error('publish requires the desktop runtime (window.dreambyteApi.publish unavailable).')
        const data = await ipc.run(payload as unknown as Parameters<typeof ipc.run>[0])
        set({ publishedUrl: data.publishedUrl, showPublishPanel: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Publish failed'
        log.error('publish error', { extra: { message }, error: err })
        set({ publishError: message })
      } finally {
        set({ isPublishing: false })
      }
    },

    setShowPublishPanel: (show: boolean) => set({ showPublishPanel: show }),

    // ── Project management ──────────────────────────────────────────────
    fetchProjectList: async () => {
      set({ isLoadingProjects: true })
      try {
        const ipc = projectsIpc()
        if (!ipc) {
          log.warn('fetchProjectList: projects IPC unavailable')
          return
        }
        const raw = await ipc.list()
        if (!raw) return
        // list() returns flat array when no pagination args; our store consumes the array shape.
        const list = Array.isArray(raw) ? raw : (raw as { items: unknown[] }).items
        set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          projectList: (list as any[]).map((p) => ({
            id: p.id,
            name: p.name,
            updatedAt: p.updatedAt,
            thumbnailUrl: p.thumbnailUrl,
            outputMode: p.outputMode,
            createdAt: p.createdAt,
            workspaceId: p.workspaceId ?? null,
          })),
        })
      } catch (e) {
        log.error('failed to fetch projects', { error: e })
      } finally {
        set({ isLoadingProjects: false })
      }
    },

    createNewProject: async (
      name?: string,
      aspectRatio?: import('../dimensions').AspectRatio,
      opts?: { draft?: boolean },
    ) => {
      const state = get()
      // Don't save current project — auto-save handles it.
      // Saving here overwrites externally-added scenes.

      const newProject = createDefaultProject([])

      // Auto-increment "Untitled Project" names. Earlier version read
      // state.projectList, which is stale if fetchProjectList hasn't run
      // yet (or ran before the most recent creation) — every new project
      // then got "Untitled Project 1". Fetch the live list from the DB so
      // the number always reflects what actually exists.
      // DRAFTS skip the live list fetch: flipping the Editor pill should open
      // the editor without an extra list round-trip first. The cached list is a
      // fine basis for the auto-incremented name (the create IPC below still
      // persists the row with status='draft').
      if (!name) {
        let existing = new Set(state.projectList.map((p) => p.name))
        if (!opts?.draft) {
          try {
            const ipc = projectsIpc()
            if (ipc) {
              const raw = await ipc.list()
              const list = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] })?.items ?? [])
              existing = new Set((list as Array<{ name: string }>).map((p) => p.name))
            }
          } catch (e) {
            log.warn('createNewProject: live list fetch failed, using cached projectList', { error: e })
          }
        }
        let n = 1
        while (existing.has(`Untitled Project ${n}`)) {
          n++
        }
        newProject.name = `Untitled Project ${n}`
      } else {
        newProject.name = name
      }
      if (aspectRatio) {
        newProject.mp4Settings = { ...newProject.mp4Settings, aspectRatio }
      }
      set({
        // EAGER draft model: every new project — including the
        // editor-pill `{ draft: true }` mint — is a real DB row with
        // status='draft' from the first moment (see the create IPC below).
        // The startup sweep soft-hides untouched empties; first activity
        // promotes to 'ready'. There is no in-memory-only draft mode anymore.
        _isDirty: false,
        project: newProject,
        // Focus the shell on the new project and close any content overlay so the
        // new project's content shows. projectView is intentionally NOT set here:
        // creating from the editor keeps you in the editor, from chat keeps you in
        // chat. Callers that need a specific view (e.g. the home composer always
        // lands in chat) set it explicitly after this resolves.
        activeProjectId: newProject.id,
        appView: 'project',
        contentView: 'none',
        scenes: [],
        selectedSceneId: null,
        globalStyle: DEFAULT_GLOBAL_STYLE,
        chatMessages: [],
        conversations: [],
        activeConversationId: null,
        _persistedMessageIds: new Set<string>(),
        structuralCutsProposed: null,
        pausedAgentRun: null,
        runCheckpoint: null,
        publishedUrl: null,
        _dbLoadComplete: true,
        // Welcome tab is only meaningful when there's no project. Reset to the
        // editor default atomically so the transition can't render a frame
        // where projectId exists but the tab bar still shows 'welcome'.
        centerOpenTabs: ['preview'],
        centerTab: 'preview',
      })

      const st = get()
      const createPayload = {
        id: st.project.id,
        name: st.project.name,
        // A new project is a real DB row from the first moment,
        // created as a 'draft'. The startup sweep soft-hides it only if it stays
        // a provably-untouched empty (no scenes, no messages, default name,
        // never reopened); first activity promotes it to 'ready' via the update
        // IPC. This replaces the old lazy in-memory persist.
        status: 'draft' as const,
        outputMode: st.project.outputMode,
        globalStyle: st.globalStyle,
        mp4Settings: st.project.mp4Settings,
        interactiveSettings: st.project.interactiveSettings,
        apiPermissions: st.project.apiPermissions,
        audioSettings: st.project.audioSettings,
        audioProviderEnabled: st.audioProviderEnabled,
        mediaGenEnabled: st.mediaGenEnabled,
        scenes: st.scenes,
        sceneGraph: st.project.sceneGraph,
        workspaceId: st.activeWorkspaceId,
      }
      try {
        const ipc = projectsIpc()
        const saved = ipc ? ((await ipc.create(createPayload)) as Record<string, unknown>) : null
        if (!ipc) {
          log.error('createNewProject: projects IPC unavailable')
        }
        if (saved) {
          const toIso = (v: unknown) => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : '')
          const createdAt = toIso(saved.createdAt) || st.project.createdAt
          const updatedAt = toIso(saved.updatedAt) || st.project.updatedAt
          noteDbVersion(st.project.id, saved.version)
          set({ project: { ...get().project, createdAt, updatedAt } })
        } else {
          await get().saveProjectToDb()
        }
      } catch (e) {
        log.error('createNewProject: persist error', { error: e })
        await get().saveProjectToDb()
      }

      await get().fetchProjectList()
      // Create first conversation for the new project
      await get().newConversation(newProject.id)
    },

    refreshProjectFromServer: async () => {
      const { project, _dbLoadComplete } = get()
      if (!project?.id || !_dbLoadComplete) return
      log.debug('refreshProjectFromServer start', { extra: { chatMessages: get().chatMessages.length } })
      try {
        const ipc = projectsIpc()
        if (!ipc) return
        // Branch-aware (#156 latent finding): scope the refresh to the branch
        // the editor is ON. The no-arg form returns DEFAULT-branch scenes,
        // which would swap the visible document out from under a non-default
        // branch — and poison the conflict baseline below, which is keyed by
        // the ACTIVE branch but would hold main's scene hashes.
        const branchAtFetch = get().projectActiveBranchId ?? null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await ipc.get(project.id, branchAtFetch ?? undefined)
        // Post-await guard (review #166): a project or branch switch can
        // complete while the IPC was in flight — the same race every sibling
        // DB→store path (loadProject, switchProjectBranch) already guards.
        // Applying this fetch would write branchAtFetch's scenes into the NEW
        // branch's store and key ITS baseline with the wrong branch's hashes
        // (the exact poisoning this fetch exists to prevent).
        if (get().project?.id !== project.id || (get().projectActiveBranchId ?? null) !== branchAtFetch) return
        // Store and DB now agree — this read IS the new CAS baseline.
        noteDbVersion(project.id, data.version)
        const newScenes: Scene[] = (data.scenes || []).map(normalizeScene)
        // Empty-branch wipe guard (review #166 red team): a branch-scoped read
        // can legitimately return ZERO scenes (new branch, no rows persisted
        // yet) — a case the old default-branch read never produced. If the
        // store holds unsaved local scenes (_isDirty), replacing them with []
        // would blank in-progress work; skip and let the pending autosave land
        // first. Kept gated on _isDirty so an EXTERNAL delete-all (MCP / Claude
        // Code / a second window emptied the DB) still propagates to a CLEAN
        // store — the agent-persist-skip durability is handled by the renderer
        // push on persistOk!==true (src/lib/hooks/use-agent-run.ts), not by blanket-
        // blocking every empty pull.
        if (newScenes.length === 0 && get().scenes.length > 0 && get()._isDirty) return
        const loadedProject: Project = {
          id: data.id,
          name: data.name,
          outputMode: data.outputMode || 'mp4',
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          mp4Settings: {
            resolution: '1080p',
            fps: 30,
            format: 'mp4',
            aspectRatio: '16:9' as const,
            ...data.mp4Settings,
          },
          interactiveSettings: data.interactiveSettings || {
            playerTheme: 'dark',
            showProgressBar: true,
            showSceneNav: true,
            allowFullscreen: true,
            brandColor: '#e84545',
            customDomain: null,
            password: null,
          },
          sceneGraph: data.sceneGraph || { nodes: [], edges: [], startSceneId: '' },
          apiPermissions: data.apiPermissions || createDefaultAPIPermissions(),
          audioSettings: data.audioSettings || DEFAULT_AUDIO_SETTINGS,
          audioProviderEnabled: data.audioProviderEnabled || { ...DEFAULT_AUDIO_PROVIDER_ENABLED },
          mediaGenEnabled: data.mediaGenEnabled || { ...DEFAULT_MEDIA_PROVIDER_ENABLED },
          watermark: data.watermark || null,
          brandKit: data.brandKit || null,
          timeline: preserveLocalTimelineMeta(data.timeline || null, get().project?.timeline),
        }
        const loadedStyle = data.globalStyle || DEFAULT_GLOBAL_STYLE
        const sel = get().selectedSceneId
        const selectedSceneId = sel && newScenes.some((s) => s.id === sel) ? sel : (newScenes[0]?.id ?? null)
        set({
          project: loadedProject,
          scenes: newScenes,
          selectedSceneId,
          globalStyle: (() => {
            const prev = get().globalStyle
            const typ = prev.uiTypography ?? 'app'
            return {
              ...loadedStyle,
              theme: getPersistedTheme(),
              uiTypography: typ,
              uiFontFamily: typ === 'custom' ? (prev.uiFontFamily ?? 'Inter') : null,
            }
          })(),
          audioProviderEnabled: loadedProject.audioProviderEnabled,
          mediaGenEnabled: loadedProject.mediaGenEnabled,
          sceneHtmlVersion: get().sceneHtmlVersion + 1,
          brandKit: loadedProject.brandKit,
        })
        // Item 8a: the store now mirrors the DB — refresh the per-scene
        // conflict baseline so the next save's retry can merge precisely.
        setSceneBaseline(project.id, get().projectActiveBranchId ?? null, newScenes)
        // Proposals are branch-scoped (0015): re-hydrate for the active branch
        // rather than reading them off the project row.
        void get().loadBranchProposals(project.id, get().projectActiveBranchId)
        log.debug('refreshProjectFromServer after set', {
          extra: { chatMessages: get().chatMessages.length },
        })
        // Removed: automatic HTML regeneration. See the analogous block in
        // loadProject() for the rationale — the regen was clobbering
        // externally-written scene HTML with stale-template output. Scene
        // edits still flow through saveSceneHTML() explicitly; refreshes
        // just update in-memory state. Bump sceneHtmlVersion so PreviewPlayer
        // re-reads disk with a fresh cache-buster.
        set({ sceneHtmlVersion: get().sceneHtmlVersion + 1 })
      } catch (e) {
        log.error('refreshProjectFromServer failed', { error: e })
      }
    },

    loadProject: async (projectId: string) => {
      // Showcase auto-exit: drop fixtures + restore before cross-project
      // load so showcase state never bleeds between projects.
      if (get().showcaseMode) get().exitShowcase()
      // Immediately clear per-project state so nothing from the old project
      // is visible while the new project loads from DB.
      set((s) => ({
        structuralCutsProposed: null,
        pausedAgentRun: null,
        runCheckpoint: null,
        conversations: [],
        chatMessages: [],
        activeConversationId: null,
        _persistedMessageIds: new Set<string>(),
        // Drop the prior project's pre-run snapshots — they pin that
        // project's scene clones and must never restore into a different project.
        _runSnapshots: [],
        // Welcome → editor transition: drop the welcome tab atomically with
        // the project switch. If the user wasn't on welcome, leave their tab
        // layout alone.
        ...(s.centerOpenTabs.includes('welcome')
          ? { centerOpenTabs: ['preview' as const], centerTab: 'preview' as const }
          : {}),
      }))

      // Save current project before switching — auto-save may not have fired yet.
      // Only save if scenes actually have content (avoids overwriting DB with empty
      // localStorage-hydrated scenes on initial page load).
      const hasContent = get().scenes.some(sceneHasRenderableContent)
      if (hasContent) {
        await get().saveProjectToDb()
      }
      try {
        const ipc = projectsIpc()
        if (!ipc) {
          log.error('loadProject: projects IPC unavailable')
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any
        try {
          data = await ipc.get(projectId)
        } catch (err) {
          // A NOT_FOUND here means the active-project pointer points at a project
          // that doesn't exist in THIS database — e.g. a draft whose row never
          // persisted, a row deleted in another window, or an id that lived in a
          // different build's DB (renderer localStorage is shared across builds
          // by the dreambyte:// origin, but each build opens its own db file).
          // ensureValidProjectId() only validates the UUID *format*, not
          // existence, so a well-formed ghost id sails straight through to here.
          // Leaving it active strands the whole app: branches.list / getVersion /
          // uploadAsset (FK → project_assets.project_id) all fail NOT_FOUND
          // against the phantom row. Recover by minting a fresh draft — the same
          // zero-friction path a clean launch takes — so there is always a real,
          // writable active project. The user's other projects stay reachable
          // via the project list (which reads from the same live DB).
          const msg = (err as Error)?.message ?? ''
          // Substring match (not anchored): Electron's ipcRenderer.invoke wraps
          // the message as "Error invoking remote method '…': IpcNotFoundError:
          // Project <uuid> not found", so a `^Project…$` anchor never matches and
          // the recovery silently no-ops (the original ghost-project bug).
          const isNotFound = /Project\s+[0-9a-f-]+\s+not found/i.test(msg)
          if (isNotFound) {
            log.warn('loadProject: project not found in DB, recovering with a fresh draft', {
              extra: { projectId },
            })
            await get().createNewProject(undefined, undefined, { draft: true })
            return
          }
          // Transient/transport failure — don't nuke the active pointer; the
          // boot retry loop or the next user action can recover.
          log.error('loadProject: IPC get failed', { error: err })
          return
        }

        // Store and DB agree right after a load — this read IS the CAS baseline.
        noteDbVersion(projectId, data.version)
        const loadedProject: Project = {
          id: data.id,
          name: data.name,
          outputMode: data.outputMode || 'mp4',
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          mp4Settings: {
            resolution: '1080p',
            fps: 30,
            format: 'mp4',
            aspectRatio: '16:9' as const,
            ...data.mp4Settings,
          },
          interactiveSettings: data.interactiveSettings || {
            playerTheme: 'dark',
            showProgressBar: true,
            showSceneNav: true,
            allowFullscreen: true,
            brandColor: '#e84545',
            customDomain: null,
            password: null,
          },
          sceneGraph: data.sceneGraph || { nodes: [], edges: [], startSceneId: '' },
          apiPermissions: data.apiPermissions || createDefaultAPIPermissions(),
          audioSettings: data.audioSettings || DEFAULT_AUDIO_SETTINGS,
          audioProviderEnabled: data.audioProviderEnabled || { ...DEFAULT_AUDIO_PROVIDER_ENABLED },
          mediaGenEnabled: data.mediaGenEnabled || { ...DEFAULT_MEDIA_PROVIDER_ENABLED },
          watermark: data.watermark || null,
          brandKit: data.brandKit || null,
          timeline: preserveLocalTimelineMeta(data.timeline || null, get().project?.timeline),
        }

        // Preserve the current editor theme and UI typography (global preference, not per-project)
        const prevGs = get().globalStyle
        const typ = prevGs.uiTypography ?? 'app'
        const loadedStyle = data.globalStyle || DEFAULT_GLOBAL_STYLE
        // Proposal/handoff state is branch-scoped now (0015) — NOT on the project
        // row. Cleared here, hydrated for the active branch right after the set.
        const defaultBranchId = (data as any).defaultBranchId ?? null
        set({
          project: loadedProject,
          scenes: (data.scenes || []).map(normalizeScene),
          selectedSceneId: data.scenes?.[0]?.id || null,
          projectActiveBranchId: defaultBranchId,
          projectDefaultBranchId: defaultBranchId,
          // Clear conversation state immediately so old project's messages don't bleed through
          conversations: [],
          chatMessages: [],
          activeConversationId: null,
          _persistedMessageIds: new Set<string>(),
          // Prior project's pre-run snapshots must not survive the switch.
          _runSnapshots: [],
          globalStyle: {
            ...loadedStyle,
            theme: getPersistedTheme(),
            uiTypography: typ,
            uiFontFamily: typ === 'custom' ? (prevGs.uiFontFamily ?? 'Inter') : null,
          },
          audioProviderEnabled: loadedProject.audioProviderEnabled,
          mediaGenEnabled: loadedProject.mediaGenEnabled,
          publishedUrl: null,
          structuralCutsProposed: null,
          pausedAgentRun: null,
          runCheckpoint: null,
          brandKit: loadedProject.brandKit,
        })
        // Hydrate this branch's proposals from branch_proposals. If a saved
        // branch is restored below via switchProjectBranch, that re-hydrates.
        void get().loadBranchProposals(projectId, defaultBranchId)

        // Initialize timeline only when none exists in the DB.
        // If the DB has a saved timeline, trust it — syncTimelineFromScenes runs
        // on the first Timeline render and keeps audio tracks in sync without
        // clobbering user-set clip positions.
        if (!data.timeline) get().initTimeline()

        // HISTORICAL: this block used to regenerate every scene's HTML on load
        // via generateSceneHTML() — the idea was "template fixes propagate".
        // In practice it silently overwrote freshly-written scene HTML with a
        // version produced by the main-process in-memory cached template,
        // which was pinned to app startup time and never refreshed across
        // sceneTemplate.ts / anime-head.ts / SDK edits. That meant the user's
        // regenerated scenes were clobbered seconds after any project open.
        //
        // Scene HTML on disk is now authoritative. Scene code edits regenerate
        // HTML explicitly via saveSceneHTML() (generation-actions.ts) — that's
        // the only in-app write path. External tools (reel scripts, POST
        // /api/scene, PATCH /api/scene) write directly to disk and the app
        // just reads them.
        //
        // Still bump sceneHtmlVersion so PreviewPlayer re-reads iframe src
        // with a cache-buster — that picks up any HTML that external tools
        // wrote while the app wasn't watching.
        set({ sceneHtmlVersion: get().sceneHtmlVersion + 1 })

        // Item 8a: store and DB agree right after a load — refresh the
        // per-scene conflict baseline (keyed to the loaded branch).
        setSceneBaseline(projectId, get().projectActiveBranchId ?? null, get().scenes)

        // Clear lastVariantsSpawn on project switch. The branch
        // ids in the spawn are scoped to the previously loaded project;
        // showing the "Compare N variants" entry in a different project's
        // BranchSelector would let users click it and try to load
        // nonexistent branches.
        set({ lastVariantsSpawn: null, isVariantComparisonOpen: false })

        // Load project conversations and assets
        await get().loadConversations(projectId)
        get().loadProjectAssets(projectId)

        // Mark DB load complete — auto-save is now safe.
        // This MUST happen before switchProjectBranch so that saveProjectToDb
        // (called inside switchProjectBranch) doesn't no-op its _dbLoadComplete guard
        // and leave the window where _dbLoadComplete=true but branch scenes haven't
        // loaded yet (which could autosave the default branch scenes to the wrong row).
        set({ _dbLoadComplete: true })

        // Pending-save marker reconciliation (branch-keyed).
        // A marker that survived to boot means a save (agent run persist
        // or user save) started but was never confirmed. If the loaded DB row
        // predates the marker, the crash window hit: tell the user instead of
        // silently presenting pre-run state. Scans ALL of this project's
        // markers (one per branch) — an agent run on a non-default branch
        // leaves its marker under that branch's key. One-shot in every
        // verdict. Known residual: freshness is the PROJECT row's updatedAt
        // (no per-branch timestamp on the cheap probe) — see persistence-marker.ts.
        try {
          const markers = readAllPendingSaveMarkers(projectId)
          const dbUpdatedAtMs = data?.updatedAt ? new Date(data.updatedAt as string | number).getTime() : 0
          let notified = false
          for (const marker of markers) {
            const verdict = reconcilePendingSaveMarker(marker, dbUpdatedAtMs, Date.now())
            if (verdict === 'notify') {
              log.warn('pending-save marker predates the DB row — recent changes may be missing', {
                extra: { sceneIds: marker.sceneIds, markerTs: marker.ts, dbUpdatedAtMs, branchId: marker.branchId },
              })
              if (!notified) {
                // One banner even if several branches were in flight.
                notified = true
                get().showTransientStatus?.(
                  'Recovering from an interrupted save — your most recent changes may be missing. Check your last run.',
                  8000,
                )
              }
            } else if (verdict === 'clear-stale') {
              log.warn('pending-save marker expired (>24h) — clearing', { extra: { markerTs: marker.ts } })
            }
            clearPendingSaveMarker(projectId, marker.branchId)
          }
        } catch (err) {
          log.warn('pending-save marker reconciliation failed', { error: err })
        }

        // Restore the last active branch and open branch tab layout for this project.
        // Must run after _dbLoadComplete so the saveProjectToDb call inside
        // switchProjectBranch runs correctly and doesn't miss pending writes.
        if (typeof localStorage !== 'undefined') {
          const savedBranchId = localStorage.getItem(`dreambyte:activeBranch:${projectId}`)
          if (savedBranchId && savedBranchId !== get().projectActiveBranchId) {
            // Fire-and-forget — if the branch was deleted, switchProjectBranch will fail
            // silently and leave the project on main, which is the correct fallback.
            // switchProjectBranch also calls setCenterTab to activate the branch's tab.
            get()
              .switchProjectBranch(savedBranchId)
              .catch(() => {})
          }
          // Reopen any other branch tabs that were open in the previous session.
          const savedTabsJson = localStorage.getItem(`dreambyte:openBranchTabs:${projectId}`)
          if (savedTabsJson) {
            try {
              const savedTabs: string[] = JSON.parse(savedTabsJson)
              const { openCenterTab } = get()
              for (const tabId of savedTabs) {
                if (tabId !== 'preview' && tabId.startsWith('preview:')) {
                  // Parse the branchId to skip tabs for the already-active branch
                  // (switchProjectBranch will open+activate that one via setCenterTab).
                  const bId = tabId.slice('preview:'.length)
                  if (bId !== savedBranchId) {
                    openCenterTab(tabId as import('./types').CenterTabId)
                  }
                }
              }
            } catch {
              // non-fatal: stale or malformed saved tabs
            }
          }
        }

        // Guard against persist middleware clobbering rich scenes with stripped
        // localStorage data. If after a short delay the store's scenes lost their
        // code fields, re-fetch from the server.
        const loadedScenes = data.scenes || []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const richSceneIds = loadedScenes.filter((s: any) => sceneHasRenderableContent(s)).map((s: any) => s.id)
        if (richSceneIds.length > 0) {
          setTimeout(() => {
            const current = get().scenes
            const clobbered = richSceneIds.some((id: string) => {
              const s = current.find((cs) => cs.id === id)
              return s && !sceneHasRenderableContent(s)
            })
            if (clobbered) {
              log.warn('loadProject: persist merge clobbered scene code, refreshing from server')
              get().refreshProjectFromServer()
            }
          }, 500)
        }

        // Scene HTML self-heal: regenerate any scene whose on-disk
        // HTML is missing or stale so the preview never shows a blank/old frame.
        // Fire-and-forget after the branch restore settles — healthy scenes are
        // skipped (no write), failures surface in sceneWriteErrors.
        void get()
          .healProjectScenes()
          .catch(() => {})

        // Restart hydration — when this load starts with NO undo history
        // (fresh app boot; sessionStorage restore was empty), pull the durable
        // stacks for (project, active branch) from the DB. A live session that
        // already has stacks (sessionStorage restore, or same-session project
        // work) wins — never clobber it.
        {
          const undoIpc = getUndoStacksIpc()
          const s0 = get()
          if (
            undoIpc &&
            s0._undoStack.length === 0 &&
            s0._redoStack.length === 0 &&
            s0._actionUndoStack.length === 0 &&
            s0._actionRedoStack.length === 0
          ) {
            const hydrateBranchId = s0.projectActiveBranchId ?? null
            void hydrateUndoStacks(undoIpc, { projectId, branchId: hydrateBranchId }).then((payload) => {
              if (!payload) return
              const s = get()
              if (s.project?.id !== projectId || (s.projectActiveBranchId ?? null) !== hydrateBranchId) return
              if (s._undoStack.length > 0 || s._actionUndoStack.length > 0) return
              set({
                _undoStack: payload.undoStack,
                _redoStack: payload.redoStack,
                _actionUndoStack: payload.actionUndoStack,
                _actionRedoStack: payload.actionRedoStack,
              })
            })
          }
        }
      } catch (e) {
        log.error('failed to load project', { error: e })
      }
    },

    switchProjectBranch: async (branchId: string, opts?: { confirmedAbortRun?: boolean }) => {
      const { project } = get()
      if (!project?.id) return
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
      if (!ipc) return
      // Guard: don't switch to the already-active branch.
      if (get().projectActiveBranchId === branchId) return
      // VS Code operation wrapper: block concurrent branch switches.
      if (get().branchOperation) return
      // Confirm gate: a live agent run would be aborted by the switch
      // (its scene writes target the current branch). Require explicit
      // confirmation ONLY in that case — otherwise the switch is silent. The
      // component (BranchSelector) shows the dialog and re-invokes with
      // confirmedAbortRun:true. No live run → no friction.
      if (get().isAgentRunning && !opts?.confirmedAbortRun) {
        set({ branchSwitchNeedsConfirm: { kind: 'branch', targetId: branchId } })
        return
      }
      set({ branchOperation: { kind: 'switch', branchId }, branchSwitchNeedsConfirm: null })
      // Abort the live run before flushing/loading so its in-flight scene writes
      // don't race the branch swap (the user confirmed this above).
      if (get().isAgentRunning) get().abortAgentRun()
      try {
        // Flush any pending edits before checkout (VS Code maybeAutoStash pattern).
        // AWAIT the flush and BLOCK loudly on failure — never switch over
        // unsaved state. flushSaveProjectToDb enqueues synchronously and reports
        // {ok}; on a no-op (nothing dirty) it resolves ok:true cheaply.
        const flush = await get().flushSaveProjectToDb()
        if (!flush.ok) {
          set({
            branchOperation: null,
            projectSaveStatus: 'error',
            projectSaveError: get().projectSaveError ?? 'Could not save before switching branch — switch cancelled.',
          })
          log.error('switchProjectBranch: pre-switch flush failed, blocking switch')
          return
        }
        // Park the OUTGOING branch's undo history under its own key before
        // the in-memory wipe below, so switching back restores it. Flush (not
        // just schedule) — the debounce must not race the wipe.
        scheduleDurablePersistFromState(get())
        await flushDurableUndoPersist()
        // loadEditorScenes also flushes pending version timers on the main-process side.
        const { scenes: branchScenes } = await ipc.loadEditorScenes({ projectId: project.id, branchId })
        // Guard: if the user switched projects while the IPC was in-flight, discard
        // the result — applying branch scenes from a different project would corrupt state.
        if (get().project.id !== project.id) {
          set({ branchOperation: null })
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set({
          scenes: (branchScenes as any[]).map(normalizeScene),
          projectActiveBranchId: branchId,
          selectedSceneId: (branchScenes as any[])[0]?.id ?? null,
          branchOperation: null,
          // Undo history belongs to the branch it was captured
          // on. A legacy snapshot (or action inverse) replayed after a switch
          // writes the OTHER branch's scenes into this one — cross-branch
          // contamination via Cmd+Z. Losing undo history on switch is the
          // standard branching-editor tradeoff; state rewind across branches
          // is the branch system's job.
          _undoStack: [],
          _redoStack: [],
          _actionUndoStack: [],
          _actionRedoStack: [],
          // Pre-run snapshots are branch-local for the same reason — a
          // checkpoint-coupled restore using one captured on another branch
          // would pour that branch's scenes into this one.
          _runSnapshots: [],
        })
        clearPersistedUndoStacks()
        // Restore the TARGET branch's parked undo history (if any). Still
        // Branch-safe — only ever stacks captured on THIS branch. Guarded against
        // a project/branch change racing the async load.
        {
          const undoIpc = getUndoStacksIpc()
          if (undoIpc) {
            void hydrateUndoStacks(undoIpc, { projectId: project.id, branchId }).then((payload) => {
              if (!payload) return
              const s = get()
              if (s.project.id !== project.id || s.projectActiveBranchId !== branchId) return
              if (s._undoStack.length > 0 || s._actionUndoStack.length > 0) return // user already edited
              set({
                _undoStack: payload.undoStack,
                _redoStack: payload.redoStack,
                _actionUndoStack: payload.actionUndoStack,
                _actionRedoStack: payload.actionRedoStack,
              })
            })
          }
        }
        // Proposals are branch-scoped (0015): drop the prior branch's card
        // immediately, then hydrate this branch's row. Without this the
        // previous branch's proposal/paused-run would linger after the switch.
        get().resetBranchProposals()
        void get().loadBranchProposals(project.id, branchId)
        // Open and activate this branch's preview tab.
        const { projectDefaultBranchId, setCenterTab } = get()
        const tabId =
          projectDefaultBranchId && branchId === projectDefaultBranchId ? 'preview' : (`preview:${branchId}` as const)
        setCenterTab(tabId)
        // Persist so the next app start restores this branch automatically.
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`dreambyte:activeBranch:${project.id}`, branchId)
        }
      } catch (err) {
        set({ branchOperation: null })
        log.error('switchProjectBranch failed', { error: err })
        if (typeof localStorage !== 'undefined') {
          const stored = localStorage.getItem(`dreambyte:activeBranch:${project.id}`)
          if (stored === branchId) localStorage.removeItem(`dreambyte:activeBranch:${project.id}`)
        }
      }
    },

    reloadActiveBranch: async () => {
      const { project, projectActiveBranchId } = get()
      if (!project?.id || !projectActiveBranchId) return
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
      if (!ipc) return
      const { scenes: branchScenes } = await ipc.loadEditorScenes({
        projectId: project.id,
        branchId: projectActiveBranchId,
      })
      // Discard if the user navigated away while the IPC was in flight.
      if (get().project.id !== project.id) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = branchScenes as any[]
      set({
        scenes: list.map(normalizeScene),
        selectedSceneId: list.find((s) => s?.id === get().selectedSceneId)?.id ?? list[0]?.id ?? null,
      })
    },

    // Phase B: promote a variant branch's content onto the target branch (main).
    // Scene ids are globally unique, so we CLONE the winner's scenes with fresh
    // ids (remapping the scene graph) rather than copy them by id, then replace
    // the target's content via an inverse-able agent/applyRun (Cmd+Z restores
    // main's prior content). HTML files for the new ids are regenerated from each
    // scene's code. Losing branches are optionally discarded after.
    promoteBranch: async (
      sourceBranchId: string,
      targetBranchId?: string | null,
      opts?: { discardBranchIds?: string[] },
    ) => {
      const { project, projectDefaultBranchId } = get()
      if (!project?.id) return
      const target = targetBranchId ?? projectDefaultBranchId
      if (!target) {
        log.warn('promoteBranch: no target/default branch to promote onto')
        return
      }
      if (target === sourceBranchId) return // already canonical
      if (get().branchOperation) return // serialize branch ops
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
      if (!ipc?.loadEditorScenes) return
      // Do NOT claim branchOperation before switchProjectBranch — its own guard
      // (`if (get().branchOperation) return`) would refuse the switch and abort
      // the entire promote. We claim it only for the post-switch phase below.
      try {
        // 1. Read the winner's full content (scenes carry their code).
        const { scenes: srcScenesRaw, sceneGraph: srcGraph } = await ipc.loadEditorScenes({
          projectId: project.id,
          branchId: sourceBranchId,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const srcScenes = (srcScenesRaw as any[]).map(normalizeScene)
        // Empty-winner guard: promoting a 0-scene branch would wipe the target.
        if (srcScenes.length === 0) {
          log.warn('promoteBranch: winner branch has no scenes — aborting (would wipe target)')
          return
        }
        // 2. Build the old→new id map, then remap EVERY scene-id cross-reference
        //    via the shared helpers (interaction jump targets in remapSceneIds;
        //    graph nodes/edges/start + fresh edge ids in remapSceneGraphIds), or
        //    the promoted branch would have dangling refs to the winner's ids.
        const idMap = new Map<string, string>()
        for (const s of srcScenes) idMap.set(s.id, uuidv4())
        const cloned = srcScenes.map((s) => remapSceneIds(s, idMap))
        const remappedGraph = srcGraph ? remapSceneGraphIds(srcGraph as SceneGraph, idMap) : null
        // 3. Switch the editor to the target branch (shows main's current content).
        await get().switchProjectBranch(target)
        if (get().projectActiveBranchId !== target) {
          log.warn('promoteBranch: target switch rejected, aborting promote')
          return
        }
        // Claim the branch-op lock now (switchProjectBranch manages its own and
        // has cleared it) for the apply/HTML/discard phase.
        set({ branchOperation: { kind: 'promote', branchId: sourceBranchId } })
        // 4. Replace target content via the inverse-able full-state action. The
        //    reducer snapshots main's prior content as the inverse (undoable).
        const result = get().dispatchAction(
          {
            type: 'agent/applyRun',
            params: {
              scenes: cloned,
              globalStyle: get().globalStyle,
              ...(remappedGraph ? { sceneGraph: remappedGraph } : {}),
              // Timeline intentionally omitted: it's project-scoped (Gap 5), so
              // there's no per-branch timeline to carry. syncTimelineFromScenes
              // rebuilds scene clips for the promoted scenes on the next render.
            },
          },
          { source: 'user' },
        )
        if (!result.success) {
          log.error('promoteBranch: agent/applyRun rejected', { extra: { error: result.error } })
          set({ branchOperation: null })
          return
        }
        // 5. Regenerate HTML files for the cloned scenes (new ids have no file yet).
        await Promise.all(
          cloned.map((c) =>
            get()
              .saveSceneHTML(c.id, true)
              .catch(() => {}),
          ),
        )
        // 6. Discard losing variant branches (best-effort — orphans are inert).
        for (const loser of opts?.discardBranchIds ?? []) {
          if (loser === target) continue // never delete the branch we promoted onto
          try {
            await ipc.delete({ projectId: project.id, id: loser })
          } catch (delErr) {
            log.warn('promoteBranch: failed to discard losing branch', { extra: { loser }, error: delErr })
          }
        }
        set({ lastVariantsSpawn: null, isVariantComparisonOpen: false })
      } catch (err) {
        log.error('promoteBranch failed', { error: err })
      } finally {
        set({ branchOperation: null })
      }
    },

    // Hydrate the agent proposal/handoff state for ONE branch (0015). Proposals
    // are branch-scoped now (own table), so this is called on project load and
    // on every branch switch — never read from the project row. Guards against
    // the project changing mid-flight. No-op-clears if the branch has no row.
    loadBranchProposals: async (projectId: string, branchId: string | null) => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
      if (!ipc?.getProposals) {
        get().resetBranchProposals()
        return
      }
      try {
        const { proposals } = await ipc.getProposals({ projectId, branchId })
        // Discard if the user switched project OR branch while the IPC was in
        // flight — otherwise a slow A-load can paint A's proposals onto branch B
        // after a fast A→B switch. Both must still match what we loaded for.
        if (get().project.id !== projectId || get().projectActiveBranchId !== branchId) return
        if (!proposals) {
          get().resetBranchProposals()
          return
        }
        set({
          structuralCutsProposed: (proposals.structuralCutsProposed as StructuralCut[] | null) ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pausedAgentRun: (proposals.pausedAgentRun as any) ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // Compat: migrate the legacy `storyboard` key on
          // checkpoints persisted before the ScenePlan rename.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runCheckpoint: normalizeCheckpointKeys((proposals.runCheckpoint as any) ?? null),
          proposalsVersion: (proposals.version as number | undefined) ?? 0,
        })
      } catch (e) {
        log.warn('loadBranchProposals failed', { error: e })
      }
    },

    // Persist ONE proposal field to the active branch's branch_proposals row
    // (0015) and sync the local version. The single client-side write path for
    // user actions (apply/dismiss a card, clear a checkpoint) — replaces the old
    // projects.update writes that targeted the (now-removed) project columns.
    persistBranchProposalField: async (
      field: 'structuralCutsProposed' | 'pausedAgentRun' | 'runCheckpoint',
      value: unknown,
    ) => {
      const { project, projectActiveBranchId } = get()
      if (!project?.id) return
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
      if (!ipc?.setProposal) return
      try {
        const { version } = await ipc.setProposal({
          projectId: project.id,
          branchId: projectActiveBranchId,
          field,
          value: value ?? null,
        })
        set({ proposalsVersion: version })
      } catch (e) {
        log.warn('persistBranchProposalField failed', { extra: { field }, error: e })
      }
    },

    // Clear all proposal/handoff state in the store. Called before hydrating a
    // different branch so the prior branch's card can't linger on screen.
    resetBranchProposals: () => {
      set({
        structuralCutsProposed: null,
        pausedAgentRun: null,
        runCheckpoint: null,
        proposalsVersion: 0,
      })
    },

    saveProjectToDb: () => {
      // Serialize behind any in-flight save (see _saveChain above). When no
      // save is active, run the body SYNCHRONOUSLY in this tick (its
      // stale-capture guards snapshot state before the first await); under
      // contention, append to the chain — the queued save re-reads fresh
      // store state when it executes, so a later caller's newer edits are
      // what actually persist.
      const inner = async () => {
        try {
          return await get()._saveProjectToDbUnchained()
        } finally {
          _activeSaves -= 1
        }
      }
      const wasIdle = _activeSaves === 0
      _activeSaves += 1
      // A failed predecessor must not wedge the chain (.catch before .then).
      const run = wasIdle ? inner() : _saveChain.catch(() => {}).then(inner)
      _saveChain = run
      return run
    },

    /**
     * The actual save. INTERNAL — always call `saveProjectToDb` (the chained
     * wrapper) instead; calling this directly re-opens the concurrent-save
     * crash-marker race the chain exists to close.
     */
    _saveProjectToDbUnchained: async () => {
      // Preempt any pending debounced save so the 30s poll / beforeunload /
      // manual callers don't double-fire with the scheduled timer.
      if (_scheduledSaveTimer) {
        clearTimeout(_scheduledSaveTimer)
        _scheduledSaveTimer = null
      }
      const { project, scenes, globalStyle, audioProviderEnabled, mediaGenEnabled, _dbLoadComplete } = get()
      // Captured pre-await so the post-await bail can detect a BRANCH switch
      // too — the version-CAS is project-scoped, not branch-scoped, so a save
      // that started on branch A must not route its write to branch B.
      const branchIdAtStart = get().projectActiveBranchId ?? null
      // Don't save until DB has been loaded — prevents overwriting real data
      // with empty localStorage-hydrated scenes
      if (!_dbLoadComplete) return
      // Skip the server save when there's no real project id. On boot the
      // persisted `project` can hydrate with id:'' (inconsistent with the
      // persisted activeProjectId) in the window before loadProject reconciles
      // it; calling the UUID-validated IPCs (getVersion/update) with '' only
      // logs IpcValidationError noise, and there is no DB row to save against.
      if (!isValidUuid(project.id)) return
      // Eager draft model: a new project is already a real DB row (status=
      // 'draft') from creation, so there is no draft early-return here — the
      // update path covers drafts and the startup sweep handles untouched ones.
      set({ projectSaveStatus: 'saving', projectSaveError: null })
      const localRich = scenes.some(sceneHasRenderableContent)

      // Pull server state into the editor when local is clearly behind (stripped persist / wrong tab).
      const pullFromDb = () => {
        void get().refreshProjectFromServer()
      }

      // Cold start (load failure recovery, a project minted without a create
      // response) leaves us with no CAS baseline. Fetch one — cheap, scalar
      // columns only, and skipped on the !localRich path below which already
      // round-trips getVersion.
      if (localRich && baseVersionFor(project.id) === null) {
        const ipc = projectsIpc()
        const probe = ipc?.getVersion ? await ipc.getVersion(project.id).catch(() => null) : null
        if (probe) noteDbVersion(project.id, probe.version)
      }

      // Stripped-localStorage guard: only runs when local has no renderable content.
      // When local IS rich we skip the DB comparison entirely — that's the 95%+ path.
      // Uses ipc.getVersion (lightweight: version+updatedAt+sceneCount+hasRichContent,
      // no scene blob deserialization) instead of the previous full ipc.get round-trip.
      if (!localRich) {
        let dbVer: { version: number; updatedAt: Date; sceneCount: number; hasRichContent: boolean } | null = null
        try {
          const ipc = projectsIpc()
          if (ipc?.getVersion) {
            dbVer = await ipc.getVersion(project.id).catch(() => null)
          }
        } catch {
          /* proceed without snapshot */
        }

        if (dbVer) {
          noteDbVersion(project.id, dbVer.version)
          const dbTime = new Date(dbVer.updatedAt).getTime()
          const ourTime = new Date(project.updatedAt).getTime()
          if (dbTime > ourTime) {
            if (dbVer.hasRichContent) pullFromDb()
            set({ projectSaveStatus: 'saved', projectLastSavedAt: Date.now(), projectSaveError: null })
            return
          }
          if (dbVer.hasRichContent && dbVer.sceneCount > scenes.length) {
            log.warn('saveProjectToDb: skipping, DB has more scenes than local (rehydration/stale client)')
            pullFromDb()
            set({ projectSaveStatus: 'saved', projectLastSavedAt: Date.now(), projectSaveError: null })
            return
          }
          if (dbVer.hasRichContent && dbVer.sceneCount === scenes.length && scenes.length > 0) {
            log.warn('saveProjectToDb: skipping, DB has scene content, local is empty (stripped localStorage)')
            pullFromDb()
            set({ projectSaveStatus: 'saved', projectLastSavedAt: Date.now(), projectSaveError: null })
            return
          }
        }
      }

      // Stale-capture guard: the getVersion round-trip above (stripped-
      // localStorage path) is an await window — scenes added or settings
      // changed during it (agent stream sync, user edit) must not be clobbered
      // by the top-of-function snapshot. The guards above intentionally used
      // the pre-await snapshot; the WRITE below uses fresh state. Bail if the
      // active project switched during the await — loadProject pre-saves the
      // outgoing project itself, and mixing the old row id with the new
      // project's state would cross-write projects.
      const freshAtWrite = get()
      if (freshAtWrite.project.id !== project.id || (freshAtWrite.projectActiveBranchId ?? null) !== branchIdAtStart) {
        // Project OR branch switched mid-await. The switch paths flush/pre-save
        // the outgoing state themselves; abandoning this stale save is the
        // correct move. Reset the 'saving' claim we made above — leaving it
        // stranded depended on the 30s poll to clean up.
        set({ projectSaveStatus: 'idle' })
        return
      }
      const wProject = freshAtWrite.project
      const wScenes = freshAtWrite.scenes
      // ONE branchId for the marker set, the write payload, and every marker
      // clear below. Re-reading get() at each site let a branch switch during
      // ipc.update clear a DIFFERENT key than was set, orphaning the crash
      // marker (false "work may be missing" at next boot).
      const writeBranchId = freshAtWrite.projectActiveBranchId ?? null

      // Durable crash marker: synchronous localStorage write BEFORE the
      // DB attempt so a crash mid-save is detectable at next boot. Cleared on
      // every confirmed-save path below; left in place when the save throws
      // (projectSaveStatus 'error' covers the live session, the marker covers
      // the crash+reboot case the in-memory flag can't).
      const markerNonce = setPendingSaveMarker({
        projectId: wProject.id,
        branchId: writeBranchId,
        sceneIds: wScenes.map((s) => s.id),
        ts: Date.now(),
      })

      try {
        const patchUpdates = {
          name: wProject.name,
          outputMode: wProject.outputMode,
          globalStyle: freshAtWrite.globalStyle,
          mp4Settings: wProject.mp4Settings,
          interactiveSettings: wProject.interactiveSettings,
          apiPermissions: wProject.apiPermissions,
          audioSettings: wProject.audioSettings,
          audioProviderEnabled: freshAtWrite.audioProviderEnabled,
          mediaGenEnabled: freshAtWrite.mediaGenEnabled,
          watermark: wProject.watermark,
          brandKit: wProject.brandKit,
          scenes: wScenes,
          sceneGraph: wProject.sceneGraph,
          timeline: wProject.timeline ?? null,
          branchId: writeBranchId,
          // The compare-and-swap baseline. Main rejects a scene write whose
          // baseline is stale, which is what stops this save from overwriting
          // scenes an agent (or another window) wrote since we last looked.
          baseVersion: baseVersionFor(wProject.id),
        }

        const ipc = projectsIpc()
        if (!ipc) {
          log.error('saveProjectToDb: projects IPC unavailable')
          return
        }
        {
          let savedProject: Record<string, unknown> | null = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              savedProject = (await ipc.update({ projectId: project.id, updates: patchUpdates })) as Record<
                string,
                unknown
              >
              break
            } catch (err) {
              // Narrow to OUR shaped errors via message prefix, not substring.
              // IpcConflictError serializes as `Error: Project was modified concurrently…`;
              // IpcNotFoundError serializes as `Error: Project <uuid> not found`.
              // Substring match, NOT anchored/startsWith: Electron's
              // ipcRenderer.invoke wraps the message as "Error invoking remote
              // method '…': <Name>: <message>", so an anchored `^Project…$` (or
              // `startsWith`) never matches and the create-on-404 / conflict-retry
              // silently no-op. We still match the full distinctive phrases so a
              // pg "ON CONFLICT" mention can't be mistaken for our conflict error.
              const msg = (err as Error).message ?? ''
              const isConflict = msg.includes('Project was modified concurrently')
              const isNotFound = /Project\s+[0-9a-f-]+\s+not found/i.test(msg)
              if (isConflict && attempt < 2) {
                log.warn('saveProjectToDb: conflict, retrying', { extra: { attempt: attempt + 1 } })
                await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)))
                try {
                  // Re-fetch full project so patchUpdates includes any scenes the MCP
                  // bridge wrote between our last read and now. Without this, retrying
                  // with the original patchUpdates would silently clobber agent-written scenes.
                  // Branch-aware (#156 latent finding): pass the branch this save WRITES
                  // to — the no-arg form returns DEFAULT-branch scenes, which is a
                  // different document when the editor is on another branch, and merging
                  // against it would clobber the write branch with main's scenes.
                  const fresh = await ipc.get(project.id, writeBranchId ?? undefined)
                  if (fresh) {
                    // Adopt the winner's version as the new CAS baseline —
                    // without this the retry re-sends the stale one and every
                    // attempt conflicts identically.
                    noteDbVersion(project.id, (fresh as Record<string, unknown>).version)
                    patchUpdates.baseVersion = baseVersionFor(project.id)
                    if (fresh.updatedAt) {
                      set({
                        project: {
                          ...get().project,
                          updatedAt: new Date(fresh.updatedAt as string | number).toISOString(),
                        },
                      })
                    }
                    if (Array.isArray((fresh as any).scenes)) {
                      // Normalize like every other DB→store path (loadProject /
                      // refreshProjectFromServer) — the retry was the one path
                      // injecting raw JSON.parse output into the store/payload
                      // (review #156). Also keeps the delete-honor hash compare
                      // shape-consistent with the renderer-built baseline.
                      const remoteScenes = ((fresh as any).scenes as typeof wScenes).map(
                        normalizeScene,
                      ) as typeof wScenes
                      const base = _sceneBaseline
                      if (base && base.projectId === wProject.id && (base.branchId ?? null) === writeBranchId) {
                        // Per-scene 3-way merge : scenes WE
                        // edited since the last agreed state keep their slot;
                        // everything we didn't touch takes the remote (agent)
                        // version. Full rule table in scene-reconcile.ts.
                        const { merged, keptLocalIds, droppedIds } = reconcileScenesForRetry(
                          wScenes,
                          remoteScenes,
                          base.map,
                        )
                        patchUpdates.scenes = merged
                        log.info('saveProjectToDb: conflict retry merged per-scene', {
                          extra: {
                            keptLocal: keptLocalIds.length,
                            dropped: droppedIds.length,
                            remote: remoteScenes.length,
                            merged: merged.length,
                          },
                        })
                      } else {
                        // No baseline for THIS project+branch (first save after
                        // a path that didn't refresh it) — degrade to the old
                        // agent-wins substitution. Regression-free fallback;
                        // bounded by the 30s poll re-saving local state.
                        patchUpdates.scenes = remoteScenes
                      }
                    }
                  }
                } catch {
                  /* proceed with stale patchUpdates — better than no retry */
                }
                continue
              }
              if (isNotFound) {
                // Project doesn't exist yet — create it
                await ipc.create({
                  id: project.id,
                  ...patchUpdates,
                })
                set({
                  _isDirty: false,
                  projectSaveStatus: 'saved',
                  projectLastSavedAt: Date.now(),
                  projectSaveError: null,
                })
                setSceneBaseline(wProject.id, writeBranchId, patchUpdates.scenes)
                clearPendingSaveMarker(wProject.id, writeBranchId, markerNonce)
                return
              }
              throw err
            }
          }
          if (savedProject) noteDbVersion(wProject.id, savedProject.version)
          if (savedProject && typeof savedProject.updatedAt === 'string') {
            set({
              project: { ...get().project, updatedAt: savedProject.updatedAt },
              _isDirty: false,
              projectSaveStatus: 'saved',
              projectLastSavedAt: Date.now(),
              projectSaveError: null,
            })
          } else {
            set({ _isDirty: false, projectSaveStatus: 'saved', projectLastSavedAt: Date.now(), projectSaveError: null })
          }
          // The DB now holds patchUpdates.scenes — that IS the new agreed
          // state (item 8a). When the conflict retry merged remote scenes in,
          // also converge the STORE onto the merged array — but only if no
          // edit landed since this save captured wScenes (zustand replaces the
          // array on every mutation, so reference equality is exactly the
          // "untouched since" check); otherwise leave the store alone and let
          // the next save/poll converge.
          setSceneBaseline(wProject.id, writeBranchId, patchUpdates.scenes)
          if (
            patchUpdates.scenes !== wScenes &&
            get().scenes === wScenes &&
            get().project.id === wProject.id &&
            (get().projectActiveBranchId ?? null) === writeBranchId
          ) {
            // Re-validate the selection like every sibling DB→store path —
            // the merge can legitimately drop the SELECTED scene (an honored
            // delete), and a dangling selectedSceneId blanks the editor and
            // preview (review #156, red team).
            const sel = get().selectedSceneId
            const mergedList = patchUpdates.scenes as typeof wScenes
            set({
              scenes: mergedList,
              sceneHtmlVersion: get().sceneHtmlVersion + 1,
              selectedSceneId: sel && mergedList.some((s) => s.id === sel) ? sel : (mergedList[0]?.id ?? null),
            })
          }
          clearPendingSaveMarker(wProject.id, writeBranchId, markerNonce)
        }
      } catch (e) {
        log.error('failed to save project', { error: e })
        // Marker intentionally NOT cleared — boot reconciliation reports it if
        // the app dies before a later save succeeds.
        set({ projectSaveStatus: 'error', projectSaveError: (e as Error).message ?? 'Project save failed' })
      }
    },

    scheduleSaveProjectToDb: () => {
      const { isAgentRunning, _dbLoadComplete } = get()
      // The agent has its own write path via syncScenesFromAgent — don't race it.
      // Before the initial DB load completes, saveProjectToDb is a no-op anyway.
      if (isAgentRunning || !_dbLoadComplete) return
      set({ _isDirty: true, projectSaveStatus: 'saving', projectSaveError: null })
      if (_scheduledSaveTimer) clearTimeout(_scheduledSaveTimer)
      _scheduledSaveTimer = setTimeout(() => {
        _scheduledSaveTimer = null
        void get().saveProjectToDb()
      }, SCHEDULED_SAVE_DEBOUNCE_MS)
    },

    flushSaveProjectToDb: () => {
      // Synchronous-enqueue save for unload events AND the pre-switch flush
      // Skips the conflict-resolution ipc.get roundtrip that
      // saveProjectToDb does — that await chain breaks during Cmd+R reload
      // because the renderer navigates before ipc.get resolves, and the
      // subsequent ipc.update never gets queued.
      //
      // The IPC update message is enqueued synchronously by postMessage, so
      // main receives and writes to SQLite even after the renderer has moved
      // on. Last-write-wins is acceptable here since the unload moment is
      // inherently a single user gesture.
      //
      // Returns a Promise<{ ok }> so the branch/conversation switch can AWAIT
      // the flush and BLOCK loudly on failure (never proceed over unsaved
      // state). Unload callers fire-and-forget and ignore the promise — the
      // synchronous enqueue above is what matters for them.
      const { project, scenes, globalStyle, audioProviderEnabled, mediaGenEnabled, _dbLoadComplete } = get()
      // Eager draft model: the row already exists (status='draft'), so there is
      // no draft early-return — the normal update path covers drafts too.
      if (!_dbLoadComplete || !project?.id) return Promise.resolve({ ok: true })
      // The CAS baseline. This path cannot fetch one — it must enqueue the IPC
      // synchronously while the renderer is unloading — so it sends what it
      // knows, including `null`. Main rejects a scene write without a baseline
      // rather than falling back to last-writer-wins; the rejection lands in
      // the .catch below as ok:false, which the awaiting switch callers already
      // treat as "block the switch". Unload callers still have the crash marker
      // and the localStorage-persisted store for boot reconciliation.
      const baseVersion = baseVersionFor(project.id)
      set({ projectSaveStatus: 'saving', projectSaveError: null })
      if (_scheduledSaveTimer) {
        clearTimeout(_scheduledSaveTimer)
        _scheduledSaveTimer = null
      }
      const patchUpdates = {
        name: project.name,
        outputMode: project.outputMode,
        globalStyle,
        mp4Settings: project.mp4Settings,
        interactiveSettings: project.interactiveSettings,
        apiPermissions: project.apiPermissions,
        audioSettings: project.audioSettings,
        audioProviderEnabled,
        mediaGenEnabled,
        watermark: project.watermark,
        brandKit: project.brandKit,
        scenes,
        sceneGraph: project.sceneGraph,
        timeline: project.timeline ?? null,
        branchId: get().projectActiveBranchId ?? null,
        baseVersion,
      }
      const ipc = projectsIpc()
      // Durable crash marker: write a synchronous localStorage marker
      // BEFORE the DB attempt so a crash mid-flush (the renderer may be
      // unmounting during unload) is detectable at next boot. Cleared on
      // confirmation in the .then; LEFT IN PLACE on failure so boot-time
      // reconciliation can resolve it — that is the marker's purpose.
      const flushBranchId = get().projectActiveBranchId ?? null
      const flushNonce = setPendingSaveMarker({
        projectId: project.id,
        branchId: flushBranchId,
        sceneIds: scenes.map((s) => s.id),
        ts: Date.now(),
      })
      if (!ipc) {
        // No IPC bridge — treat as a failed flush so the caller can block. The
        // unload path ignores this; only the awaiting switch acts on it. The
        // marker stays for boot reconciliation.
        set({ projectSaveStatus: 'error', projectSaveError: 'Save failed (desktop runtime unavailable)' })
        return Promise.resolve({ ok: false })
      }
      // The message is enqueued synchronously here (unload-safe). The returned
      // promise lets the switch path observe success/failure.
      return ipc
        .update({ projectId: project.id, updates: patchUpdates })
        .then((saved: unknown) => {
          noteDbVersion(project.id, (saved as Record<string, unknown> | null)?.version)
          set({ projectSaveStatus: 'saved', projectLastSavedAt: Date.now(), projectSaveError: null, _isDirty: false })
          clearPendingSaveMarker(project.id, flushBranchId, flushNonce)
          return { ok: true as const }
        })
        .catch((err: unknown) => {
          // Leave the marker in place — boot reconciliation owns the recovery.
          set({ projectSaveStatus: 'error', projectSaveError: (err as Error)?.message ?? 'Project save failed' })
          return { ok: false as const }
        })
    },

    deleteProjectFromDb: async (projectId: string) => {
      try {
        const ipc = projectsIpc()
        if (!ipc) {
          log.error('deleteProjectFromDb: projects IPC unavailable')
          return
        }
        await ipc.delete(projectId)
        await get().fetchProjectList()
      } catch (e) {
        log.error('failed to delete project', { error: e })
      }
    },
  }
}
