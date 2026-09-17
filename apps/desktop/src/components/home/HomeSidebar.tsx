'use client'

import { useState, useEffect, useRef, type ReactNode } from 'react'
import { useVideoStore } from '@/lib/store'
import { Plus, Folder, ChevronDown, Check, Layers, type LucideIcon } from 'lucide-react'
import ProjectTreeItem from './ProjectTreeItem'
import SidebarUserButton from '../SidebarUserButton'
import { Segmented } from '@/components/settings/shared'
import { AudioMixer } from '@/components/mixer/AudioMixer'

/** The media-library glyph (matches the editor's Media tab icon). */
function MediaLibraryIcon({ size = 16, className }: { size?: number; className?: string }) {
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
      className={className}
    >
      <path d="M21.1935 16.793C20.8437 19.2739 20.6689 20.5143 19.7717 21.2572C18.8745 22 17.5512 22 14.9046 22H9.09536C6.44881 22 5.12553 22 4.22834 21.2572C3.33115 20.5143 3.15626 19.2739 2.80648 16.793L2.38351 13.793C1.93748 10.6294 1.71447 9.04765 2.66232 8.02383C3.61017 7 5.29758 7 8.67239 7H15.3276C18.7024 7 20.3898 7 21.3377 8.02383C22.0865 8.83268 22.1045 9.98979 21.8592 12" />
      <path d="M19.5617 7C19.7904 5.69523 18.7863 4.5 17.4617 4.5H6.53788C5.21323 4.5 4.20922 5.69523 4.43784 7" />
      <path d="M17.4999 4.5C17.5283 4.24092 17.5425 4.11135 17.5427 4.00435C17.545 2.98072 16.7739 2.12064 15.7561 2.01142C15.6497 2 15.5194 2 15.2588 2H8.74099C8.48035 2 8.35002 2 8.24362 2.01142C7.22584 2.12064 6.45481 2.98072 6.45704 4.00434C6.45727 4.11135 6.47146 4.2409 6.49983 4.5" />
      <circle cx="16.5" cy="11.5" r="1.5" />
      <path d="M19.9999 20L17.1157 17.8514C16.1856 17.1586 14.8004 17.0896 13.7766 17.6851L13.5098 17.8403C12.7984 18.2542 11.8304 18.1848 11.2156 17.6758L7.37738 14.4989C6.6113 13.8648 5.38245 13.8309 4.5671 14.4214L3.24316 15.3803" />
    </svg>
  )
}

/**
 * Global sidebar. Two render modes (AppShell decides which):
 *  - docked (default): flush left column on the shell bg (--bg), part of the shell.
 *  - floating: rounded elevated overlay used for the collapsed hover-peek (mini).
 * `floating` also renders the mini flat list (no Recents header).
 * Collapse + search live in the shell header, not here.
 */
export default function HomeSidebar({
  floating = false,
  trafficLightInset = false,
  onOpenSettings,
  onOpenWorkspaces,
  onOpenLibrary,
  layersSlot,
}: {
  floating?: boolean
  trafficLightInset?: boolean
  onOpenSettings: () => void
  /** Opens the Workspaces management page in the content area. */
  onOpenWorkspaces?: () => void
  /** Opens the Media Library in the content area. */
  onOpenLibrary?: () => void
  /** Editor view: scene/layers panel rendered below the nav, replacing the
   *  projects list. When set, the projects list + Manage Workspaces are hidden. */
  layersSlot?: ReactNode
}) {
  const projectList = useVideoStore((s) => s.projectList)
  const activeProjectId = useVideoStore((s) => s.activeProjectId)
  const activeConversationId = useVideoStore((s) => s.activeConversationId)
  const appView = useVideoStore((s) => s.appView)
  const openProject = useVideoStore((s) => s.openProject)
  const switchConversation = useVideoStore((s) => s.switchConversation)
  const goAppHome = useVideoStore((s) => s.goAppHome)
  const projectView = useVideoStore((s) => s.projectView)
  const setProjectView = useVideoStore((s) => s.setProjectView)
  const createNewProject = useVideoStore((s) => s.createNewProject)
  const workspaces = useVideoStore((s) => s.workspaces)
  const activeWorkspaceId = useVideoStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useVideoStore((s) => s.setActiveWorkspace)
  const fetchWorkspaces = useVideoStore((s) => s.fetchWorkspaces)

  const [switcherOpen, setSwitcherOpen] = useState(false)

  // "New video" is context-aware: from the editor it mints a blank project and
  // STAYS in the editor (createNewProject preserves projectView). Under the
  // eager draft model the project is a real DB row with status='draft' from the
  // first moment; the startup sweep soft-hides it if it stays untouched, and the
  // first real activity promotes it to 'ready'. Everywhere else this returns to
  // the chat-first home composer to describe the new video.
  // The ref guards against a double-click minting two blank drafts.
  const creatingRef = useRef(false)
  const handleNewVideo = () => {
    if (appView === 'project' && projectView === 'editor') {
      if (creatingRef.current) return
      creatingRef.current = true
      void createNewProject(undefined, undefined, { draft: true }).finally(() => {
        creatingRef.current = false
      })
    } else {
      goAppHome()
    }
  }

  useEffect(() => {
    void fetchWorkspaces()
  }, [fetchWorkspaces])

  // Keyboard dismiss for the workspace switcher dropdown. With Escape wired, the
  // click-away scrim below can stay a pure presentational dismiss layer (a11y).
  useEffect(() => {
    if (!switcherOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitcherOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [switcherOpen])

  // Projects of the active workspace (null = All workspaces → every project).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null
  const recents = projectList.filter((p) => !activeWorkspaceId || p.workspaceId === activeWorkspaceId).slice(0, 8)

  // A project IS the workspace: opening a nested chat opens its project (chat
  // view) and switches to that conversation.
  const openChat = (projectId: string, conversationId: string) => {
    if (appView === 'project' && activeProjectId === projectId) {
      void switchConversation(conversationId)
    } else {
      // Pass the conversation through openProject so it's applied after the
      // project load settles (no race overwriting activeConversationId).
      openProject(projectId, 'chat', conversationId)
    }
  }

  // Workspaces nav removed — the project is the only container you create.
  // Library opens its page in the content area. (Customize removed — redundant page.)
  const navItems: {
    label: string
    icon: LucideIcon | typeof MediaLibraryIcon
    onClick?: () => void
  }[] = [{ label: 'Library', icon: MediaLibraryIcon, onClick: onOpenLibrary }]

  // Both modes share the 252px width (the floating border is inside the box via
  // border-box, so no 4px compensation is needed — the prior 256px was incidental).
  const outerClass = floating
    ? 'h-full w-[252px] rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--panel)]'
    : 'h-full w-[252px] shrink-0 bg-[var(--bg)] pl-3.5'

  return (
    <aside
      className={`flex flex-col px-2.5 pb-2.5 pt-0 ${outerClass}`}
      style={floating ? { boxShadow: '0 12px 30px -16px rgba(0,0,0,0.5)' } : undefined}
    >
      {/* Draggable strip that clears the macOS traffic lights at the sidebar top. */}
      {trafficLightInset && !floating && (
        <div className="-mx-2.5 -mt-2.5 mb-1 h-7 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      )}
      {/* Chat / Editor view switcher — same segmented control as Models tabs. */}
      {!floating && (
        <div className="mb-1.5">
          <Segmented
            options={[
              { value: 'chat', label: 'Chat' },
              { value: 'editor', label: 'Editor' },
            ]}
            value={projectView}
            onChange={setProjectView}
          />
        </div>
      )}

      {/* Workspace switcher — sets the active workspace (filters the project list). */}
      {!floating && (
        <div className="relative">
          <button
            onClick={() => setSwitcherOpen((o) => !o)}
            className="no-style flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-transparent !px-3 text-[14px] font-medium text-[var(--ink)] hover:bg-[var(--card)]"
          >
            <Layers size={16} className="flex-none text-[var(--graphite)]" />
            <span className="min-w-0 flex-1 truncate text-left">{activeWorkspace?.name ?? 'All workspaces'}</span>
            <ChevronDown size={14} className="flex-none text-[var(--mute)]" />
          </button>
          {switcherOpen && (
            <>
              {/* Pure dismiss scrim — presentational; Escape also closes (above). */}
              <div role="presentation" className="fixed inset-0 z-30" onClick={() => setSwitcherOpen(false)} />
              <div
                className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline-strong)] bg-[var(--card)] py-1"
                style={{ boxShadow: 'var(--shadow-md)' }}
              >
                <button
                  onClick={() => {
                    setActiveWorkspace(null)
                    setSwitcherOpen(false)
                  }}
                  className="no-style flex h-8 w-full items-center gap-2 !px-3 text-[13px] text-[var(--ink-soft)] hover:bg-[var(--card-hover)]"
                >
                  <span className="w-4">
                    {!activeWorkspaceId && <Check size={13} className="text-[var(--accent)]" />}
                  </span>
                  All workspaces
                </button>
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => {
                      setActiveWorkspace(w.id)
                      setSwitcherOpen(false)
                    }}
                    className="no-style flex h-8 w-full items-center gap-2 !px-3 text-[13px] text-[var(--ink-soft)] hover:bg-[var(--card-hover)]"
                  >
                    <span className="w-4">
                      {activeWorkspaceId === w.id && <Check size={13} className="text-[var(--accent)]" />}
                    </span>
                    <span className="truncate">{w.name}</span>
                  </button>
                ))}
                {/* All projects — recents-first (updatedAt = last opened/edited),
                    scrollable so any project is one click away. */}
                {projectList.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-[var(--hairline)]" />
                    <div className="px-3 pb-1 pt-1 text-[11px] font-medium text-[var(--slate)]">Projects</div>
                    <div className="max-h-64 overflow-y-auto">
                      {[...projectList]
                        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                        .map((p) => (
                          <button
                            key={p.id}
                            onClick={() => {
                              setSwitcherOpen(false)
                              openProject(p.id, 'chat')
                            }}
                            className="no-style flex h-8 w-full items-center gap-2 !px-3 text-[13px] text-[var(--ink-soft)] hover:bg-[var(--card-hover)]"
                          >
                            <span className="w-4">
                              {activeProjectId === p.id && <Check size={13} className="text-[var(--accent)]" />}
                            </span>
                            <span className="truncate">{p.name}</span>
                          </button>
                        ))}
                    </div>
                  </>
                )}
                <div className="my-1 h-px bg-[var(--hairline)]" />
                <button
                  onClick={() => {
                    setSwitcherOpen(false)
                    onOpenWorkspaces?.()
                  }}
                  className="no-style flex h-8 w-full items-center gap-2 !px-3 text-[13px] text-[var(--graphite)] hover:bg-[var(--card-hover)] hover:text-[var(--ink)]"
                >
                  <span className="w-4" />
                  Manage workspaces…
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <button
        onClick={handleNewVideo}
        className="no-style flex h-9 items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--card)] !px-3 text-[14px] font-medium text-[var(--ink)] hover:bg-[var(--card-hover)]"
      >
        <Plus size={16} /> New video
      </button>

      <nav>
        {navItems.map(({ label, icon: Icon, onClick }) => (
          <button
            key={label}
            onClick={onClick}
            className="no-style flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-transparent !px-3 text-[14px] text-[var(--ink-soft)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
          >
            <Icon size={16} className="text-[var(--graphite)]" /> {label}
          </button>
        ))}
      </nav>

      {layersSlot ? (
        /* Editor view: scene/layers panel below the nav (replaces the projects list). */
        <div className="mt-1.5 min-h-0 flex-1 overflow-hidden">{layersSlot}</div>
      ) : (
        <div className="mt-1.5 flex-1 overflow-y-auto">
          {!floating && <div className="mb-1 mt-3 px-3 text-[12px] text-[var(--slate)]">Projects</div>}
          {recents.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--mute)]">No projects yet — start above.</div>
          ) : (
            recents.map((p) => {
              const active = appView === 'project' && activeProjectId === p.id
              return (
                <ProjectTreeItem
                  key={p.id}
                  id={p.id}
                  name={p.name}
                  active={active}
                  activeConversationId={activeConversationId}
                  defaultExpanded={active && !floating}
                  onOpenProject={(pid) => openProject(pid, 'chat')}
                  onOpenChat={openChat}
                />
              )
            })
          )}

          {/* Manage Workspaces — opens the workspaces page in the content area. */}
          {!floating && (
            <button
              onClick={() => onOpenWorkspaces?.()}
              className="no-style mt-1 flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-md)] !px-3 text-[13px] text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
            >
              <Folder size={16} className="text-[var(--mute)]" />
              Manage Workspaces
            </button>
          )}
        </div>
      )}

      {/* Mixing console — editor view only, docked just above the settings button. */}
      {layersSlot ? <AudioMixer /> : null}

      <SidebarUserButton onClick={onOpenSettings} />
    </aside>
  )
}
