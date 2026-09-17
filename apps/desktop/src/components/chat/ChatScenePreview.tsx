'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, SquareArrowOutUpRight, Volume2, VolumeX } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { sceneSrc } from '@/lib/scene-url'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { usePersistedState } from '@/lib/hooks/use-persisted-state'

/**
 * Chat-mode scene preview.
 *
 * A thin, single-iframe pane that follows the scene the agent is working on
 * (or the selected / latest scene) so you can watch the build without leaving
 * chat. Deliberately NOT PreviewPlayer (1.9k lines of editor-coupled zoom/
 * capture/scrub) — this reuses the shared modules both previews must agree on:
 *
 *   - `sceneSrc()` (src/lib/scene-url.ts) — NEVER hand-build the iframe src; the
 *     scene-frame origin boundary that sandboxes LLM-generated JS lives there.
 *   - the playback-controller postMessage protocol (src/lib/scene-html/) —
 *     `{ target: 'dreambyte-scene', sceneId, type: 'play'|'pause'|'set_audio_muted' }`.
 *
 * Resource policy:
 *   - Refresh is DEBOUNCED: agent builds rewrite scene HTML repeatedly;
 *     we reload once ~900ms after writes settle, not per write.
 *   - Collapse UNMOUNTS the iframe (not display:none) — zero idle CPU.
 *   - Audio muted by default; scenes load paused and we drive play.
 *
 * Placement contract (D6 jsdom test): this pane is a SIBLING of
 * AgentChatHost's slot in AppShell — it must never live inside the
 * reparented AgentChat node, or it would travel into the editor panel and
 * reload its iframe on every view switch.
 */

/** Debounce window for scene-HTML rewrites during an agent build. */
const REFRESH_SETTLE_MS = 900

export default function ChatScenePreview() {
  const scenes = useVideoStore((s) => s.scenes)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const isGenerating = useVideoStore((s) => s.isGenerating)
  const generatingSceneId = useVideoStore((s) => s.generatingSceneId)
  const sceneHtmlVersion = useVideoStore((s) => s.sceneHtmlVersion)
  const sceneWriteErrors = useVideoStore((s) => s.sceneWriteErrors)
  const setProjectView = useVideoStore((s) => s.setProjectView)
  const selectScene = useVideoStore((s) => s.selectScene)
  const aspectRatio = useVideoStore((s) => s.project.mp4Settings?.aspectRatio)
  const resolution = useVideoStore((s) => s.project.mp4Settings?.resolution)

  const [collapsed, setCollapsed] = usePersistedState('dreambyte:chat-preview-collapsed', false)
  const [muted, setMuted] = useState(true) // default-muted — chat stays quiet
  const [playing, setPlaying] = useState(true)
  // Bumped after writes settle → cache-busts the iframe src (sceneSrc ?v=).
  const [refreshVersion, setRefreshVersion] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Follow priority: the scene the agent is building right now → the user's
  // selected scene → the newest scene on the timeline.
  const followed = useMemo(() => {
    if (isGenerating && generatingSceneId) {
      const live = scenes.find((s) => s.id === generatingSceneId)
      if (live) return live
    }
    if (selectedSceneId) {
      const sel = scenes.find((s) => s.id === selectedSceneId)
      if (sel) return sel
    }
    return scenes.length > 0 ? scenes[scenes.length - 1] : null
  }, [scenes, selectedSceneId, isGenerating, generatingSceneId])

  // ── Debounced refresh: reload once after disk writes settle ──────────
  useEffect(() => {
    if (sceneHtmlVersion === 0) return // initial mount — nothing was rewritten
    const t = setTimeout(() => setRefreshVersion((v) => v + 1), REFRESH_SETTLE_MS)
    return () => clearTimeout(t) // a newer write restarts the settle window
  }, [sceneHtmlVersion])

  const post = useCallback(
    (msg: Record<string, unknown>) => {
      const win = iframeRef.current?.contentWindow
      if (!win || !followed) return
      win.postMessage({ target: 'dreambyte-scene', sceneId: followed.id, ...msg }, '*')
    },
    [followed],
  )

  // Scenes boot paused — on load, apply mute state and start playback.
  const handleLoad = useCallback(() => {
    post({ type: 'set_audio_muted', muted })
    if (playing) post({ type: 'play' })
  }, [post, muted, playing])

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      post({ type: p ? 'pause' : 'play' })
      return !p
    })
  }, [post])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      post({ type: 'set_audio_muted', muted: !m })
      return !m
    })
  }, [post])

  const writeError = followed ? sceneWriteErrors[followed.id] : undefined
  const dims = resolveProjectDimensions(aspectRatio, resolution)

  // ── Collapsed: slim rail, iframe fully unmounted (zero idle CPU, D7) ──────
  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-[var(--hairline)] pt-2">
        <button
          onClick={() => setCollapsed(false)}
          title="Show scene preview"
          className="rounded p-1.5 text-[var(--graphite)] hover:bg-[var(--color-panel-bg)] hover:text-[var(--ink)]"
        >
          <ChevronLeft size={15} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex w-[340px] shrink-0 flex-col border-l border-[var(--hairline)]"
      data-testid="chat-scene-preview"
    >
      {/* Header: scene name + controls */}
      <div className="flex items-center gap-1 border-b border-[var(--hairline)] px-2 py-1.5">
        <button
          onClick={() => setCollapsed(true)}
          title="Hide preview"
          className="rounded p-1 text-[var(--graphite)] hover:text-[var(--ink)]"
        >
          <ChevronRight size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ink-soft)]">
          {followed ? followed.name || 'Untitled scene' : 'Preview'}
          {isGenerating && generatingSceneId === followed?.id && (
            <span className="ml-1.5 text-[10px] text-[var(--mute)]">building…</span>
          )}
        </span>
        {followed && (
          <>
            <button
              onClick={togglePlay}
              title={playing ? 'Pause' : 'Play'}
              className="rounded p-1 text-[var(--graphite)] hover:text-[var(--ink)]"
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute'}
              className="rounded p-1 text-[var(--graphite)] hover:text-[var(--ink)]"
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button
              onClick={() => {
                selectScene(followed.id)
                setProjectView('editor')
              }}
              title="Open in editor"
              className="rounded p-1 text-[var(--graphite)] hover:text-[var(--ink)]"
            >
              <SquareArrowOutUpRight size={14} />
            </button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 items-start justify-center overflow-hidden p-2">
        {!followed ? (
          <div className="mt-10 px-4 text-center text-[12px] leading-relaxed text-[var(--mute)]">
            No scenes yet — ask the agent to build something and it will show up here while you chat.
          </div>
        ) : writeError ? (
          <div className="mt-10 px-4 text-center text-[12px] leading-relaxed text-[var(--mute)]">
            <p className="m-0 font-medium text-red-400">Scene failed to render</p>
            <p className="mt-1">{writeError}</p>
          </div>
        ) : (
          <div
            className="relative w-full overflow-hidden rounded-md border border-[var(--hairline)] bg-black"
            style={{ aspectRatio: `${dims.width} / ${dims.height}` }}
          >
            <iframe
              ref={iframeRef}
              key={`${followed.id}-${refreshVersion}`}
              src={sceneSrc(followed.id, refreshVersion)}
              onLoad={handleLoad}
              sandbox="allow-scripts allow-same-origin" // same as PreviewPlayer: no top-navigation / popups
              title={`Scene preview: ${followed.name || followed.id}`}
              className="absolute left-0 top-0 origin-top-left border-0"
              style={{
                width: dims.width,
                height: dims.height,
                // Scale the full-size scene into the pane (parent is aspect-locked).
                transform: `scale(${(340 - 16 - 2) / dims.width})`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
