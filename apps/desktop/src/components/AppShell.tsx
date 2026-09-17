'use client'

import { useEffect, useState } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { resolveUIFontStack } from '@/lib/ui-font'
import Editor from './Editor'
import AgentChatHost from './chat/AgentChatHost'
import ChatScenePreview from './chat/ChatScenePreview'
import { SettingsNav, SettingsContent } from './SettingsPanel'
import HomeSidebar from './home/HomeSidebar'
import HomeStage from './home/HomeStage'
import { CommandPalette } from './CommandPalette'
import EditorLayersPanel from './home/EditorLayersPanel'
import CenterTabs from './editor/CenterTabs'
import EditorHeaderTools from './editor/EditorHeaderTools'
import WorkspaceView from './WorkspaceView'
import MediaLibrary from './MediaLibrary'
import AgentRunNotifier from './AgentRunNotifier'
import NewProjectModal from './NewProjectModal'

const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)
const noDrag = isElectron ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined

/**
 * Top-level unified shell. One frame across home / chat / editor: a draggable
 * header strip (traffic-light inset), a docked sidebar (--bg) whose CONTENTS
 * swap by view, and a floating content card (--panel). Flipping [Chat|Editor]
 * never changes the shell — only the three regions swap (sidebar -> scenes/
 * layers, content -> canvas+timeline). Editor renders in `embedded` mode inside the content card.
 */
export default function AppShell() {
  const appView = useVideoStore((s) => s.appView)
  const projectView = useVideoStore((s) => s.projectView)
  const setAppView = useVideoStore((s) => s.setAppView)
  const fetchProjectList = useVideoStore((s) => s.fetchProjectList)
  const project = useVideoStore((s) => s.project)
  const activeProjectId = useVideoStore((s) => s.activeProjectId)
  const activeConversationId = useVideoStore((s) => s.activeConversationId)
  const globalStyle = useVideoStore((s) => s.globalStyle)

  // Content-area overlay + sidebar collapse live in the store (persisted) so a
  // refresh resumes the same panel — e.g. being in Settings survives a reload.
  const contentView = useVideoStore((s) => s.contentView)
  const setContentView = useVideoStore((s) => s.setContentView)
  const settingsSection = useVideoStore((s) => s.settingsSection)
  const setSettingsSection = useVideoStore((s) => s.setSettingsSection)
  const collapsed = useVideoStore((s) => s.sidebarCollapsed)
  const setCollapsed = useVideoStore((s) => s.setSidebarCollapsed)
  const setCenterTab = useVideoStore((s) => s.setCenterTab)
  // Command palette: trigger lives in the store. The editor renders
  // its own palette (full command set); the shell renders it for home/chat so
  // the Search button works everywhere. Mutually exclusive views ⇒ no double render.
  const commandPaletteOpen = useVideoStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useVideoStore((s) => s.setCommandPaletteOpen)
  const projectList = useVideoStore((s) => s.projectList)
  const openProject = useVideoStore((s) => s.openProject)
  const setSettingsSection2 = useVideoStore((s) => s.setSettingsSection)

  // Transient hover-peek for the collapsed sidebar — intentionally NOT persisted.
  const [peek, setPeek] = useState(false)

  const settingsOpen = contentView === 'settings'
  const workspacesOpen = contentView === 'workspaces'
  const libraryOpen = contentView === 'library'

  useEffect(() => {
    void fetchProjectList()
  }, [fetchProjectList])

  // Editor theme + UI font are global preferences: apply them at the shell root
  // (always mounted) so toggling in Settings takes effect immediately, in any
  // view — not only after the editor mounts.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.remove('light-theme', 'blue-theme')
    if (globalStyle.theme === 'light') {
      root.classList.add('light-theme')
    } else if (globalStyle.theme === 'blue') {
      root.classList.add('blue-theme')
    }
    root.style.setProperty('--font-global', globalStyle.fontOverride ?? globalStyle.font ?? 'Geist')
    root.style.setProperty('--font-ui', resolveUIFontStack(globalStyle))
    const scaleMap = ['0.9', '1', '1.1', '1.2']
    root.style.setProperty('--ui-zoom', scaleMap[globalStyle.uiTextSize ?? 1] ?? '1')
    if (isElectron) root.classList.add('electron-app')
    else root.classList.remove('electron-app')
  }, [
    globalStyle.theme,
    globalStyle.font,
    globalStyle.fontOverride,
    globalStyle.uiTypography,
    globalStyle.uiFontFamily,
    globalStyle.uiTextSize,
  ])

  const inProject = appView === 'project'
  // Flipping to Editor with no project open mints an in-memory draft (see
  // setProjectView in the store), so by the time the editor renders there is
  // always an active project — possibly an unsaved draft.
  const inEditor = inProject && projectView === 'editor'

  // The content-area destinations (Settings / Customize / Workspaces / Library)
  // are a single mutually-exclusive enum — opening one replaces whatever was open.
  const openSettings = () => setContentView('settings')
  const openWorkspaces = () => setContentView('workspaces')
  // In the editor the Library opens as a center tab (it lives alongside Preview /
  // Export); on home/chat there are no tabs, so it takes over the content card.
  const openLibrary = () => {
    if (inEditor) setCenterTab('media')
    else setContentView('library')
  }

  // Navigating in the sidebar — picking a project/chat, hitting New Video, or
  // toggling Chat/Editor — dismisses the Library and Workspaces overlays so the
  // chosen content shows. (Both keep the HomeSidebar visible, so the user can
  // click straight through to other destinations and expects them to take.)
  // Settings is left open intentionally: it replaces the sidebar entirely, so
  // there's nothing to click through to — you leave it via its own Back button.
  useEffect(() => {
    const cv = useVideoStore.getState().contentView
    if (cv === 'library' || cv === 'workspaces') setContentView('none')
  }, [activeProjectId, activeConversationId, projectView, setContentView])

  return (
    // A full-width draggable top bar holds the controls; below it
    // the sidebar + content card sit side by side. The content card tucks UNDER
    // the top bar with rounded corners (top-left rounds into the sidebar gap).
    <div className="relative flex h-screen flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      {/* Fires General-tab notification prefs on agent-run completion (renders null). */}
      <AgentRunNotifier />
      {/* New-project modal (name + dimensions) — mounted at the shell so it works
          from the Projects gate and the editor alike (renders null until opened). */}
      <NewProjectModal />
      {/* Top bar — full width, draggable, transparent. Clears traffic lights (pl-20). */}
      <header
        className={`flex h-10 shrink-0 items-center gap-0.5 pr-3 ${isElectron ? 'pl-20' : 'pl-2'}`}
        style={isElectron ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <button
          onClick={() => setCollapsed(!collapsed)}
          onMouseEnter={() => collapsed && setPeek(true)}
          className="no-style grid h-8 w-8 place-items-center rounded-[var(--radius-md)] text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
          style={noDrag}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
        >
          <PanelLeft size={17} />
        </button>
        <button
          onClick={() => setCommandPaletteOpen(true)}
          aria-label="Search"
          className="no-style grid h-8 w-8 place-items-center rounded-[var(--radius-md)] text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
          style={noDrag}
          title="Search"
        >
          <Search size={16} />
        </button>

        {settingsOpen ? (
          <span className="ml-2 text-[13px] font-medium text-[var(--ink)]" style={noDrag}>
            Settings
          </span>
        ) : libraryOpen ? (
          <button
            onClick={() => setContentView('none')}
            className="no-style ml-2 flex items-center gap-1 text-[13px] font-medium text-[var(--graphite)] hover:text-[var(--ink)]"
            style={noDrag}
            title="Back"
          >
            <span aria-hidden>&larr;</span> Library
          </button>
        ) : (
          inProject && (
            <span className="ml-2 truncate text-[13px] font-medium text-[var(--ink)]" style={noDrag}>
              {project?.name || 'Untitled'}
            </span>
          )
        )}

        {/* Canvas tabs as pills, inline with the project name (editor view). */}
        {inEditor && !settingsOpen && !libraryOpen && (
          <div style={noDrag} className="ml-3 min-w-0 overflow-x-auto">
            <CenterTabs />
          </div>
        )}

        <div className="flex-1" />

        {inEditor && !settingsOpen && !libraryOpen && (
          <div style={noDrag} className="flex items-center gap-2">
            <EditorHeaderTools />
          </div>
        )}
      </header>

      {/* Body: sidebar + content card, both under the top bar. */}
      <div className="relative flex min-h-0 flex-1">
        {settingsOpen ? (
          // Same aside geometry as HomeSidebar (p-2.5 pl-3.5) so the two sidebars
          // feel seamless — items inherit the 14px-left / 10px-right inset and
          // SettingsNav adds no horizontal padding of its own.
          <aside className="flex h-full w-[252px] shrink-0 flex-col bg-[var(--bg)] p-2.5 pl-3.5">
            <div className="mb-1 flex items-center gap-2 py-1">
              <button
                onClick={() => setContentView('none')}
                className="no-style text-[13px] text-[var(--graphite)] hover:text-[var(--ink)]"
                aria-label="Close settings"
                title="Close settings"
              >
                &larr;
              </button>
              <span className="text-[13px] font-medium text-[var(--ink)]">Settings</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <SettingsNav
                active={settingsSection}
                onSelect={setSettingsSection}
                onClose={() => setContentView('none')}
              />
            </div>
          </aside>
        ) : (
          !collapsed && (
            <HomeSidebar
              onOpenSettings={openSettings}
              onOpenWorkspaces={openWorkspaces}
              onOpenLibrary={openLibrary}
              layersSlot={inEditor ? <EditorLayersPanel /> : undefined}
            />
          )
        )}

        {/* Collapsed peek: floating sidebar overlay (home/chat only) */}
        {!settingsOpen && !inEditor && collapsed && peek && (
          <div className="absolute inset-y-0 left-0 z-40 p-2" onMouseLeave={() => setPeek(false)}>
            <HomeSidebar
              floating
              onOpenSettings={openSettings}
              onOpenWorkspaces={openWorkspaces}
              onOpenLibrary={openLibrary}
            />
          </div>
        )}

        {/* Content card — tucks under the top bar (rounded top); bottom is square
            and flush to the window's bottom edge. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[var(--radius-lg)] border border-b-0 border-r-0 border-[var(--hairline)] bg-[var(--panel)]">
          {settingsOpen ? (
            <SettingsContent active={settingsSection} />
          ) : libraryOpen ? (
            <div className="flex-1 overflow-hidden">
              <MediaLibrary />
            </div>
          ) : workspacesOpen ? (
            <WorkspaceView onClose={() => setContentView('none')} />
          ) : (
            <>
              {appView === 'home' && <HomeStage />}

              {inEditor && (
                <Editor embedded showWelcome={false} onGoHome={() => setAppView('home')} onEnterEditor={() => {}} />
              )}
            </>
          )}
          {/* Always mounted while in a project (even behind Settings/Library/
              Workspaces overlays) so an in-flight agent stream survives view
              switches — AgentChatHost reparents the live chat into the editor's
              Agent panel instead of mounting a second AgentChat instance.

              The scene preview pane is a SIBLING of the host, never a child of
              AgentChat: the chat node is reparented (appendChild) into the
              editor panel on view switches, and an iframe inside it would
              reload on every move. The wrapper row hides exactly when the host
              would (editor view / overlays), so the reparenting invariant in
              AgentChatHost — "React only ever removes homeRef" — is unchanged. */}
          {inProject && (
            <div
              className={`flex min-h-0 flex-1 ${
                !settingsOpen && !libraryOpen && !workspacesOpen && projectView === 'chat' ? '' : 'hidden'
              }`}
            >
              <AgentChatHost visible={!settingsOpen && !libraryOpen && !workspacesOpen} />
              {projectView === 'chat' && !settingsOpen && !libraryOpen && !workspacesOpen && <ChatScenePreview />}
            </div>
          )}
        </main>
      </div>

      {/* Command palette — shell-rendered for home/chat so the Search
          button works outside the editor. The editor renders its own (full
          command set) when inEditor, so render here only when NOT in the editor. */}
      {commandPaletteOpen && !inEditor && (
        <CommandPalette
          onClose={() => setCommandPaletteOpen(false)}
          projects={appView === 'home' ? projectList.map((p) => ({ id: p.id, name: p.name })) : []}
          onAction={(a) => {
            setCommandPaletteOpen(false)
            if (a.type === 'open-project') openProject(a.projectId, 'chat')
            else if (a.type === 'open-conversation') openProject(a.projectId, 'chat', a.conversationId)
            else if (a.action === 'settings') setContentView('settings')
            else if (a.action === 'agents') {
              setContentView('settings')
              setSettingsSection2('agents')
            } else if (a.action === 'media') setContentView('library')
          }}
        />
      )}
    </div>
  )
}
