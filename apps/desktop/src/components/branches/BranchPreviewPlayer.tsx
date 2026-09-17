'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Pause, GitBranch } from 'lucide-react'
import type { BranchRecord, BranchSceneMeta } from '@/types/dreambyte-api'
import { sceneSrc } from '@/lib/scene-url'
import { registerPreviewFrame } from '@/lib/preview-frame-registry'

interface Props {
  projectId: string
  branchId: string
  branch?: BranchRecord
}

// Colors for scene blocks in the timeline strip (cycles)
const SCENE_COLORS = [
  'bg-indigo-500/60',
  'bg-sky-500/60',
  'bg-violet-500/60',
  'bg-teal-500/60',
  'bg-amber-500/60',
  'bg-rose-500/60',
]

export default function BranchPreviewPlayer({ projectId, branchId, branch }: Props) {
  const [scenes, setScenes] = useState<BranchSceneMeta[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined

  const load = useCallback(async () => {
    if (!ipc) return
    setLoading(true)
    setError(null)
    try {
      const { scenes: list } = await ipc.listScenes({ projectId, branchId })
      setScenes(list)
      setSelectedIndex(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scenes')
    } finally {
      setLoading(false)
    }
  }, [ipc, projectId, branchId])

  useEffect(() => {
    load()
  }, [load])

  const selectedScene = scenes[selectedIndex]
  const totalDuration = scenes.reduce((a, s) => a + (s.duration ?? 8), 0)

  // Auto-advance when playing
  useEffect(() => {
    if (!isPlaying || !selectedScene) return
    const duration = (selectedScene.duration ?? 8) * 1000
    playTimerRef.current = setTimeout(() => {
      setSelectedIndex((i) => {
        if (i + 1 < scenes.length) return i + 1
        setIsPlaying(false)
        return i
      })
    }, duration)
    return () => {
      if (playTimerRef.current) clearTimeout(playTimerRef.current)
    }
  }, [isPlaying, selectedScene, selectedIndex, scenes.length])

  // Tell iframe to play/pause via postMessage
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: isPlaying ? 'play' : 'pause' }, '*')
  }, [isPlaying])

  // R1 follow-up: register this preview's iframe in the shared frame
  // registry so its scene-error beacons pass the posting-frame binding in
  // PreviewPlayer's listener (otherwise branch-preview playback errors are
  // silently dropped and never reach the scene-error buffer). The iframe is
  // keyed by sceneUrl, so a scene switch remounts it — this effect re-runs
  // after render with the fresh element and the cleanup unregisters the old.
  const selectedSceneId = selectedScene?.id
  useEffect(() => {
    if (!selectedSceneId) return
    return registerPreviewFrame(selectedSceneId, iframeRef.current)
  }, [selectedSceneId])

  function selectScene(index: number) {
    setIsPlaying(false)
    if (playTimerRef.current) clearTimeout(playTimerRef.current)
    setSelectedIndex(index)
  }

  const sceneUrl = selectedScene ? sceneSrc(selectedScene.id) : null

  if (!ipc) return null

  return (
    <div className="flex h-full flex-col bg-[var(--color-input-bg)]">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5">
        <GitBranch size={11} className="text-[var(--color-text-muted)]" />
        <span className="text-[12px] font-medium text-[var(--color-text-primary)]">{branch?.name ?? 'branch'}</span>
        {!loading && (
          <span className="text-[11px] text-[var(--color-text-muted)]">
            · {scenes.length} scene{scenes.length !== 1 ? 's' : ''}
            {totalDuration > 0 && ` · ${Math.round(totalDuration)}s`}
          </span>
        )}
        <span className="ml-auto rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
          read-only
        </span>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
          Loading...
        </div>
      )}
      {error && <div className="flex flex-1 items-center justify-center text-[12px] text-red-400">{error}</div>}
      {!loading && !error && scenes.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
          No scenes on this branch
        </div>
      )}

      {!loading && !error && scenes.length > 0 && (
        <>
          {/* Preview iframe — takes the bulk of vertical space */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
            {sceneUrl && (
              <iframe
                ref={iframeRef}
                key={sceneUrl}
                src={sceneUrl}
                sandbox="allow-scripts allow-same-origin" // same as PreviewPlayer: no top-navigation / popups
                className="h-full w-full"
                style={{ aspectRatio: '16/9', maxHeight: '100%', maxWidth: '100%' }}
                title={selectedScene?.name ?? `Scene ${selectedIndex + 1}`}
              />
            )}
            {/* Scene name overlay */}
            <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/50 px-2 py-1 text-[11px] text-white">
              {selectedScene?.name ?? `Scene ${selectedIndex + 1}`}
            </div>
          </div>

          {/* Playback controls */}
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] px-3 py-1.5">
            <button
              type="button"
              onClick={() => setIsPlaying((p) => !p)}
              className="no-style flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-primary)] hover:bg-[var(--agent-chat-user-surface)]"
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {selectedIndex + 1} / {scenes.length}
            </span>
          </div>

          {/* Timeline strip — proportional to scene duration */}
          <div
            className="flex shrink-0 border-t border-[var(--color-border)] bg-[var(--color-panel)]"
            style={{ height: 52 }}
          >
            <div className="flex h-full w-full items-stretch gap-px overflow-hidden px-1 py-1">
              {scenes.map((s, i) => {
                const widthPct = totalDuration > 0 ? ((s.duration ?? 8) / totalDuration) * 100 : 100 / scenes.length
                const isSelected = i === selectedIndex
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => selectScene(i)}
                    style={{ width: `${widthPct}%` }}
                    className={`no-style relative flex h-full min-w-[28px] flex-col items-start justify-end overflow-hidden rounded px-1.5 pb-1 transition-all ${
                      SCENE_COLORS[i % SCENE_COLORS.length]
                    } ${isSelected ? 'ring-2 ring-white/60' : 'opacity-70 hover:opacity-100'}`}
                  >
                    <span className="truncate text-[9px] font-medium text-white/90">{s.name ?? `${i + 1}`}</span>
                    <span className="text-[8px] text-white/60">{s.duration ?? 8}s</span>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
