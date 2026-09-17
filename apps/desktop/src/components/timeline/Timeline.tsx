'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import { Play, Pause } from 'lucide-react'
import { useTimelineZoom } from './useTimelineZoom'
import { usePlayheadDrag } from './usePlayheadDrag'
import {
  RULER_HEIGHT,
  TOOLBAR_WIDTH,
  TRACK_HEADER_WIDTH,
  TRACK_ROW_HEIGHT,
  SNAP_THRESHOLD,
  DRAG_DEAD_ZONE,
} from './constants'
import { trimToPlayhead, cloneForDuplicate } from '@/lib/timeline/clip-edits'
import {
  collectSnapTargets,
  findSnap,
  getTrackClipBounds,
  clampToAvoidOverlap,
  clampMultiClipDelta,
  canTrackAcceptClipObject,
  type SnapTarget,
} from '@/lib/timeline/snap-engine'
import { snapToFrame } from './keyframe-position'
import TimeRuler, { formatTimecode } from './TimeRuler'
import TimelineToolbar, { type TimelineTool } from './TimelineToolbar'
import { AudioMeter } from './AudioMeter'
import { useTimelineAudio } from '@/lib/hooks/use-timeline-audio'
import TrackHeader from './TrackHeader'
import TrackRow from './TrackRow'
import Playhead from './Playhead'
import { AudioUrlMapContext, buildAudioUrlMap } from './AudioUrlMapContext'
import type { Track } from '@/lib/types'
import { importFilesToTimeline } from '@/lib/utils/timeline-import'
import { addAssetToTimeline, ASSET_DRAG_MIME } from '@/lib/utils/add-asset-to-timeline'
import { addSfxAtGlobalTime, SFX_DRAG_MIME, type SfxDragPayload } from '@/lib/utils/add-sfx-to-timeline'
import type { ProjectAsset } from '@/lib/types'

// Timecode comes from TimeRuler so the playhead gutter and the ruler can't
// disagree (both show real frames, m:ss:ff).

const DIVIDER_HEIGHT = 1
const SCROLLBAR_WIDTH = 14
const LEFT_GUTTER = TOOLBAR_WIDTH + TRACK_HEADER_WIDTH
const MIN_SECTION_HEIGHT = TRACK_ROW_HEIGHT + 4
const MIN_ROW_HEIGHT = 20
const MAX_ROW_HEIGHT = 80
const DOT_SIZE = 10

interface Props {
  currentTime: number
  totalDuration: number
  onSeek: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
  trackHeight?: number
}

export default function Timeline({
  currentTime,
  totalDuration,
  onSeek,
  onScrubStart,
  onScrubEnd,
  trackHeight = 200,
}: Props) {
  // Selector-per-field instead of `useVideoStore()` so Timeline doesn't
  // re-render on every unrelated store mutation (chat keystrokes, transport
  // ticks on unrelated state, scene-name edits, …). Action refs are stable
  // in Zustand so subscribing returns the same fn ref and never re-renders.
  const scenes = useVideoStore((s) => s.scenes)
  const project = useVideoStore((s) => s.project)
  const timelineScrollX = useVideoStore((s) => s.timelineScrollX)
  const timelineAutoScroll = useVideoStore((s) => s.timelineAutoScroll)
  const timelineFollowPaused = useVideoStore((s) => s.timelineFollowPaused)
  const selectedClipIds = useVideoStore((s) => s.selectedClipIds)
  const isAgentRunning = useVideoStore((s) => s.isAgentRunning)
  const timelineTransport = useVideoStore((s) => s.timelineTransport)
  const setTimelineScrollX = useVideoStore((s) => s.setTimelineScrollX)
  const setTimelineFollowPaused = useVideoStore((s) => s.setTimelineFollowPaused)
  const initTimeline = useVideoStore((s) => s.initTimeline)
  const syncTimelineFromScenes = useVideoStore((s) => s.syncTimelineFromScenes)
  const moveClip = useVideoStore((s) => s.moveClip)
  const getTimeline = useVideoStore((s) => s.getTimeline)
  const setSelectedClipIds = useVideoStore((s) => s.setSelectedClipIds)
  const containerRef = useRef<HTMLDivElement>(null)

  // ── File-drop on timeline ─────────────────────────────────────────────
  // Accept videos / audio / images dropped from the OS. Probe duration via a
  // hidden media element, find or create the first eligible non-locked track
  // for the file's kind, append the clip at the end of that track.
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  // Pixel X (relative to the timeline's left edge) where a dropped clip's left
  // edge will land — drives the NLE-style vertical insertion line. Null
  // when nothing is being dragged over.
  const [dropX, setDropX] = useState<number | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const fileDragCounter = useRef(0)
  // dropX only means something mid-drag; clear it whenever the drag ends.
  useEffect(() => {
    if (!isFileDragOver) setDropX(null)
  }, [isFileDragOver])
  // Auto-dismiss error toast.
  useEffect(() => {
    if (!dropError) return
    const t = window.setTimeout(() => setDropError(null), 4000)
    return () => window.clearTimeout(t)
  }, [dropError])

  // True for any drag operation carrying files. Checks both `types` (covers
  // 'Files' and 'text/uri-list' for Finder symlinks) and `items` (some
  // Electron/Chromium builds populate one but not the other during dragenter).
  const isFileDrag = (e: React.DragEvent): boolean => {
    const dt = e.dataTransfer
    if (!dt) return false
    if (Array.from(dt.types).some((t) => t === 'Files' || t === 'application/x-moz-file')) return true
    if (dt.items && dt.items.length > 0) {
      for (let i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind === 'file') return true
      }
    }
    return false
  }

  // True when an internal gallery asset card is being dragged.
  const isAssetDrag = (e: React.DragEvent): boolean => {
    const dt = e.dataTransfer
    if (!dt) return false
    return Array.from(dt.types).includes(ASSET_DRAG_MIME)
  }

  // True when an SFX library card is being dragged.
  const isSfxDrag = (e: React.DragEvent): boolean => {
    const dt = e.dataTransfer
    if (!dt) return false
    return Array.from(dt.types).includes(SFX_DRAG_MIME)
  }

  const isAnyInternalDrag = (e: React.DragEvent) => isAssetDrag(e) || isSfxDrag(e)

  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e) && !isAnyInternalDrag(e)) return
    e.preventDefault()
    fileDragCounter.current += 1
    setIsFileDragOver(true)
  }, [])

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e) && !isAnyInternalDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // Position the insertion line at the cursor — this is exactly where the
    // clip's left edge lands (drop math resolves to the same pixel). Clamp to
    // the track area so the line never crosses into the header gutter.
    const el = containerRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      setDropX(Math.max(LEFT_GUTTER, e.clientX - rect.left))
    }
  }, [])

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e) && !isAnyInternalDrag(e)) return
    fileDragCounter.current = Math.max(0, fileDragCounter.current - 1)
    if (fileDragCounter.current === 0) setIsFileDragOver(false)
  }, [])

  // Convert a drop event's clientX into a global timeline time, accounting for
  // the LEFT_GUTTER and the current scroll offset — same math the playhead
  // drag uses. Reads `pps`/`scrollX` from refs because the drop handler must
  // be defined before `pps` is computed below.
  const ppsRef = useRef(0)
  const scrollXRef = useRef(0)
  const computeDropTime = useCallback((e: React.DragEvent): number => {
    const el = containerRef.current
    if (!el || ppsRef.current <= 0) return 0
    const rect = el.getBoundingClientRect()
    const cursorPx = e.clientX - rect.left - LEFT_GUTTER
    return Math.max(0, (scrollXRef.current + cursorPx) / ppsRef.current)
  }, [])

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      if (isSfxDrag(e)) {
        e.preventDefault()
        fileDragCounter.current = 0
        setIsFileDragOver(false)
        try {
          const raw = e.dataTransfer.getData(SFX_DRAG_MIME)
          if (!raw) return
          const payload = JSON.parse(raw) as SfxDragPayload
          const t = computeDropTime(e)
          const result = await addSfxAtGlobalTime(payload, t)
          if (!result.ok && result.error) setDropError(result.error)
        } catch (err: any) {
          setDropError(err?.message ?? 'Could not add SFX to timeline')
        }
        return
      }
      if (isAssetDrag(e)) {
        e.preventDefault()
        fileDragCounter.current = 0
        setIsFileDragOver(false)
        try {
          const payload = e.dataTransfer.getData(ASSET_DRAG_MIME)
          if (!payload) return
          const asset = JSON.parse(payload) as ProjectAsset
          const dropTime = computeDropTime(e)
          // Cmd / Ctrl held → insert mode (push downstream clips to make room).
          const insert = e.ctrlKey || e.metaKey
          const result = await addAssetToTimeline(asset, { startTime: dropTime, insert })
          if (!result.ok && result.error) setDropError(result.error)
        } catch (err: any) {
          setDropError(err?.message ?? 'Could not add asset to timeline')
        }
        return
      }
      if (!isFileDrag(e)) return
      e.preventDefault()
      fileDragCounter.current = 0
      setIsFileDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      // W2 — batch import with bounded concurrency + progress reporting.
      await importFilesToTimeline(files, (msg) => setDropError(msg))
    },
    [computeDropTime],
  )

  // Use a fallback duration so the ruler/zoom math works even with 0 scenes
  const effectiveDuration = totalDuration > 0 ? totalDuration : 30

  // Timeline audio engine: plays standalone audio clips (dropped files) in
  // sync with the transport; scene-mirrored audio keeps playing in iframes.
  useTimelineAudio()

  const { pps, totalWidth, maxScrollX, usableWidth, zoomIn, zoomOut, fitAll } = useTimelineZoom(
    containerRef,
    effectiveDuration,
    LEFT_GUTTER + SCROLLBAR_WIDTH,
  )

  // Keep drop-time math (defined above) in sync with the live pps/scroll.
  ppsRef.current = pps
  scrollXRef.current = timelineScrollX

  // Wait for the DB load to complete before initializing a default timeline —
  // otherwise the persisted/DB tracks would be replaced briefly by defaults
  // (V1/V2/A1/A2) on every reload, causing a visible flash.
  const dbLoadComplete = useVideoStore((s) => s._dbLoadComplete)
  useEffect(() => {
    if (dbLoadComplete && !project.timeline) initTimeline()
  }, [dbLoadComplete, project.timeline, initTimeline])

  const prevScenesSigRef = useRef<string | null>(null)
  useEffect(() => {
    const sig = scenes
      .map((s) => {
        const avatars = (s.aiLayers ?? [])
          .filter((l) => l.type === 'avatar')
          .map((l) => `${l.id}:${l.startAt ?? 0}:${l.estimatedDuration ?? ''}:${l.label ?? ''}`)
          .join('|')
        // Includes every audio field that affects CLIP PLACEMENT (startOffset,
        // per-SFX trigger times, tts duration) — not just presence — so edits
        // from the audio inspector re-materialize the timeline clips.
        const sfxSig = (s.audioLayer?.sfx ?? []).map((f) => `${f.id}@${f.triggerAt}`).join('+')
        // Text overlays are mirrored as timeline clips, so changes to their
        // count/timing/content must re-trigger a sync (placement + label).
        const txSig = (s.textOverlays ?? []).map((o) => `${o.id}@${o.delay}#${o.duration}:${o.content ?? ''}`).join('+')
        return `${s.id}:${s.duration}:${s.name ?? ''}:${s.transition ?? ''}:${s.audioLayer?.src ?? ''}:${s.audioLayer?.enabled ? '1' : '0'}:${s.audioLayer?.startOffset ?? 0}:${s.audioLayer?.tts?.src ?? ''}:${s.audioLayer?.tts?.duration ?? ''}:${s.audioLayer?.music?.src ?? ''}:${sfxSig}:av=${avatars}:tx=${txSig}`
      })
      .join(',')
    // Only record the signature when we actually sync. Recording it while the
    // timeline is still null (sync skipped) meant that once initTimeline ran,
    // the now-unchanged signature blocked the first sync forever — so audio
    // added before the timeline existed never materialized onto a track.
    // Depending on project.timeline re-runs this the moment the timeline appears.
    if (project.timeline && sig !== prevScenesSigRef.current) {
      syncTimelineFromScenes()
      prevScenesSigRef.current = sig
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, project.timeline, syncTimelineFromScenes])

  // Pre-compute the source-id → audio URL lookup map for the whole timeline
  // and thread it down via context so each ClipBlock's `useAudioUrl` is an
  // O(1) lookup instead of an N-scene walk per render. See
  // src/components/timeline/AudioUrlMapContext.ts for the rationale.
  //
  // Memoize on a SIGNATURE of just the URL-bearing fields rather than the
  // raw scenes ref so the Map identity (and every consumer's re-render)
  // only flips when an audio URL actually changed (a scene rename doesn't
  // invalidate it).
  const audioUrlSig = useMemo(() => {
    return scenes
      .map((s) => {
        const a = s.audioLayer
        const sfx = (a?.sfx ?? []).map((x) => `${x.id}:${x.src ?? ''}`).join(',')
        const avs = (s.aiLayers ?? [])
          .filter((l) => l.type === 'avatar')
          .map((l) => `${l.id}:${(l as any).videoUrl ?? ''}`)
          .join(',')
        return [s.id, a?.src ?? '', a?.tts?.src ?? '', a?.music?.src ?? '', sfx, avs].join('|')
      })
      .join('#')
  }, [scenes])
  const audioUrlMap = useMemo(
    () => buildAudioUrlMap(scenes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioUrlSig],
  )

  const sceneBoundaries = useMemo(() => {
    const bounds: number[] = []
    const v1 = project.timeline?.tracks.find((t) => t.type === 'video')
    if (v1) {
      for (const clip of v1.clips) {
        if (clip.sourceType === 'scene') {
          bounds.push(clip.startTime)
          bounds.push(clip.startTime + clip.duration)
        }
      }
    } else {
      let acc = 0
      for (const scene of scenes) {
        bounds.push(acc)
        acc += scene.duration
      }
      bounds.push(acc)
    }
    return [...new Set(bounds)].sort((a, b) => a - b)
  }, [scenes, project.timeline])

  const {
    isDragging: isPlayheadDragging,
    dragTime,
    onPointerDown: onPlayheadPointerDown,
  } = usePlayheadDrag({
    pps,
    scrollX: timelineScrollX,
    containerRef,
    sceneBoundaries,
    onSeek,
    onScrubStart,
    onScrubEnd,
    leftOffset: LEFT_GUTTER,
  })

  // Re-engage auto-follow each time playback transitions from paused -> playing.
  const prevIsPlayingRef = useRef(timelineTransport.isPlaying)
  useEffect(() => {
    if (!prevIsPlayingRef.current && timelineTransport.isPlaying) {
      setTimelineFollowPaused(false)
    }
    prevIsPlayingRef.current = timelineTransport.isPlaying
  }, [timelineTransport.isPlaying, setTimelineFollowPaused])

  // Auto-scroll only reacts to playhead advancement; do not fight user-initiated scrolls.
  const prevCurrentTimeRef = useRef(currentTime)
  useEffect(() => {
    const timeAdvanced = currentTime !== prevCurrentTimeRef.current
    prevCurrentTimeRef.current = currentTime
    if (!timeAdvanced) return
    if (!timelineAutoScroll || isPlayheadDragging || timelineFollowPaused) return
    const playheadX = currentTime * pps
    const viewLeft = timelineScrollX
    if (playheadX >= viewLeft && playheadX <= viewLeft + usableWidth) {
      const relPos = (playheadX - viewLeft) / usableWidth
      if (relPos > 0.8) {
        setTimelineScrollX(Math.min(maxScrollX, Math.max(0, playheadX - usableWidth * 0.25)))
      }
    }
  }, [
    currentTime,
    pps,
    usableWidth,
    timelineAutoScroll,
    isPlayheadDragging,
    timelineFollowPaused,
    timelineScrollX,
    maxScrollX,
    setTimelineScrollX,
  ])

  const timeline = project.timeline
  const { videoTracks, audioTracks, allTracks } = useMemo(() => {
    if (!timeline) return { videoTracks: [], audioTracks: [], allTracks: [] }
    const sorted = [...timeline.tracks].sort((a, b) => a.position - b.position)
    return {
      // NLE convention: higher tracks (V2, V3...) are above V1.
      // With bottom-anchored layout, array index 0 = visually topmost row.
      // Reverse so V2 (position 1) sits at index 0 (top) and V1 (position 0) at the bottom.
      // Everything except audio renders in the "video" stripe (image, text,
      // graphics, scene all stack visually). Audio gets its own bottom stripe.
      videoTracks: sorted.filter((t) => t.type !== 'audio').reverse(),
      audioTracks: sorted.filter((t) => t.type === 'audio'),
      allTracks: sorted,
    }
  }, [timeline])

  // ── Divider ──
  const contentHeight = trackHeight - RULER_HEIGHT
  const [dividerRatio, setDividerRatio] = useState(0.55)
  const [isDividerDragging, setIsDividerDragging] = useState(false)
  const videoSectionHeight = Math.max(MIN_SECTION_HEIGHT, Math.floor((contentHeight - DIVIDER_HEIGHT) * dividerRatio))
  const audioSectionHeight = Math.max(MIN_SECTION_HEIGHT, contentHeight - DIVIDER_HEIGHT - videoSectionHeight)

  const handleDividerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      setIsDividerDragging(true)
      const startY = e.clientY
      const startRatio = dividerRatio
      const handleMove = (ev: PointerEvent) => {
        const available = contentHeight - DIVIDER_HEIGHT
        setDividerRatio(Math.max(0.15, Math.min(0.85, startRatio + (ev.clientY - startY) / available)))
      }
      const handleUp = () => {
        setIsDividerDragging(false)
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [dividerRatio, contentHeight],
  )

  // ── Tool state ──
  const [activeTool, setActiveTool] = useState<TimelineTool>('select')

  // ── Per-section state ──
  const [videoScrollY, setVideoScrollY] = useState(0)
  const [audioScrollY, setAudioScrollY] = useState(0)
  const [videoRowHeight, setVideoRowHeight] = useState(TRACK_ROW_HEIGHT)
  const [audioRowHeight, setAudioRowHeight] = useState(TRACK_ROW_HEIGHT)

  // Trim snap guide (shared across sections)
  const [trimSnapTime, setTrimSnapTime] = useState<number | null>(null)

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Deselect + seek on any click that didn't land on a clip — clicking the
      // empty part of a track lane (a child of the content container) should
      // clear the selection too, not just a click on the exact background. The
      // old `e.target === e.currentTarget` check missed lane clicks, so clicking
      // off a multi-selection left it stuck selected.
      if ((e.target as HTMLElement).closest('[data-clip]')) return
      setSelectedClipIds([])
      const rect = e.currentTarget.getBoundingClientRect()
      const time = (timelineScrollX + (e.clientX - rect.left)) / pps
      onSeek(Math.max(0, Math.min(effectiveDuration, time)))
    },
    [timelineScrollX, pps, effectiveDuration, onSeek, setSelectedClipIds],
  )

  const handleMarqueeSelect = useCallback(
    (ids: string[], additive: boolean) => {
      if (additive) {
        const merged = Array.from(new Set([...useVideoStore.getState().selectedClipIds, ...ids]))
        setSelectedClipIds(merged)
      } else {
        setSelectedClipIds(ids)
      }
    },
    [setSelectedClipIds],
  )

  // ── Clip Drag ──
  // dragState carries only the COARSE bits (active, targetTrackId, snapTarget)
  // that the React tree needs for drop-target highlights + snap indicators.
  // Fine per-RAF values (ghostLeft, newStartTime) live in dragLiveRef and
  // are written straight to the ghost DOM node via `ghostRef`. Goal: no
  // React re-render per pointermove — only when the visible coarse state
  // actually flips.
  const dragStateRef = useRef<typeof dragState>(null)
  const [dragState, setDragState] = useState<{
    clipId: string
    sourceTrackId: string
    startX: number
    startY: number
    origStartTime: number
    active: boolean
    targetTrackId: string | null
    /** IDs of all clips being dragged (multi-select) */
    allClipIds: string[]
    /** Snap that produced the current position (for visual indicator). */
    snapTarget: SnapTarget | null
  } | null>(null)

  // Refs for the always-mounted ghost divs (one per section). Timeline holds
  // both refs and passes them to the corresponding TrackSection — the drag
  // handler picks the right one at drag-start based on the source clip's
  // type and writes transform straight to its `.style` on each RAF tick.
  const videoGhostRef = useRef<HTMLDivElement>(null)
  const audioGhostRef = useRef<HTMLDivElement>(null)
  // Mutable per-RAF drag values — NOT React state. handleUp reads from this
  // to compute the final move; the RAF tick writes to it before each DOM
  // transform write.
  const dragLiveRef = useRef<{
    ghostLeft: number
    newStartTime: number
  } | null>(null)

  // Keep ref in sync for use in event handlers
  const setDragStateAndRef = useCallback((val: typeof dragState | ((prev: typeof dragState) => typeof dragState)) => {
    if (typeof val === 'function') {
      setDragState((prev) => {
        const next = val(prev)
        dragStateRef.current = next
        return next
      })
    } else {
      dragStateRef.current = val
      setDragState(val)
    }
  }, [])

  const handleClipDragStart = useCallback(
    (clipId: string, trackId: string, e: React.PointerEvent) => {
      if (isAgentRunning) return
      const clip = timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!clip) return
      e.preventDefault()
      // ⌥-drag duplicate: holding Option at drag-start clones
      // the clip — the original stays put and a copy lands at the drop position.
      // Single-clip path only; multi-select duplicate is deferred.
      const duplicateOnDrop = e.altKey
      document.body.style.cursor = duplicateOnDrop ? 'copy' : 'grabbing'

      // ── NLE-style selection-on-grab ─────────────────────────────────
      // Reconcile the selection the instant the clip is grabbed (pointer-down),
      // BEFORE computing the drag set, so every case matches standard NLE behaviour:
      //   • grab an UNSELECTED clip (no shift) → select ONLY its group, deselect
      //     others, then drag it ("click-drag an unselected clip selects + moves
      //     it"), so stale selection rings don't linger while a different
      //     clip drags.
      //   • shift-grab an unselected clip → add it to the selection, drag group.
      //   • grab a clip already in a multi-selection (no shift) → keep the whole
      //     selection and drag the group; collapse to just this clip ONLY if it
      //     turns out to be a plain click (resolved on pointer-up below).
      //   • shift-grab a selected clip → deselect it, but only on a plain click
      //     (a shift-drag still moves the group).
      // The two `defer*` flags are resolved in handleUp when the grab was a
      // click (never moved past the dead zone), not a drag.
      const store = useVideoStore.getState()
      const selBefore = store.selectedClipIds
      const inSelection = selBefore.includes(clipId)
      let deferCollapse = false
      let deferShiftToggle = false
      if (e.shiftKey) {
        if (inSelection) deferShiftToggle = true
        else store.toggleClipSelection(clipId, true)
      } else if (!inSelection) {
        store.toggleClipSelection(clipId, false)
      } else if (selBefore.length > 1) {
        deferCollapse = true
      }
      // Drag set = the now-reconciled selection (group drag) or just this clip.
      const selNow = useVideoStore.getState().selectedClipIds
      const allIds = selNow.includes(clipId) && selNow.length > 1 ? selNow : [clipId]

      // Initialize live ref with drag-start position. The RAF handler writes
      // to this ref and to the ghost DOM node directly — no React re-render
      // per tick (EE).
      dragLiveRef.current = {
        ghostLeft: clip.startTime * pps,
        newStartTime: clip.startTime,
      }
      setDragStateAndRef({
        clipId,
        sourceTrackId: trackId,
        startX: e.clientX,
        startY: e.clientY,
        origStartTime: clip.startTime,
        active: false,
        targetTrackId: trackId,
        allClipIds: allIds,
        snapTarget: null,
      })
      const fps = project.mp4Settings?.fps ?? 30
      const frameSnap = pps >= fps
      const viewStart = timelineScrollX / pps
      const viewEnd = (timelineScrollX + usableWidth) / pps
      const snapEnabled = useVideoStore.getState().timelineSnapEnabled
      const snapTargets = snapEnabled
        ? collectSnapTargets(timeline ?? null, currentTime, clipId, {
            fps,
            frameSnap,
            viewStart,
            viewEnd,
          })
        : []
      // RAF-coalesce pointermove so we render at most one drag-state update
      // per frame. Without this, a 120Hz trackpad fires 2× per frame and the
      // whole React tree re-renders twice — visible jitter on big timelines.
      let pendingEv: PointerEvent | null = null
      let rafId: number | null = null
      const applyMove = () => {
        rafId = null
        const ev = pendingEv
        pendingEv = null
        if (!ev) return
        const ds = dragStateRef.current
        if (!ds) return
        const dx = ev.clientX - e.clientX
        const dy = ev.clientY - e.clientY

        const isActive = ds.active || Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE
        let newTime = Math.max(0, ds.origStartTime + dx / pps)
        let snapHit = findSnap(newTime, pps, SNAP_THRESHOLD, snapTargets)
        newTime = snapHit.time
        // Also snap end of clip; prefer the start-edge snap when both fire.
        const clipEnd = newTime + clip.duration
        const endHit = findSnap(clipEnd, pps, SNAP_THRESHOLD, snapTargets)
        if (endHit.target && endHit.time !== clipEnd) {
          newTime = endHit.time - clip.duration
          if (!snapHit.target) snapHit = endHit
        }

        const sourceTrack = allTracks.find((t) => t.id === ds.sourceTrackId)
        let targetTrackId = ds.sourceTrackId
        // Vertical row movement of the grabbed clip within its section. Reused
        // below to move the rest of a multi-selection up/down tracks together.
        const anchorIsAudio = sourceTrack?.type === 'audio'
        let anchorRowDelta = 0
        if (sourceTrack) {
          const section = anchorIsAudio ? audioTracks : videoTracks
          // Filter to tracks that can accept this clip type — keeps audio off video, etc.
          const accepting = section.filter((t) => canTrackAcceptClipObject(t, clip))
          const srcIdxInAccepting = accepting.indexOf(sourceTrack)
          const rowH = anchorIsAudio ? audioRowHeight : videoRowHeight
          // Use the section row height to compute target index, but pick from the accepting list.
          const sectionIdx = section.indexOf(sourceTrack)
          const desiredIdx = sectionIdx + Math.round(dy / rowH)
          // Map desired section index onto accepting tracks by clamping; ensures we always
          // land on a valid track and never silently drop the clip.
          const acceptingIdx =
            accepting.length === 0
              ? -1
              : Math.max(0, Math.min(accepting.length - 1, srcIdxInAccepting + (desiredIdx - sectionIdx)))
          targetTrackId = acceptingIdx >= 0 ? accepting[acceptingIdx].id : ds.sourceTrackId
          anchorRowDelta = acceptingIdx >= 0 ? acceptingIdx - srcIdxInAccepting : 0
        }

        // EE: write per-RAF values to live ref + ghost DOM — bypasses React entirely.
        // Fresh scrollX from the store so horizontal position is always correct
        // even if the user scrolls the timeline while dragging.
        const newGhostLeft = Math.max(0, newTime) * pps
        dragLiveRef.current = { ghostLeft: newGhostLeft, newStartTime: Math.max(0, newTime) }
        const activeGhostRef = sourceTrack?.type === 'audio' ? audioGhostRef : videoGhostRef
        if (isActive && activeGhostRef.current) {
          const liveScrollX = useVideoStore.getState().timelineScrollX
          activeGhostRef.current.style.transform = `translateX(${newGhostLeft - liveScrollX}px)`
        }

        // Multi-clip drag: live-translate EVERY selected clip (including the
        // dragged one) by the same delta so the whole group moves together as
        // real blocks — no separate ghost, no dimmed clip, so they all look
        // identical. Re-applied each RAF, so a coarse React re-render that
        // resets the inline transform self-heals within a frame. (Multi-drag is
        // horizontal-only on the same tracks, so translateX is sufficient.)
        if (isActive && ds.allClipIds.length > 1) {
          const deltaPx = newGhostLeft - ds.origStartTime * pps
          const liveTl = getTimeline()
          for (const id of ds.allClipIds) {
            const el = document.querySelector(`[data-clip="${id}"]`) as HTMLElement | null
            if (!el) continue
            // Vertical (cross-track) movement applies only to clips in the
            // grabbed clip's section, so a group of video clips moves tracks
            // together while linked audio stays in the audio section (it still
            // syncs horizontally via the same deltaPx).
            const tr = liveTl?.tracks.find((t) => t.clips.some((c) => c.id === id))
            const sameSection = tr ? (tr.type === 'audio') === anchorIsAudio : false
            const rowH = tr?.type === 'audio' ? audioRowHeight : videoRowHeight
            const ty = sameSection ? anchorRowDelta * rowH : 0
            el.style.transform = `translateX(${deltaPx}px) translateY(${ty}px)`
          }
        }

        // Only fire a React state update when COARSE state changes (active flip,
        // track switch, or snap target change). Ghost position (per-RAF) never
        // enters React state — that's the whole point of EE.
        if (isActive !== ds.active || targetTrackId !== ds.targetTrackId || snapHit.target !== ds.snapTarget) {
          setDragStateAndRef({
            ...ds,
            active: isActive,
            targetTrackId,
            snapTarget: snapHit.target,
          })
        }
      }
      const handleMove = (ev: PointerEvent) => {
        pendingEv = ev
        if (rafId !== null) return
        rafId = requestAnimationFrame(applyMove)
      }
      const handleUp = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        // Flush any pending move so the final position reflects the very
        // last pointer event, not the previous RAF tick.
        if (pendingEv) applyMove()
        document.body.style.cursor = ''

        // EE: reset the ghost transform so it doesn't linger after release.
        const srcTrack = allTracks.find((t) => t.id === dragStateRef.current?.sourceTrackId)
        const activeGhostRef = srcTrack?.type === 'audio' ? audioGhostRef : videoGhostRef
        if (activeGhostRef.current) {
          activeGhostRef.current.style.transform = ''
        }
        // Clear the live transforms applied to the multi-dragged clips so they
        // snap to their committed positions (set below) without a leftover offset.
        const dsUp = dragStateRef.current
        if (dsUp && dsUp.allClipIds.length > 1) {
          for (const id of dsUp.allClipIds) {
            const el = document.querySelector(`[data-clip="${id}"]`) as HTMLElement | null
            if (el) el.style.transform = ''
          }
        }

        // Read final positions from their respective refs, then clear both.
        const finalState = dragStateRef.current
        const finalLive = dragLiveRef.current
        setDragStateAndRef(null)
        dragLiveRef.current = null

        if (finalState?.active && finalLive) {
          const newStartTime = finalLive.newStartTime
          const targetId = finalState.targetTrackId ?? finalState.sourceTrackId
          const timeDelta = newStartTime - finalState.origStartTime

          const snapEnabledCommit = useVideoStore.getState().timelineSnapEnabled
          const commitFps = project.mp4Settings?.fps ?? 30
          const frameRound = (t: number) => (snapEnabledCommit ? snapToFrame(t, commitFps) : t)

          if (finalState.allClipIds.length > 1) {
            // Multi-clip drag → clip/batchMove: overlap-safe (all-or-nothing),
            // supports per-clip track changes, and one combined undo. Horizontal
            // delta is collision-clamped; vertical (cross-track) movement applies
            // the grabbed clip's row-delta to every selected clip in its section,
            // so a group of clips moves up/down tracks together while linked
            // audio stays in its own section (synced only horizontally).
            const currentTl = useVideoStore.getState().project.timeline
            const tracks = currentTl?.tracks ?? []
            const allClips = tracks.flatMap((t) => t.clips)
            const draggedClipObjs = finalState.allClipIds
              .map((cid) => allClips.find((cl) => cl.id === cid))
              .filter((c): c is NonNullable<typeof c> => !!c)
            const safeDelta = currentTl ? clampMultiClipDelta(draggedClipObjs, timeDelta, tracks) : timeDelta

            // Recompute the anchor's vertical row-delta from its source→target track.
            const anchorClip = allClips.find((c) => c.id === finalState.clipId)
            const srcTr = tracks.find((t) => t.id === finalState.sourceTrackId)
            const tgtTr = tracks.find((t) => t.id === finalState.targetTrackId)
            const anchorIsAudio2 = srcTr?.type === 'audio'
            const anchorSection = anchorIsAudio2 ? audioTracks : videoTracks
            const anchorAcc = anchorClip ? anchorSection.filter((t) => canTrackAcceptClipObject(t, anchorClip)) : []
            const srcI = srcTr ? anchorAcc.indexOf(srcTr) : -1
            const tgtI = tgtTr ? anchorAcc.indexOf(tgtTr) : -1
            const rowDelta = srcI >= 0 && tgtI >= 0 ? tgtI - srcI : 0

            const moves = draggedClipObjs.map((c) => {
              const tr = tracks.find((t) => t.id === c.trackId)
              let newTrackId = c.trackId
              if (tr && rowDelta !== 0 && (tr.type === 'audio') === anchorIsAudio2) {
                const sect = tr.type === 'audio' ? audioTracks : videoTracks
                const acc = sect.filter((t) => canTrackAcceptClipObject(t, c))
                const i = acc.indexOf(tr)
                if (i >= 0) newTrackId = acc[Math.max(0, Math.min(acc.length - 1, i + rowDelta))].id
              }
              return { clipId: c.id, startTime: Math.max(0, frameRound(c.startTime + safeDelta)), newTrackId }
            })
            const res = useVideoStore
              .getState()
              .dispatchAction({ type: 'clip/batchMove', params: { moves } }, { source: 'user' })
            if (!res.success && res.error?.code === 'OVERLAP_DETECTED') {
              useVideoStore.getState().showTransientStatus?.('Move blocked — clips would overlap')
            }
          } else {
            // Single clip: overlap prevention
            const currentTl = useVideoStore.getState().project.timeline
            const targetTrack = currentTl?.tracks.find((t) => t.id === targetId)
            // When the original is the overlap reference, exclude it; for a
            // duplicate the original keeps its slot, so no clip is excluded.
            const bounds = targetTrack
              ? getTrackClipBounds(targetTrack, duplicateOnDrop ? '' : finalState.clipId)
              : null
            const dropSt = bounds ? clampToAvoidOverlap(newStartTime, clip.duration, bounds) : newStartTime
            if (duplicateOnDrop) {
              // Clone: original stays put, a copy lands at the drop position on
              // the target track. cloneForDuplicate strips id/trackId (addClip
              // mints fresh ones) + the link/group bindings, and deep-clones
              // keyframes/filters/position/scale so edits to the copy can't
              // bleed back into the original via a shared reference.
              useVideoStore.getState().addClip(targetId, { ...cloneForDuplicate(clip), startTime: frameRound(dropSt) })
            } else {
              moveClip(finalState.clipId, targetId, frameRound(dropSt))
            }
          }
        } else {
          // Plain click (never dragged past the dead zone): resolve the deferred
          // selection intent. A real drag has finalState.active === true and is
          // handled by the move-commit branch above.
          if (deferShiftToggle) useVideoStore.getState().toggleClipSelection(clipId, true)
          else if (deferCollapse) useVideoStore.getState().toggleClipSelection(clipId, false)
        }

        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [
      timeline,
      pps,
      currentTime,
      allTracks,
      videoTracks,
      audioTracks,
      videoRowHeight,
      audioRowHeight,
      moveClip,
      selectedClipIds,
      isAgentRunning,
    ],
  )

  // ── Keyboard ──
  //
  // The handler reads a bunch of props + per-render state (selectedClipIds,
  // currentTime, timeline, …). If we put those in the effect's deps the
  // global keydown listener detaches + re-attaches on every state tick —
  // hot during playback. Instead we keep the handler in a ref that's
  // updated synchronously each render, and attach a stable shim that
  // delegates to whatever's in the ref. Effect deps stay empty so the
  // listener binds once for the component's lifetime.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't hijack single-key timeline shortcuts (s / j / k / l / delete / …)
      // while the user is typing in a field OR a contentEditable surface (scene
      // text overlays, the rich code editor). The old guard missed
      // contentEditable, so typing could split clips, delete, or now toggle
      // playback (J/K/L) mid-keystroke.
      const tgt = e.target as HTMLElement | null
      if (
        tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        (tgt && (tgt.isContentEditable || tgt.closest('[contenteditable="true"]')))
      )
        return
      if (useVideoStore.getState().isAgentRunning) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedClipIds.length > 0) {
        e.preventDefault()
        const { removeClip, removeClipRipple, timelineMagnetic } = useVideoStore.getState()
        // Ripple delete fires on:
        //   - Shift+Delete (explicit)
        //   - Plain Delete when the magnetic-timeline toggle is on (FCP-style)
        // Process in original timeline order so each subsequent ripple sees the
        // already-shifted timeline.
        const rippleMode = e.shiftKey || timelineMagnetic
        if (rippleMode) {
          const tl = useVideoStore.getState().project.timeline
          const ordered = [...selectedClipIds].sort((a, b) => {
            const ca = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === a)
            const cb = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === b)
            return (ca?.startTime ?? 0) - (cb?.startTime ?? 0)
          })
          for (const id of ordered) removeClipRipple(id)
        } else {
          for (const id of selectedClipIds) removeClip(id)
        }
        setSelectedClipIds([])
      }
      if (e.key === 's' && !e.metaKey && !e.ctrlKey && selectedClipIds.length > 0) {
        e.preventDefault()
        const { splitClip } = useVideoStore.getState()
        for (const id of selectedClipIds) {
          const clip = timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
          if (clip) {
            const rel = currentTime - clip.startTime
            if (rel > 0 && rel < clip.duration) splitClip(id, rel)
          }
        }
        setSelectedClipIds([])
        return // stop — without this, 's' falls through to later key handlers
      }
      // Cmd/Ctrl+A — select all clips in the sequence (standard NLE shortcut).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (tl) setSelectedClipIds(tl.tracks.flatMap((t) => t.clips.map((c) => c.id)))
        return
      }
      // Cmd/Ctrl+R — open Speed/Duration prompt for the first selected clip.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'r') {
        if (selectedClipIds.length === 0) return
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        const id = selectedClipIds[0]
        const clip = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
        if (!clip) return
        const raw = window.prompt('Clip speed (%):', String((clip.speed * 100).toFixed(0)))
        if (raw == null) return
        const pct = parseFloat(raw)
        if (!Number.isFinite(pct) || pct <= 0) return
        const newSpeed = pct / 100
        const sourceRange = clip.trimEnd != null ? clip.trimEnd - clip.trimStart : clip.duration * clip.speed
        const newDuration = Math.max(0.05, sourceRange / newSpeed)
        useVideoStore.getState().updateClip(id, { speed: newSpeed, duration: newDuration })
        return
      }
      // Cmd/Ctrl+C — copy selected clips to the in-app clipboard.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
        if (selectedClipIds.length === 0) return
        e.preventDefault()
        useVideoStore.getState().copyClips(selectedClipIds)
        return
      }
      // Cmd/Ctrl+X — cut selected.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'x') {
        if (selectedClipIds.length === 0) return
        e.preventDefault()
        useVideoStore.getState().cutClips(selectedClipIds)
        return
      }
      // Cmd/Ctrl+V — paste at playhead and select the newly-placed clips.
      // Cmd/Ctrl+Shift+V — paste insert: pushes downstream clips on each
      // affected track to make room (standard NLE shortcut).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (!useVideoStore.getState().clipClipboard) return
        e.preventDefault()
        useVideoStore.getState().pasteClips(currentTime, { insert: e.shiftKey })
        return
      }
      // Cmd/Ctrl+G — group selected clips. Cmd/Ctrl+Shift+G — ungroup.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) {
          if (selectedClipIds.length > 0) {
            useVideoStore.getState().ungroupClip(selectedClipIds[0])
          }
        } else {
          if (selectedClipIds.length >= 2) {
            useVideoStore.getState().groupClips(selectedClipIds)
          }
        }
        return
      }
      // Cmd/Ctrl + [=/+] zoom in, Cmd/Ctrl + [-/_] zoom out, Cmd/Ctrl + 0 fit-all.
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          zoomIn()
          return
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          zoomOut()
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          fitAll()
          return
        }
      }
      // Cmd/Ctrl+D — apply default video transition (crossfade 0.5s) on the
      // trailing edge of each selected NON-audio clip. Standard NLE behaviour.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        const { updateClip } = useVideoStore.getState()
        for (const id of selectedClipIds) {
          const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
          if (!c || c.sourceType === 'audio') continue
          updateClip(id, { transition: { type: 'crossfade', duration: 0.5 } })
        }
        return
      }
      // Shift+Cmd+D — default AUDIO transition (constant-power crossfade) on
      // every selected audio clip.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        const { updateClip } = useVideoStore.getState()
        for (const id of selectedClipIds) {
          const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
          if (!c || c.sourceType !== 'audio') continue
          updateClip(id, { transition: { type: 'constant-power-crossfade', duration: 0.5 } })
        }
        return
      }
      // Escape — clear selection AND reset the active tool to select.
      // Fires even when nothing is selected so a
      // stray razor/slip tool always returns to the safe default.
      if (e.key === 'Escape') {
        const hadSel = selectedClipIds.length > 0
        if (hadSel) setSelectedClipIds([])
        setActiveTool('select')
        if (hadSel || activeTool !== 'select') {
          e.preventDefault()
          return
        }
      }
      // Trim Start / Trim End to playhead (Q / [ trim start, W / ] trim end).
      // Operates on the first selected clip. The start edge moves the clip to the
      // playhead and consumes head source via trimStart; the end edge shortens the
      // tail via trimEnd. Geometry lives in src/lib/timeline/clip-edits.ts so the
      // (duration, trimEnd) pair always satisfies trimEnd === trimStart +
      // duration*speed. `[`/`]` are NOT trim aliases — they stay owned by
      // PreviewPlayer scene-nav to avoid a double-action with the playhead jump.
      {
        const isTrimStart = e.key === 'q' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        const isTrimEnd = e.key === 'w' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        if ((isTrimStart || isTrimEnd) && selectedClipIds.length > 0) {
          const tl = useVideoStore.getState().project.timeline
          const clip = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipIds[0])
          if (clip && currentTime > clip.startTime && currentTime < clip.startTime + clip.duration) {
            e.preventDefault()
            const { updateClip } = useVideoStore.getState()
            updateClip(clip.id, trimToPlayhead(clip, isTrimStart ? 'start' : 'end', currentTime))
            return
          }
        }
      }
      // E — toggle Enable on selected clips (standard NLE shortcut).
      if (e.key === 'e' && !e.metaKey && !e.ctrlKey && selectedClipIds.length > 0) {
        e.preventDefault()
        const { updateClip } = useVideoStore.getState()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        // Toggle as a group: if ANY selected clip is currently enabled, disable all;
        // otherwise enable all. Standard NLE behaviour.
        const anyEnabled = selectedClipIds.some((id) => {
          const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
          return c ? c.enabled !== false : false
        })
        const next = !anyEnabled
        for (const id of selectedClipIds) updateClip(id, { enabled: next })
        return
      }
      // I — set sequence in-point at playhead; Shift+I jumps to it; Alt+I clears.
      if (e.key === 'i' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useVideoStore.getState().setSequenceInPoint(currentTime)
        return
      }
      if (e.key === 'I' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const tIn = useVideoStore.getState().project.timeline?.inPoint
        if (tIn != null) onSeek(tIn)
        return
      }
      if (e.key === 'i' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        useVideoStore.getState().setSequenceInPoint(null)
        return
      }
      // X — mark in/out from the first selected clip's range (standard NLE shortcut).
      // Cmd+Shift+X clears both marks.
      if (e.key === 'x' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl || selectedClipIds.length === 0) return
        const id = selectedClipIds[0]
        const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
        if (!c) return
        useVideoStore.getState().setSequenceInPoint(c.startTime)
        useVideoStore.getState().setSequenceOutPoint(c.startTime + c.duration)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault()
        useVideoStore.getState().setSequenceInPoint(null)
        useVideoStore.getState().setSequenceOutPoint(null)
        return
      }
      // O — set sequence out-point; Shift+O jumps; Alt+O clears.
      if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useVideoStore.getState().setSequenceOutPoint(currentTime)
        return
      }
      if (e.key === 'O' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const tOut = useVideoStore.getState().project.timeline?.outPoint
        if (tOut != null) onSeek(tOut)
        return
      }
      if (e.key === 'o' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        useVideoStore.getState().setSequenceOutPoint(null)
        return
      }
      // Cmd/Ctrl+K — Add Edit at playhead. Splits every unlocked clip whose
      // range covers the current time ("Add Edit"). When clips are
      // selected, restrict to those clips' tracks; otherwise all tracks.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        let trackIds: string[] | undefined
        if (selectedClipIds.length > 0) {
          const selTracks = new Set<string>()
          for (const t of tl.tracks) {
            for (const c of t.clips) {
              if (selectedClipIds.includes(c.id)) selTracks.add(t.id)
            }
          }
          if (selTracks.size > 0) trackIds = Array.from(selTracks)
        }
        useVideoStore.getState().addEditAtTime(currentTime, trackIds)
        return
      }
      // M — add an unlabelled marker at the playhead. Shift+Option+M prompts
      // for a label. Mirrors the standard "Add Marker" / "Add Marker (with name)".
      if (e.key === 'm' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useVideoStore.getState().addMarker(currentTime)
        return
      }
      if (e.key === 'M' && e.shiftKey && e.altKey) {
        e.preventDefault()
        const label = window.prompt('Marker label:', '')
        useVideoStore.getState().addMarker(currentTime, label ?? undefined)
        return
      }
      // Shift+M — toggle audio mute on selected audio clips.
      if (e.key === 'M' && e.shiftKey && selectedClipIds.length > 0) {
        e.preventDefault()
        const { updateClip } = useVideoStore.getState()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        const anyAudible = selectedClipIds.some((id) => {
          const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
          return c?.sourceType === 'audio' && !c.audioMuted
        })
        for (const id of selectedClipIds) {
          const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
          if (c?.sourceType === 'audio') updateClip(id, { audioMuted: anyAudible })
        }
        return
      }
      // J / K / L transport (standard NLE shortcut). No reverse playback yet, so:
      //   L → play, K → pause, J → step back 1s per press.
      //
      // PreviewPlayer OWNS playback and the `isPlaying` flag (it pushes the flag
      // into the store). It only reacts to the `dreambyte-preview-command`
      // `toggle_play` event — the same path the Play button uses. Setting
      // `timelineTransport.isPlaying` directly does nothing (the engine
      // overwrites it).
      // Fire toggle_play, gated on the real (engine-driven) play state so L only
      // ever starts and K only ever stops.
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const firePlayToggle = () =>
          window.dispatchEvent(new CustomEvent('dreambyte-preview-command', { detail: { action: 'toggle_play' } }))
        if (e.key === 'l') {
          e.preventDefault()
          if (!useVideoStore.getState().timelineTransport.isPlaying) firePlayToggle()
          return
        }
        if (e.key === 'k') {
          e.preventDefault()
          if (useVideoStore.getState().timelineTransport.isPlaying) firePlayToggle()
          return
        }
        if (e.key === 'j') {
          e.preventDefault()
          const t = useVideoStore.getState().timelineTransport
          onSeek(Math.max(0, t.globalTime - 1))
          return
        }
        // `/` — play around the playhead: jump back 2s and start playing.
        // "Play Around" uses pre/post-roll; we approximate with a
        // simple back-step and play.
        if (e.key === '/') {
          e.preventDefault()
          const t = useVideoStore.getState().timelineTransport
          onSeek(Math.max(0, t.globalTime - 2))
          if (!useVideoStore.getState().timelineTransport.isPlaying) firePlayToggle()
          return
        }
      }
      // Home / End — jump to timeline start / end.
      if (e.key === 'Home' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onSeek(0)
        return
      }
      if (e.key === 'End' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onSeek(effectiveDuration)
        return
      }
      // Left / Right arrow — step playhead one frame; Shift adds a 10× multiplier.
      // Alt+Left / Alt+Right — nudge SELECTED clips by 1 frame; Shift+Alt for 5×.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.metaKey || e.ctrlKey) return
        const fpsLocal = project.mp4Settings?.fps ?? 30
        if (e.altKey) {
          if (selectedClipIds.length === 0) return
          e.preventDefault()
          const frames = e.shiftKey ? 5 : 1
          const delta = (frames / fpsLocal) * (e.key === 'ArrowRight' ? 1 : -1)
          const tl = useVideoStore.getState().project.timeline
          if (!tl) return
          // Route the nudge through the typed reducer so TRACK_OVERLAP_RULES
          // are enforced all-or-nothing — nudging selected clips into each other
          // (or a stationary clip) on a reject track now refuses the whole batch
          // instead of silently stacking them. One combined undo restores all.
          const moves = selectedClipIds
            .map((id) => {
              const c = tl.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
              if (!c) return null
              return { clipId: id, startTime: Math.max(0, c.startTime + delta) }
            })
            .filter((x): x is { clipId: string; startTime: number } => !!x)
          if (moves.length > 0) {
            const res = useVideoStore
              .getState()
              .dispatchAction({ type: 'clip/batchMove', params: { moves } }, { source: 'user' })
            if (!res.success && res.error?.code === 'OVERLAP_DETECTED') {
              useVideoStore.getState().showTransientStatus?.('Nudge blocked — clips would overlap')
            }
          }
          return
        }
        if (!e.altKey) {
          e.preventDefault()
          const frames = e.shiftKey ? 10 : 1
          const delta = (frames / fpsLocal) * (e.key === 'ArrowRight' ? 1 : -1)
          onSeek(Math.max(0, Math.min(effectiveDuration, currentTime + delta)))
          return
        }
      }
      // Up / Down — jump to previous / next edit point (standard NLE shortcut).
      // Edit point = any clip start or end across all tracks. Ignores the
      // edit point at the current playhead time so repeat-press steps through.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const tl = useVideoStore.getState().project.timeline
        if (!tl) return
        const edits = new Set<number>()
        for (const t of tl.tracks) {
          for (const c of t.clips) {
            edits.add(c.startTime)
            edits.add(c.startTime + c.duration)
          }
        }
        const sorted = Array.from(edits).sort((a, b) => a - b)
        const eps = 0.0005
        if (e.key === 'ArrowDown') {
          const next = sorted.find((x) => x > currentTime + eps)
          if (next != null) onSeek(next)
        } else {
          const prev = [...sorted].reverse().find((x) => x < currentTime - eps)
          if (prev != null) onSeek(prev)
        }
        return
      }
      // Tool shortcuts
      const toolMap: Record<string, TimelineTool> = {
        v: 'select',
        c: 'razor',
        b: 'ripple',
        y: 'slip',
        n: 'rolling',
        u: 'slide',
        h: 'hand',
      }
      if (!e.metaKey && !e.ctrlKey && toolMap[e.key]) {
        setActiveTool(toolMap[e.key])
      }
    }
    // Update the ref synchronously each render. The shim listener
    // (registered once below) calls whatever's in the ref, so the
    // closure here can capture the latest props without re-binding the
    // global keydown listener.
    keyHandlerRef.current = handleKeyDown
  })
  useEffect(() => {
    const shim = (e: KeyboardEvent) => keyHandlerRef.current(e)
    window.addEventListener('keydown', shim)
    return () => window.removeEventListener('keydown', shim)
  }, [])

  return (
    <AudioUrlMapContext.Provider value={audioUrlMap}>
      <div
        className="w-full flex flex-row"
        style={{
          height: trackHeight,
          background: 'var(--tl-bg)',
          position: 'relative',
        }}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
      >
        {/* Drop insertion line: a thin vertical marker at the exact spot the
          dropped clip's left edge will land. Replaces
          the old full-area dashed box — no border, no hint card. */}
        {isFileDragOver && dropX !== null && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-[400]"
            style={{
              left: dropX,
              width: 2,
              marginLeft: -1,
              background: 'var(--color-accent)',
              boxShadow: '0 0 4px var(--color-accent)',
            }}
          />
        )}
        {/* Drop-error toast. Reuses the existing top-bar pattern from
          Editor.tsx — small bar, auto-dismiss, dismiss button on the right. */}
        {dropError && (
          <div
            className="absolute top-0 left-0 right-0 z-[401] flex items-center justify-between px-3 py-1.5 text-[12px]"
            style={{
              background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-panel))',
              color: 'var(--color-text-primary)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <span>{dropError}</span>
            <span
              onClick={() => setDropError(null)}
              className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] ml-3"
            >
              Dismiss
            </span>
          </div>
        )}

        {/* Main timeline content */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ position: 'relative', overflow: 'hidden' }}
          ref={containerRef}
        >
          {/* Ruler row: timecode gutter + ruler */}
          <div className="flex-shrink-0 flex" style={{ marginRight: SCROLLBAR_WIDTH }}>
            <div
              className="flex items-center justify-between flex-shrink-0 px-1.5 font-mono tabular-nums select-none"
              style={{
                width: LEFT_GUTTER,
                height: RULER_HEIGHT,
                fontSize: 12,
                color: 'var(--color-text-muted)',
                background: 'var(--tl-bg)',
                borderBottom: '1px solid var(--tl-border)',
                borderRight: '1px solid var(--tl-border)',
              }}
            >
              <span
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('dreambyte-preview-command', { detail: { action: 'toggle_play' } }),
                  )
                }
                className="no-style electron-titlebar-icon flex h-6 w-6 items-center justify-center rounded-md shrink-0 transition-colors cursor-pointer"
                data-tooltip={timelineTransport.isPlaying ? 'Pause' : 'Play'}
              >
                {timelineTransport.isPlaying ? (
                  <Pause size={13} fill="currentColor" />
                ) : (
                  <Play size={13} fill="currentColor" />
                )}
              </span>
              <span>{formatTimecode(currentTime, project.mp4Settings?.fps ?? 30, true)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <TimeRuler
                pps={pps}
                totalWidth={totalWidth}
                scrollX={timelineScrollX}
                containerWidth={usableWidth}
                onSeek={onSeek}
                fps={project.mp4Settings?.fps ?? 30}
                markers={timeline?.markers}
                onMarkerRemove={(id) => useVideoStore.getState().removeMarker(id)}
                onMarkerRename={(id, label) => useVideoStore.getState().updateMarker(id, { label })}
                inPoint={timeline?.inPoint}
                outPoint={timeline?.outPoint}
              />
            </div>
          </div>

          {/* Main content row: toolbar | sections */}
          <div className="flex flex-1 overflow-hidden">
            {/* Toolbar column */}
            <TimelineToolbar activeTool={activeTool} onToolChange={setActiveTool} height={contentHeight} />

            {/* Sections column */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Video section */}
              <TrackSection
                tracks={videoTracks}
                sectionType="video"
                height={videoSectionHeight}
                scrollY={videoScrollY}
                onScrollY={setVideoScrollY}
                rowHeight={videoRowHeight}
                onRowHeightChange={setVideoRowHeight}
                pps={pps}
                scrollX={timelineScrollX}
                usableWidth={usableWidth}
                totalDuration={effectiveDuration}
                activeTool={activeTool}
                fps={project.mp4Settings?.fps ?? 30}
                dragState={dragState}
                ghostRef={videoGhostRef}
                onClipDragStart={handleClipDragStart}
                onContentClick={handleContentClick}
                getTimeline={getTimeline}
                trimSnapTime={trimSnapTime}
                onTrimSnap={setTrimSnapTime}
                onMarqueeSelect={handleMarqueeSelect}
              />

              {/* Divider */}
              <div
                className="flex-shrink-0 select-none"
                style={{
                  height: DIVIDER_HEIGHT,
                  cursor: 'row-resize',
                  position: 'relative',
                  zIndex: 30,
                  background: isDividerDragging ? 'var(--tl-playhead)' : 'var(--tl-border)',
                  transition: isDividerDragging ? 'none' : 'background 0.15s',
                }}
                onPointerDown={handleDividerPointerDown}
              >
                {/* Master audio meter — only visible while standalone audio plays */}
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                  <AudioMeter />
                </div>
              </div>

              {/* Audio section */}
              <TrackSection
                tracks={audioTracks}
                sectionType="audio"
                height={audioSectionHeight}
                scrollY={audioScrollY}
                onScrollY={setAudioScrollY}
                rowHeight={audioRowHeight}
                onRowHeightChange={setAudioRowHeight}
                pps={pps}
                scrollX={timelineScrollX}
                usableWidth={usableWidth}
                totalDuration={effectiveDuration}
                activeTool={activeTool}
                fps={project.mp4Settings?.fps ?? 30}
                dragState={dragState}
                ghostRef={audioGhostRef}
                onClipDragStart={handleClipDragStart}
                onContentClick={handleContentClick}
                getTimeline={getTimeline}
                trimSnapTime={trimSnapTime}
                onTrimSnap={setTrimSnapTime}
                onMarqueeSelect={handleMarqueeSelect}
              />
            </div>
            {/* end sections column */}
          </div>
          {/* end main content row */}

          {/* Playhead */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: LEFT_GUTTER,
              right: SCROLLBAR_WIDTH,
              bottom: 0,
              pointerEvents: 'none',
              zIndex: 20,
            }}
          >
            <Playhead
              currentTime={currentTime}
              pps={pps}
              scrollX={timelineScrollX}
              containerWidth={usableWidth}
              isDragging={isPlayheadDragging}
              dragTime={dragTime}
              onPointerDown={onPlayheadPointerDown}
            />
          </div>

          {/* Streaming lock indicator */}
          {isAgentRunning && (
            <div
              className="absolute top-0 left-0 right-0 z-50 pointer-events-none"
              style={{ height: 2, background: 'var(--tl-playhead)', opacity: 0.6 }}
            />
          )}
        </div>
        {/* end main timeline content */}
      </div>
    </AudioUrlMapContext.Provider>
  )
}

// ═══════════════════════════════════════════════════════════════════
// NLE-style vertical scrollbar with zoom dot handles
// ═══════════════════════════════════════════════════════════════════

function VerticalScrollbar({
  scrollY,
  onScrollY,
  contentHeight,
  viewHeight,
  width,
  rowHeight,
  onRowHeightChange,
}: {
  scrollY: number
  onScrollY: (y: number) => void
  contentHeight: number
  viewHeight: number
  width: number
  rowHeight: number
  onRowHeightChange: (h: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)

  // The thumb represents the visible window within the content.
  // Dot handles at top/bottom resize the thumb = vertical zoom (row height change).
  const maxScroll = Math.max(0, contentHeight - viewHeight)
  const canScroll = contentHeight > viewHeight

  // Thumb sizing: ratio of viewHeight to contentHeight, clamped
  const ratio = contentHeight > 0 ? Math.min(1, viewHeight / contentHeight) : 1
  const minThumb = DOT_SIZE * 2 + 8
  const thumbHeight = Math.max(minThumb, Math.floor(viewHeight * ratio))
  const trackSpace = viewHeight - thumbHeight
  const thumbTop = canScroll && trackSpace > 0 ? (scrollY / maxScroll) * trackSpace : 0

  // ── Scroll (drag middle of thumb) ──
  const handleThumbPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startScroll = scrollY
    const handleMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      if (trackSpace > 0) {
        onScrollY(Math.max(0, Math.min(maxScroll, startScroll + (dy / trackSpace) * maxScroll)))
      }
    }
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  // ── Zoom (drag top dot = shrink rows, drag bottom dot = grow rows) ──
  const handleDotDrag = (edge: 'top' | 'bottom', e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startRowHeight = rowHeight

    const handleMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      // Dragging top dot down or bottom dot up = zoom in (bigger rows)
      // Dragging top dot up or bottom dot down = zoom out (smaller rows)
      const direction = edge === 'top' ? -1 : 1
      const sensitivity = 0.5
      const newHeight = Math.round(startRowHeight + dy * direction * sensitivity)
      onRowHeightChange(Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, newHeight)))
    }

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  // Click gutter to jump scroll
  const handleTrackClick = (e: React.MouseEvent) => {
    if (!canScroll) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const clickY = e.clientY - rect.top
    const targetScroll = (clickY / viewHeight) * contentHeight - viewHeight / 2
    onScrollY(Math.max(0, Math.min(maxScroll, targetScroll)))
  }

  return (
    <div
      ref={trackRef}
      className="flex-shrink-0 relative"
      style={{ width, background: 'var(--tl-scrollbar-bg)', cursor: 'default' }}
      onClick={handleTrackClick}
    >
      {/* Thumb */}
      <div
        className="absolute flex flex-col items-center justify-between"
        style={{
          left: 1,
          right: 1,
          top: thumbTop,
          height: thumbHeight,
          background: 'var(--tl-scrollbar-thumb)',
          borderRadius: 3,
          cursor: canScroll ? 'grab' : 'default',
        }}
        onPointerDown={handleThumbPointerDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top zoom dot */}
        <div
          className="flex-shrink-0 rounded-full border border-[rgba(255,255,255,0.4)]"
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            cursor: 'ns-resize',
            background: 'rgba(80,80,80,0.9)',
            marginTop: 1,
            boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.15)',
          }}
          onPointerDown={(e) => handleDotDrag('top', e)}
        />
        {/* Bottom zoom dot */}
        <div
          className="flex-shrink-0 rounded-full border border-[rgba(255,255,255,0.4)]"
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            cursor: 'ns-resize',
            background: 'rgba(80,80,80,0.9)',
            marginBottom: 1,
            boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.15)',
          }}
          onPointerDown={(e) => handleDotDrag('bottom', e)}
        />
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// TrackSection: independently scrollable group of tracks
// ═══════════════════════════════════════════════════════════════════

interface TrackSectionProps {
  tracks: Track[]
  sectionType: 'video' | 'audio'
  height: number
  scrollY: number
  onScrollY: (y: number) => void
  rowHeight: number
  onRowHeightChange: (h: number) => void
  pps: number
  scrollX: number
  usableWidth: number
  totalDuration: number
  activeTool: TimelineTool
  fps: number
  dragState: {
    clipId: string
    sourceTrackId: string
    active: boolean
    targetTrackId: string | null
    snapTarget: SnapTarget | null
    /** All clips in the drag (multi-select). Length > 1 suppresses the single-clip ghost. */
    allClipIds: string[]
  } | null
  /** Ref to the always-mounted ghost div for this section. Position is written
   *  directly to the DOM via style.transform — no React re-render per drag tick. */
  ghostRef: React.RefObject<HTMLDivElement>
  onClipDragStart: (clipId: string, trackId: string, e: React.PointerEvent) => void
  onContentClick: (e: React.MouseEvent<HTMLDivElement>) => void
  getTimeline: () => import('@/lib/types').Timeline | null
  trimSnapTime: number | null
  onTrimSnap: (time: number | null) => void
  onMarqueeSelect: (clipIds: string[], additive: boolean) => void
}

function TrackSection({
  tracks,
  sectionType,
  height,
  scrollY,
  onScrollY,
  rowHeight,
  onRowHeightChange,
  pps,
  scrollX,
  usableWidth,
  totalDuration,
  activeTool,
  fps,
  dragState,
  ghostRef,
  onClipDragStart,
  onContentClick,
  getTimeline,
  trimSnapTime,
  onTrimSnap,
  onMarqueeSelect,
}: TrackSectionProps) {
  const totalContentHeight = tracks.length * rowHeight

  // For video sections, anchor tracks to the bottom (V1 at bottom)
  const isBottomAnchored = sectionType === 'video'
  // When bottom-anchored, offset so content sticks to the bottom of the section
  const bottomOffset = isBottomAnchored ? Math.max(0, height - totalContentHeight) : 0

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && totalContentHeight > height) {
        e.stopPropagation()
        const maxY = Math.max(0, totalContentHeight - height)
        // Invert scroll for video section (bottom-anchored)
        const delta = isBottomAnchored ? -e.deltaY : e.deltaY
        onScrollY(Math.max(0, Math.min(maxY, scrollY + delta)))
      }
    },
    [totalContentHeight, height, scrollY, onScrollY, isBottomAnchored],
  )

  // ── Marquee selection ──
  // Pointer-drag on empty section space draws a rubber-band rectangle and,
  // on release, selects every clip whose bounding box intersects it. Shift
  // makes the selection additive.
  const contentRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{
    startX: number
    startY: number
    curX: number
    curY: number
    additive: boolean
  } | null>(null)
  // After a real marquee selection, swallow the trailing `click` event so
  // handleContentClick doesn't immediately deselect + seek.
  const suppressNextClickRef = useRef(false)

  const handleMarqueePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only start when click landed outside any clip block. Walk up the
      // ancestor chain — checking the immediate target misses empty space
      // INSIDE a track row (where target is the track row, not the content).
      const targetEl = e.target as Element | null
      if (targetEl?.closest('[data-clip]')) return
      if (e.button !== 0) return
      if (activeTool !== 'select') return
      const rect = contentRef.current?.getBoundingClientRect()
      if (!rect) return
      e.preventDefault()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setMarquee({ startX: x, startY: y, curX: x, curY: y, additive: e.shiftKey })

      const onMove = (ev: PointerEvent) => {
        const r = contentRef.current?.getBoundingClientRect()
        if (!r) return
        setMarquee((m) => (m ? { ...m, curX: ev.clientX - r.left, curY: ev.clientY - r.top } : m))
      }
      const onUp = () => {
        setMarquee((m) => {
          if (!m) {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            return null
          }
          const r = contentRef.current?.getBoundingClientRect()
          if (!r) {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            return null
          }
          // Treat near-zero drags as a plain click — let onClick handle it.
          if (Math.abs(m.curX - m.startX) < 3 && Math.abs(m.curY - m.startY) < 3) {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            return null
          }
          // Normalize rect into the section's local content coords.
          const left = Math.min(m.startX, m.curX)
          const right = Math.max(m.startX, m.curX)
          const top = Math.min(m.startY, m.curY)
          const bottom = Math.max(m.startY, m.curY)

          // Convert horizontal pixels to time range.
          const timeStart = (left + scrollX) / pps
          const timeEnd = (right + scrollX) / pps

          // Walk tracks to find vertical hits. Account for the
          // bottom-anchor offset and per-section scrollY.
          const hits: string[] = []
          for (let i = 0; i < tracks.length; i++) {
            const trackTop = i * rowHeight + bottomOffset - scrollY
            const trackBottom = trackTop + rowHeight
            if (trackBottom < top || trackTop > bottom) continue
            // Don't marquee-select clips on a locked track — they can't be
            // moved/edited, so selecting them just produces silent move-rejects.
            if (tracks[i].locked) continue
            for (const c of tracks[i].clips) {
              const cStart = c.startTime
              const cEnd = c.startTime + c.duration
              if (cEnd >= timeStart && cStart <= timeEnd) hits.push(c.id)
            }
          }
          onMarqueeSelect(hits, m.additive)
          suppressNextClickRef.current = true
          // Auto-clear so a release outside the section doesn't leave the
          // flag set and swallow a later legitimate click.
          setTimeout(() => {
            suppressNextClickRef.current = false
          }, 250)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          return null
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [activeTool, scrollX, pps, scrollY, rowHeight, bottomOffset, tracks, onMarqueeSelect],
  )

  const marqueeRect = marquee && {
    left: Math.min(marquee.startX, marquee.curX),
    top: Math.min(marquee.startY, marquee.curY),
    width: Math.abs(marquee.curX - marquee.startX),
    height: Math.abs(marquee.curY - marquee.startY),
  }

  const handleContentClickGuarded = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        return
      }
      onContentClick(e)
    },
    [onContentClick],
  )

  return (
    <div className="flex flex-shrink-0 overflow-hidden" style={{ height }}>
      {/* Track headers */}
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{ width: TRACK_HEADER_WIDTH, borderRight: '1px solid var(--tl-border)' }}
      >
        <div style={{ transform: `translateY(${bottomOffset - scrollY}px)` }}>
          {tracks.map((track) => (
            <TrackHeader key={track.id} track={track} height={rowHeight} />
          ))}
        </div>
      </div>

      {/* Track content */}
      <div
        ref={contentRef}
        className="flex-1 overflow-hidden relative"
        style={{ background: 'var(--tl-track-bg)' }}
        onClick={handleContentClickGuarded}
        onPointerDown={handleMarqueePointerDown}
        onWheel={handleWheel}
      >
        <div style={{ transform: `translateY(${bottomOffset - scrollY}px)` }}>
          {tracks.map((track) => {
            const isDropTarget =
              dragState?.active && dragState.targetTrackId === track.id && dragState.sourceTrackId !== track.id
            return (
              <div
                key={track.id}
                className="relative"
                style={{
                  height: rowHeight,
                  background: isDropTarget ? 'var(--tl-ghost)' : undefined,
                  transition: 'background 0.1s',
                }}
              >
                <div style={{ transform: `translateX(${-scrollX}px)` }}>
                  <TrackRow
                    track={track}
                    pps={pps}
                    scrollX={scrollX}
                    containerWidth={usableWidth}
                    height={rowHeight}
                    totalDuration={totalDuration}
                    activeTool={activeTool}
                    fps={fps}
                    draggingClipId={dragState?.active && dragState.allClipIds.length <= 1 ? dragState.clipId : null}
                    onClipDragStart={onClipDragStart}
                    onTrimSnap={onTrimSnap}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {/* Drag ghost — always mounted while a drag is in flight so the RAF
            handler can write style.transform directly without waiting for a
            React render. Position (left/transform) is maintained via DOM
            mutation; only track-row changes (top) and visibility (display)
            go through React state (EE). */}
        {(() => {
          if (!dragState) return null
          const tl = getTimeline()
          const clip = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === dragState.clipId)
          if (!clip) return null
          const idx = tracks.findIndex((t) => t.id === dragState.targetTrackId)
          // Single-clip drag only: multi-drag moves the real clip blocks
          // directly (see applyMove), so the placeholder ghost would be a
          // redundant empty box next to them.
          const visible = dragState.active && idx >= 0 && dragState.allClipIds.length <= 1
          return (
            <div
              ref={ghostRef}
              className="absolute pointer-events-none rounded-[2px]"
              style={{
                display: visible ? 'block' : 'none',
                // Horizontal position (left=0 as anchor) is maintained via
                // style.transform written by the RAF handler — no JSX involvement.
                left: 0,
                top: idx >= 0 ? idx * rowHeight + bottomOffset - scrollY + 3 : 0,
                width: clip.duration * pps,
                height: rowHeight - 6,
                background: 'var(--tl-ghost)',
                border: '1px solid var(--tl-ghost-border)',
                willChange: 'transform',
                zIndex: 50,
              }}
            />
          )
        })()}

        {/* Marquee rectangle */}
        {marqueeRect && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
              background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
              border: '1px solid var(--color-accent)',
              zIndex: 60,
            }}
          />
        )}

        {/* Trim snap guide */}
        {trimSnapTime !== null && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: trimSnapTime * pps - scrollX,
              width: 1,
              background: 'var(--tl-snap)',
              opacity: 0.8,
              zIndex: 45,
            }}
          />
        )}

        {/* Drag snap indicator — typed by what we snapped to. */}
        {dragState?.active &&
          dragState.snapTarget &&
          (() => {
            const { time, type } = dragState.snapTarget
            const isDashed = type === 'grid' || type === 'frame'
            const isPlayhead = type === 'playhead'
            const color = isPlayhead ? 'var(--tl-playhead)' : 'var(--tl-snap)'
            const opacity = type === 'frame' ? 0.5 : 0.85
            return (
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: time * pps - scrollX,
                  width: isDashed ? 0 : 1,
                  borderLeft: isDashed ? `1px dashed ${color}` : undefined,
                  background: isDashed ? undefined : color,
                  opacity,
                  zIndex: 46,
                }}
              />
            )
          })()}
      </div>

      {/* Scrollbar with zoom dots */}
      <VerticalScrollbar
        scrollY={scrollY}
        onScrollY={onScrollY}
        contentHeight={totalContentHeight}
        viewHeight={height}
        width={SCROLLBAR_WIDTH}
        rowHeight={rowHeight}
        onRowHeightChange={onRowHeightChange}
      />
    </div>
  )
}
