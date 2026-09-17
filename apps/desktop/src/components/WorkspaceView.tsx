'use client'

import { useEffect, useState, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import { Plus, FolderOpen, Clock, Layers, ChevronLeft, Trash2 } from 'lucide-react'
import PermissionsPanel from './settings/PermissionsPanel'

const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#6366f1']

interface ProjectListItem {
  id: string
  name: string
  description: string | null
  outputMode: string
  workspaceId: string | null
  updatedAt: string
  createdAt: string
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getSceneCount(p: ProjectListItem, currentProjectId: string, currentScenes: any[]) {
  if (p.id === currentProjectId) return currentScenes.length
  try {
    const data = JSON.parse(p.description || '{}')
    return data.scenes?.length ?? 0
  } catch {
    return 0
  }
}

/** Project card — shared by the unassigned list and the workspace detail grid. */
function ProjectCard({
  project: p,
  isCurrent,
  sceneCount,
  onOpen,
  onDelete,
}: {
  project: ProjectListItem
  isCurrent: boolean
  sceneCount: number
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={`group/card cursor-pointer rounded-[var(--radius-lg)] border p-4 transition-colors ${
        isCurrent
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[var(--hairline)] bg-[var(--card)] hover:border-[var(--hairline-strong)]'
      }`}
      onClick={onOpen}
    >
      <div className="mb-2 flex items-start justify-between">
        <span className="mr-2 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">{p.name}</span>
        <span
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="shrink-0 text-[11px] text-[var(--mute)] opacity-0 transition-opacity hover:text-[var(--danger)] group-hover/card:opacity-100"
        >
          Delete
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-[var(--mute)]">
        <span className="flex items-center gap-1">
          <Layers size={10} />
          {sceneCount} scene{sceneCount !== 1 ? 's' : ''}
        </span>
        <span className="uppercase">{p.outputMode || 'mp4'}</span>
        <span className="ml-auto flex items-center gap-1">
          <Clock size={10} />
          {formatRelative(p.updatedAt)}
        </span>
      </div>
    </div>
  )
}

/** Single workspace detail view */
function WorkspaceDetail({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const {
    workspaces,
    project,
    scenes,
    loadProject,
    createNewProject,
    deleteProjectFromDb,
    fetchWorkspaces,
    updateWorkspace,
    deleteWorkspace,
    setActiveWorkspace,
    setCenterTab,
  } = useVideoStore()

  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const workspace = workspaces.find((w) => w.id === workspaceId)

  useEffect(() => {
    setLoading(true)
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
    const load = ipc
      ? ipc.list({ workspaceId }).then((raw) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const list = Array.isArray(raw) ? raw : ((raw as any)?.items ?? [])
          setProjects(list)
        })
      : Promise.resolve(setProjects([]))
    Promise.resolve(load)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workspaceId])

  useEffect(() => {
    if (isEditingName && nameInputRef.current) nameInputRef.current.focus()
  }, [isEditingName])

  if (!workspace) return null

  const handleSaveName = async () => {
    if (nameValue.trim() && nameValue !== workspace.name) {
      await updateWorkspace(workspace.id, { name: nameValue.trim() })
    }
    setIsEditingName(false)
  }

  const handleOpenProject = async (id: string) => {
    await loadProject(id)
    setCenterTab('preview')
  }

  const handleNewProject = async () => {
    setActiveWorkspace(workspace.id)
    await createNewProject()
    setCenterTab('preview')
  }

  const handleDeleteProject = async (id: string) => {
    await deleteProjectFromDb(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
    fetchWorkspaces()
  }

  const handleDeleteWorkspace = async () => {
    await deleteWorkspace(workspace.id)
    onBack()
  }

  return (
    <div className="max-w-[720px] mx-auto px-8 py-10">
      {/* Back + header */}
      <div
        onClick={onBack}
        className="mb-6 flex cursor-pointer items-center gap-1 text-[12px] text-[var(--mute)] transition-colors hover:text-[var(--ink)]"
      >
        <ChevronLeft size={14} />
        All workspaces
      </div>

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          {workspace.color && (
            <span className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: workspace.color }} />
          )}
          {isEditingName ? (
            <input
              ref={nameInputRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveName()
                if (e.key === 'Escape') setIsEditingName(false)
              }}
              className="flex-1 border-b border-[var(--hairline-strong)] bg-transparent text-xl font-semibold text-[var(--ink)] outline-none"
            />
          ) : (
            <h1
              className="cursor-pointer text-xl font-semibold text-[var(--ink)] hover:opacity-80"
              onClick={() => {
                setNameValue(workspace.name)
                setIsEditingName(true)
              }}
            >
              {workspace.name}
            </h1>
          )}
          <span
            onClick={handleDeleteWorkspace}
            className="ml-auto cursor-pointer text-[var(--mute)] transition-colors hover:text-[var(--danger)]"
            title="Delete workspace"
          >
            <Trash2 size={14} />
          </span>
        </div>

        <div className="flex items-center gap-4 text-[13px] text-[var(--mute)]">
          <span>
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Projects grid */}
      <div className="mb-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[12px] font-medium text-[var(--slate)]">Projects</h2>
          <span
            onClick={handleNewProject}
            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--mute)] transition-colors hover:text-[var(--ink)]"
          >
            <Plus size={14} />
            New project
          </span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-[13px] text-[var(--mute)]">Loading...</div>
        ) : projects.length === 0 ? (
          <div className="py-12 text-center">
            <FolderOpen size={32} className="mx-auto mb-3 text-[var(--mute)] opacity-30" />
            <p className="mb-4 text-[13px] text-[var(--mute)]">No projects in this workspace yet</p>
            <span
              onClick={handleNewProject}
              className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--accent)] transition-opacity hover:opacity-80"
            >
              <Plus size={12} />
              Create your first project
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                isCurrent={p.id === project.id}
                sceneCount={getSceneCount(p, project.id, scenes)}
                onOpen={() => handleOpenProject(p.id)}
                onDelete={() => handleDeleteProject(p.id)}
              />
            ))}
          </div>
        )}

        {/* Workspace-scoped permissions — rules here apply to every project in
            this workspace (bound to workspaceId; see WORKSPACES-PAGE.md E1). */}
        <div className="mt-8 border-t border-[var(--hairline)] pt-6">
          <PermissionsPanel forcedWorkspaceId={workspaceId} />
        </div>
      </div>
    </div>
  )
}

/** Main workspace tab — shows all workspaces, click to drill in */
export default function WorkspaceView({ onClose }: { onClose: () => void }) {
  const {
    activeWorkspaceId,
    workspaces,
    fetchWorkspaces,
    createWorkspace,
    setActiveWorkspace,
    project,
    scenes,
    loadProject,
    deleteProjectFromDb,
    setCenterTab,
  } = useVideoStore()

  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [newName, setNewName] = useState('')
  const [unassigned, setUnassigned] = useState<ProjectListItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const loadUnassigned = () => {
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
    if (!ipc) return
    ipc
      .list({ workspaceId: 'none' })
      .then((raw) => setUnassigned(Array.isArray(raw) ? raw : ((raw as any)?.items ?? [])))
      .catch(() => {})
  }

  useEffect(() => {
    fetchWorkspaces()
    loadUnassigned()
  }, [fetchWorkspaces])

  const handleOpenProject = async (id: string) => {
    await loadProject(id)
    setCenterTab('preview')
  }

  const handleDeleteProject = async (id: string) => {
    await deleteProjectFromDb(id)
    setUnassigned((prev) => prev.filter((p) => p.id !== id))
  }

  useEffect(() => {
    if (creatingWorkspace) inputRef.current?.focus()
  }, [creatingWorkspace])

  const handleCreate = async () => {
    if (!newName.trim()) {
      setCreatingWorkspace(false)
      return
    }
    const colorIdx = workspaces.length % DEFAULT_COLORS.length
    const id = await createWorkspace(newName.trim(), { color: DEFAULT_COLORS[colorIdx] })
    setNewName('')
    setCreatingWorkspace(false)
    setActiveWorkspace(id)
  }

  // Drill-in: show single workspace detail
  if (activeWorkspaceId) {
    return (
      <div className="flex-1 overflow-y-auto bg-[var(--color-input-bg)]">
        <WorkspaceDetail workspaceId={activeWorkspaceId} onBack={() => setActiveWorkspace(null)} />
      </div>
    )
  }

  // All workspaces list
  return (
    <div className="flex-1 overflow-y-auto bg-[var(--color-input-bg)]">
      <div className="mx-auto max-w-[720px] px-8 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Workspaces</h1>
          <span
            onClick={() => setCreatingWorkspace(true)}
            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--mute)] transition-colors hover:text-[var(--ink)]"
          >
            <Plus size={14} />
            New workspace
          </span>
        </div>

        {/* Unassigned projects — projects not in any workspace, shown first. */}
        {unassigned.length > 0 && (
          <div className="mb-8">
            <h2 className="mb-3 text-[12px] font-medium text-[var(--slate)]">
              Unassigned projects · {unassigned.length}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {unassigned.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  isCurrent={p.id === project.id}
                  sceneCount={getSceneCount(p, project.id, scenes)}
                  onOpen={() => handleOpenProject(p.id)}
                  onDelete={() => handleDeleteProject(p.id)}
                />
              ))}
            </div>
          </div>
        )}

        <h2 className="mb-3 text-[12px] font-medium text-[var(--slate)]">All workspaces</h2>

        {/* Create workspace inline */}
        {creatingWorkspace && (
          <div className="mb-4 flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--card)] p-4">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: DEFAULT_COLORS[workspaces.length % DEFAULT_COLORS.length] }}
            />
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') {
                  setCreatingWorkspace(false)
                  setNewName('')
                }
              }}
              onBlur={handleCreate}
              placeholder="Workspace name..."
              className="flex-1 border-none bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--mute)]"
            />
          </div>
        )}

        {workspaces.length === 0 && !creatingWorkspace ? (
          <div className="py-16 text-center">
            <Layers size={40} className="mx-auto mb-4 text-[var(--mute)] opacity-20" />
            <p className="mb-4 text-[14px] text-[var(--mute)]">
              Workspaces group projects together for shared assets, styles, and batch workflows.
            </p>
            <span
              onClick={() => setCreatingWorkspace(true)}
              className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-[var(--accent)] transition-opacity hover:opacity-80"
            >
              <Plus size={14} />
              Create your first workspace
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="cursor-pointer rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--card)] p-4 transition-colors hover:border-[var(--hairline-strong)]"
                onClick={() => setActiveWorkspace(ws.id)}
              >
                <div className="mb-2 flex items-center gap-2.5">
                  {ws.color && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: ws.color }} />}
                  <span className="truncate text-[14px] font-medium text-[var(--ink)]">{ws.name}</span>
                </div>
                <div className="text-[12px] text-[var(--mute)]">
                  {ws.projectCount} project{ws.projectCount !== 1 ? 's' : ''}
                  <span className="mx-2">·</span>
                  {formatRelative(ws.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
