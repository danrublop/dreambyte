'use client'

import { useCallback, useRef, useState, useMemo, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { useVideoStore } from '@/lib/store'
import type { Clip, Track } from '@/lib/types'
import { CLIP_TRIM_HANDLE_WIDTH, SNAP_THRESHOLD, MIN_CLIP_DURATION } from './constants'
import { findAdjacent, slipTrims, slideEdits } from '@/lib/timeline/clip-edits'
import { collectSnapTargets, findSnap, getTrackClipBounds } from '@/lib/timeline/snap-engine'
import { snapToFrame } from './keyframe-position'
import type { TimelineTool } from './TimelineToolbar'
import { useWaveform } from './useWaveform'
import { useVideoThumbnails } from './useVideoThumbnails'
import { KeyframeOverlay } from './KeyframeMarker'
import { AudioGainRubberBand } from './AudioGainRubberBand'
import { useAudioUrlMap } from './AudioUrlMapContext'
import { Link as LinkIcon } from 'lucide-react'
import { MenuSurface, MenuRow } from '@/components/ui/MenuDropdown'
import { useViewportMenuPosition } from '@/components/ui/useViewportMenuPosition'
import {
  TRANSITION_DRAG_MIME,
  CAMERA_DRAG_MIME,
  applyTransitionToClip,
  applyCameraEffectToClip,
  type TransitionDragPayload,
  type CameraDragPayload,
} from '@/lib/utils/apply-to-clip'

/** NLE-style label colours offered in the clip context menu. `null` = clear
 *  the override and fall back to the sourceType colour. */
const CLIP_LABEL_COLORS: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Rose', value: '#f43f5e' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Sky', value: '#0ea5e9' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Slate', value: '#64748b' },
]

/** Clip color CSS variable names per sourceType */
const CLIP_COLOR_VARS: Record<string, string> = {
  scene: 'var(--tl-clip-video)',
  audio: 'var(--tl-clip-audio)',
  video: 'var(--tl-clip-video)',
  image: 'var(--tl-clip-image)',
  title: 'var(--tl-clip-title)',
  avatar: 'var(--color-accent)',
}

interface Props {
  track: Track
  pps: number
  scrollX: number
  containerWidth: number
  height: number
  totalDuration: number
  activeTool: TimelineTool
  fps?: number
  /** ID of clip currently being dragged (to show ghost opacity) */
  draggingClipId?: string | null
  onClipDragStart?: (clipId: string, trackId: string, e: React.PointerEvent) => void
  /** Called when a trim operation snaps, so parent can render snap guide */
  onTrimSnap?: (time: number | null) => void
}

export default function TrackRow({
  track,
  pps,
  scrollX,
  containerWidth,
  height,
  totalDuration,
  activeTool,
  fps,
  draggingClipId,
  onClipDragStart,
  onTrimSnap,
}: Props) {
  // Selector-per-field instead of `useVideoStore()` so this component only
  // re-renders when a field it actually reads changes. `useVideoStore()` with
  // no selector re-renders the whole TrackRow on *any* store mutation —
  // every chat keystroke, every transport tick. Big perf win on long
  // timelines. Action refs (toggleClipSelection / updateClip / …) are stable
  // in Zustand so subscribing returns the same fn ref and never re-renders.
  const selectedClipIds = useVideoStore((s) => s.selectedClipIds)
  const isAgentRunning = useVideoStore((s) => s.isAgentRunning)
  const updateClip = useVideoStore((s) => s.updateClip)
  const getTimeline = useVideoStore((s) => s.getTimeline)
  const splitClip = useVideoStore((s) => s.splitClip)

  // Viewport virtualization: only mount clip blocks whose [start, end) range
  // intersects the visible window plus a half-viewport margin on each side
  // (so a quick scroll doesn't reveal a blank lane mid-fling). On a 30-minute
  // timeline with hundreds of clips this is the difference between a smooth
  // render and a stalled tab.
  const visibleClips = useMemo(() => {
    if (pps <= 0) return track.clips
    const margin = containerWidth // one viewport on each side
    const viewStartSec = Math.max(0, (scrollX - margin) / pps)
    const viewEndSec = (scrollX + containerWidth + margin) / pps
    return track.clips.filter((c) => c.startTime + c.duration > viewStartSec && c.startTime < viewEndSec)
  }, [track.clips, pps, scrollX, containerWidth])

  return (
    <div
      className="relative"
      style={{
        height,
        minHeight: height,
      }}
    >
      <div className="absolute top-0 bottom-0 left-0" style={{ width: totalDuration * pps }}>
        {visibleClips.map((clip) => (
          <ClipBlock
            key={clip.id}
            clip={clip}
            track={track}
            pps={pps}
            scrollX={scrollX}
            containerWidth={containerWidth}
            height={height}
            activeTool={activeTool}
            fps={fps}
            isDragging={draggingClipId === clip.id}
            isSelected={selectedClipIds.includes(clip.id)}
            isLocked={track.locked || isAgentRunning}
            onUpdate={updateClip}
            onSplit={splitClip}
            getTimeline={getTimeline}
            onDragStart={onClipDragStart}
            onTrimSnap={onTrimSnap}
          />
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════

interface ClipBlockProps {
  clip: Clip
  track: Track
  pps: number
  scrollX: number
  containerWidth: number
  height: number
  activeTool: TimelineTool
  fps?: number
  isDragging: boolean
  isSelected: boolean
  isLocked: boolean
  onUpdate: (clipId: string, updates: Partial<Clip>) => void
  onSplit: (clipId: string, atTime: number) => { leftId: string; rightId: string } | null
  getTimeline: () => import('@/lib/types').Timeline | null
  onDragStart?: (clipId: string, trackId: string, e: React.PointerEvent) => void
  onTrimSnap?: (time: number | null) => void
}

type TrimSide = 'left' | 'right' | null

/** Mirrored waveform path rendered as filled SVG */
const WaveformSVG = memo(function WaveformSVG({ peaks }: { peaks: number[] }) {
  const n = peaks.length
  if (n === 0) return null

  // NLE-style waveform: a single-sided filled area anchored to
  // the BOTTOM of the clip, peaks rising upward (no mirrored bottom half).
  const baseY = 100 // bottom of the viewBox
  const amp = 96 // loudest peaks rise nearly to the top of the clip body
  const xScale = 1000 / n // spread across 1000-wide viewBox

  let d = `M 0 ${baseY}`
  for (let i = 0; i < n; i++) {
    const x = i * xScale
    const y = baseY - peaks[i] * amp
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`
  }
  d += ` L 1000 ${baseY} Z`

  return (
    <svg
      className="absolute"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      // Fill the clip body below the 15px top label bar; the waveform rests on
      // the bottom edge like a typical NLE audio clip.
      style={{
        left: 0,
        right: 0,
        top: 15,
        bottom: 0,
        width: '100%',
        height: 'calc(100% - 15px)',
        pointerEvents: 'none',
      }}
    >
      <path d={d} fill="var(--tl-waveform)" opacity="0.92" />
    </svg>
  )
})

/** DaVinci-style filmstrip: evenly-spaced thumbnails covering the clip width. */
const VideoFilmstrip = memo(function VideoFilmstrip({
  url,
  width,
  height,
  trimStart,
  trimEnd,
}: {
  url: string
  width: number
  height: number
  trimStart: number
  trimEnd: number | null
}) {
  // Approx thumbnail width = height * 16/9 (most footage); cap at 12 frames so we
  // don't hammer the seeker for ultra-wide clips while zoomed in.
  const thumbWidth = Math.max(32, Math.round(height * (16 / 9)))
  const count = Math.max(1, Math.min(12, Math.ceil(width / thumbWidth)))
  // Sample across the visible source range (trim-aware). null trimEnd means
  // "to end of source" — pass through and let the hook clamp to video duration.
  const thumbs = useVideoThumbnails(url, count, trimStart, trimEnd)

  if (thumbs.length === 0) return null
  return (
    <div className="absolute inset-0 flex pointer-events-none" style={{ background: '#000' }}>
      {thumbs.map((src, i) => (
        <div key={i} className="flex-1 min-w-0 bg-cover bg-center" style={{ backgroundImage: `url(${src})` }} />
      ))}
    </div>
  )
})

/** Resolve an audio clip's sourceId to its audio file URL via the precomputed
 *  map provided by Timeline. O(1) lookup. The map is memoized at the
 *  Timeline level on the `scenes` reference, so the walk over scenes /
 *  aiLayers / sfx[] happens once per scenes change instead of once per
 *  render per ClipBlock. See AudioUrlMapContext.ts for the build logic. */
function useAudioUrl(clip: Clip): string | null {
  const map = useAudioUrlMap()
  if (clip.sourceType !== 'audio') return null
  // Standalone clips (dropped files, linked video audio) carry their media
  // URL directly in sourceId — the scene-audio map only knows aud-/tts-/mus-.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clip.sourceId) || clip.sourceId.startsWith('/')) return clip.sourceId
  return map.get(clip.sourceId) ?? null
}

function resolveSceneIdFromClip(
  clip: Clip,
  scenes: ReturnType<typeof useVideoStore.getState>['scenes'],
): string | null {
  if (clip.sourceType === 'scene') return clip.sourceId
  if (clip.sourceType === 'avatar') {
    for (const scene of scenes) {
      if (scene.aiLayers?.some((l) => l.id === clip.sourceId && l.type === 'avatar')) return scene.id
    }
    return null
  }
  if (clip.sourceId.startsWith('aud-') || clip.sourceId.startsWith('tts-') || clip.sourceId.startsWith('mus-')) {
    return clip.sourceId.slice(4)
  }
  if (clip.sourceId.startsWith('avatar-audio:')) {
    const layerId = clip.sourceId.slice('avatar-audio:'.length)
    for (const scene of scenes) {
      if (scene.aiLayers?.some((l) => l.id === layerId && l.type === 'avatar')) return scene.id
    }
    return null
  }
  for (const scene of scenes) {
    if (scene.audioLayer?.sfx?.some((sfx) => sfx.id === clip.sourceId)) return scene.id
  }
  return null
}

const ClipBlock = memo(function ClipBlock({
  clip,
  track,
  pps,
  scrollX,
  containerWidth,
  height,
  activeTool,
  fps = 30,
  isDragging,
  isSelected,
  isLocked,
  onUpdate,
  onSplit,
  getTimeline,
  onDragStart,
  onTrimSnap,
}: ClipBlockProps) {
  const [trimActive, setTrimActive] = useState(false)
  const [hoverSide, setHoverSide] = useState<TrimSide>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dropAccept, setDropAccept] = useState(false)
  const clipRef = useRef<HTMLDivElement>(null)
  // New-clip flash — show a 250ms accent ring on freshly added clips.
  const isJustAdded = useVideoStore((s) => !!s.recentlyAddedClipIds[clip.id])

  useEffect(() => {
    if (!menu) return
    // mousedown is the more reliable dismiss signal than `click` — a slight
    // drag between mousedown/up suppresses the click event entirely and
    // would leave a stale menu open. Skip the close when the mousedown
    // landed INSIDE the portal'd menu (marked with data-clip-context-menu)
    // so a click on a menu item can still dispatch through to its handler
    // before the menu unmounts.
    const closeOnOutsideMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (target?.closest('[data-clip-context-menu]')) return
      setMenu(null)
    }
    // Capture-phase contextmenu — fires BEFORE ClipBlock.handleContextMenu
    // can call stopPropagation, so right-clicking a second clip closes the
    // first menu instead of stacking both open. Previously the bubble-phase
    // listener never saw the new event because of stopPropagation in
    // handleContextMenu.
    const close = () => setMenu(null)
    window.addEventListener('mousedown', closeOnOutsideMouseDown)
    window.addEventListener('contextmenu', close, { capture: true })
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideMouseDown)
      window.removeEventListener('contextmenu', close, { capture: true })
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocked) return
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY })
    },
    [isLocked],
  )

  // Waveform for audio clips (hooks must be called before early returns)
  const audioUrl = useAudioUrl(clip)
  const peaks = useWaveform(audioUrl)

  // Scene clips have no video file to filmstrip, but they carry frames sampled
  // across the scene (filmstrip) plus a still thumbnail fallback — render them
  // across the clip so scene clips read like video clips (frames on the clip)
  // instead of a flat color block. Both selectors return stable refs.
  const sceneFilmstrip = useVideoStore((s) =>
    clip.sourceType === 'scene' ? (s.scenes.find((sc) => sc.id === clip.sourceId)?.filmstrip ?? null) : null,
  )
  const sceneThumbnail = useVideoStore((s) =>
    clip.sourceType === 'scene' ? (s.scenes.find((sc) => sc.id === clip.sourceId)?.thumbnail ?? null) : null,
  )
  // Filmstrip is sparse (slots fill in as the scene plays) — drop empty slots,
  // and fall back to the still thumbnail until at least one frame exists.
  const sceneFrames = (() => {
    const fs = sceneFilmstrip?.filter((f): f is string => !!f) ?? []
    if (fs.length > 0) return fs
    return sceneThumbnail ? [sceneThumbnail] : null
  })()

  const left = clip.startTime * pps
  const width = Math.max(2, clip.duration * pps)

  const color = clip.color ?? CLIP_COLOR_VARS[clip.sourceType] ?? 'var(--tl-clip-video)'
  // Solo: when any track of the same type is soloed, non-soloed tracks of
  // that type are treated as effectively muted (dimmed).
  const isSoloMuted = useVideoStore((s) => {
    const tl = s.project.timeline
    if (!tl) return false
    const anySolo = tl.tracks.some((t) => t.type === track.type && t.solo === true)
    return anySolo && track.solo !== true
  })
  const isMuted = track.muted || isSoloMuted
  const isClipDisabled = clip.enabled === false
  const isClipAudioMuted = clip.audioMuted === true
  const isRazor = activeTool === 'razor'

  // ── Trim ──
  const handleTrimStart = useCallback(
    (side: 'left' | 'right', e: React.PointerEvent) => {
      if (isLocked) return
      e.stopPropagation()
      e.preventDefault()
      setTrimActive(true)
      document.body.style.cursor = 'ew-resize'

      // Get adjacent clip bounds for overlap prevention.
      // Ripple mode bypasses the adjacent-clip clamps because downstream clips
      // will shift out of the way on commit.
      const isRippleTrim = activeTool === 'ripple'
      const isRollingTrim = activeTool === 'rolling'
      const bounds = getTrackClipBounds(track, clip.id)
      const prevClipEnd = isRippleTrim ? 0 : (bounds.filter((b) => b.end <= clip.startTime + 0.001).pop()?.end ?? 0)
      const nextClipStart = isRippleTrim
        ? Infinity
        : (bounds.find((b) => b.start >= clip.startTime + clip.duration - 0.001)?.start ?? Infinity)

      // Rolling: locate the adjacent clip on the same track that shares the
      // edit point so we can apply the inverse delta to it.
      const adjacentClip = isRollingTrim
        ? (() => {
            if (side === 'right') {
              const next = track.clips.find(
                (c) => c.id !== clip.id && Math.abs(c.startTime - (clip.startTime + clip.duration)) < 0.001,
              )
              return next ?? null
            }
            const prev = track.clips.find(
              (c) => c.id !== clip.id && Math.abs(c.startTime + c.duration - clip.startTime) < 0.001,
            )
            return prev ?? null
          })()
        : null

      const frameSnap = pps >= fps
      const viewStart = scrollX / pps
      const viewEnd = (scrollX + containerWidth) / pps
      const snapEnabled = useVideoStore.getState().timelineSnapEnabled
      // Read the playhead lazily from the store at drag-start so we don't
      // need `currentTime` as a prop. Keeping it off props is what lets the
      // ClipBlock memo short-circuit during playback (transport ticks ~60Hz
      // would otherwise bust the memo on every visible clip).
      const currentTime = useVideoStore.getState().timelineTransport.globalTime
      const snapTargets = snapEnabled
        ? collectSnapTargets(getTimeline(), currentTime, clip.id, {
            fps,
            frameSnap,
            viewStart,
            viewEnd,
          })
        : []

      // RAF-coalesce trim moves: every pointermove triggers onUpdate which
      // re-renders the whole timeline tree. Without throttling, trim feels
      // sticky on long timelines.
      let pendingEv: PointerEvent | null = null
      let rafId: number | null = null
      const computeTrim = (ev: PointerEvent) => {
        const deltaTime = (ev.clientX - e.clientX) / pps

        if (side === 'left') {
          const proposed = clip.startTime + deltaTime
          const hit = findSnap(proposed, pps, SNAP_THRESHOLD, snapTargets)
          // Clamp: can't go before previous clip end, can't make duration < min
          let newStart = Math.max(prevClipEnd, hit.time)
          newStart = Math.min(clip.startTime + clip.duration - MIN_CLIP_DURATION, newStart)
          // Rolling: the new edit point can't go before adjacent.startTime + MIN
          // (otherwise the previous clip would be shorter than minimum).
          if (isRollingTrim && adjacentClip) {
            newStart = Math.max(adjacentClip.startTime + MIN_CLIP_DURATION, newStart)
          }
          const shift = newStart - clip.startTime
          const newDuration = clip.duration - shift
          const newTrimStart = Math.max(0, clip.trimStart + shift * clip.speed)
          onUpdate(clip.id, { startTime: newStart, duration: newDuration, trimStart: newTrimStart })
          // Rolling: extend the previous clip's right edge into the gap by the same delta.
          if (isRollingTrim && adjacentClip) {
            const prevNewDuration = newStart - adjacentClip.startTime
            const prevSpeed = adjacentClip.speed || 1
            const prevNewTrimEnd = adjacentClip.trimStart + prevNewDuration * prevSpeed
            onUpdate(adjacentClip.id, { duration: prevNewDuration, trimEnd: prevNewTrimEnd })
          }
          // Only report a snap when the clamp didn't override the snap target.
          onTrimSnap?.(hit.target && Math.abs(newStart - hit.time) < 0.001 ? newStart : null)
        } else {
          const proposed = clip.startTime + clip.duration + deltaTime
          const hit = findSnap(proposed, pps, SNAP_THRESHOLD, snapTargets)
          let newEnd = Math.min(nextClipStart, hit.time)
          newEnd = Math.max(clip.startTime + MIN_CLIP_DURATION, newEnd)
          // Rolling: clamp so the next clip can't shrink below the minimum.
          if (isRollingTrim && adjacentClip) {
            const adjacentEnd = adjacentClip.startTime + adjacentClip.duration
            newEnd = Math.min(adjacentEnd - MIN_CLIP_DURATION, newEnd)
          }
          const newDuration = newEnd - clip.startTime
          const newTrimEnd = clip.trimStart + newDuration * clip.speed
          onUpdate(clip.id, { duration: newDuration, trimEnd: newTrimEnd })
          // Rolling: shift the next clip's start (and trim head) by the same delta.
          if (isRollingTrim && adjacentClip) {
            const nextSpeed = adjacentClip.speed || 1
            const oldAdjacentEnd = adjacentClip.startTime + adjacentClip.duration
            const nextNewStart = newEnd
            const nextNewDuration = oldAdjacentEnd - nextNewStart
            const adjacentShift = nextNewStart - adjacentClip.startTime
            const nextNewTrimStart = Math.max(0, adjacentClip.trimStart + adjacentShift * nextSpeed)
            onUpdate(adjacentClip.id, {
              startTime: nextNewStart,
              duration: nextNewDuration,
              trimStart: nextNewTrimStart,
            })
          }
          onTrimSnap?.(hit.target && Math.abs(newEnd - hit.time) < 0.001 ? newEnd : null)
        }
      }
      const applyMove = () => {
        rafId = null
        const ev = pendingEv
        pendingEv = null
        if (ev) computeTrim(ev)
      }
      const handleMove = (ev: PointerEvent) => {
        pendingEv = ev
        if (rafId !== null) return
        rafId = requestAnimationFrame(applyMove)
      }

      // Capture tool at trim-start; ripple semantics shift downstream on commit.
      const rippleAtStart = activeTool === 'ripple'
      const originalEnd = clip.startTime + clip.duration

      const handleUp = () => {
        // Cancel any pending RAF and flush the last move so the commit reads
        // the final pointer position.
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        if (pendingEv) applyMove()
        setTrimActive(false)
        document.body.style.cursor = ''
        onTrimSnap?.(null)

        // Frame-snap on commit: round only the EDGE the user actually
        // dragged so a left-edge trim never silently nudges the right
        // edge (and vice versa). Honors the snap toggle.
        if (snapEnabled) {
          const tl = useVideoStore.getState().project.timeline
          const finalClip = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)
          if (finalClip) {
            if (side === 'right') {
              const snappedEnd = snapToFrame(finalClip.startTime + finalClip.duration, fps)
              const snappedDuration = Math.max(MIN_CLIP_DURATION, snappedEnd - finalClip.startTime)
              if (snappedDuration !== finalClip.duration) {
                useVideoStore.getState().updateClip(clip.id, { duration: snappedDuration })
              }
            } else {
              const snappedStart = snapToFrame(finalClip.startTime, fps)
              // Keep the right edge fixed: adjust duration so end stays put.
              const oldEnd = finalClip.startTime + finalClip.duration
              const snappedDuration = Math.max(MIN_CLIP_DURATION, oldEnd - snappedStart)
              if (snappedStart !== finalClip.startTime) {
                useVideoStore.getState().updateClip(clip.id, {
                  startTime: snappedStart,
                  duration: snappedDuration,
                })
              }
            }
          }
        }

        // Write-through: right-edge trim on a scene clip writes back to scene.duration
        // so the source of truth stays in sync with the visual clip length.
        if (side === 'right' && clip.sourceType === 'scene') {
          const finalClip = useVideoStore
            .getState()
            .project.timeline?.tracks.flatMap((t) => t.clips)
            .find((c) => c.id === clip.id)
          if (!finalClip) {
            console.warn('[TrackRow] trim write-through skipped — clip not found (branch switch during trim?)')
            window.removeEventListener('pointermove', handleMove)
            window.removeEventListener('pointerup', handleUp)
            return
          }
          if (finalClip.sourceType === 'scene') {
            useVideoStore.getState().updateScene(finalClip.sourceId, { duration: finalClip.duration })
          }
        }

        // Ripple-trim: shift downstream clips on the same track by the
        // (new end − old end) delta. Only meaningful on right-edge trim
        // because Dreambyte's left-edge trim is "trim-in-place" (the right edge
        // stays put), so downstream doesn't need to move.
        if (rippleAtStart && side === 'right') {
          const tl = useVideoStore.getState().project.timeline
          const finalClip = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)
          const finalTrack = tl?.tracks.find((t) => t.id === clip.trackId)
          if (finalClip && finalTrack) {
            const finalEnd = finalClip.startTime + finalClip.duration
            const delta = finalEnd - originalEnd
            if (Math.abs(delta) > 0.0001) {
              // Pin anchor at the original edit point so we don't reshift clips that
              // already moved as part of the trim (the trimmed clip itself).
              const batch: Array<{ id: string; updates: Partial<Clip> }> = []
              for (const c of finalTrack.clips) {
                if (c.id === finalClip.id) continue
                if (c.startTime + 0.0001 >= originalEnd) {
                  batch.push({ id: c.id, updates: { startTime: Math.max(0, c.startTime + delta) } })
                }
              }
              if (batch.length > 0) useVideoStore.getState().batchUpdateClips(batch)
            }
          }
        }

        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    // `currentTime` is intentionally NOT in deps — handler reads it lazily
    // via `useVideoStore.getState()` at drag-start so the memo stays warm.
    [clip, track, pps, isLocked, getTimeline, onUpdate, onTrimSnap],
  )

  // ── Hover detection ──
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (trimActive || isLocked || isRazor) return
      const rect = clipRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      if (x < CLIP_TRIM_HANDLE_WIDTH) setHoverSide('left')
      else if (x > rect.width - CLIP_TRIM_HANDLE_WIDTH) setHoverSide('right')
      else setHoverSide(null)
    },
    [trimActive, isLocked, isRazor],
  )

  // ── Click ──
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isLocked) return
      if (isRazor) {
        // Razor: split at click position. Refuse splits within 4px of the
        // edges (≈ trim-handle width) so the user doesn't get a zero-duration
        // half on accidental edge clicks.
        const rect = clipRef.current?.getBoundingClientRect()
        if (!rect) return
        const clickX = e.clientX - rect.left
        const edgePadding = Math.max(4 / pps, 0.01)
        const relTime = clickX / pps
        if (relTime > edgePadding && relTime < clip.duration - edgePadding) {
          onSplit(clip.id, relTime)
        }
        return
      }
      if (activeTool === 'ripple') {
        // Ripple-edit tool: click a clip → remove it AND close the gap by
        // shifting later clips left. Replaces the Shift+Del shortcut for
        // mouse-driven flows.
        useVideoStore.getState().removeClipRipple(clip.id)
        return
      }
      // Keep the preview/inspector in sync with the clicked clip (select its
      // scene), but do NOT yank the right panel into "properties" — that jump is
      // double-click only. The clip SELECTION itself (single / shift-multi /
      // collapse-to-one / select-on-grab) is handled entirely on pointer-down/up
      // by the selection-on-grab path in Timeline's handleClipDragStart. Doing
      // it here too would double-fire and cancel out shift-toggles.
      const { scenes, selectScene } = useVideoStore.getState()
      const relatedSceneId = resolveSceneIdFromClip(clip, scenes)
      if (relatedSceneId) selectScene(relatedSceneId)
    },
    [clip, pps, isLocked, isRazor, activeTool, onSplit],
  )

  // Double-click a clip → open its layer's property editor in the left
  // panel's Layer tab (the same Transform/Blending panel a click on the
  // layer-stack row opens). Media scenes route to their media layer
  // ('video' / 'ai:<id>'); authored scenes route to the scene row.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const st = useVideoStore.getState()
      // Audio clips open audio settings: scene-mirror clips (tts/music/sfx)
      // route to their owner scene's Audio inspector; standalone clips
      // (dropped files) get the clip-level inspector.
      if (clip.sourceType === 'audio') {
        const ownerSceneId = resolveSceneIdFromClip(clip, st.scenes)
        if (ownerSceneId) {
          st.selectScene(ownerSceneId)
          st.openLayerStackProperties('audio')
        } else {
          st.setSelectedClipIds([clip.id])
          st.openLayerStackProperties(`clip:${clip.id}`)
        }
        return
      }
      // Text-overlay clips → open that overlay's form in the layer stack.
      if (clip.linkGroupId?.startsWith('text:')) {
        const overlayId = clip.linkGroupId.slice('text:'.length)
        const ownerScene = st.scenes.find((s) => (s.textOverlays ?? []).some((t) => t.id === overlayId))
        if (ownerScene) {
          st.selectScene(ownerScene.id)
          st.openLayerStackProperties(`text:${overlayId}`)
        }
        return
      }
      // Standalone video/image clips (dropped media files) have no scene to host
      // their properties → open the clip-level inspector (opacity + color grade).
      if (clip.sourceType === 'video' || clip.sourceType === 'image') {
        st.setSelectedClipIds([clip.id])
        st.openLayerStackProperties(`clip:${clip.id}`)
        return
      }
      if (clip.sourceType !== 'scene') return
      const scene = st.scenes.find((s) => s.id === clip.sourceId)
      if (!scene) return
      st.selectScene(scene.id)
      const firstImage = (scene.aiLayers ?? []).find((l) => l.type === 'image')
      const key =
        scene.videoLayer?.enabled && scene.videoLayer.src
          ? 'video'
          : firstImage
            ? `ai:${firstImage.id}`
            : `scene:${scene.id}`
      st.openLayerStackProperties(key)
    },
    [clip],
  )

  // ── Accept dropped transition/effect cards from the right panel ──
  const acceptsDrop = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TRANSITION_DRAG_MIME) || e.dataTransfer.types.includes(CAMERA_DRAG_MIME)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!acceptsDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropAccept(true)
  }, [])

  const handleDragLeave = useCallback(() => setDropAccept(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!acceptsDrop(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDropAccept(false)
      try {
        const tRaw = e.dataTransfer.getData(TRANSITION_DRAG_MIME)
        if (tRaw) {
          const p = JSON.parse(tRaw) as TransitionDragPayload
          applyTransitionToClip(clip.id, p.id)
          return
        }
        const cRaw = e.dataTransfer.getData(CAMERA_DRAG_MIME)
        if (cRaw) {
          const p = JSON.parse(cRaw) as CameraDragPayload
          applyCameraEffectToClip(clip.id, p.id)
        }
      } catch {
        /* ignore malformed payload */
      }
    },
    [clip.id],
  )

  // ── Pointer down (trim or drag) ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (isLocked || isRazor) return
      const rect = clipRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const onLeftHandle = x < CLIP_TRIM_HANDLE_WIDTH
      const onRightHandle = x > rect.width - CLIP_TRIM_HANDLE_WIDTH
      // Ripple tool: handle drag = ripple trim, body click = ripple delete.
      if (activeTool === 'ripple') {
        if (onLeftHandle) {
          handleTrimStart('left', e)
          return
        }
        if (onRightHandle) {
          handleTrimStart('right', e)
          return
        }
        return
      }
      // Standard trim handles (select tool and others that aren't slip/ripple).
      if (activeTool !== 'slip') {
        if (onLeftHandle) {
          handleTrimStart('left', e)
          return
        }
        if (onRightHandle) {
          handleTrimStart('right', e)
          return
        }
      }
      // Rolling tool only works on edit points (handles). Clicking the body
      // is a no-op so the user doesn't accidentally start a move drag.
      if (activeTool === 'rolling') {
        e.preventDefault()
        return
      }
      // Slide tool: body drag shifts THIS clip's startTime; neighbors absorb
      // the change by trimming so the sequence duration stays constant.
      // Source content of the slid clip is unchanged (trimStart / trimEnd
      // / duration all stay).
      if (activeTool === 'slide') {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const origStart = clip.startTime

        // Neighbors that share an edit point with this clip (one definition of
        // "adjacent", shared with the reducer via clip-edits.findAdjacent).
        const prevAdj = findAdjacent(track.clips, clip, 'prev')
        const nextAdj = findAdjacent(track.clips, clip, 'next')

        // Hard clamp on slide range: can't push prev below MIN, can't push next below MIN.
        const minStart = prevAdj ? prevAdj.startTime + MIN_CLIP_DURATION : 0
        const maxStart = nextAdj ? nextAdj.startTime + nextAdj.duration - clip.duration - MIN_CLIP_DURATION : Infinity

        document.body.style.cursor = 'ew-resize'
        // RAF-throttled to keep slide-tool drag at 60fps on long timelines.
        let pendingEv: PointerEvent | null = null
        let rafId: number | null = null
        const apply = () => {
          rafId = null
          const ev = pendingEv
          pendingEv = null
          if (!ev) return
          const dt = (ev.clientX - startX) / pps
          const proposed = Math.max(minStart, Math.min(maxStart, origStart + dt))
          const delta = proposed - origStart
          // Same geometry the reducer commits (clip-edits.slideEdits), applied
          // as a live preview. Pass the clip at its ORIGINAL position — its
          // startTime is mutated each frame, so reading it live would drift.
          for (const e of slideEdits({ ...clip, startTime: origStart }, prevAdj, nextAdj, delta)) {
            const { clipId: id, ...rest } = e
            onUpdate(id, rest)
          }
        }
        const onMove = (ev: PointerEvent) => {
          pendingEv = ev
          if (rafId !== null) return
          rafId = requestAnimationFrame(apply)
        }
        const onUp = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
          if (pendingEv) apply()
          document.body.style.cursor = ''
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          // Commit through clip/slide for one clean undo step. The per-RAF preview
          // mutated this clip + both neighbors directly; reset all three to their
          // drag-start values, then dispatch the net slide delta so the reducer
          // recomputes the neighbor trims and records a single inverse.
          const finalClip = getTimeline()
            ?.tracks.flatMap((t) => t.clips)
            .find((c) => c.id === clip.id)
          if (!finalClip) return
          const delta = finalClip.startTime - origStart
          if (Math.abs(delta) < 1e-6) return
          onUpdate(clip.id, { startTime: origStart })
          if (prevAdj) onUpdate(prevAdj.id, { duration: prevAdj.duration, trimEnd: prevAdj.trimEnd })
          if (nextAdj) {
            onUpdate(nextAdj.id, {
              startTime: nextAdj.startTime,
              duration: nextAdj.duration,
              trimStart: nextAdj.trimStart,
            })
          }
          useVideoStore
            .getState()
            .dispatchAction({ type: 'clip/slide', params: { clipId: clip.id, delta } }, { source: 'user' })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return
      }
      // Slip tool: whole clip is a slip area; ignore the handles so the user
      // doesn't accidentally trim while in slip mode (standard NLE shortcut).
      if (activeTool === 'slip') {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startTrimStart = clip.trimStart
        const startTrimEnd = clip.trimEnd
        const speed = clip.speed || 1
        document.body.style.cursor = 'col-resize'
        // RAF-throttled to coalesce trim updates within a frame.
        let pendingEv: PointerEvent | null = null
        let rafId: number | null = null
        const apply = () => {
          rafId = null
          const ev = pendingEv
          pendingEv = null
          if (!ev) return
          const dt = (ev.clientX - startX) / pps
          // Dragging right = peek earlier source content. Same geometry the
          // reducer commits (clip-edits.slipTrims) so preview == commit.
          const sourceDelta = -dt * speed
          const { trimStart, trimEnd } = slipTrims({ trimStart: startTrimStart, trimEnd: startTrimEnd }, sourceDelta)
          onUpdate(clip.id, { trimStart, trimEnd })
        }
        const onMove = (ev: PointerEvent) => {
          pendingEv = ev
          if (rafId !== null) return
          rafId = requestAnimationFrame(apply)
        }
        const onUp = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
          if (pendingEv) apply()
          document.body.style.cursor = ''
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          // Commit through the reducer for clean undo + linked-aware slip. The
          // per-RAF preview mutated only THIS clip's trim (updateClip doesn't
          // propagate trim to linked siblings, so a linked A/V pair wouldn't slip
          // together). Reset this clip to its drag-start trim, then dispatch one
          // clip/slip with the net source delta — the reducer slips the whole
          // link group atomically and records a single undo step.
          const finalClip = getTimeline()
            ?.tracks.flatMap((t) => t.clips)
            .find((c) => c.id === clip.id)
          if (!finalClip) return
          const sourceDelta = finalClip.trimStart - startTrimStart
          if (Math.abs(sourceDelta) < 1e-6) return
          onUpdate(clip.id, { trimStart: startTrimStart, trimEnd: startTrimEnd })
          useVideoStore
            .getState()
            .dispatchAction(
              { type: 'clip/slip', params: { clipId: clip.id, sourceDelta, linked: !!clip.linkGroupId } },
              { source: 'user' },
            )
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return
      }
      if (onDragStart) {
        onDragStart(clip.id, track.id, e)
      }
    },
    [clip, track.id, isLocked, isRazor, activeTool, handleTrimStart, onDragStart, onUpdate, pps],
  )

  // Cursor logic
  let cursor: string
  if (isRazor) cursor = 'crosshair'
  else if (activeTool === 'ripple')
    cursor = 'not-allowed' // ripple = click to delete; "not-allowed" reads as "click and this goes"
  else if (activeTool === 'slip') cursor = 'col-resize'
  else if (activeTool === 'slide') cursor = 'ew-resize'
  else if (hoverSide) cursor = 'ew-resize'
  else if (isLocked) cursor = 'default'
  else cursor = 'grab'

  // Opacity: fade when being dragged
  let opacity = isMuted ? 0.5 : 1
  if (isDragging) opacity = 0.3

  // (Viewport culling is owned by TrackRow's `visibleClips` useMemo — we only
  // see clips that intersect the visible window, so an inner cull is dead
  // code and a stale scrollX dependency we don't need here.)

  return (
    <div
      ref={clipRef}
      data-clip={clip.id}
      className="absolute overflow-hidden"
      style={{
        left,
        width,
        top: 3,
        bottom: 3,
        background: isClipDisabled ? `repeating-linear-gradient(135deg, ${color}aa 0 6px, ${color}55 6px 12px)` : color,
        border: dropAccept
          ? '2px solid var(--color-accent)'
          : trimActive
            ? '2px solid var(--tl-snap)'
            : '1px solid var(--tl-clip-border)',
        // Selection ring = Signal Blue (docs/EDITOR-DESIGN.md §2.5/§12.8), as a
        // box-shadow so it adds no layout shift and reads in BOTH themes. The
        // old `1px solid #fff` selected border was invisible on light clips in
        // light mode. Every selected clip (incl. the others in a multi-drag)
        // now shows the same accent ring.
        boxShadow: isSelected || isJustAdded ? '0 0 0 2px var(--accent)' : undefined,
        cursor,
        opacity: isMuted || isClipDisabled ? 0.4 : isClipAudioMuted ? 0.6 : opacity,
        transition: isDragging
          ? 'opacity 0.15s'
          : isJustAdded
            ? 'box-shadow 0.25s ease-out, border-color 0.1s'
            : 'box-shadow 0.12s ease-out, border-color 0.1s',
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverSide(null)}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {menu && (
        <ClipContextMenu
          x={menu.x}
          y={menu.y}
          clipId={clip.id}
          clip={clip}
          onClose={() => setMenu(null)}
          onSplit={() => {
            // Read the playhead lazily — the menu is only open momentarily,
            // and keeping `currentTime` off ClipBlock's props is what lets
            // the memo short-circuit during playback.
            const ct = useVideoStore.getState().timelineTransport.globalTime
            const tl = getTimeline()
            const c = tl?.tracks.flatMap((t) => t.clips).find((cc) => cc.id === clip.id)
            if (!c) return
            const rel = ct - c.startTime
            if (rel > 0.01 && rel < c.duration - 0.01) onSplit(clip.id, rel)
          }}
        />
      )}
      {/* Left trim handle */}
      {(hoverSide === 'left' || trimActive) && !isRazor && (
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: CLIP_TRIM_HANDLE_WIDTH,
            background: hoverSide === 'left' || trimActive ? '#ffffff33' : 'transparent',
            borderRight: '1px solid #fff6',
          }}
        />
      )}
      {/* Right trim handle */}
      {(hoverSide === 'right' || trimActive) && !isRazor && (
        <div
          className="absolute right-0 top-0 bottom-0"
          style={{
            width: CLIP_TRIM_HANDLE_WIDTH,
            background: hoverSide === 'right' || trimActive ? '#ffffff33' : 'transparent',
            borderLeft: '1px solid #fff6',
          }}
        />
      )}

      {/* Filmstrip preview for video clips (DaVinci-style) */}
      {clip.sourceType === 'video' && (
        <VideoFilmstrip
          url={clip.sourceId}
          width={width}
          height={height}
          trimStart={clip.trimStart}
          trimEnd={clip.trimEnd}
        />
      )}

      {/* Scene clips: lay sampled frames across the clip like a video filmstrip.
          Tiles map evenly onto the sampled frames so a wide clip shows each
          frame in order (and repeats to fill), a narrow one shows the first. */}
      {clip.sourceType === 'scene' &&
        sceneFrames &&
        (() => {
          const tiles = Math.max(1, Math.min(14, Math.round(width / Math.max(48, height * (16 / 9)))))
          return (
            <div className="absolute inset-0 flex pointer-events-none">
              {Array.from({ length: tiles }).map((_, i) => {
                const frame =
                  sceneFrames[Math.min(sceneFrames.length - 1, Math.floor((i / tiles) * sceneFrames.length))]
                return (
                  <div
                    key={i}
                    className="flex-1 min-w-0 bg-cover bg-center"
                    style={{ backgroundImage: `url(${frame})`, boxShadow: 'inset -1px 0 0 rgba(0,0,0,0.25)' }}
                  />
                )
              })}
            </div>
          )
        })()}

      {/* Waveform for audio clips */}
      {clip.sourceType === 'audio' && peaks.length > 0 && <WaveformSVG peaks={peaks} />}

      {/* Link indicator: small chain glyph on linked clips. Hidden on tiny clips. */}
      {clip.linkGroupId && width > 26 && (
        <span
          className="absolute z-10 flex items-center"
          style={{ top: 4, left: 4, color: 'var(--color-accent)', pointerEvents: 'none' }}
          aria-label="Linked clip"
        >
          <LinkIcon size={9} />
        </span>
      )}

      {/* Group indicator: dashed top stripe so the user sees the clip is in a group. */}
      {clip.groupId && (
        <span
          className="absolute z-10 pointer-events-none"
          style={{
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: 'repeating-linear-gradient(90deg, var(--color-accent) 0 4px, transparent 4px 8px)',
          }}
          aria-label="Grouped clip"
        />
      )}

      {/* Clip label — top header bar (NLE style), same for every clip
          type so audio and video read identically. Square corners; the bar is a
          subtle dark strip so the name stays legible over filmstrip/waveform. */}
      {width > 30 && (
        <span
          className="absolute top-0 left-0 right-0 z-10 truncate"
          style={{
            height: 15,
            lineHeight: '15px',
            padding: '0 6px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tl-clip-label)',
            background: 'rgba(0, 0, 0, 0.32)',
            pointerEvents: 'none',
          }}
        >
          {clip.label}
        </span>
      )}

      {/* Keyframe diamonds overlay. Renders one per keyframe at time × pps. */}
      <KeyframeOverlay clip={clip} pixelsPerSecond={pps} height={height} locked={isLocked} />
      {clip.sourceType === 'audio' && (
        <AudioGainRubberBand clip={clip} pixelsPerSecond={pps} height={height} locked={isLocked} />
      )}

      {/* Effect indicator pills — only shown when clip has non-default effects */}
      {width > 60 &&
        (() => {
          const hasOpacity = (clip.opacity ?? 1) < 1
          const hasFade = clip.transition?.type === 'fade'
          const hasFilters = (clip.filters?.length ?? 0) > 0
          if (!hasOpacity && !hasFade && !hasFilters) return null
          return (
            <span
              className="absolute z-10 flex gap-[2px] items-center"
              style={{ right: 5, top: 4, pointerEvents: 'none' }}
            >
              {hasOpacity && (
                <span style={{ width: 5, height: 5, borderRadius: 1, background: '#f59e0b' }} title="Opacity" />
              )}
              {hasFade && (
                <span style={{ width: 5, height: 5, borderRadius: 1, background: '#60a5fa' }} title="Fade transition" />
              )}
              {hasFilters && (
                <span style={{ width: 5, height: 5, borderRadius: 1, background: '#a78bfa' }} title="Filters" />
              )}
            </span>
          )
        })()}
    </div>
  )
})

// ═══════════════════════════════════════════════════════════════════
// ClipContextMenu — small fixed-position menu rendered on right-click
// ═══════════════════════════════════════════════════════════════════

function ClipContextMenu({
  x,
  y,
  clipId,
  clip,
  onClose,
  onSplit,
}: {
  x: number
  y: number
  clipId: string
  /** Full clip — used to read the current value of properties when adding a keyframe at the playhead. */
  clip: Clip
  onClose: () => void
  onSplit: () => void
}) {
  // Subscribe directly to the playhead inside the menu so `playheadInClip`
  // updates live while the menu is open without making ClipBlock take
  // `currentTime` as a prop (which would bust ClipBlock's memo every
  // transport tick — see review item K).
  const currentTime = useVideoStore((s) => s.timelineTransport.globalTime)

  const { ref: menuRef, style: menuPosStyle, maxHeight: menuMaxHeight } = useViewportMenuPosition(x, y)

  const canSplit = (() => {
    const rel = currentTime - clip.startTime
    return rel > 0.01 && rel < clip.duration - 0.01
  })()
  const removeClip = useVideoStore((s) => s.removeClip)
  const removeClipRipple = useVideoStore((s) => s.removeClipRipple)
  const dispatchAction = useVideoStore((s) => s.dispatchAction)
  const unlinkGroup = useVideoStore((s) => s.unlinkGroup)
  const linkClips = useVideoStore((s) => s.linkClips)
  const groupClips = useVideoStore((s) => s.groupClips)
  const ungroupClip = useVideoStore((s) => s.ungroupClip)
  const updateClip = useVideoStore((s) => s.updateClip)
  const selectedClipIds = useVideoStore((s) => s.selectedClipIds)
  const isLinked = !!clip.linkGroupId
  const isGrouped = !!clip.groupId
  const canLink = !isLinked && selectedClipIds.length >= 2 && selectedClipIds.includes(clip.id)
  const canGroup = !isGrouped && selectedClipIds.length >= 2 && selectedClipIds.includes(clip.id)
  const isEnabled = clip.enabled !== false
  const isAudioClip = clip.sourceType === 'audio'
  const isAudioMuted = clip.audioMuted === true
  const currentGainDb = (() => {
    const g = clip.audioGain ?? 1
    if (g <= 0) return -Infinity
    return 20 * Math.log10(g)
  })()

  // Build the playhead-keyframe payload once; only enabled when the
  // playhead is inside the clip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playheadInClip = currentTime >= clip.startTime && currentTime <= clip.startTime + clip.duration
  const clipRelativeTime = currentTime - clip.startTime

  type AnimProp = 'opacity' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'gain'
  const propValueGetters: Record<AnimProp, () => number> = {
    opacity: () => clip.opacity,
    x: () => clip.position.x,
    y: () => clip.position.y,
    scaleX: () => clip.scale.x,
    scaleY: () => clip.scale.y,
    rotation: () => clip.rotation,
    gain: () => clip.audioGain ?? 1,
  }
  function addKeyframe(property: AnimProp) {
    if (!playheadInClip) return
    dispatchAction(
      {
        type: 'keyframe/add',
        params: {
          clipId,
          keyframe: {
            time: Math.max(0, Math.min(clip.duration, clipRelativeTime)),
            property,
            value: propValueGetters[property](),
            easing: 'linear',
          },
        },
      },
      { source: 'user' },
    )
  }

  const items: {
    label: string
    hint?: string
    disabled?: boolean
    onClick: () => void
    divider?: boolean
    /** Explicit, not inferred from the label — a `/delete/i` regex would
     *  silently mis-style any future item whose label merely mentions delete. */
    destructive?: boolean
  }[] = [
    {
      label: 'Split at playhead',
      hint: 'S',
      disabled: !canSplit,
      onClick: () => {
        onSplit()
        onClose()
      },
    },
    {
      label: isLinked ? 'Delete (incl. linked)' : 'Delete',
      hint: '⌫',
      destructive: true,
      onClick: () => {
        removeClip(clipId)
        onClose()
      },
    },
    {
      label: 'Ripple delete',
      hint: '⇧⌫',
      destructive: true,
      onClick: () => {
        removeClipRipple(clipId)
        onClose()
      },
    },
    {
      label: 'Unlink',
      disabled: !isLinked,
      onClick: () => {
        unlinkGroup(clipId)
        onClose()
      },
    },
    {
      label: 'Link selected clips',
      disabled: !canLink,
      onClick: () => {
        linkClips(selectedClipIds)
        onClose()
      },
    },
    {
      label: 'Group selected clips',
      hint: '⌘G',
      disabled: !canGroup,
      onClick: () => {
        groupClips(selectedClipIds)
        onClose()
      },
    },
    {
      label: 'Ungroup',
      hint: '⌘⇧G',
      disabled: !isGrouped,
      onClick: () => {
        ungroupClip(clipId)
        onClose()
      },
    },
    {
      label: isEnabled ? 'Disable clip' : 'Enable clip',
      hint: 'E',
      onClick: () => {
        updateClip(clipId, { enabled: !isEnabled })
        onClose()
      },
    },
    {
      label: `Speed… (${(clip.speed * 100).toFixed(0)}%)`,
      onClick: () => {
        const raw = window.prompt('Clip speed (%):', String((clip.speed * 100).toFixed(0)))
        if (raw == null) {
          onClose()
          return
        }
        const pct = parseFloat(raw)
        if (!Number.isFinite(pct) || pct <= 0) {
          onClose()
          return
        }
        const newSpeed = pct / 100
        // Recompute duration so the source content end-point stays in sync.
        // For trimEnd!=null the consumed source range is fixed; new duration
        // = (trimEnd - trimStart) / newSpeed. For open-ended we just keep
        // duration and let the new speed change how much source plays.
        const sourceRange = clip.trimEnd != null ? clip.trimEnd - clip.trimStart : clip.duration * clip.speed
        const newDuration = Math.max(0.05, sourceRange / newSpeed)
        updateClip(clipId, { speed: newSpeed, duration: newDuration })
        onClose()
      },
    },
    ...(isAudioClip
      ? ([
          {
            label: isAudioMuted ? 'Unmute' : 'Mute',
            hint: 'M',
            onClick: () => {
              updateClip(clipId, { audioMuted: !isAudioMuted })
              onClose()
            },
          },
          {
            label: `Audio gain… (${Number.isFinite(currentGainDb) ? currentGainDb.toFixed(1) : '-∞'} dB)`,
            onClick: () => {
              const raw = window.prompt(
                'Set audio gain (dB):',
                Number.isFinite(currentGainDb) ? currentGainDb.toFixed(1) : '0',
              )
              if (raw == null) {
                onClose()
                return
              }
              const db = parseFloat(raw)
              if (Number.isNaN(db)) {
                onClose()
                return
              }
              const gain = Math.pow(10, db / 20)
              updateClip(clipId, { audioGain: gain })
              onClose()
            },
          },
        ] as typeof items)
      : []),
    // ── Keyframe shortcuts ───────────────────────────────────────────
    { label: '— Keyframe at playhead —', divider: true, disabled: true, onClick: () => {} },
    ...(
      [
        ['opacity', 'Add opacity keyframe'],
        ['x', 'Add X position keyframe'],
        ['y', 'Add Y position keyframe'],
        ['rotation', 'Add rotation keyframe'],
        ...((isAudioClip ? [['gain', 'Add audio gain keyframe']] : []) as Array<[AnimProp, string]>),
      ] as Array<[AnimProp, string]>
    ).map(([prop, label]) => ({
      label,
      disabled: !playheadInClip,
      onClick: () => {
        addKeyframe(prop)
        onClose()
      },
    })),
  ]

  // Portal to document.body — the clip's container has overflow:hidden, so
  // rendering the menu inline clipped it near the viewport edges. Position
  // is `fixed` with cursor coords, so the portal placement is identical.
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Clip actions"
      // Marker attribute so the global mousedown-close listener can detect
      // clicks landing inside this menu and skip the close (otherwise the
      // close fires before the item's <button> click can dispatch).
      data-clip-context-menu
      className="fixed z-[1000]"
      style={menuPosStyle}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuSurface
        className="min-w-[180px]"
        // This menu is taller than a short window; scroll inside it rather than
        // letting the bottom items fall off-screen.
        style={{ maxHeight: menuMaxHeight, overflowY: 'auto' }}
      >
        <div style={{ padding: 4 }}>
          <div
            style={{
              padding: '4px 8px 2px',
              fontSize: 11,
              fontWeight: 450,
              lineHeight: 1,
              color: 'var(--color-text-muted)',
            }}
          >
            Label colour
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', padding: '2px 8px 6px' }}>
            {CLIP_LABEL_COLORS.map((c) => {
              const active = (clip.color ?? null) === c.value
              return (
                <button
                  key={c.name}
                  type="button"
                  title={c.name}
                  aria-label={`${c.name} label colour`}
                  aria-pressed={active}
                  onClick={() => {
                    updateClip(clipId, { color: c.value ?? undefined })
                    onClose()
                  }}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    padding: 0,
                    cursor: 'pointer',
                    background: c.value ?? 'transparent',
                    border: c.value
                      ? active
                        ? '2px solid var(--color-text-primary)'
                        : '1px solid rgba(255,255,255,0.25)'
                      : `1px dashed var(--color-text-muted)`,
                  }}
                />
              )
            })}
          </div>
          {items.map((item) => {
            if (item.divider) {
              return (
                <div
                  key={item.label}
                  style={{
                    margin: '4px 0 2px',
                    padding: '5px 8px 3px',
                    borderTop: '1px solid var(--color-border)',
                    fontSize: 11,
                    fontWeight: 450,
                    lineHeight: 1,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {item.label.replace(/^— | —$/g, '')}
                </div>
              )
            }
            return (
              <MenuRow
                key={item.label}
                name={item.label}
                hint={item.hint}
                disabled={item.disabled}
                destructive={item.destructive}
                onClick={item.onClick}
              />
            )
          })}
        </div>
      </MenuSurface>
    </div>,
    document.body,
  )
}
