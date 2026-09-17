'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, Plus, Bell, ChevronDown, Check } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import SceneSaveStatusIndicator from './SceneSaveStatusIndicator'
import SceneLockBadge from './scene/SceneLockBadge'

interface Branch {
  id: string
  name: string
  isDefault: boolean
  projectId: string
  createdAt: Date
}

export default function EditorStatusBar() {
  const project = useVideoStore((s) => s.project)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const projectActiveBranchId = useVideoStore((s) => s.projectActiveBranchId)
  const { switchProjectBranch, incrementBranchListVersion } = useVideoStore()
  const branchOperation = useVideoStore((s) => s.branchOperation)

  const [branches, setBranches] = useState<Branch[]>([])
  const [activeBranch, setActiveBranch] = useState<Branch | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const branchRef = useRef<HTMLDivElement>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  const [notifOpen, setNotifOpen] = useState(false)
  const notifWrapRef = useRef<HTMLDivElement>(null)

  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined

  const loadBranches = useCallback(async () => {
    if (!ipc || !project?.id) return
    try {
      const { branches: list } = await ipc.list({ projectId: project.id })
      const typedList = list as Branch[]
      setBranches(typedList)
      const current =
        typedList.find((b) => b.id === projectActiveBranchId) ?? typedList.find((b) => b.isDefault) ?? typedList[0]
      if (current) setActiveBranch(current)
    } catch {
      // non-fatal
    }
  }, [ipc, project?.id, projectActiveBranchId])

  useEffect(() => {
    if (project?.id) void loadBranches()
  }, [project?.id, projectActiveBranchId, loadBranches])

  useEffect(() => {
    if (!branchOpen) return
    function handler(e: MouseEvent) {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false)
        setCreating(false)
        setNewName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [branchOpen])

  useEffect(() => {
    if (creating && newNameRef.current) newNameRef.current.focus()
  }, [creating])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (notifWrapRef.current && !notifWrapRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function selectBranch(branch: Branch) {
    const previous = activeBranch
    setActiveBranch(branch)
    setBranchOpen(false)
    switchProjectBranch(branch.id).catch(() => {
      // Restore optimistic update if the switch fails
      setActiveBranch(previous)
    })
  }

  async function handleCreate() {
    if (!ipc || !newName.trim() || !project?.id) return
    setBranchLoading(true)
    try {
      const { branch } = await ipc.create({
        projectId: project.id,
        name: newName.trim(),
        sourceBranchId: activeBranch?.id,
      })
      setNewName('')
      setCreating(false)
      incrementBranchListVersion()
      await loadBranches()
      switchProjectBranch((branch as Branch).id)
    } catch {
      // non-fatal
    } finally {
      setBranchLoading(false)
    }
  }

  const projectLabel = project?.name?.trim() || 'Untitled project'

  const itemClass = 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-border)]/40 transition-colors'

  // Transient feedback slot. Driven by store.showTransientStatus()
  // from actionUndo/actionRedo; auto-clears when its expiresAt timer fires.
  const transientStatus = useVideoStore((s) => s.transientStatus)

  // Scene-lock badge sits with the other per-scene status (save status). Only render it — and
  // its leading divider — when the selected scene actually holds a lock, so the status bar stays
  // clean when nothing's contending for the scene (the cursor model's quiet default).
  const selectedSceneLocked = useVideoStore((s) => !!s.scenes.find((sc) => sc.id === selectedSceneId)?.lock)

  return (
    <footer className="relative z-[120] flex h-8 shrink-0 items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 text-[12px] text-[var(--color-text-muted)] select-none [font-variant-numeric:tabular-nums]">
      {transientStatus && (
        <div
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-1 z-[121] rounded px-2 py-0.5 text-[11px]"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 14%, var(--color-panel))',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border)',
          }}
        >
          {transientStatus.text}
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {/* Project branch selector */}
        {ipc && project?.id ? (
          <div ref={branchRef} className="relative shrink-0">
            {branchOperation?.kind === 'switch' ? (
              <div className={`${itemClass} max-w-[160px] cursor-default opacity-60`}>
                <GitBranch size={12} className="shrink-0 animate-pulse" strokeWidth={2} />
                <span className="truncate font-medium">Switching...</span>
              </div>
            ) : (
              <button
                type="button"
                className={`${itemClass} max-w-[160px] cursor-pointer`}
                onClick={() => setBranchOpen((o) => !o)}
                title={activeBranch?.name ?? 'Select branch'}
                disabled={!!branchOperation}
              >
                <GitBranch size={12} className="shrink-0 opacity-80" strokeWidth={2} />
                <span className="truncate font-medium">{activeBranch?.name ?? 'main'}</span>
                <ChevronDown size={10} className="shrink-0 opacity-60" />
              </button>
            )}
            {branchOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[200px] rounded border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
                {branches.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => selectBranch(b)}
                    className="no-style flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--agent-chat-user-surface)]"
                  >
                    <GitBranch size={10} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="flex-1 truncate text-left">{b.name}</span>
                    {b.isDefault && (
                      <span className="rounded bg-[var(--color-bg)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                        default
                      </span>
                    )}
                    {activeBranch?.id === b.id && <Check size={10} className="shrink-0" />}
                  </button>
                ))}
                <div className="mx-2 my-1 border-t border-[var(--color-border)]" />
                {creating ? (
                  <div className="flex items-center gap-1 px-2 py-1">
                    <input
                      ref={newNameRef}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="branch-name"
                      className="flex-1 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-primary)] outline-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreate()
                        if (e.key === 'Escape') {
                          setCreating(false)
                          setNewName('')
                        }
                      }}
                      disabled={branchLoading}
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreate()}
                      disabled={!newName.trim() || branchLoading}
                      className="no-style flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                    >
                      <Check size={10} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="no-style flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--agent-chat-user-surface)] hover:text-[var(--color-text-primary)]"
                  >
                    <Plus size={10} />
                    New branch from current
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <span
            className={`${itemClass} shrink-0 cursor-default max-w-[160px]`}
            title="Project branches available in the desktop app"
          >
            <GitBranch size={12} className="shrink-0 opacity-80" strokeWidth={2} />
            <span className="truncate font-medium">main</span>
          </span>
        )}

        <div className="mx-1 h-3 w-px shrink-0 bg-[var(--color-border)]" aria-hidden />

        <SceneSaveStatusIndicator sceneId={selectedSceneId} className="shrink-0 px-1" />

        {selectedSceneId && selectedSceneLocked && (
          <>
            <div className="mx-1 h-3 w-px shrink-0 bg-[var(--color-border)]" aria-hidden />
            <SceneLockBadge sceneId={selectedSceneId} viewer="user" />
          </>
        )}

        <div className="mx-1 h-3 w-px shrink-0 bg-[var(--color-border)]" aria-hidden />

        <span className="truncate px-1 font-medium text-[var(--color-text-primary)]/80" title={projectLabel}>
          {projectLabel}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <div className="mx-1 h-3 w-px shrink-0 bg-[var(--color-border)]" aria-hidden />

        <span className="px-1.5 text-[11px] font-medium tracking-wide text-[var(--color-text-muted)]">Dreambyte</span>

        <div className="relative" ref={notifWrapRef}>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-border)]/40 transition-colors"
            onClick={() => setNotifOpen((o) => !o)}
            aria-label="Notifications"
            aria-expanded={notifOpen}
          >
            <Bell size={13} strokeWidth={2} />
          </button>
          {notifOpen && (
            <div className="absolute bottom-full right-0 mb-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-[12px] text-[var(--color-text-muted)] shadow-lg">
              <p className="leading-snug">Export and publish alerts will show here as the app grows.</p>
            </div>
          )}
        </div>
      </div>
    </footer>
  )
}
