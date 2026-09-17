'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useVideoStore } from '@/lib/store'
import { SCENE_ERROR_MESSAGE_TYPE, isErrorReportBoundToFrame } from '@/lib/agents/error-capture-shared'
import { isRegisteredPreviewFrame } from '@/lib/preview-frame-registry'
import { nextRenderableSceneId as computeNextRenderableSceneId } from '@/lib/preview-sequence'
import { replayTargetOnPlay, shouldAdvance } from '@/lib/preview-advance'
import { clipLocalTime } from '@/lib/preview-time'
import { resolveSceneAudioMix } from '@/lib/audio/scene-audio-mix'
import { resolveProjectDimensions } from '@/lib/dimensions'
import { sceneSrc } from '@/lib/scene-url'
import InteractionOverlay from './InteractionOverlay'
import GridOverlay from './GridOverlay'
import { ScenePlayer } from '@/lib/scene-player'
import { GradePreviewFilter } from '@/components/preview/GradePreviewFilter'
import { ClipGradeSvgFilter } from '@/components/preview/ClipGradeSvgFilter'
import type { Scene, Clip } from '@/lib/types'
import type { InteractionCallbacks } from '@/components/interactions/InteractionRenderer'

// Media rendering: bare video/image clips render as a DOM <video>/<img> layer
// (planCompositeFrame-driven, preview=export). This is the only preview media path.
const PreviewMediaLayer = dynamic(() => import('./PreviewMediaLayer'), { ssr: false })
import { getActiveClips, getPlaybackSequenceClips, getV1Track } from '@/lib/timeline/sequence'
import { planCompositeFrame, type CompositeLayer } from '@/lib/timeline/composite-frame'
import { applyGradePreview } from '@/lib/edit-engines/grade-detect'

/** DreambyteCharts timeline reveals keep bars at height 0 until several seconds in; paused @ t=0 looks like an empty chart. */
const D3_PEEK_MAX_S = 6
function formatVerifyError(err: Scene['verifyError'], status: Scene['verifyStatus']): string {
  if (!err) {
    return status === 'errored' ? 'Scene failed verification' : 'Scene failed to verify'
  }
  const where = typeof err.line === 'number' ? ` (line ${err.line})` : ''
  switch (err.kind) {
    case 'syntax':
      return `Syntax error${where}: ${err.message}`
    case 'runtime':
      return `Runtime error${where}: ${err.message}`
    case 'timeout':
      return err.message || 'Scene exceeded verification timeout'
    case 'asset':
      return `Asset error: ${err.message}`
    default:
      return err.message || 'Scene failed verification'
  }
}

function d3PausedPreviewTime(scene: Scene | undefined): number {
  if (!scene || scene.sceneType !== 'd3') return 0
  const d = Math.max(0.05, scene.duration ?? 8)
  return Math.min(d, D3_PEEK_MAX_S)
}

/** Drop ids no longer present; return the SAME reference when nothing changed
 *  so the prune effect doesn't trigger a needless re-render. */
function prunedSet(prev: Set<string>, live: Set<string>): Set<string> {
  let changed = false
  const next = new Set<string>()
  for (const id of prev) {
    if (live.has(id)) next.add(id)
    else changed = true
  }
  return changed ? next : prev
}
function prunedRecord<T>(prev: Record<string, T>, live: Set<string>): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const k of Object.keys(prev)) {
    if (live.has(k)) next[k] = prev[k]
    else changed = true
  }
  return changed ? next : prev
}

/**
 * Downscale a captured data URI and re-encode it as JPEG. `size` maps the source
 * dimensions to the target ones, so each caller keeps its own sizing rule.
 * Falls back to the original URI if decode/2d-context is unavailable.
 *
 * Shared by the two capturePage callers — the agent frame capture and the
 * filmstrip slot capture — which were otherwise a full-resolution PNG of the
 * WHOLE app window and a cropped 80px JPEG respectively.
 */
function shrinkToJpeg(
  dataUri: string,
  size: (w: number, h: number) => { w: number; h: number },
  quality: number,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const { w, h } = size(img.width, img.height)
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w))
      c.height = Math.max(1, Math.round(h))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(dataUri)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(dataUri)
    img.src = dataUri
  })
}

/** Long-edge cap for agent-visible frames: ~800px is legible to a vision model at ~1/5 the tokens. */
const AGENT_FRAME_MAX_EDGE = 800
const AGENT_FRAME_JPEG_QUALITY = 0.7
const fitAgentFrame = (w: number, h: number) => {
  const s = Math.min(1, AGENT_FRAME_MAX_EDGE / Math.max(1, w, h))
  return { w: w * s, h: h * s }
}

export default function PreviewPlayer() {
  const {
    scenes,
    selectedSceneId,
    isGenerating,
    generatingSceneId,
    timelineHeight,
    setTimelineHeight,
    sceneHtmlVersion,
    agentReloadNonce,
    agentReloadSceneIds,
    saveSceneHTML,
    project,
    gridConfig,
    updateGridConfig,
    undo,
    redo,
    actionUndo,
    actionRedo,
    _undoStack,
    _redoStack,
    isPreviewFullscreen,
    setPreviewFullscreen,
    setPreviewZoom,
    gradePreviewOverride,
    sceneGradePreview,
    setTimelineTransport,
    projectActiveBranchId,
    projectDefaultBranchId,
    centerTab,
  } = useVideoStore()

  const outputMode = project.outputMode
  const projectDims = resolveProjectDimensions(project.mp4Settings?.aspectRatio, project.mp4Settings?.resolution)
  const previewAspect = `${projectDims.width}/${projectDims.height}`

  // Media rendering: bare video/image clips render via the DOM
  // PreviewMediaLayer (planCompositeFrame-driven, preview=export) — including in
  // MIXED projects. `hasMediaClips` gates
  // whether the DOM media layer mounts.
  const hasMediaClips = (project.timeline?.tracks ?? []).some((t) =>
    t.clips.some((c) => c.sourceType === 'video' || c.sourceType === 'image'),
  )
  // Live grade/curve drag-preview for MEDIA clips: the grading UI stashes an
  // uncommitted filter list in `gradePreviewOverride`; fold it into the timeline the
  // DOM media layer renders. When no override is
  // active, applyGradePreview returns the SAME timeline ref, so the media layer's rAF
  // stays parked — it only re-syncs while a grade is actually being previewed.
  const mediaPreviewTimeline = useMemo(
    () => applyGradePreview(project.timeline, gradePreviewOverride),
    [project.timeline, gradePreviewOverride],
  )

  const selectedScene = scenes.find((s) => s.id === selectedSceneId)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const iframeMapRef = useRef<Record<string, HTMLIFrameElement | null>>({})
  const playerMapRef = useRef<Record<string, ScenePlayer>>({})
  const dragOrigin = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const animFrameRef = useRef<number>()
  const scenesRef = useRef(scenes)
  const selectedIdRef = useRef(selectedSceneId)
  // Clip identity of what's PLAYING — distinct from selectedSceneId (the iframe).
  // A scene split into two clips shares one iframe; this disambiguates which
  // half is live so playback uses that half's trim/speed (not the first match).
  const currentClipIdRef = useRef<string | null>(null)
  // The scene clips visible at the playhead (multi-track) + the live playhead —
  // refs so the rAF tick / resume can read them without re-creating callbacks.
  const activeClipsRef = useRef<Array<{ sourceId: string; clip: Clip }>>([])
  const globalTimeRef = useRef(0)
  // Global wall-clock master (multi-track): the topmost active scene + total
  // timeline duration, read by the rAF tick so the clock advances by real time
  // independent of any one scene (top mp4 keeps playing when the track below
  // ends or gaps).
  const topActiveSceneIdRef = useRef<string | null>(null)
  const totalDurationRef = useRef(0)
  const isPlayingRef = useRef(false)
  const currentTimeRef = useRef(0)
  const isAutoAdvancing = useRef(false) // set true when onEnded auto-advances to next scene
  const advanceFromRef = useRef<string | null>(null) // single-fire guard: scene id currently advancing (see advanceFromScene)
  const completedRef = useRef(false) // transport parked at end-of-timeline; the next play() replays from scene 1
  const isSeeking = useRef(false) // set true when handleSeek/stepFrame changes scenes
  const pendingPlayRef = useRef<string | null>(null) // queued play for unloaded scene
  const pendingPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // safety net: a queued scene that never produces a player must not freeze playback
  const goToSceneAndPlayRef = useRef<((id: string) => void) | null>(null) // stable self-ref for the safety-net timeout

  // Gap playback: when playhead is between clips (dead air)
  const isInGapRef = useRef(false)
  const gapPlaybackRef = useRef<{
    startGlobalT: number // global time when this gap segment started
    endGlobalT: number // global time when gap ends (next clip's startTime)
    nextSceneId: string
    nextClipId?: string // the specific clip to enter after the gap (split-aware)
    wallStart: number // Date.now() when gap tick started
  } | null>(null)

  // Clip fade transitions: cross-fade between outgoing/incoming scene iframes
  type TransitionState = {
    outgoingSceneId: string
    incomingSceneId: string
    progress: number // 0→1
    duration: number
    incomingSeeked: boolean
  } | null
  const transitionRef = useRef<TransitionState>(null)

  // ── State ─────────────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false)
  const [isInGap, setIsInGap] = useState(false)
  const [gapGlobalTime, setGapGlobalTime] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  // seekTimes removed — scene-clock seek via postMessage replaces ?t= URL params
  const [sceneVersions, setSceneVersions] = useState<Record<string, number>>({})
  const [loadedScenes, setLoadedScenes] = useState<Set<string>>(new Set())
  const [failedScenes, setFailedScenes] = useState<Set<string>>(new Set())
  const failedScenesRef = useRef(failedScenes) // mirror for the stable play()/advance callbacks
  const sceneWriteErrors = useVideoStore((s) => s.sceneWriteErrors)
  const [zoom, setZoom] = useState(1)
  // Measured preview frame size — fit to the available viewport area so the
  // frame is never clipped/covered by the timeline or the right-hand panel.
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null)
  const zoomRef = useRef(1)
  const panXRef = useRef(0)
  const panYRef = useRef(0)
  useEffect(() => {
    zoomRef.current = zoom
    setPreviewZoom(zoom)
  }, [zoom, setPreviewZoom])
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  useEffect(() => {
    panXRef.current = panX
  }, [panX])
  useEffect(() => {
    panYRef.current = panY
  }, [panY])
  const [isDragging, setIsDragging] = useState(false)
  const isFullscreen = isPreviewFullscreen
  const setIsFullscreen = setPreviewFullscreen
  const preFullscreenTimelineHeightRef = useRef<number>(200)
  const wasFullscreenRef = useRef(false)
  // Filmstrip frame accumulation: which slots are already captured per scene,
  // plus a serialization flag so capturePage calls never overlap.
  const filmstripSlotsRef = useRef<Map<string, Set<number>>>(new Map())
  const filmstripCapturingRef = useRef(false)

  useEffect(() => {
    if (isFullscreen && !wasFullscreenRef.current) {
      if (timelineHeight > 0) preFullscreenTimelineHeightRef.current = timelineHeight
      setTimelineHeight(0)
    } else if (!isFullscreen && wasFullscreenRef.current) {
      const restoreHeight = preFullscreenTimelineHeightRef.current > 0 ? preFullscreenTimelineHeightRef.current : 200
      setTimelineHeight(restoreHeight)
    }
    wasFullscreenRef.current = isFullscreen
  }, [isFullscreen, timelineHeight, setTimelineHeight])

  // ── One-time: resave HTML for any non-SVG scenes already in the store ──────
  useEffect(() => {
    scenes
      .filter((s) => {
        if (s.sceneType === 'react') return !!s.reactCode
        if (s.sceneType === 'canvas2d') return !!s.canvasCode
        if (s.sceneType === 'motion' || s.sceneType === 'd3' || s.sceneType === 'three') {
          return !!s.sceneCode || !!s.canvasBackgroundCode?.trim()
        }
        if (s.sceneType === 'lottie') return !!s.lottieSource
        if (s.sceneType === '3d_world') return !!s.worldConfig
        return !!s.svgContent || !!s.canvasBackgroundCode?.trim()
      })
      .forEach((s) => saveSceneHTML(s.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep refs in sync with state
  useEffect(() => {
    scenesRef.current = scenes
  }, [scenes])
  useEffect(() => {
    selectedIdRef.current = selectedSceneId
  }, [selectedSceneId])
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])
  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])
  useEffect(() => {
    isInGapRef.current = isInGap
  }, [isInGap])
  useEffect(() => {
    failedScenesRef.current = failedScenes
  }, [failedScenes])

  // ── Track mute: handled by the per-category mix effect below ────────────────
  // Don't post a per-track `set_audio_muted` to scenes: the iframe handler mutes
  // EVERY audio/video element, so muting just the music track would silence
  // narration, SFX, and embedded video for the whole scene. The per-category mix
  // (set_scene_audio_mix) drops a muted lane's AUDIO elements via volume, per
  // category, with no last-writer race.
  //
  // Export parity — what the EXPORT does with V1-track mute on scene-embedded
  // <video>-element audio: NOTHING. Tier3 captures frames from a BrowserWindow
  // with webContents.setAudioMuted(true) and encodes with `-an` (no page audio is
  // ever captured); the MP4's scene audio is mixed separately by
  // mixSceneAudioElectron from scene.audioLayer (tts/sfx/music/legacy file) gated
  // by resolveSceneAudioMix, which resolves lanes by the tts-/aud-/mus-/sfx clip
  // sourceIds — V1 is never consulted and embedded-video audio has no input path.
  // pixi-mp4's renderAudioBlobForScene likewise reads only config.audioLayer. So
  // the preview copies the export: no whole-iframe mute, no video-element mute.
  // (The `set_audio_muted` iframe handler itself stays — ChatScenePreview's mute
  // toggle still posts it.)

  // ── Per-category audio mix: propagate faders / pan / solo / master to scene iframes ──
  // The export bakes the full mixer. Resolve
  // each scene's mix with the SAME resolver the export uses (resolveSceneAudioMix) and
  // push it, so dragging a fader / pan / solo / the master is audible in preview and
  // matches the exported MP4. Fingerprint the mix-affecting fields so it doesn't fire
  // on every clip move.
  const masterVolume = project.audioSettings?.masterVolume
  // Fingerprint the mix-affecting fields: per-track volume/mute/solo/pan + the master,
  // AND per-clip audioMuted + which track each clip sits on (resolveSceneAudioMix reads
  // clip.audioMuted and resolves a clip's track by placement). Without the clip segment,
  // toggling a single clip's mute or dragging a clip to another track wouldn't re-push
  // and the preview would diverge from the export. A within-track move (startTime only)
  // leaves this unchanged, so it doesn't fire on every clip move.
  const trackMixSig =
    (project.timeline?.tracks ?? [])
      .map(
        (t) =>
          `${t.id}:${t.volume ?? 1}:${t.muted ? 1 : 0}:${t.solo ? 1 : 0}:${t.pan ?? 0}:` +
          t.clips.map((c) => `${c.sourceId}${c.audioMuted ? '!' : ''}`).join('|'),
      )
      .join(',') + `|m:${masterVolume ?? 1}`
  useEffect(() => {
    const tracks = project.timeline?.tracks ?? []
    for (const scene of scenesRef.current) {
      const player = playerMapRef.current[scene.id]
      if (player) player.setSceneAudioMix(resolveSceneAudioMix(scene, tracks, masterVolume))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackMixSig])

  // ── Register frame capturer for agent visual feedback ──────────────────────
  // Priority: Electron webContents.capturePage (works for iframe canvas/WebGL) →
  // html2canvas fallback (web build, DOM only — misses live canvas).
  //
  // Crop to the preview frame and downscale before upload. A full-window,
  // full-resolution PNG costs ~4k image tokens per capture while the scene
  // occupies a small fraction of it (the rest is chat sidebar, mixer and
  // timeline). captureFilmstripSlot below shares the same shrinkToJpeg path.
  useEffect(() => {
    const tryElectronCapture = async (): Promise<string | null> => {
      const api = (
        window as unknown as {
          electronAPI?: {
            capturePage?: (a?: {
              rect?: { x: number; y: number; width: number; height: number }
            }) => Promise<{ ok: boolean; dataUri?: string }>
          }
        }
      ).electronAPI
      if (!api?.capturePage) return null
      try {
        // Scene-only crop when the preview frame is on screen; whole window otherwise
        // (chat-only view) so a capture never comes back empty.
        const r = canvasRef.current?.getBoundingClientRect()
        const rect =
          r && r.width >= 2 && r.height >= 2
            ? {
                x: Math.round(r.left),
                y: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              }
            : undefined
        const res = (await api.capturePage(rect ? { rect } : undefined)) as { ok: boolean; dataUri?: string }
        if (!res?.ok || !res.dataUri) return null
        return await shrinkToJpeg(res.dataUri, fitAgentFrame, AGENT_FRAME_JPEG_QUALITY)
      } catch {
        return null
      }
    }

    const tryHtml2Canvas = async (sceneId: string, time: number): Promise<string | null> => {
      const iframe = iframeMapRef.current[sceneId]
      if (!iframe?.contentWindow || !iframe.contentDocument) return null

      iframe.contentWindow.postMessage({ target: 'dreambyte-scene', sceneId, type: 'seek', time }, '*')
      await new Promise<void>((resolve) => {
        const onAck = (ev: MessageEvent) => {
          const d = ev.data
          if (!d || d.source !== 'dreambyte-scene' || d.type !== 'seeked') return
          if (d.sceneId && d.sceneId !== sceneId) return
          window.removeEventListener('message', onAck)
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }
        window.addEventListener('message', onAck)
        setTimeout(() => {
          window.removeEventListener('message', onAck)
          resolve()
        }, 500)
      })

      try {
        const { default: html2canvas } = await import('html2canvas')
        const scene = scenesRef.current.find((s) => s.id === sceneId)
        // Same long-edge budget as the Electron path above, applied at render
        // time so there's no second encode. (The old flat scale:0.5 was dead in
        // practice — Electron is tried first and always wins in the desktop app.)
        const body = iframe.contentDocument.body
        const longEdge = Math.max(1, body.scrollWidth, body.scrollHeight)
        const canvas = await html2canvas(body, {
          scale: Math.min(1, AGENT_FRAME_MAX_EDGE / longEdge),
          useCORS: true,
          allowTaint: true,
          backgroundColor: scene?.bgColor ?? '#000000',
          logging: false,
        })
        return canvas.toDataURL('image/jpeg', AGENT_FRAME_JPEG_QUALITY)
      } catch {
        return null
      }
    }

    const capturer = async (sceneId: string, time: number): Promise<string | null> => {
      return (await tryElectronCapture()) ?? (await tryHtml2Canvas(sceneId, time))
    }

    useVideoStore.getState().registerFrameCapturer(capturer)
    return () => {
      useVideoStore.getState().registerFrameCapturer(null)
    }
  }, [])

  // Span ALL video tracks (V2-over-V1 composite) so a scene parked on V2 past
  // V1's end still extends the total timeline duration.
  const _v1Clips =
    project.timeline?.tracks
      .filter((t) => t.type === 'video')
      .flatMap((t) => t.clips)
      .filter((c) => c.sourceType === 'scene') ?? []
  const totalDuration =
    _v1Clips.length > 0
      ? Math.max(..._v1Clips.map((c) => c.startTime + c.duration))
      : scenes.reduce((a, s) => a + s.duration, 0)
  const isThisGenerating = isGenerating && generatingSceneId === selectedSceneId

  // ── Auto-reload the selected scene when its HTML file changes on disk ─────
  // Single-scene saves / undo / branch switch bump sceneHtmlVersion; the active
  // scene is the one that changed, so reloading just it is correct and avoids
  // remounting hidden iframes (which would reset their in-iframe state). The
  // agent's MULTI-scene rewrites are handled separately below via agentReload.
  const reloadSceneIds = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setSceneVersions((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = (next[id] ?? 0) + 1
      return next
    })
    setLoadedScenes((prev) => {
      const n = new Set(prev)
      for (const id of ids) n.delete(id)
      return n
    })
  }, [])

  const prevHtmlVersion = useRef(sceneHtmlVersion)
  useEffect(() => {
    if (sceneHtmlVersion !== prevHtmlVersion.current) {
      prevHtmlVersion.current = sceneHtmlVersion
      if (selectedSceneId) reloadSceneIds([selectedSceneId])
    }
  }, [sceneHtmlVersion, selectedSceneId, reloadSceneIds])

  // ── Reload exactly the scenes an agent run rewrote ────────────────────────
  // An agent build rewrites several scene HTML files at once. Without this, only
  // the selected iframe refreshes (above) and the other rewritten scenes keep
  // showing their pre-build HTML — their ?v= never changes, so React never
  // refetches them. agentReloadNonce bumps once per run AFTER the files land on
  // disk (see agent-actions), carrying the exact set of rewritten ids.
  const prevAgentReloadNonce = useRef(agentReloadNonce)
  useEffect(() => {
    if (agentReloadNonce !== prevAgentReloadNonce.current) {
      prevAgentReloadNonce.current = agentReloadNonce
      reloadSceneIds(agentReloadSceneIds)
    }
  }, [agentReloadNonce, agentReloadSceneIds, reloadSceneIds])

  // ── Manual scene selection (from scene list click) ────────────────────────
  useEffect(() => {
    // A new scene is now active — clear the single-fire advance guard so this
    // scene can advance once it reaches its own trimEnd / end. Runs on every
    // selection change, including auto-advance (before the early-returns below).
    advanceFromRef.current = null
    // Any explicit move off the parked-end scene leaves `completed` — the next
    // play resumes the now-selected scene, not a replay-from-start.
    completedRef.current = false
    // Drop any queued auto-play targeting a now-stale scene so it can't ghost-play
    // after a selection change. Inlined (not the useCallback) so this effect
    // keeps its [selectedSceneId]-only dep list.
    if (!isAutoAdvancing.current) {
      pendingPlayRef.current = null
      if (pendingPlayTimerRef.current) {
        clearTimeout(pendingPlayTimerRef.current)
        pendingPlayTimerRef.current = null
      }
    }
    if (isAutoAdvancing.current) {
      // Auto-advance from onEnded — don't interrupt playback
      isAutoAdvancing.current = false
      return
    }
    if (isSeeking.current) {
      // Seek/step already handled time and pause — don't reset
      isSeeking.current = false
      return
    }
    // User manually picked a scene — stop playback; D3 charts need t>0 while paused or bars stay hidden (timeline reveal)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    setIsPlaying(false)
    const picked = scenesRef.current.find((s) => s.id === selectedSceneId)
    const idleT = d3PausedPreviewTime(picked)
    setCurrentTime(idleT)
    // Point the live-clip cursor at the picked scene's clip so a subsequent
    // play() uses ITS trim (not a stale clip id from prior playback). Earliest
    // clip of the scene is the entry point.
    if (selectedSceneId) {
      const pickedClips = (getV1SceneClips() ?? []).filter(
        (c) => c.sourceId === selectedSceneId && c.sourceType === 'scene',
      )
      currentClipIdRef.current = pickedClips.slice().sort((a, b) => a.startTime - b.startTime)[0]?.id ?? null
    }
    if (selectedSceneId) {
      const sid = selectedSceneId
      setTimeout(() => {
        pauseAllScenes()
        const pl = playerMapRef.current[sid]
        if (pl) {
          requestAnimationFrame(() => {
            try {
              pl.seek(idleT)
            } catch {}
          })
        }
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSceneId])

  // ── Helpers ───────────────────────────────────────────────────────────────
  // Zoom is disabled (fixed-size preview); only the reset-view shortcut remains
  // so Cmd+0 can re-center pan if a stray drag ever moved it.
  const resetView = useCallback(() => {
    setZoom(1)
    setPanX(0)
    setPanY(0)
  }, [])

  // ── Per-scene animation control (via ScenePlayer postMessage) ─────────────

  const getPlayer = useCallback((sceneId: string | null): ScenePlayer | null => {
    if (!sceneId) return null
    return playerMapRef.current[sceneId] ?? null
  }, [])

  const pauseScene = useCallback(
    (sceneId: string | null) => {
      if (!sceneId) return
      const player = getPlayer(sceneId)
      if (player) {
        player.pause()
        return
      }
      // Fallback for iframes without the playback controller (legacy)
      const iframe = iframeMapRef.current[sceneId]
      if (iframe)
        try {
          ;(iframe.contentWindow as any).__pause?.()
        } catch {}
    },
    [getPlayer],
  )

  const resumeScene = useCallback(
    (sceneId: string | null) => {
      if (!sceneId) return
      const player = getPlayer(sceneId)
      if (player) {
        player.play()
        return
      }
      // Fallback for iframes without the playback controller (legacy)
      const iframe = iframeMapRef.current[sceneId]
      if (iframe)
        try {
          ;(iframe.contentWindow as any).__resume?.()
        } catch {}
    },
    [getPlayer],
  )

  /** Stop every loaded scene (avoids ghost audio from display:none / hidden iframes still playing). */
  const pauseAllScenes = useCallback(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(playerMapRef.current)) ids.add(id)
    for (const id of Object.keys(iframeMapRef.current)) {
      if (iframeMapRef.current[id]) ids.add(id)
    }
    ids.forEach((id) => pauseScene(id))
  }, [pauseScene])

  /**
   * Multi-track resume: every scene visible at the playhead plays NATIVELY, each
   * synced to its clip-local start first. A stacked mp4 on V2 must actually play
   * through, not show a frozen frame (seeking a <video> per frame freezes it).
   * Falls back to the selected scene when there's no active set yet.
   */
  const resumeActiveLayers = useCallback(() => {
    const actives = activeClipsRef.current
    if (actives.length === 0) {
      resumeScene(selectedIdRef.current)
      return
    }
    const gt = globalTimeRef.current
    for (const { sourceId, clip } of actives) {
      const p = playerMapRef.current[sourceId]
      if (p) {
        const localT = Math.max(0, gt - clip.startTime)
        try {
          p.seek((clip.trimStart ?? 0) + localT * (clip.speed ?? 1))
        } catch {}
      }
      resumeScene(sourceId)
    }
  }, [resumeScene])

  // ── Interaction callbacks for preview mode ──────────────────────────────────

  // Track which gates have been triggered to avoid re-triggering
  const triggeredGatesRef = useRef<Set<string>>(new Set())

  /**
   * The COMPOSITE playback sequence: scene clips across ALL video tracks, sorted
   * by startTime (ties broken by track position descending, so a higher lane —
   * V2 over V1 — wins). A scene dragged up to V2 therefore
   * plays over the hole it left on V1 instead of the gap going black; a true gap
   * (no clip on ANY video track at that time) still plays black. Returns null if
   * there's no timeline.
   *
   * The sequence is the V1 SPINE (lowest-position video track) plus only the
   * higher-track scene clips that fall in a V1 GAP (don't overlap any V1 clip).
   * A higher-track clip that OVERLAPS V1 is an overlay, NOT a sequence entry —
   * including it would make the single-iframe engine play the two stacked clips
   * back-to-back (a visible jump). True top-over-bottom compositing of an
   * overlapping clip needs simultaneous rendering (DOM-stacked iframes, Phase B).
   */
  const getV1SceneClips = useCallback(() => {
    // Shared with the export's fade (composite-frame.applyFadeTransition) via
    // getPlaybackSequenceClips — ONE definition of the spine + gap-filler ordering
    // so preview and export advance through (and crossfade between) the same clips.
    const tl = useVideoStore.getState().project.timeline
    if (!getV1Track(tl)) return null
    return getPlaybackSequenceClips(tl)
  }, [])

  // ── The single playback tick ───────────────────────────────────────────────
  // ONE rAF tick body — clip-local playhead write + trimEnd watchdog + fade
  // cross-fade + gate checks — used by EVERY transport entry point (play,
  // resumeAndTick). Auto-advance routes through resumeAndTick, so a separate
  // tick there would make scenes 2..N lose the watchdog (right-trim overshoot)
  // and the fades. advanceFromScene is
  // reached via a ref because it's defined after this (it calls goToSceneAndPlay →
  // resumeAndTick, a cycle we break with the ref).
  const runPlaybackTick = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    // GLOBAL WALL-CLOCK MASTER: globalTime advances by REAL elapsed time, not by
    // any one scene's player. So duration + gaps span ALL tracks and the topmost
    // active scene (e.g. an mp4 on V2) keeps playing when the track below it ends
    // or gaps. Every scene active at the playhead is driven from this one clock.
    const startWall = Date.now()
    const startGlobal = globalTimeRef.current
    let prevActive = new Set(activeClipsRef.current.map((a) => a.sourceId))
    let prevTop = topActiveSceneIdRef.current

    const tick = () => {
      if (!isPlayingRef.current) return
      const total = totalDurationRef.current
      const g = startGlobal + (Date.now() - startWall) / 1000

      // End of the whole timeline (max across all tracks) → stop cleanly (no loop).
      if (total > 0 && g >= total) {
        completedRef.current = true
        pauseAllScenes()
        setIsPlaying(false)
        return
      }

      const tl = useVideoStore.getState().project.timeline
      const active = getActiveClips(tl, g, { sourceType: 'scene' })
      let top: { clip: Clip; trackZBase: number } | null = null
      for (const a of active)
        if (!top || a.trackZBase > top.trackZBase) top = { clip: a.clip, trackZBase: a.trackZBase }

      // Resume/pause scenes as they enter/leave the active set (one clock drives all).
      const activeIds = new Set(active.map((a) => a.clip.sourceId))
      for (const id of prevActive) if (!activeIds.has(id)) pauseScene(id)
      for (const a of active) {
        if (!prevActive.has(a.clip.sourceId)) {
          const p = playerMapRef.current[a.clip.sourceId]
          if (p) {
            try {
              p.seek((a.clip.trimStart ?? 0) + Math.max(0, g - a.clip.startTime) * (a.clip.speed ?? 1))
            } catch {}
            resumeScene(a.clip.sourceId)
          }
        }
      }
      prevActive = activeIds

      if (top) {
        if (isInGapRef.current) {
          setIsInGap(false)
          isInGapRef.current = false
          gapPlaybackRef.current = null
        }
        const topId = top.clip.sourceId
        currentClipIdRef.current = top.clip.id
        // The displayed/selected scene follows the topmost layer. Guard the
        // selection effect (isAutoAdvancing) so it doesn't pause playback.
        if (topId !== prevTop) {
          prevTop = topId
          isAutoAdvancing.current = true
          useVideoStore.getState().selectScene(topId)
        }
        const localT = Math.max(0, g - top.clip.startTime)
        setCurrentTime(localT)

        // Fade transition (EXECUTOR side): the crossfade's VISUAL ramp is now driven
        // by planCompositeFrame({fade}) in the render (sceneLayerById) — the same plan
        // the export uses — so this tick only does the EXECUTOR work the plan can't:
        // seek the incoming scene's player ONCE to its in-point when the fade starts
        // (mirrors the export host seeking the incoming iframe). transitionRef is the
        // one-shot latch (incomingSeeked) + which scene is outgoing, so we seek once
        // and clear when the fade ends. No setTransitionForRender — the render reads
        // the plan, and setCurrentTime already re-renders every frame.
        const seq = getV1SceneClips()
        const idx = seq ? seq.findIndex((c) => c.id === top.clip.id) : -1
        const nextClip = seq && idx >= 0 ? seq[idx + 1] : undefined
        if (
          top.clip.transition &&
          top.clip.transition.type !== 'none' &&
          top.clip.transition.duration > 0 &&
          nextClip
        ) {
          const remaining = top.clip.duration - localT
          const td = top.clip.transition.duration
          if (remaining < td && remaining >= 0) {
            if (!transitionRef.current?.incomingSeeked) {
              const incomingPlayer = playerMapRef.current[nextClip.sourceId]
              if (incomingPlayer) incomingPlayer.seek(nextClip.trimStart ?? 0)
            }
            transitionRef.current = {
              outgoingSceneId: topId,
              incomingSceneId: nextClip.sourceId,
              progress: Math.min(1, Math.max(0, 1 - remaining / td)),
              duration: td,
              incomingSeeked: true,
            }
          } else if (transitionRef.current?.outgoingSceneId === topId) {
            transitionRef.current = null
          }
        } else if (transitionRef.current) {
          transitionRef.current = null
        }

        // Gate detection on the top scene: pause for an interactive gate.
        const scene = scenesRef.current.find((s) => s.id === topId)
        if (scene?.interactions) {
          for (const el of scene.interactions) {
            if (el.type === 'gate' && !triggeredGatesRef.current.has(el.id) && localT >= el.appearsAt) {
              triggeredGatesRef.current.add(el.id)
              pauseAllScenes()
              setIsPlaying(false)
              return
            }
          }
        }
      } else {
        // True gap (no clip on ANY track) → black, but keep advancing the clock.
        if (!isInGapRef.current) {
          setIsInGap(true)
          isInGapRef.current = true
        }
        setGapGlobalTime(g)
      }

      animFrameRef.current = requestAnimationFrame(tick)
    }
    animFrameRef.current = requestAnimationFrame(tick)
  }, [getV1SceneClips, pauseAllScenes, pauseScene, resumeScene])

  /** Resume current scene and restart the (shared) tick loop */
  const resumeAndTick = useCallback(() => {
    pauseAllScenes()
    resumeActiveLayers()
    setIsPlaying(true)
    runPlaybackTick()
  }, [resumeActiveLayers, pauseAllScenes, runPlaybackTick])

  // Find the first scene at/after `fromSceneId` (in timeline order) that can
  // actually render. A verify-errored scene never mounts its iframe, so it has
  // no player — walking past it here is what keeps one broken scene from
  // freezing the whole build. Falls back to scenes-array order with no V1 track.
  const nextRenderableSceneId = useCallback(
    (fromSceneId: string): string | null => {
      // A scene is unrenderable if verify flagged it OR its controller posted
      // init_error (failedScenes — e.g. anime.js missing, C4b). Both lack a live player.
      const isErrored = (id: string) =>
        scenesRef.current.find((s) => s.id === id)?.verifyStatus === 'errored' || failedScenesRef.current.has(id)
      // Composite order (spans all video tracks, V2-over-V1) so auto-advance walks
      // the same sequence the playhead and gap logic do.
      const composite = getV1SceneClips()
      const ordered = composite ? composite.map((c) => c.sourceId) : scenesRef.current.map((s) => s.id)
      return computeNextRenderableSceneId(ordered, isErrored, fromSceneId)
    },
    [getV1SceneClips],
  )

  const goToSceneAndPlay = useCallback(
    // `clipId` targets a SPECIFIC clip of the scene (e.g. the right half of a
    // split); omitted, it enters the scene's earliest clip. Either way the live
    // clip identity is recorded in currentClipIdRef so the tick uses its trim.
    (sceneId: string, clipId?: string) => {
      if (!sceneId) return
      // Clear any stale safety-net timer from a previous queued scene.
      if (pendingPlayTimerRef.current) {
        clearTimeout(pendingPlayTimerRef.current)
        pendingPlayTimerRef.current = null
      }
      // Resolve to the first renderable scene at/after the requested one. A
      // verify-errored scene never mounts its iframe, so its player never
      // appears; without this, playback parks in pendingPlayRef forever and the
      // whole build freezes on one broken scene.
      const requestedErrored =
        scenesRef.current.find((s) => s.id === sceneId)?.verifyStatus === 'errored' ||
        failedScenesRef.current.has(sceneId)
      const playId = requestedErrored ? nextRenderableSceneId(sceneId) : sceneId
      if (!playId) {
        // Nothing renderable from here — land on the requested (broken) scene's
        // error card and stop cleanly instead of freezing.
        pauseAllScenes()
        triggeredGatesRef.current.clear()
        isAutoAdvancing.current = false
        useVideoStore.getState().selectScene(sceneId)
        setCurrentTime(0)
        setIsPlaying(false)
        return
      }
      pauseAllScenes()
      triggeredGatesRef.current.clear()
      // Mark as auto-advancing so the selectedSceneId effect doesn't kill playback
      isAutoAdvancing.current = true
      useVideoStore.getState().selectScene(playId)
      setCurrentTime(0)
      // Resolve the target clip: the explicit one (split right-half), else this
      // scene's earliest clip. Record it as the live clip so the tick, watchdog,
      // and fade read THIS clip's trim — not the first same-sourceId match.
      const sceneClips = (getV1SceneClips() ?? []).filter((c) => c.sourceId === playId && c.sourceType === 'scene')
      const targetClip =
        (clipId && sceneClips.find((c) => c.id === clipId)) ||
        sceneClips.slice().sort((a, b) => a.startTime - b.startTime)[0]
      currentClipIdRef.current = targetClip?.id ?? null
      const player = playerMapRef.current[playId]
      if (player) {
        // Seek to trimStart so clip in-point is respected.
        player.seek(targetClip?.trimStart ?? 0)
        requestAnimationFrame(() => resumeAndTick())
      } else {
        pendingPlayRef.current = playId
        // Safety net: a non-errored scene whose iframe never produces a player
        // must not park forever. The iframe's onLoad (which creates the player)
        // fires on document load — sub-second for local scene HTML — so a 10s
        // wait only elapses for a genuinely stuck scene, never a merely slow
        // one. On expiry, advance to the next renderable scene, or stop if none.
        pendingPlayTimerRef.current = setTimeout(() => {
          pendingPlayTimerRef.current = null
          if (pendingPlayRef.current !== playId) return // it loaded (or moved on)
          pendingPlayRef.current = null
          // Only force-advance if the transport is still playing. A pause()
          // during the 10s wait clears pendingPlayRef, but belt-and-braces — a
          // fired timer must never UNpause a deliberately-paused editor.
          if (!isPlayingRef.current) return
          const nextId = nextRenderableSceneId(playId)
          if (nextId) {
            goToSceneAndPlayRef.current?.(nextId)
          } else {
            pauseAllScenes()
            setIsPlaying(false)
          }
        }, 10000)
      }
    },
    [pauseAllScenes, resumeAndTick, nextRenderableSceneId, getV1SceneClips],
  )
  // Stable self-reference for the safety-net timeout (avoids a self-dep cycle).
  goToSceneAndPlayRef.current = goToSceneAndPlay

  // Advance from `fromSceneId` to the next clip in timeline order (playing through
  // any gap as black, stopping at the last clip). Extracted from the iframe's
  // onEnded so the trimEnd watchdog can trigger the SAME path — a right-trimmed
  // scene clip must advance at its trimmed out-point, not at the iframe's full
  // animation length. Two guards keep it single-fire: it ignores a call for a scene
  // that isn't the one currently playing (a late onEnded from a scene we already
  // left), and ignores a repeat for a scene already advancing.
  const advanceFromScene = useCallback(
    (fromSceneId: string) => {
      if (
        !shouldAdvance({
          fromSceneId,
          selectedSceneId: selectedIdRef.current,
          advancingSceneId: advanceFromRef.current,
        })
      ) {
        return
      }
      advanceFromRef.current = fromSceneId

      const sortedClips = getV1SceneClips()
      if (sortedClips && sortedClips.length > 0) {
        // Advance by the LIVE clip, not by sourceId — two split halves share a
        // sourceId, so a sourceId index would re-enter the left half forever.
        const currentClipIdx =
          sortedClips.findIndex((c) => c.id === currentClipIdRef.current) >= 0
            ? sortedClips.findIndex((c) => c.id === currentClipIdRef.current)
            : sortedClips.findIndex((c) => c.sourceId === fromSceneId)
        if (currentClipIdx >= 0 && currentClipIdx < sortedClips.length - 1) {
          const currentClip = sortedClips[currentClipIdx]
          const nextClip = sortedClips[currentClipIdx + 1]
          const gapDuration = nextClip.startTime - (currentClip.startTime + currentClip.duration)
          const nextScene = scenesRef.current.find((s) => s.id === nextClip.sourceId)
          if (nextScene) {
            if (gapDuration > 0.01) {
              const gapStartT = currentClip.startTime + currentClip.duration
              setIsInGap(true)
              isInGapRef.current = true
              setGapGlobalTime(gapStartT)
              gapPlaybackRef.current = {
                startGlobalT: gapStartT,
                endGlobalT: nextClip.startTime,
                nextSceneId: nextScene.id,
                nextClipId: nextClip.id,
                wallStart: Date.now(),
              }
              if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
              const tickGap = () => {
                if (!isPlayingRef.current) return
                const gpb = gapPlaybackRef.current
                if (!gpb || !isInGapRef.current) return
                const elapsed = (Date.now() - gpb.wallStart) / 1000
                const currentGlobalT = gpb.startGlobalT + elapsed
                setGapGlobalTime(currentGlobalT)
                if (currentGlobalT >= gpb.endGlobalT) {
                  setIsInGap(false)
                  isInGapRef.current = false
                  gapPlaybackRef.current = null
                  goToSceneAndPlay(gpb.nextSceneId, gpb.nextClipId)
                  return
                }
                animFrameRef.current = requestAnimationFrame(tickGap)
              }
              animFrameRef.current = requestAnimationFrame(tickGap)
            } else {
              goToSceneAndPlay(nextScene.id, nextClip.id)
            }
            return
          }
        }
        if (currentClipIdx === sortedClips.length - 1) {
          // Last clip ended — park the transport in `completed` so the next play()
          // replays from scene 1 instead of resuming the last scene in place.
          completedRef.current = true
          pauseAllScenes()
          setIsPlaying(false)
          return
        }
      }
      // Fallback: array order
      const allScenes = scenesRef.current
      const idx = allScenes.findIndex((s) => s.id === fromSceneId)
      if (idx < allScenes.length - 1) {
        goToSceneAndPlay(allScenes[idx + 1].id)
      } else {
        completedRef.current = true
        pauseAllScenes()
        setIsPlaying(false)
      }
    },
    [getV1SceneClips, goToSceneAndPlay, pauseAllScenes],
  )
  const interactionCallbacks: InteractionCallbacks = {
    brandColor: project.interactiveSettings?.brandColor ?? '#e84545',
    onHotspotClick: useCallback(
      (el) => {
        if (el.jumpsToSceneId) goToSceneAndPlay(el.jumpsToSceneId)
      },
      [goToSceneAndPlay],
    ),
    onChoiceSelect: useCallback(
      (_el, _optionId, jumpsToSceneId) => {
        if (jumpsToSceneId) goToSceneAndPlay(jumpsToSceneId)
      },
      [goToSceneAndPlay],
    ),
    onQuizAnswer: useCallback(
      (el, _selectedOptionId, correct) => {
        if (correct && el.onCorrect === 'jump' && el.onCorrectSceneId) {
          setTimeout(() => goToSceneAndPlay(el.onCorrectSceneId!), 1500)
        } else if (!correct && el.onWrong === 'jump' && el.onWrongSceneId) {
          setTimeout(() => goToSceneAndPlay(el.onWrongSceneId!), 1500)
        } else if (!correct && el.onWrong === 'retry') {
          // Don't resume — quiz resets and waits for another answer
        } else {
          // continue: resume playback after delay
          setTimeout(() => resumeAndTick(), 1500)
        }
      },
      [goToSceneAndPlay, resumeAndTick],
    ),
    onGateContinue: useCallback(
      (_el) => {
        resumeAndTick()
      },
      [resumeAndTick],
    ),
    onFormSubmit: useCallback(
      (el, _values) => {
        if (el.jumpsToSceneId) {
          goToSceneAndPlay(el.jumpsToSceneId)
        } else {
          resumeAndTick()
        }
      },
      [goToSceneAndPlay, resumeAndTick],
    ),
    onSliderChange: useCallback((el: any, value: number) => {
      const sceneId = selectedIdRef.current
      if (!sceneId) return
      useVideoStore.getState().setRuntimeVariable(sceneId, el.setsVariable, value)
      const player = playerMapRef.current[sceneId]
      player?.setVariable(el.setsVariable, value)
    }, []),
    onToggleChange: useCallback((el: any, value: boolean) => {
      const sceneId = selectedIdRef.current
      if (!sceneId) return
      useVideoStore.getState().setRuntimeVariable(sceneId, el.setsVariable, value)
      const player = playerMapRef.current[sceneId]
      player?.setVariable(el.setsVariable, value)
    }, []),
    onResume: useCallback(() => {
      resumeAndTick()
    }, [resumeAndTick]),
  }

  // ── Playback controls ─────────────────────────────────────────────────────
  // The scene clock inside the iframe is the single source of truth for time.
  // The parent polls player.currentTime (updated by iframe postMessages)
  // to sync the playhead — no independent clock.

  // Drop any queued auto-play (and its 10s safety-net timer) so a scene that
  // finishes loading after the transport stopped/moved can't ghost-play or fire a
  // force-advance. Called from pause, seek, and selection change.
  const clearPendingPlay = useCallback(() => {
    pendingPlayRef.current = null
    if (pendingPlayTimerRef.current) {
      clearTimeout(pendingPlayTimerRef.current)
      pendingPlayTimerRef.current = null
    }
  }, [])

  const pause = useCallback(() => {
    setIsPlaying(false)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    pauseAllScenes()
    clearPendingPlay()
    // Clear any in-progress transition so the incoming-scene seek latch resets
    transitionRef.current = null
    // Persist gap position so resume knows where to continue from
    if (isInGapRef.current && gapPlaybackRef.current) {
      const pb = gapPlaybackRef.current
      const elapsed = (Date.now() - pb.wallStart) / 1000
      const currentGlobalT = pb.startGlobalT + elapsed
      gapPlaybackRef.current = { ...pb, startGlobalT: currentGlobalT, wallStart: Date.now() }
      setGapGlobalTime(currentGlobalT)
    }
  }, [pauseAllScenes, clearPendingPlay])

  const play = useCallback(() => {
    // An explicit user play must never inherit a stale single-fire advance guard.
    // advanceFromRef is cleared on selection change, but the replay-from-end case
    // (last scene parked without a selection change) would leave it set on the
    // last scene, rejecting a later advance and freezing the playhead. Clear it
    // unconditionally at every explicit play.
    advanceFromRef.current = null

    // Audio-only / sceneless timeline: there's no scene player to source the
    // clock, so drive a wall-clock ticker. The audio engine chases globalTime
    // through the store, so advancing currentTime is enough to make standalone
    // audio play (preview stays black — there's nothing visual to show).
    if (scenesRef.current.length === 0) {
      const tl = useVideoStore.getState().project.timeline
      const total = tl
        ? tl.tracks.flatMap((t) => t.clips).reduce((m, c) => Math.max(m, c.startTime + c.duration), 0)
        : 0
      if (total <= 0) return // nothing on the timeline to play
      const startT = currentTimeRef.current >= total ? 0 : currentTimeRef.current
      if (startT === 0) setCurrentTime(0)
      setIsPlaying(true)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      const wallStart = Date.now()
      const tickAudioOnly = () => {
        if (!isPlayingRef.current) return
        const t = startT + (Date.now() - wallStart) / 1000
        if (t >= total) {
          setCurrentTime(total)
          setIsPlaying(false)
          return
        }
        setCurrentTime(t)
        animFrameRef.current = requestAnimationFrame(tickAudioOnly)
      }
      animFrameRef.current = requestAnimationFrame(tickAudioOnly)
      return
    }

    // If we're in a gap, count down remaining gap time then advance to the next clip
    if (isInGapRef.current && gapPlaybackRef.current) {
      const pb = gapPlaybackRef.current
      gapPlaybackRef.current = { ...pb, wallStart: Date.now() }
      setIsPlaying(true)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      const tickGap = () => {
        if (!isPlayingRef.current) return
        const gpb = gapPlaybackRef.current
        if (!gpb || !isInGapRef.current) return
        const elapsed = (Date.now() - gpb.wallStart) / 1000
        const currentGlobalT = gpb.startGlobalT + elapsed
        setGapGlobalTime(currentGlobalT)
        if (currentGlobalT >= gpb.endGlobalT) {
          setIsInGap(false)
          isInGapRef.current = false
          gapPlaybackRef.current = null
          goToSceneAndPlay(gpb.nextSceneId)
          return
        }
        animFrameRef.current = requestAnimationFrame(tickGap)
      }
      animFrameRef.current = requestAnimationFrame(tickGap)
      return
    }

    // Replay from end: the transport is parked `completed` (the last scene
    // ended). An explicit play restarts from scene 1 / t=0 instead of resuming the
    // last scene in place. goToSceneAndPlay seeks the first renderable scene to its
    // trimStart and drives the shared tick, so this reuses the proven play path —
    // single-scene projects replay the same way (first === last). The general
    // guard-clear above already reset advanceFromRef.
    const replayId = replayTargetOnPlay({
      completed: completedRef.current,
      firstSceneId: getV1SceneClips()?.[0]?.sourceId ?? scenesRef.current[0]?.id,
    })
    if (completedRef.current) {
      completedRef.current = false
      if (replayId) {
        setCurrentTime(0)
        goToSceneAndPlay(replayId)
        return
      }
    }

    // play() on an errored or never-ready selected scene must not park on a
    // dead frame. Route it through the SAME skip the auto-advance path uses
    // (goToSceneAndPlay → nextRenderableSceneId resolves past the broken scene and
    // arms the 10s no-player safety net). An errored scene never mounts a player;
    // a non-errored scene that just hasn't produced its player yet also routes here
    // so the safety net covers a genuinely-stuck load.
    const selId = selectedIdRef.current
    const selErrored = selId ? scenesRef.current.find((s) => s.id === selId)?.verifyStatus === 'errored' : false
    const selHasPlayer = selId ? !!playerMapRef.current[selId] : false
    if (selId && (selErrored || failedScenesRef.current.has(selId) || !selHasPlayer)) {
      goToSceneAndPlay(selId)
      return
    }

    setIsPlaying(true)
    pauseAllScenes()
    resumeActiveLayers() // multi-track: play every visible layer, not just the selected

    // The single shared tick: clip-local playhead + trimEnd watchdog + fade
    // cross-fade + gates. play, resumeAndTick, and restart all drive THIS body, so
    // an auto-advanced scene 2..N keeps its right-trim watchdog and fades.
    runPlaybackTick()
  }, [resumeActiveLayers, pauseAllScenes, goToSceneAndPlay, runPlaybackTick, getV1SceneClips])

  // Replay-from-end is handled by play()'s `completed`-state branch, which seeks
  // the transport to scene 1 / t=0 and drives the single shared tick.

  // ── Seek helpers ─────────────────────────────────────────────────────────

  const isScrubbingRef = useRef(false)
  const scrubRAFRef = useRef<number | null>(null)
  const pendingScrubTimeRef = useRef<number | null>(null)

  const applySeekImmediate = useCallback(
    (globalT: number) => {
      // Cancel polling loop immediately to prevent stale time overwriting the seek
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      setIsPlaying(false)
      pauseAllScenes()
      // Clear gap state — seek always lands somewhere explicit
      setIsInGap(false)
      isInGapRef.current = false
      gapPlaybackRef.current = null
      // A seek lands somewhere explicit — drop the completed-end park so the next
      // play resumes from the seek target, not a replay-from-start.
      completedRef.current = false
      // Drop any queued auto-play so a late-loading scene can't ghost-play over a
      // seek target.
      clearPendingPlay()

      const allScenes = scenesRef.current
      if (allScenes.length === 0) return

      // Timeline-aware seek across ALL video tracks (multi-track): seek every clip
      // active at globalT to its clip-local time so a stacked mp4 follows the
      // scrub; the displayed scene is the topmost. A gap is "no clip on ANY
      // track" — only then do we black out.
      const tl = useVideoStore.getState().project.timeline
      const active = getActiveClips(tl, globalT, { sourceType: 'scene' })
      if (active.length > 0) {
        let top: { clip: Clip; trackZBase: number } | null = null
        for (const a of active) {
          const localT = Math.max(0, globalT - a.clip.startTime)
          const p = playerMapRef.current[a.clip.sourceId]
          if (p) {
            try {
              p.seek((a.clip.trimStart ?? 0) + localT * (a.clip.speed ?? 1))
            } catch {}
          }
          if (!top || a.trackZBase > top.trackZBase) top = { clip: a.clip, trackZBase: a.trackZBase }
        }
        if (top) {
          currentClipIdRef.current = top.clip.id
          if (top.clip.sourceId !== selectedIdRef.current) {
            isSeeking.current = true
            useVideoStore.getState().selectScene(top.clip.sourceId)
          }
          setCurrentTime(Math.max(0, globalT - top.clip.startTime))
        }
        return
      }

      // No clip on ANY track at globalT → a true gap. Park at the next clip
      // (across all video tracks) and show black.
      const clips = getV1SceneClips()
      if (clips && clips.length > 0) {
        const allVideoSceneClips = (tl?.tracks ?? [])
          .filter((t) => t.type === 'video')
          .flatMap((t) => t.clips)
          .filter((c) => c.sourceType === 'scene')
        const nextClip = allVideoSceneClips
          .filter((c) => c.startTime > globalT)
          .sort((a, b) => a.startTime - b.startTime)[0]
        if (nextClip) {
          const nextScene = allScenes.find((s) => s.id === nextClip.sourceId)
          if (nextScene) {
            setIsInGap(true)
            isInGapRef.current = true
            setGapGlobalTime(globalT)
            gapPlaybackRef.current = {
              startGlobalT: globalT,
              endGlobalT: nextClip.startTime,
              nextSceneId: nextScene.id,
              nextClipId: nextClip.id,
              wallStart: Date.now(),
            }
            currentClipIdRef.current = nextClip.id
            if (nextScene.id !== selectedIdRef.current) {
              isSeeking.current = true
              useVideoStore.getState().selectScene(nextScene.id)
            }
            setCurrentTime(0)
            const player = playerMapRef.current[nextScene.id]
            if (player) player.seek(0)
            return
          }
        }
        // Past the end — clamp to last clip
        const lastClip = clips[clips.length - 1]
        const lastScene = allScenes.find((s) => s.id === lastClip.sourceId)
        if (lastScene) {
          if (lastScene.id !== selectedIdRef.current) {
            isSeeking.current = true
            useVideoStore.getState().selectScene(lastScene.id)
          }
          setCurrentTime(lastClip.duration)
          const player = playerMapRef.current[lastScene.id]
          if (player) player.seek(lastClip.duration)
          return
        }
      }

      // Fallback: packed time model (no timeline data)
      let acc = 0
      for (const scene of allScenes) {
        if (globalT <= acc + scene.duration) {
          const localT = Math.max(0, globalT - acc)
          if (scene.id !== selectedIdRef.current) {
            isSeeking.current = true
            useVideoStore.getState().selectScene(scene.id)
          }
          setCurrentTime(localT)
          const player = playerMapRef.current[scene.id]
          if (player) player.seek(localT)
          return
        }
        acc += scene.duration
      }
      const lastScene = allScenes[allScenes.length - 1]
      if (lastScene.id !== selectedIdRef.current) {
        isSeeking.current = true
        useVideoStore.getState().selectScene(lastScene.id)
      }
      setCurrentTime(lastScene.duration)
      const player = playerMapRef.current[lastScene.id]
      if (player) player.seek(lastScene.duration)
    },
    [pauseAllScenes, clearPendingPlay],
  )

  // ── Frame stepping ──────────────────────────────────────────────────────
  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const allScenes = scenesRef.current
      if (allScenes.length === 0) return

      // Compute current global time using timeline clip positions
      const clips = getV1SceneClips()
      let globalT: number
      let totalDur: number
      if (clips && clips.length > 0) {
        if (isInGapRef.current && gapPlaybackRef.current) {
          globalT = gapPlaybackRef.current.startGlobalT
        } else {
          const currentClip = clips.find((c) => c.sourceId === selectedIdRef.current)
          globalT = currentClip
            ? currentClip.startTime + currentTimeRef.current
            : allScenes
                .slice(
                  0,
                  allScenes.findIndex((s) => s.id === selectedIdRef.current),
                )
                .reduce((a, s) => a + s.duration, 0) + currentTimeRef.current
        }
        totalDur = Math.max(...clips.map((c) => c.startTime + c.duration))
      } else {
        const idx = allScenes.findIndex((s) => s.id === selectedIdRef.current)
        globalT = allScenes.slice(0, Math.max(0, idx)).reduce((a, s) => a + s.duration, 0) + currentTimeRef.current
        totalDur = allScenes.reduce((a, s) => a + s.duration, 0)
      }

      const fps = useVideoStore.getState().project.mp4Settings?.fps ?? 30
      const newGlobal = Math.max(0, Math.min(totalDur, globalT + direction * (1 / fps)))
      applySeekImmediate(newGlobal)
    },
    [applySeekImmediate],
  )

  const jumpScene = useCallback((direction: -1 | 1) => {
    const idx = scenesRef.current.findIndex((s) => s.id === selectedIdRef.current)
    const targetIdx = Math.max(0, Math.min(scenesRef.current.length - 1, idx + direction))
    const targetScene = scenesRef.current[targetIdx]
    if (!targetScene) return
    if (targetScene.id !== selectedIdRef.current) {
      isSeeking.current = true
    }
    useVideoStore.getState().selectScene(targetScene.id)
    const idleT = d3PausedPreviewTime(targetScene)
    setCurrentTime(idleT)
    const player = playerMapRef.current[targetScene.id]
    if (player) player.seek(idleT)
  }, [])

  const handleSeek = useCallback(
    (globalT: number) => {
      // During active scrub, coalesce rapid pointermove seeks into one per rAF
      if (isScrubbingRef.current) {
        pendingScrubTimeRef.current = globalT
        if (scrubRAFRef.current != null) return
        scrubRAFRef.current = requestAnimationFrame(() => {
          scrubRAFRef.current = null
          const t = pendingScrubTimeRef.current
          pendingScrubTimeRef.current = null
          if (t != null) applySeekImmediate(t)
        })
        return
      }
      applySeekImmediate(globalT)
    },
    [applySeekImmediate],
  )

  const handleScrubStart = useCallback(() => {
    if (isScrubbingRef.current) return
    isScrubbingRef.current = true
    // Mute audio on every loaded scene (crossing boundaries may hit several)
    Object.values(playerMapRef.current).forEach((p) => {
      try {
        p.startScrub()
      } catch {}
    })
  }, [])

  const handleScrubEnd = useCallback(() => {
    if (!isScrubbingRef.current) return
    isScrubbingRef.current = false
    // Flush any pending coalesced seek
    if (scrubRAFRef.current != null) {
      cancelAnimationFrame(scrubRAFRef.current)
      scrubRAFRef.current = null
    }
    const pending = pendingScrubTimeRef.current
    pendingScrubTimeRef.current = null
    if (pending != null) applySeekImmediate(pending)
    // Unmute audio on every loaded scene
    Object.values(playerMapRef.current).forEach((p) => {
      try {
        p.endScrub()
      } catch {}
    })
  }, [applySeekImmediate])

  // If PreviewPlayer unmounts while a scrub is in progress (tab switch, project
  // reload), broadcast scrub_end so iframes don't stay muted forever.
  useEffect(() => {
    return () => {
      if (pendingPlayTimerRef.current) {
        clearTimeout(pendingPlayTimerRef.current)
        pendingPlayTimerRef.current = null
      }
      if (isScrubbingRef.current) {
        Object.values(playerMapRef.current).forEach((p) => {
          try {
            p.endScrub()
          } catch {}
        })
      }
    }
  }, [])

  // Dispose ScenePlayers for scenes that were deleted, and prune the per-scene
  // state maps. Each ScenePlayer registers a global window 'message' listener
  // (scene-player.ts); without this, deleting scenes over a long session would
  // leak a player + listener each.
  // Keyed on the id SET (join), not the scenes array, so a content edit that
  // keeps the same ids doesn't churn.
  const sceneIdsKey = scenes.map((s) => s.id).join(',')
  useEffect(() => {
    const liveIds = new Set(scenes.map((s) => s.id))
    for (const id of Object.keys(playerMapRef.current)) {
      if (!liveIds.has(id)) {
        try {
          playerMapRef.current[id]?.destroy()
        } catch {}
        delete playerMapRef.current[id]
        delete iframeMapRef.current[id]
      }
    }
    setLoadedScenes((prev) => prunedSet(prev, liveIds))
    setFailedScenes((prev) => prunedSet(prev, liveIds))
    setSceneVersions((prev) => prunedRecord(prev, liveIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIdsKey])

  // Tear down every ScenePlayer on unmount (project switch, tab change,
  // compositor swap) so no scene's global 'message' listener outlives the view.
  useEffect(() => {
    const players = playerMapRef.current
    return () => {
      for (const id of Object.keys(players)) {
        try {
          players[id]?.destroy()
        } catch {}
        delete players[id]
      }
    }
  }, [])

  // Commands from app header controls and timeline play button
  useEffect(() => {
    const onPreviewCommand = (event: Event) => {
      const custom = event as CustomEvent<{ action?: string; time?: number }>
      const action = custom.detail?.action
      if (!action) return
      if (action === 'undo') {
        if (!actionUndo()) undo()
        return
      }
      if (action === 'redo') {
        if (!actionRedo()) redo()
        return
      }
      // Zoom commands removed — the preview is a fixed, non-zoomable frame.
      if (action === 'toggle_play') {
        if (isPlayingRef.current) pause()
        else play()
        return
      }
      if (action === 'seek' && typeof custom.detail?.time === 'number') {
        handleSeek(custom.detail.time)
        return
      }
      if (action === 'scrub_start') {
        handleScrubStart()
        return
      }
      if (action === 'scrub_end') {
        handleScrubEnd()
        return
      }
      if (action === 'step_back') {
        stepFrame(-1)
        return
      }
      if (action === 'step_forward') {
        stepFrame(1)
        return
      }
    }
    window.addEventListener('dreambyte-preview-command', onPreviewCommand as EventListener)
    return () => window.removeEventListener('dreambyte-preview-command', onPreviewCommand as EventListener)
  }, [undo, redo, actionUndo, actionRedo, play, pause, handleSeek, handleScrubStart, handleScrubEnd, stepFrame])

  // ── Scene load handler ────────────────────────────────────────────────────
  // Capture one filmstrip frame for a scene from the LIVE preview at time `t`.
  // Uses Electron capturePage (works for canvas/WebGL, unlike html2canvas),
  // cropped to the preview frame, then downscaled so the stored frames stay
  // tiny. Each scene fills FILMSTRIP_SLOTS slots; a slot is captured once.
  const captureFilmstripSlot = useCallback(async (sceneId: string, t: number, duration: number) => {
    const FILMSTRIP_SLOTS = 6
    if (filmstripCapturingRef.current) return
    const api = (
      window as unknown as {
        electronAPI?: {
          capturePage?: (a?: {
            rect?: { x: number; y: number; width: number; height: number }
          }) => Promise<{ ok: boolean; dataUri?: string }>
        }
      }
    ).electronAPI
    if (!api?.capturePage) return
    const el = canvasRef.current
    if (!el) return
    const dur = Math.max(0.1, duration)
    const slot = Math.min(FILMSTRIP_SLOTS - 1, Math.max(0, Math.floor((t / dur) * FILMSTRIP_SLOTS)))
    let filled = filmstripSlotsRef.current.get(sceneId)
    if (!filled) {
      filled = new Set()
      filmstripSlotsRef.current.set(sceneId, filled)
    }
    if (filled.has(slot)) return
    const r = el.getBoundingClientRect()
    const rect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
    if (rect.width < 2 || rect.height < 2) return
    filmstripCapturingRef.current = true
    try {
      const res = await api.capturePage({ rect })
      if (!res?.ok || !res.dataUri) return
      // Downscale to ~80px tall JPEG so 6 frames/scene stay light in the DB.
      const small = await shrinkToJpeg(res.dataUri, (w, h) => ({ w: (w / Math.max(1, h)) * 80, h: 80 }), 0.6)
      filled.add(slot)
      useVideoStore.getState().setSceneFilmstripFrame(sceneId, slot, small, FILMSTRIP_SLOTS)
    } catch {
      /* best-effort — ignore capture failures */
    } finally {
      filmstripCapturingRef.current = false
    }
  }, [])

  const handleSceneLoad = useCallback(
    (sceneId: string) => {
      setLoadedScenes((prev) => new Set([...prev, sceneId]))

      // Create ScenePlayer for this iframe
      const iframe = iframeMapRef.current[sceneId]
      if (iframe) {
        // Destroy old player if exists
        playerMapRef.current[sceneId]?.destroy()
        const player = new ScenePlayer(iframe, sceneId)
        playerMapRef.current[sceneId] = player

        // Seed the player with the current per-category mix when the iframe is READY
        // (its audio elements exist and its message listener is attached) — posting
        // before 'ready' can be dropped, leaving a scene loaded mid-session at base
        // volume until the next mix edit. Seeding on ready makes it match the export
        // immediately. (The live-update effect handles later mix changes.)
        player.onReady = () => {
          const tracks = useVideoStore.getState().project.timeline?.tracks ?? []
          const scene = scenesRef.current.find((s) => s.id === sceneId)
          if (scene) {
            player.setSceneAudioMix(
              resolveSceneAudioMix(scene, tracks, useVideoStore.getState().project.audioSettings?.masterVolume),
            )
          }
          // The timeline audio engine owns ALL scene audio (tts/music/sfx ride
          // the engine + mixer — see use-timeline-audio `ownsSceneAudio: true`), so
          // tell the iframe to mute its own audio and let the engine be the single
          // source. Sticky in the controller and set once on ready — BEFORE the
          // first play — so playback never doubles. Avatar lipsync audio is exempt
          // inside the controller, so this is safe for avatar scenes.
          player.setEngineOwnsAudio(true)
        }

        // The fourth playhead writer: `t` is SOURCE time (masterTL.time()),
        // posted on every scene-clock tick and on every seek echo. Store CLIP-LOCAL time
        // like the three tick writers (play / resumeAndTick / restart), or a
        // left-trimmed/split/sped clip snaps the playhead back to source time on
        // each echo. The handler is installed once per player, so the clip must be
        // resolved from fresh store state here — never captured at install time.
        player.onTimeUpdate = (t) => {
          // Opportunistically grab a filmstrip frame from the live preview for
          // the scene that's currently on screen (playing, or the selected scene
          // settling after a seek). Slots fill in over a playthrough/scrub.
          if (isPlayingRef.current || sceneId === selectedIdRef.current) {
            const sc = scenesRef.current.find((s) => s.id === sceneId)
            if (sc) void captureFilmstripSlot(sceneId, t, sc.duration)
          }
          // During playback the GLOBAL WALL-CLOCK tick owns the playhead; a scene
          // player's own time echo must not fight it. Only write the playhead from
          // a scene echo when PAUSED (e.g. a scene settling after a seek).
          if (!isPlayingRef.current && sceneId === selectedIdRef.current) {
            const cs = getV1SceneClips()
            const clip =
              cs?.find((c) => c.id === currentClipIdRef.current) ??
              cs?.find((c) => c.sourceId === sceneId && t >= c.trimStart && (c.trimEnd == null || t < c.trimEnd)) ??
              cs?.find((c) => c.sourceId === sceneId)
            setCurrentTime(clipLocalTime(t, clip?.trimStart, clip?.speed))
          }
        }
        // A scene's iframe reaching its animation end does not drive advancement
        // during linear playback — the GLOBAL WALL-CLOCK tick is the master and
        // advances by the timeline, not by any one scene ending (a lone clip would
        // otherwise loop, and a stacked layer ending would cut the others). onEnded
        // only matters when NOT playing (e.g. a paused scene that auto-completes);
        // the tick handles the playing case.
        player.onEnded = () => {
          if (isPlayingRef.current) return
          advanceFromScene(sceneId)
        }

        // A late init_error (controller couldn't build its timeline) marks
        // the scene failed so playback skips it, mirroring the global handler.
        player.onInitError = () => {
          setFailedScenes((prev) => (prev.has(sceneId) ? prev : new Set(prev).add(sceneId)))
        }

        // In-scene interactivity events (from DreambyteReact hooks)
        player.onVariableChanged = (name, value) => {
          useVideoStore.getState().setRuntimeVariable(sceneId, name, value)
        }
        player.onElementClicked = (_elementId, _data) => {
          // Element clicks from scene code — can be used for scene graph navigation
          // Currently tracked for analytics; extend as needed
        }
      }

      // Always start paused; resume only if this is the active scene while playing
      pauseScene(sceneId)
      const loadedScene = scenesRef.current.find((s) => s.id === sceneId)
      const idleT = d3PausedPreviewTime(loadedScene)
      // Load choreography: a freshly-loaded scene's seek must NOT land AFTER
      // the play message. The deferred idle-frame seek below echoes back through the
      // controller's seek handler, which runs syncMedia(false) (pause) — so for the
      // ACTIVE scene that we're about to play, that deferred seek would freeze its
      // audio AND video right after resume. When this scene is the active one and the
      // transport is playing, skip the idle seek entirely: resumeScene (and the play
      // path) already seek to trimStart before playing. Otherwise (paused, or a
      // background scene) the idle-frame seek is still needed so 3d_world/Three render
      // one frame while RAF is blocked.
      const isActiveAndPlaying = sceneId === selectedIdRef.current && isPlayingRef.current
      const p = playerMapRef.current[sceneId]
      if (p && !isActiveAndPlaying) {
        requestAnimationFrame(() => {
          try {
            p.seek(idleT)
          } catch {}
        })
      }
      if (sceneId === selectedIdRef.current && idleT > 0 && !isActiveAndPlaying) {
        setCurrentTime(idleT)
      }
      if (isActiveAndPlaying) {
        // Seek to the clip in-point BEFORE play, synchronously, so no post-play seek
        // echo can pause the scene. Prefer the LIVE clip (currentClipIdRef) so a
        // split right-half enters at ITS in-point, not the scene's first clip.
        const cs = getV1SceneClips()
        const clip =
          cs?.find((c) => c.id === currentClipIdRef.current && c.sourceId === sceneId) ??
          cs?.find((c) => c.sourceId === sceneId)
        try {
          p?.seek(clip?.trimStart ?? 0)
        } catch {}
        resumeScene(sceneId)
      }
      // Check if this scene was queued for auto-play (from onEnded). Clearing the
      // ref + timer is unconditional (the queued player materialized), but the
      // ghost-play guard only fires the play when the transport is STILL
      // playing — a stale pendingPlayRef from before a pause must not resurrect
      // playback on a paused editor (a slow scene that loads after the user
      // paused would otherwise ghost-play).
      if (pendingPlayRef.current === sceneId) {
        pendingPlayRef.current = null
        // The queued player materialized — cancel the freeze safety-net timer.
        if (pendingPlayTimerRef.current) {
          clearTimeout(pendingPlayTimerRef.current)
          pendingPlayTimerRef.current = null
        }
        const p = playerMapRef.current[sceneId]
        if (p && isPlayingRef.current) {
          const cs = getV1SceneClips()
          const pendingClip =
            cs?.find((c) => c.id === currentClipIdRef.current && c.sourceId === sceneId) ??
            cs?.find((c) => c.sourceId === sceneId && c.sourceType === 'scene')
          p.seek(pendingClip?.trimStart ?? 0)
          p.play()
        }
      }
      // Filmstrip frames are captured live from the preview via capturePage as
      // the scene plays/seeks (see captureFilmstripSlot, wired into the player's
      // onTimeUpdate above) — html2canvas misses canvas/WebGL content, so we use
      // the Electron page-capture path instead.
      void loadedScene
    },
    [pauseScene, resumeScene, captureFilmstripSlot, advanceFromScene, getV1SceneClips],
  )

  // ── Element selection from iframe (inspector integration) ─────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data) return

      // Audio error from scene iframe — surface to user
      if (e.data.type === 'dreambyte:audio-error') {
        console.warn('[PreviewPlayer] Audio playback error:', e.data.error, e.data.track)
        toast.error('Audio playback error', {
          description: e.data.error ? String(e.data.error) : 'Check the audio layer and try again.',
        })
        return
      }

      if (e.data.source !== 'dreambyte-scene') return
      const store = useVideoStore.getState()

      // Playback error beacon: forward scene runtime errors to the main-
      // process ring buffer so verify_scene and the agent's context refresh
      // can see broken playback. Also routes the React error-boundary
      // channel (dreambyte-jsx-error) into the same pipe.
      // The claimed sceneId is forgeable (any same-origin frame can post
      // it) — bind the report to the POSTING frame by requiring that the
      // claimed scene's iframe is the message's actual source window. A
      // hostile agent-generated scene can't attribute fake errors to
      // sibling scenes and poison their verify_scene / context-refresh state.
      // Second binding source: other preview surfaces —
      // BranchPreviewPlayer's read-only branch preview — register their
      // iframes in the shared registry so THEIR beacons bind too instead of
      // being silently dropped. Same source-window requirement either way.
      const isBoundToPostingFrame = (claimedSceneId: unknown): boolean =>
        isErrorReportBoundToFrame(claimedSceneId, e.source, (id) => iframeMapRef.current[id]) ||
        isRegisteredPreviewFrame(claimedSceneId, e.source)
      if (e.data.type === SCENE_ERROR_MESSAGE_TYPE && e.data.sceneId && e.data.error) {
        if (!isBoundToPostingFrame(e.data.sceneId)) return
        void (
          window as unknown as { dreambyteApi?: { sceneErrors?: { report: (a: unknown) => Promise<unknown> } } }
        ).dreambyteApi?.sceneErrors
          ?.report({ sceneId: e.data.sceneId, error: e.data.error })
          ?.catch(() => {})
        return
      }
      if (e.data.type === 'dreambyte-jsx-error' && e.data.sceneId && e.data.message) {
        if (!isBoundToPostingFrame(e.data.sceneId)) return
        void (
          window as unknown as { dreambyteApi?: { sceneErrors?: { report: (a: unknown) => Promise<unknown> } } }
        ).dreambyteApi?.sceneErrors
          ?.report({
            sceneId: e.data.sceneId,
            error: { kind: 'jsx', message: String(e.data.message), at: Date.now() },
          })
          ?.catch(() => {})
        return
      }

      // init_error: the scene's playback controller couldn't build its anime.js
      // timeline (offline / missing vendor asset). Treat it like a verify-errored
      // scene — mark it failed so nextRenderableSceneId skips it, and if it's the
      // one we're trying to play, advance past it now instead of a dead transport.
      if (e.data.type === 'init_error' && e.data.sceneId) {
        if (!isBoundToPostingFrame(e.data.sceneId)) return
        const badId = e.data.sceneId as string
        setFailedScenes((prev) => (prev.has(badId) ? prev : new Set(prev).add(badId)))
        if (isPlayingRef.current && (badId === selectedIdRef.current || pendingPlayRef.current === badId)) {
          const nextId = nextRenderableSceneId(badId)
          if (nextId && nextId !== badId) {
            goToSceneAndPlayRef.current?.(nextId)
          } else {
            pauseAllScenes()
            setIsPlaying(false)
          }
        }
        return
      }

      if (e.data.type === 'element_selected') {
        const el = e.data.element
        store.selectInspectorElement(el, null)
      }

      if (e.data.type === 'element_deselected') {
        store.selectInspectorElement(null)
      }

      if (e.data.type === 'elements_list') {
        store.setInspectorElements(e.data.elements ?? {})
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // ── Wheel zoom disabled ───────────────────────────────────────────────────
  // Scroll-wheel zoom-to-cursor is intentionally off so the preview never
  // rescales under the user.

  // ── Fit the preview frame to the available viewport area ──────────────────
  // Measure the real container (which shrinks when the right panel widens or the
  // timeline grows) and size the frame to fit inside it, preserving aspect
  // ratio and capped at a max so it never gets clipped/covered by other UI.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const aspect = projectDims.width / projectDims.height
    const PADDING = 24
    const MAX_W = isFullscreen ? 1280 : 780
    const MAX_H = isFullscreen ? 900 : 700
    const compute = () => {
      const availW = el.clientWidth - PADDING * 2
      const availH = el.clientHeight - PADDING * 2
      if (availW <= 0 || availH <= 0) return
      // Largest aspect-correct box that fits the available area...
      let w = Math.min(availW, availH * aspect)
      // ...then cap so it doesn't grow past the natural max on big screens.
      w = Math.min(w, MAX_W, MAX_H * aspect)
      const h = w / aspect
      setFrameSize({ w: Math.round(w), h: Math.round(h) })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [projectDims.width, projectDims.height, isFullscreen])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'Escape' && isFullscreen) setIsFullscreen(false)
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        resetView()
      }

      if (inInput) return

      // Undo/Redo — Cmd+Z / Cmd+Shift+Z (only when not in text inputs).
      // Prefer the action-layer stack when it has entries — those are
      // the typed Action inverses with action_log + WAL visibility. Fall back
      // to the snapshot stack so scene-level operations (which mostly
      // bypass the action layer) still undo correctly.
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          if (!actionRedo()) redo()
        } else {
          if (!actionUndo()) undo()
        }
        return
      }

      // Toggle grid overlay with G key
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        updateGridConfig({ showGrid: !gridConfig.showGrid })
      }
      // Space: Play/Pause
      if (e.key === ' ') {
        e.preventDefault()
        if (isPlayingRef.current) pause()
        else play()
      }
      // Arrow keys: frame stepping
      if (e.key === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault()
        stepFrame(-1)
      }
      if (e.key === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault()
        stepFrame(1)
      }
      // Shift+Arrow: 1 second jumps
      if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault()
        const clips = getV1SceneClips()
        const currentClip = clips?.find((c) => c.sourceId === selectedIdRef.current)
        const off = currentClip
          ? currentClip.startTime
          : scenesRef.current
              .slice(
                0,
                Math.max(
                  0,
                  scenesRef.current.findIndex((s) => s.id === selectedIdRef.current),
                ),
              )
              .reduce((a, s) => a + s.duration, 0)
        handleSeek(Math.max(0, off + currentTimeRef.current - 1))
      }
      if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault()
        const clips = getV1SceneClips()
        const currentClip = clips?.find((c) => c.sourceId === selectedIdRef.current)
        const off = currentClip
          ? currentClip.startTime
          : scenesRef.current
              .slice(
                0,
                Math.max(
                  0,
                  scenesRef.current.findIndex((s) => s.id === selectedIdRef.current),
                ),
              )
              .reduce((a, s) => a + s.duration, 0)
        const totalDur =
          clips && clips.length > 0
            ? Math.max(...clips.map((c) => c.startTime + c.duration))
            : scenesRef.current.reduce((a, s) => a + s.duration, 0)
        handleSeek(Math.min(totalDur, off + currentTimeRef.current + 1))
      }
      // Home/End: jump to start/end
      if (e.key === 'Home') {
        e.preventDefault()
        handleSeek(0)
      }
      if (e.key === 'End') {
        e.preventDefault()
        const clips = getV1SceneClips()
        const totalDur =
          clips && clips.length > 0
            ? Math.max(...clips.map((c) => c.startTime + c.duration))
            : scenesRef.current.reduce((a, s) => a + s.duration, 0)
        handleSeek(totalDur)
      }
      // [ ] : jump to scene boundaries
      if (e.key === '[') {
        e.preventDefault()
        jumpScene(-1)
      }
      if (e.key === ']') {
        e.preventDefault()
        jumpScene(1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    isFullscreen,
    resetView,
    gridConfig.showGrid,
    updateGridConfig,
    pause,
    play,
    stepFrame,
    jumpScene,
    handleSeek,
    undo,
    redo,
    actionUndo,
    actionRedo,
  ])

  // ── Drag-to-pan ───────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return
      setIsDragging(true)
      dragOrigin.current = { x: e.clientX, y: e.clientY, px: panX, py: panY }
      e.preventDefault()
    },
    [panX, panY],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      setPanX(dragOrigin.current.px + e.clientX - dragOrigin.current.x)
      setPanY(dragOrigin.current.py + e.clientY - dragOrigin.current.y)
    },
    [isDragging],
  )

  const handleMouseUp = useCallback(() => setIsDragging(false), [])

  // ── Computed values ───────────────────────────────────────────────────────
  const sceneIndex = scenes.findIndex((s) => s.id === selectedSceneId)
  const sceneStartOffset = (() => {
    // The selected scene's clip across ALL video tracks (a scene on V2 has its
    // real startTime there). Prefer the LIVE clip so the playhead tracks the
    // correct half of a split scene; fall back to the first clip of the scene.
    const videoClips =
      project.timeline?.tracks
        .filter((t) => t.type === 'video')
        .flatMap((t) => t.clips)
        .filter((c) => c.sourceId === selectedSceneId && c.sourceType === 'scene') ?? []
    const clip = videoClips.find((c) => c.id === currentClipIdRef.current) ?? videoClips[0]
    if (clip) return clip.startTime
    return scenes.slice(0, Math.max(0, sceneIndex)).reduce((a, s) => a + s.duration, 0)
  })()
  // During gap playback, globalTime comes from the gap tick counter, not from a scene's local time
  const globalTime = isInGap ? gapGlobalTime : sceneStartOffset + currentTime

  // ── Multi-track scene compositing (all-DOM) ──────────────
  // The active SET of scene clips at the playhead, across all video tracks,
  // z-ordered by track (top wins). Each becomes a stacked iframe layer below.
  // A scene maps to its TOP-most active clip (highest trackZBase). Empty = gap.
  const activeByScene = useMemo(() => {
    const m = new Map<string, { clip: Clip; trackZBase: number }>()
    for (const a of getActiveClips(project.timeline, globalTime, { sourceType: 'scene' })) {
      const prev = m.get(a.clip.sourceId)
      if (!prev || a.trackZBase > prev.trackZBase) m.set(a.clip.sourceId, { clip: a.clip, trackZBase: a.trackZBase })
    }
    return m
  }, [project.timeline, globalTime])
  // The top-most active scene (highest track) owns pointer events + is the gap test.
  let topActiveSceneId: string | null = null
  let topActiveZ = -1
  for (const [sid, a] of activeByScene) {
    if (a.trackZBase > topActiveZ) {
      topActiveZ = a.trackZBase
      topActiveSceneId = sid
    }
  }

  // PIXEL-UNIFY: each scene iframe's visibility / z / opacity — INCLUDING
  // the crossfade ramp — comes from the SAME planCompositeFrame({fade}) the export
  // host consumes (src/electron/ipc/export-tier3.ts), so the preview and export share
  // ONE fade implementation instead of this component's old parallel
  // `transitionForRender` copy that could silently drift from applyFadeTransition.
  // Scene layers are keyed by sourceId; a fade adds the incoming scene as a second
  // layer at z=1 with opacity=progress (the outgoing ramps to (1-progress)·alpha) —
  // exactly what the scene map below reads. Media layers are rendered separately by
  // PreviewMediaLayer, which consumes this same plan's media layers. Recomputes
  // every frame because `globalTime` (via setCurrentTime) updates each tick.
  const sceneLayerById = useMemo(() => {
    const plan = planCompositeFrame(project.timeline, globalTime, { fade: true })
    const m = new Map<string, CompositeLayer>()
    if (!plan.isGap) for (const l of plan.layers) if (l.kind === 'scene') m.set(l.sceneId, l)
    return m
  }, [project.timeline, globalTime])

  // Expose the active set + playhead to the rAF tick / resume (refs, no re-render).
  activeClipsRef.current = [...activeByScene.entries()].map(([sourceId, a]) => ({ sourceId, clip: a.clip }))
  globalTimeRef.current = globalTime
  topActiveSceneIdRef.current = topActiveSceneId
  totalDurationRef.current = totalDuration

  // Position the active layers at the playhead — but ONLY while PAUSED/scrubbing.
  // During playback every active layer plays natively (resumeAndTick), because
  // seeking a <video> per frame freezes it instead of playing through. When
  // paused, this seek makes the stacked composite correct at the playhead.
  useEffect(() => {
    if (isPlaying) return
    for (const [sid, a] of activeByScene) {
      const p = playerMapRef.current[sid]
      if (!p) continue
      const localT = Math.max(0, globalTime - a.clip.startTime)
      try {
        p.seek((a.clip.trimStart ?? 0) + localT * (a.clip.speed ?? 1))
      } catch {}
    }
  }, [globalTime, activeByScene, isPlaying])

  // Sync transport state to store so Editor/Timeline can read it
  useEffect(() => {
    setTimelineTransport({ globalTime, totalDuration, isPlaying })
  }, [globalTime, totalDuration, isPlaying, setTimelineTransport])
  const getSceneSrc = (scene: Scene): string | null => {
    const byType: Record<string, boolean> = {
      react: !!scene.reactCode,
      svg: !!scene.svgContent,
      canvas2d: !!scene.canvasCode,
      motion: !!scene.sceneHTML || !!scene.sceneCode || !!scene.canvasBackgroundCode?.trim(),
      d3: !!scene.sceneCode || !!scene.canvasBackgroundCode?.trim(),
      three: !!scene.sceneCode,
      lottie: !!scene.lottieSource,
      zdog: !!scene.sceneCode,
      '3d_world': !!scene.worldConfig || !!scene.sceneHTML,
      avatar_scene: !!scene.aiLayers?.some((l) => l.type === 'avatar'),
    }
    const st = scene.sceneType ?? 'svg'
    let hasRenderable = byType[st] ?? false
    if (st === 'svg') hasRenderable = hasRenderable || !!scene.canvasBackgroundCode?.trim()
    // Media scenes: a video layer or image layers ARE the content (a dropped
    // video becomes an svg-type scene with empty svgContent + videoLayer).
    if (!hasRenderable && scene.videoLayer?.enabled && scene.videoLayer.src) hasRenderable = true
    if (!hasRenderable && (scene.aiLayers?.length ?? 0) > 0) hasRenderable = true
    if (!hasRenderable) {
      // Persist middleware can clobber in-memory code fields after DB load while the HTML
      // file on disk is valid. If the scene has a sceneType set (meaning it was generated
      // at some point) and there's no recorded write error, assume the HTML file exists.
      if (scene.sceneType && scene.sceneType !== 'svg' && !sceneWriteErrors[scene.id]) {
        hasRenderable = true
      }
    }
    if (!hasRenderable) {
      return null
    }
    return sceneSrc(scene.id, sceneVersions[scene.id] ?? 0)
  }

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = (
    <div
      style={{
        transform: `translate(${panX}px, ${panY}px)`,
        transformOrigin: 'center center',
        transition: isDragging ? 'none' : 'transform 0.12s ease',
        willChange: 'transform',
        flexShrink: 0,
      }}
    >
      <div
        ref={canvasRef}
        className={`preview-frame relative ${outputMode === 'interactive' ? 'overflow-visible' : 'overflow-hidden'}`}
        style={{
          aspectRatio: previewAspect,
          // Frame size is measured to fit the available viewport area (see the
          // ResizeObserver above) so it shrinks rather than being covered by the
          // timeline or right panel. Fall back to a sensible default pre-measure.
          ...(frameSize
            ? { width: frameSize.w, height: frameSize.h }
            : projectDims.width >= projectDims.height
              ? { width: 'min(780px, 100%)' }
              : { height: 'min(700px, 100%)' }),
        }}
      >
        {/* Grade hover-preview SVG filter (temp/tint/curves) — referenced by
            the iframe's css filter via url(#dreambyte-grade-preview). Built
            from the same engine the scene template uses on commit, so the
            preview math matches the committed render exactly. */}
        {sceneGradePreview?.grade && <GradePreviewFilter grade={sceneGradePreview.grade} />}

        {/* DOM media layer — the renderer for bare video/image clips
            (composites over the scene iframes, preview=export). Mounts when media
            exists. */}
        {hasMediaClips && (
          <div className="absolute inset-0 z-[2]">
            <PreviewMediaLayer timeline={mediaPreviewTimeline} globalTime={globalTime} isPlaying={isPlaying} />
          </div>
        )}

        {/* All scene iframes — always in DOM, switch by display */}
        {scenes.map((scene) => {
          const src = getSceneSrc(scene)
          if (!src) return null
          // Multi-track (all-DOM): this scene is visible if its clip is in the
          // active set at the playhead; it stacks by track (top wins) and the
          // TOP active scene owns pointer events. Empty active set = gap (black).
          // Visibility / z / opacity (incl. crossfade) from the shared composite
          // plan (sceneLayerById, above) — the SAME pure plan the export consumes.
          const layer = sceneLayerById.get(scene.id)
          const isTopActive = scene.id === topActiveSceneId
          // Verify-scene gate: when the offscreen verifier flagged the
          // scene as errored, replace the iframe entirely with an error card
          // so the broken HTML never reaches the user. Other failure paths
          // (network, manual write error) keep the existing overlay UX.
          const verifyErrored = scene.verifyStatus === 'errored'
          const hasError = verifyErrored || failedScenes.has(scene.id) || !!sceneWriteErrors[scene.id]
          const verifyMessage = verifyErrored ? formatVerifyError(scene.verifyError, scene.verifyStatus) : null
          // The plan already folds fade-in/out + opacity + the crossfade ramp into
          // layer.opacity, and gives z directly (V1→1, V2→2, …, fade incoming→1).
          const visible = !!layer
          const resolvedOpacity = layer ? layer.opacity : undefined
          const layerZ = layer ? layer.z : 0
          // COMMITTED clip color grade: the plan already resolved this scene's
          // clip.grade into layer.grade (CSS tier on a scene iframe — a WebGL pass can't
          // sample an iframe, so LUT/hue are media-only). Same compile + id as the export
          // host → preview == export. Hover-preview (transient) composes on top.
          const gradeDesc = layer?.grade
          const committedGradeCss =
            gradeDesc && gradeDesc.tier === 'css'
              ? [gradeDesc.filterCss, gradeDesc.svgFilterMarkup ? `url(#${gradeDesc.svgFilterId})` : '']
                  .filter(Boolean)
                  .join(' ')
              : ''
          const hoverGradeCss = sceneGradePreview?.sceneId === scene.id ? sceneGradePreview.css : ''
          const sceneFilter = [committedGradeCss, hoverGradeCss].filter(Boolean).join(' ') || undefined
          return (
            <div
              key={scene.id}
              className="absolute inset-0"
              style={{
                visibility: visible ? 'visible' : 'hidden',
                zIndex: layerZ,
                opacity: visible ? resolvedOpacity : undefined,
              }}
            >
              {/* Committed clip-grade SVG <filter> (white balance / curves / wheels),
                  referenced by the iframe's css filter via url(#clip-grade-<id>). */}
              {gradeDesc && gradeDesc.tier === 'css' && gradeDesc.svgFilterMarkup && (
                <ClipGradeSvgFilter grade={gradeDesc.raw} id={gradeDesc.svgFilterId} />
              )}
              {/*
                Verify-errored scenes never mount the iframe — the script
                already failed once and would fail again on every frame seek.
                Other scenes mount as before; the overlay covers them when
                load / write errors fire.
              */}
              {!verifyErrored && (
                <iframe
                  ref={(el) => {
                    iframeMapRef.current[scene.id] = el
                  }}
                  data-scene-id={scene.id}
                  src={src}
                  className="scene-iframe absolute inset-0 h-full w-full max-h-full max-w-full border-0 outline-none ring-0"
                  style={{
                    pointerEvents: isTopActive ? 'auto' : 'none',
                    background: scene.bgColor ?? '#fffef9',
                    // Committed clip grade (CSS+SVG tier) + the transient hover
                    // preview, composed. Empty → undefined (no filter cost).
                    filter: sceneFilter,
                  }}
                  onLoad={() => {
                    setFailedScenes((prev) => {
                      if (!prev.has(scene.id)) return prev
                      const next = new Set(prev)
                      next.delete(scene.id)
                      return next
                    })
                    handleSceneLoad(scene.id)
                  }}
                  onError={() => {
                    setFailedScenes((prev) => new Set(prev).add(scene.id))
                  }}
                  allow="autoplay; fullscreen"
                  sandbox="allow-scripts allow-same-origin"
                  title={`Scene ${scene.id}`}
                />
              )}
              {/* Grade hover-preview vignette (transient) — the committed render
                  bakes an equivalent overlay into the scene HTML */}
              {sceneGradePreview?.sceneId === scene.id && (sceneGradePreview.grade?.vignette ?? 0) > 1e-4 && (
                <div
                  className="pointer-events-none absolute inset-0 z-[4]"
                  style={{
                    background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,${
                      Math.round((sceneGradePreview.grade!.vignette ?? 0) * 0.85 * 1000) / 1000
                    }) 100%)`,
                  }}
                />
              )}
              {/* Error overlay — shown when scene HTML failed to load, write, or verify */}
              {isTopActive && hasError && (
                <div
                  className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2"
                  style={{ background: scene.bgColor ?? '#fffef9' }}
                >
                  <span className="text-sm text-red-500 font-medium">
                    {verifyMessage || sceneWriteErrors[scene.id] || 'Scene failed to load'}
                  </span>
                  <span
                    className="text-sm text-neutral-500 hover:text-neutral-700 cursor-pointer underline"
                    onClick={() => {
                      setFailedScenes((prev) => {
                        const next = new Set(prev)
                        next.delete(scene.id)
                        return next
                      })
                      // Clear store error and bump version to force iframe reload
                      const { [scene.id]: _, ...rest } = useVideoStore.getState().sceneWriteErrors
                      useVideoStore.setState({ sceneWriteErrors: rest })
                      setSceneVersions((prev) => ({ ...prev, [scene.id]: (prev[scene.id] ?? 0) + 1 }))
                    }}
                  >
                    Click to retry
                  </span>
                </div>
              )}
            </div>
          )
        })}

        {/* Gap overlay: black screen while playhead is between clips */}
        {isInGap && <div className="absolute inset-0 z-[4]" style={{ background: '#000000' }} />}

        {/* Grid overlay */}
        <GridOverlay grid={gridConfig} />

        {/* Generating overlay */}
        {isThisGenerating && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 px-6"
            style={{ background: selectedScene?.bgColor ?? '#fffef9' }}
          >
            {selectedScene?.sceneType === 'canvas2d' ? (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  drawing...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">
                  Generating Canvas animation...
                </span>
              </>
            ) : selectedScene?.sceneType === 'motion' ? (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  animating...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">
                  Generating Motion animation...
                </span>
              </>
            ) : selectedScene?.sceneType === 'd3' ? (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  charting...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">
                  Generating D3 visualization...
                </span>
              </>
            ) : selectedScene?.sceneType === 'three' ? (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  rendering...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">
                  Generating Three.js scene...
                </span>
              </>
            ) : selectedScene?.sceneType === 'lottie' ? (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  drawing...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">Generating SVG overlay...</span>
              </>
            ) : selectedScene?.svgContent ? (
              <div
                className="w-full h-full"
                style={{ pointerEvents: 'none' }}
                dangerouslySetInnerHTML={{ __html: selectedScene.svgContent }}
              />
            ) : (
              <>
                <span className="text-[var(--color-accent)] text-sm font-mono uppercase tracking-widest animate-pulse">
                  drawing...
                </span>
                <span className="text-[#3a3a45] text-[11px] text-center max-w-[200px]">
                  Generating SVG elements and animations...
                </span>
              </>
            )}
          </div>
        )}

        {/* Empty state for selected scene */}
        {!selectedScene?.svgContent &&
          !selectedScene?.canvasCode &&
          !selectedScene?.sceneCode &&
          !selectedScene?.lottieSource &&
          !selectedScene?.sceneHTML &&
          !selectedScene?.canvasBackgroundCode?.trim() &&
          !(selectedScene?.sceneType === '3d_world' && selectedScene?.worldConfig) &&
          !(selectedScene?.sceneType === 'avatar_scene' && selectedScene?.aiLayers?.some((l) => l.type === 'avatar')) &&
          !isThisGenerating && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2"
              style={{ background: selectedScene ? (selectedScene.bgColor ?? 'var(--color-input-bg)') : '#000' }}
            >
              {selectedScene && (
                <>
                  <p className="text-[#6b6b7a] text-sm">No content yet</p>
                  <p className="text-[#3a3a45] text-sm">Write a prompt and click Generate</p>
                </>
              )}
            </div>
          )}

        {/* Loading indicator */}
        {selectedSceneId &&
          (selectedScene?.svgContent ||
            selectedScene?.canvasCode ||
            selectedScene?.sceneCode ||
            selectedScene?.lottieSource ||
            selectedScene?.sceneHTML ||
            !!selectedScene?.canvasBackgroundCode?.trim() ||
            (selectedScene?.sceneType === '3d_world' && !!selectedScene?.worldConfig) ||
            (selectedScene?.sceneType === 'avatar_scene' &&
              !!selectedScene?.aiLayers?.some((l) => l.type === 'avatar'))) &&
          !loadedScenes.has(selectedSceneId) &&
          !isThisGenerating && (
            <div className="absolute inset-0 z-10 bg-[#0d0d0f]/80 flex items-center justify-center pointer-events-none">
              <div className="text-[#6b6b7a] text-sm">Loading preview...</div>
            </div>
          )}

        {/* Interaction overlay for interactive mode */}
        {outputMode === 'interactive' && selectedSceneId && selectedScene && (
          <InteractionOverlay
            scene={selectedScene}
            mode={isPlaying ? 'preview' : 'edit'}
            currentTime={currentTime}
            interactionCallbacks={interactionCallbacks}
          />
        )}
      </div>
    </div>
  )

  const viewport = (
    <div
      ref={viewportRef}
      className="w-full h-full flex items-center justify-center select-none overflow-hidden"
      style={{
        cursor: isDragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
        // Preview viewport backdrop = the chat page's content surface (--panel):
        // white in light mode (unchanged), #1a1a1a in dark (matches chat content).
        background: 'var(--panel)',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {canvas}
    </div>
  )

  // ── Render ────────────────────────────────────────────────────────────────

  // Empty-branch state: show a prompt when this is a non-default branch with no scenes.
  const isNonDefaultBranch =
    projectActiveBranchId != null && projectDefaultBranchId != null && projectActiveBranchId !== projectDefaultBranchId
  const isBranchTab = centerTab === 'preview' || (centerTab != null && centerTab.startsWith('preview:'))
  if (scenes.length === 0 && isNonDefaultBranch && isBranchTab) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-[var(--color-input-bg)] text-[var(--color-text-muted)]">
        <div className="text-[13px] font-medium text-[var(--color-text-primary)]">No scenes on this branch</div>
        <div className="text-[12px]">Add a scene from the agent, or duplicate scenes from another branch.</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-visible relative">
      <div className="flex-1 relative">
        <div className={`absolute inset-0 ${outputMode === 'interactive' ? 'overflow-visible' : 'overflow-hidden'}`}>
          {viewport}
        </div>
      </div>
    </div>
  )
}
