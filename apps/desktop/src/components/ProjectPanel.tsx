'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import { ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import type { WorkspaceListItem } from '@/lib/types'

interface ProjectListItem {
  id: string
  name: string
  description: string | null
  outputMode: string
  workspaceId: string | null
  updatedAt: string
  createdAt: string
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ProjectRow({
  p,
  isCurrent,
  workspaces,
  onSelect,
  onConfirmDelete,
  onMove,
}: {
  p: ProjectListItem
  isCurrent: boolean
  workspaces: WorkspaceListItem[]
  onSelect: (id: string) => void
  onConfirmDelete: (id: string) => void
  onMove: (projectId: string, workspaceId: string | null) => void
}) {
  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <div
      className={`group/item flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors relative ${
        isCurrent ? 'bg-[var(--color-panel)]/50' : 'hover:bg-[var(--color-panel)]/50'
      }`}
      onClick={() => onSelect(p.id)}
    >
      <span className="text-[13px] font-medium truncate flex-1 min-w-0 text-[var(--color-text-secondary)] opacity-80 group-hover/item:opacity-100">
        {p.name}
      </span>

      <span
        onClick={(e) => {
          e.stopPropagation()
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setMenuOpen({ x: rect.right - 160, y: rect.bottom + 4 })
        }}
        className="opacity-0 group-hover/item:opacity-100 transition-opacity text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer shrink-0"
      >
        <MoreHorizontal size={14} />
      </span>

      {/* Inline dropdown menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="fixed z-[10000] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: menuOpen.x, top: menuOpen.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {workspaces.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                Move to...
              </div>
              {workspaces
                .filter((w) => w.id !== p.workspaceId)
                .map((w) => (
                  <div
                    key={w.id}
                    className="px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:bg-white/5 cursor-pointer flex items-center gap-2"
                    onClick={() => {
                      onMove(p.id, w.id)
                      setMenuOpen(null)
                    }}
                  >
                    {w.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: w.color }} />}
                    <span className="truncate">{w.name}</span>
                  </div>
                ))}
              {p.workspaceId && (
                <div
                  className="px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:bg-white/5 cursor-pointer"
                  onClick={() => {
                    onMove(p.id, null)
                    setMenuOpen(null)
                  }}
                >
                  Unassign from workspace
                </div>
              )}
              <div className="border-t border-[var(--color-border)] my-1" />
            </>
          )}
          <div
            className="px-3 py-1.5 text-[12px] text-red-400 hover:bg-white/5 cursor-pointer"
            onClick={() => {
              onConfirmDelete(p.id)
              setMenuOpen(null)
            }}
          >
            Delete project
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProjectPanel({
  onClose,
  homeMode = false,
  onProjectOpened,
}: {
  onClose: () => void
  // When true, no project is "open" — hide the current-project header so the
  // panel doesn't reference a project the user hasn't entered yet.
  homeMode?: boolean
  // Called after a project is opened/created from this panel so the parent
  // can transition out of the home view.
  onProjectOpened?: () => void
}) {
  const {
    project,
    scenes,
    createNewProject,
    loadProject,
    deleteProjectFromDb,
    saveProjectToDb,
    workspaces,
    fetchWorkspaces,
    moveProjectToWorkspace,
    openNewProjectModal,
  } = useVideoStore()

  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(project.name)

  // Fetch full project list with details
  const fetchProjects = useCallback(async () => {
    setLoading(true)
    try {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
      const raw = ipc ? await ipc.list() : null
      if (raw) {
        const list = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? [])
        setProjects(list as Parameters<typeof setProjects>[0])
      }
    } catch {
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchWorkspaces()
  }, [fetchProjects, fetchWorkspaces])

  const handleRename = async () => {
    if (renameValue.trim() && renameValue !== project.name) {
      useVideoStore.getState().updateProject({ name: renameValue.trim() })
      await saveProjectToDb()
      fetchProjects()
    }
    setIsRenaming(false)
  }

  const handleDelete = async (id: string) => {
    await deleteProjectFromDb(id)
    // In homeMode no project is "open" — deleting from the list shouldn't
    // pull the user into another project unprompted.
    if (!homeMode && id === project.id) {
      const remaining = projects.filter((p) => p.id !== id)
      if (remaining.length > 0) {
        await loadProject(remaining[0].id)
      } else {
        await createNewProject()
      }
    }
    fetchProjects()
    fetchWorkspaces()
  }

  const handleSelect = async (id: string) => {
    // In homeMode any selection is treated as "open" — load and let the
    // parent transition out of the home view.
    if (homeMode || id !== project.id) {
      await loadProject(id)
      onProjectOpened?.()
    }
  }

  const handleMoveProject = async (projectId: string, workspaceId: string | null) => {
    await moveProjectToWorkspace(projectId, workspaceId)
    fetchProjects()
  }

  const currentSceneCount = scenes.length
  const totalDuration = scenes.reduce((sum, s) => sum + (s.duration || 5), 0)

  return (
    <div className="flex flex-col h-full text-[var(--color-text-primary)] bg-transparent">
      <div className="flex-1 overflow-y-auto">
        {/* Current project — hidden on the home view, where no project is open. */}
        {!homeMode && (
          <div className="sticky top-0 z-10 border-b border-[var(--color-border)] p-4 bg-[var(--color-bg)]">
            <div className="px-2">
              <input
                value={isRenaming ? renameValue : project.name}
                onFocus={() => {
                  setRenameValue(project.name)
                  setIsRenaming(true)
                }}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename()
                  if (e.key === 'Escape') {
                    setIsRenaming(false)
                    setRenameValue(project.name)
                  }
                }}
                className="w-full text-[15px] font-medium bg-transparent border-none outline-none text-[var(--color-text-secondary)] opacity-80 truncate mb-1"
              />

              <details className="mt-1 group">
                <summary className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="tabular-nums">{totalDuration}s</span>
                  <span>·</span>
                  <span>{project.mp4Settings?.aspectRatio || '16:9'}</span>
                  <span>·</span>
                  <span className="uppercase">{project.outputMode}</span>
                  <ChevronDown size={10} className="group-open:rotate-180 transition-transform" />
                </summary>
                <div className="mt-2 space-y-2 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">ID</span>
                    <span className="text-[var(--color-text-secondary)] font-mono text-[11px] truncate ml-2 max-w-[160px]">
                      {project.id}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">FPS</span>
                    <span className="text-[var(--color-text-secondary)]">{project.mp4Settings?.fps || 30}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">Aspect ratio</span>
                    <span className="text-[var(--color-text-secondary)]">
                      {project.mp4Settings?.aspectRatio || '16:9'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">Scenes</span>
                    <span className="text-[var(--color-text-secondary)]">{currentSceneCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">Created</span>
                    <span className="text-[var(--color-text-secondary)]">{formatDate(project.createdAt)}</span>
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}

        <div className="px-4 pt-1 pb-4">
          {/* Recents */}
          <div className="flex items-center justify-between mb-0 px-2">
            <span className="text-sm font-semibold text-[var(--color-text-muted)]">Recents</span>
            <button
              onClick={openNewProjectModal}
              aria-label="New project"
              data-tooltip="New project"
              data-tooltip-pos="left"
              className="no-style flex items-center justify-center w-7 h-7 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[color:color-mix(in_srgb,var(--color-text-muted)_22%,var(--color-bg))] transition-colors"
            >
              <Plus size={16} />
            </button>
          </div>

          {loading ? (
            <div className="text-[12px] text-[var(--color-text-muted)] py-4 text-center">Loading...</div>
          ) : projects.length === 0 ? (
            <div className="text-[12px] text-[var(--color-text-muted)] py-4 text-center">No projects yet</div>
          ) : (
            <div className="space-y-0">
              {[...projects]
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                .map((p) => (
                  <ProjectRow
                    key={p.id}
                    p={p}
                    isCurrent={!homeMode && p.id === project.id}
                    workspaces={workspaces}
                    onSelect={handleSelect}
                    onConfirmDelete={handleDelete}
                    onMove={handleMoveProject}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
