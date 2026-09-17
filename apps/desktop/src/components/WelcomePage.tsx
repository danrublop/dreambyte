'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import { FolderOpen, Video, Plus, Search, X, Key, ArrowRight } from 'lucide-react'
import RecordingHUD from '@/components/recording/RecordingHUD'
import type { RecordingSessionManifest } from '@/types/electron'
import { DreambyteLogo as AgentIcon } from './icons/DreambyteLogo'
import { formatDate } from '@/lib/utils/format-date'

/**
 * Shown on the welcome screen the first time a desktop user lands with zero
 * provider keys saved in the keyring. The agent is unreachable until they
 * enter at least one LLM key (Anthropic / OpenAI / Google). Without this
 * banner, the user gets a mystery 401 on their first "generate" click.
 *
 * Web build (no dreambyteApi) hides the banner — the hosted flow is different.
 * Dismiss state lives in localStorage so it doesn't nag across restarts.
 */
function BYOKBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [needsKey, setNeedsKey] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('dreambyte:byok-banner-dismissed') === '1'
  })

  useEffect(() => {
    if (dismissed) return
    const api = typeof window !== 'undefined' ? (window as any).dreambyteApi?.settings : undefined
    if (!api?.listProviderKeys) {
      setNeedsKey(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.listProviderKeys()
        if (cancelled) return
        // LLM providers only — not having a HeyGen key is fine, not having
        // any of the three main LLM keys means the agent can't run.
        const llm = new Set(['anthropic', 'openai', 'google', 'gemini'])
        const anyKey = (res?.keys ?? []).some(
          (k: { provider: string; hasKey: boolean }) => llm.has(k.provider) && k.hasKey,
        )
        setNeedsKey(!anyKey)
      } catch {
        setNeedsKey(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dismissed])

  if (dismissed || needsKey !== true) return null

  return (
    <div className="w-full mb-5 p-3 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 flex items-start gap-3">
      <div className="w-7 h-7 rounded-md bg-[var(--color-accent)]/15 text-[var(--color-accent)] flex items-center justify-center flex-shrink-0">
        <Key size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-[var(--color-text-primary)] leading-tight mb-0.5">
          Add your first API key
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">
          Dreambyte uses your Anthropic, OpenAI, or Google key to generate scenes. Paid out of your account, not ours.
        </p>
        <button
          onClick={onOpenSettings}
          className="mt-2 text-[11px] font-bold text-[var(--color-accent)] inline-flex items-center gap-1 hover:underline no-style"
        >
          Open Settings <ArrowRight size={11} />
        </button>
      </div>
      <button
        onClick={() => {
          localStorage.setItem('dreambyte:byok-banner-dismissed', '1')
          setDismissed(true)
        }}
        className="no-style text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors flex-shrink-0"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

type RecordingPhase = 'idle' | 'recording'

export default function WelcomePage({
  onEnterEditor,
  onOpenSearch,
}: {
  onEnterEditor: () => void
  onOpenSearch?: () => void
}) {
  const {
    fetchProjectList,
    projectList,
    loadProject,
    createNewProject,
    addScene,
    updateScene,
    saveSceneHTML,
    setSettingsTab,
  } = useVideoStore()
  const [loading, setLoading] = useState(true)
  const [recordPhase, setRecordPhase] = useState<RecordingPhase>('idle')
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchProjectList().finally(() => setLoading(false))
  }, [fetchProjectList])

  useEffect(() => {
    if (showAllProjects) {
      searchInputRef.current?.focus()
    }
  }, [showAllProjects])

  const handleOpenProject = async (projectId: string) => {
    await loadProject(projectId)
    onEnterEditor()
  }

  const handleNewProject = async () => {
    await createNewProject()
    onEnterEditor()
  }

  const handleRecordClick = () => {
    setRecordPhase('recording')
  }

  const handleRecordingFinish = useCallback(
    async (manifest: RecordingSessionManifest) => {
      setRecordPhase('idle')
      try {
        await createNewProject('Screen Recording')
        const sceneId = addScene('Screen recording')
        updateScene(sceneId, {
          videoLayer: {
            src: manifest.screenVideoUrl,
            enabled: true,
            opacity: 1,
            trimStart: 0,
            trimEnd: null,
          },
        })
        await saveSceneHTML(sceneId)
        onEnterEditor()
      } catch (err: any) {
        alert(
          `Failed to create project from recording: ${err.message || 'Unknown error'}.\nThe recording was saved to disk.`,
        )
      }
    },
    [createNewProject, addScene, updateScene, saveSceneHTML, onEnterEditor],
  )

  const handleRecordingCancel = () => {
    setRecordPhase('idle')
  }

  const filteredProjects = useMemo(() => {
    return projectList.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
  }, [projectList, searchQuery])

  const recentProjects = useMemo(() => {
    return projectList.slice(0, 5)
  }, [projectList])

  if (recordPhase === 'recording') {
    return <RecordingHUD onFinish={handleRecordingFinish} onCancel={handleRecordingCancel} />
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-primary)] relative font-sans">
      {/* Search Overlay (Command Palette style) */}
      {showAllProjects && (
        <>
          <div
            className="fixed inset-0 z-[100] bg-black/20"
            onClick={() => {
              setShowAllProjects(false)
              setSearchQuery('')
            }}
          />
          <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[101] w-[min(560px,90vw)] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
              <Search size={16} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects..."
                className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowAllProjects(false)
                    setSearchQuery('')
                  }
                  if (e.key === 'Enter' && filteredProjects[0]) handleOpenProject(filteredProjects[0].id)
                }}
              />
            </div>
            <div className="max-h-[320px] overflow-y-auto py-1 custom-scrollbar">
              {filteredProjects.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No projects found</p>
              )}
              {filteredProjects.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handleOpenProject(p.id)}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-white/[0.06] group"
                >
                  <FolderOpen
                    size={16}
                    className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]"
                  />
                  <span className="text-sm flex-1">{p.name}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">{formatDate(p.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="w-full max-w-[420px] flex flex-col items-start px-4">
        {/* Header */}
        <div className="flex flex-col gap-0 mb-6 select-none">
          <div className="flex items-center gap-0">
            <AgentIcon size={46} className="text-[var(--color-text-primary)]" />
            <h1
              className="text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)] leading-none uppercase ml-[-4px]"
              style={{ fontFamily: "'Saira Stencil', sans-serif" }}
            >
              Dreambyte
            </h1>
          </div>
          <div className="pl-[42px] flex items-center gap-1 text-[9px] uppercase font-bold tracking-wider text-[var(--color-text-muted)] mt-[-3px]">
            <span className="opacity-80">Pro</span>
            <span className="w-1 h-1 rounded-full bg-[var(--color-border)]" />
            <button
              onClick={() => setSettingsTab('general')}
              className="hover:text-[var(--color-text-primary)] transition-colors"
            >
              Settings
            </button>
          </div>
        </div>

        {/* First-run BYOK prompt — shows when no LLM key is configured. */}
        <BYOKBanner onOpenSettings={() => setSettingsTab('models')} />

        {/* Action Cards (Scaled down) */}
        <div className="grid grid-cols-3 gap-3 w-full mb-6">
          <ActionCard icon={<Plus size={18} />} label="New project" onClick={handleNewProject} />
          <ActionCard icon={<FolderOpen size={18} />} label="Open project" onClick={onOpenSearch ?? (() => {})} />
          <ActionCard icon={<Video size={18} />} label="Record" onClick={handleRecordClick} />
        </div>

        {/* Recent Projects (Screenshot match ultra-refined) */}
        <div className="w-full">
          <div className="flex items-center justify-between mb-0.5 px-0.5">
            <span className="text-[12px] text-[var(--color-text-muted)] font-medium font-sans">Recent projects</span>
            <span
              onClick={onOpenSearch}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer transition-colors font-sans opacity-70"
            >
              View all ({projectList.length})
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            {loading ? (
              <div className="py-6 text-left text-[var(--color-text-muted)]">
                <span className="text-[9px] font-mono">Syncing...</span>
              </div>
            ) : projectList.length === 0 ? (
              <div
                onClick={handleNewProject}
                className="py-3 flex flex-col items-start gap-1 hover:bg-white/[0.01] cursor-pointer group transition-all"
              >
                <span className="text-[11px] font-semibold text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]">
                  Initialize repository
                </span>
              </div>
            ) : (
              recentProjects.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handleOpenProject(p.id)}
                  className="flex items-center justify-between py-0.5 px-0.5 group cursor-pointer"
                >
                  <span className="text-[12px] font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)] transition-colors opacity-80 group-hover:opacity-100">
                    {p.name}
                  </span>
                  <span className="text-[11px] text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)] transition-colors font-sans opacity-40">
                    ~
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionCard({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] p-2.5 px-3 pt-3 pb-2 rounded-md cursor-pointer transition-colors group flex flex-col items-start gap-1 w-full border border-[var(--color-border)] shadow-sm"
    >
      <div className="text-[var(--color-text-primary)] opacity-80 group-hover:opacity-100 transition-opacity">
        {icon}
      </div>
      <span className="text-[11px] font-semibold tracking-tight text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)] transition-colors">
        {label}
      </span>
    </div>
  )
}
