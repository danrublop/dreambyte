import type { Track, Timeline, Clip, TrackType, ClipSourceType } from '@/lib/types'
import { rangesOverlap } from '@/lib/timeline/overlap'

export type SnapTargetType =
  | 'grid'
  | 'frame'
  | 'clip-start'
  | 'clip-end'
  | 'playhead'
  | 'marker'
  | 'in-point'
  | 'out-point'

export interface SnapTarget {
  time: number
  type: SnapTargetType
  /** Originating clip id for clip-start / clip-end targets. */
  sourceId?: string
}

export interface SnapResult {
  time: number
  target: SnapTarget | null
}

/**
 * Collects all snap-worthy time points from the timeline, each tagged with its target type.
 * When frameSnap is true and fps + viewport bounds are provided, also generates
 * frame-boundary targets within the visible range.
 */
export function collectSnapTargets(
  timeline: Timeline | null,
  playheadTime?: number,
  excludeClipId?: string,
  options?: { fps?: number; frameSnap?: boolean; viewStart?: number; viewEnd?: number },
): SnapTarget[] {
  const targets: SnapTarget[] = []
  if (playheadTime !== undefined) targets.push({ time: playheadTime, type: 'playhead' })

  if (timeline) {
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.id === excludeClipId) continue
        targets.push({ time: clip.startTime, type: 'clip-start', sourceId: clip.id })
        targets.push({ time: clip.startTime + clip.duration, type: 'clip-end', sourceId: clip.id })
      }
    }
    for (const marker of timeline.markers ?? []) {
      targets.push({ time: marker.time, type: 'marker', sourceId: marker.id })
    }
    if (typeof timeline.inPoint === 'number') {
      targets.push({ time: timeline.inPoint, type: 'in-point' })
    }
    if (typeof timeline.outPoint === 'number') {
      targets.push({ time: timeline.outPoint, type: 'out-point' })
    }
  }

  // Frame-boundary snap targets within the visible viewport
  if (options?.frameSnap && options.fps && options.viewStart != null && options.viewEnd != null) {
    const { fps, viewStart, viewEnd } = options
    const frameDuration = 1 / fps
    const firstFrame = Math.ceil(viewStart * fps)
    const lastFrame = Math.floor(viewEnd * fps)
    for (let f = firstFrame; f <= lastFrame; f++) {
      targets.push({ time: f * frameDuration, type: 'frame' })
    }
  }

  // Sort by time so findSnap can binary-search the candidate range instead
  // of walking the whole list every pointermove (every RAF tick during a
  // drag). At high zoom the frame grid alone can be thousands of targets;
  // without sorting this was the dominant cost during drag.
  targets.sort((a, b) => a.time - b.time)
  return targets
}

const TARGET_PRIORITY: Record<SnapTargetType, number> = {
  playhead: 0,
  marker: 0,
  'in-point': 0,
  'out-point': 0,
  'clip-start': 1,
  'clip-end': 1,
  grid: 2,
  frame: 3,
}

/** Binary-search the first index whose target.time >= `target` in a
 *  sorted-by-time snap-targets array. Returns `arr.length` if none. */
function lowerBoundByTime(arr: SnapTarget[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].time < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Find the nearest snap target within threshold (in pixels).
 * Ties are broken by target priority (playhead > clip edges > grid > frame).
 * Returns the snapped time + which target produced it (or `null` for no snap).
 *
 * Requires `snapTargets` to be sorted ascending by `time` — `collectSnapTargets`
 * guarantees this. We binary-search the lower bound and walk forward only
 * while `target.time - time < threshold`, so the cost is O(log n + k) where
 * k is the number of candidates within threshold (1-3 in practice). Before
 * this, every RAF tick scanned the full target list — dominant cost at
 * high zoom where the frame grid produces thousands of targets.
 */
export function findSnap(time: number, pps: number, thresholdPx: number, snapTargets: SnapTarget[]): SnapResult {
  const thresholdTime = thresholdPx / pps
  let best: SnapTarget | null = null
  let bestDist = Infinity

  const startIdx = lowerBoundByTime(snapTargets, time - thresholdTime)
  for (let i = startIdx; i < snapTargets.length; i++) {
    const t = snapTargets[i]
    const dist = Math.abs(t.time - time)
    // Targets are sorted; once we pass the right threshold we can stop.
    if (t.time - time >= thresholdTime) break
    if (dist >= thresholdTime) continue
    if (dist < bestDist || (dist === bestDist && best && TARGET_PRIORITY[t.type] < TARGET_PRIORITY[best.type])) {
      bestDist = dist
      best = t
    }
  }

  return best ? { time: best.time, target: best } : { time, target: null }
}

/**
 * Returns sorted clip bounds on a track, excluding one or more clips.
 * Used for collision/overlap detection.
 */
export function getTrackClipBounds(
  track: Track,
  excludeClipIds?: string | string[],
): { start: number; end: number; id: string }[] {
  const excluded = new Set(Array.isArray(excludeClipIds) ? excludeClipIds : excludeClipIds ? [excludeClipIds] : [])
  return track.clips
    .filter((c) => !excluded.has(c.id))
    .map((c) => ({ start: c.startTime, end: c.startTime + c.duration, id: c.id }))
    .sort((a, b) => a.start - b.start)
}

/**
 * Clamp a time range so it doesn't overlap with existing clips on a track.
 * Returns the clamped start time.
 */
export function clampToAvoidOverlap(
  newStart: number,
  duration: number,
  bounds: { start: number; end: number }[],
): number {
  const fits = (start: number) =>
    start >= 0 && !bounds.some((b) => rangesOverlap(start, start + duration, b.start, b.end))

  const want = Math.max(0, newStart)
  if (fits(want)) return want

  // Candidate gap edges: before each clip (if the gap fits) and after each
  // clip. Every candidate is validated against ALL bounds — the old
  // single-pass version could "resolve" into a different clip, or clamp a
  // negative snap-before to 0 and land right back on the clip it was
  // avoiding.
  let best: number | null = null
  for (const b of bounds) {
    for (const cand of [b.start - duration, b.end]) {
      if (!fits(cand)) continue
      if (best === null || Math.abs(cand - want) < Math.abs(best - want)) best = cand
    }
  }
  if (best !== null) return best
  // No gap fits anywhere (fully packed track) — append past the last clip.
  return bounds.reduce((acc, b) => Math.max(acc, b.end), 0)
}

/**
 * Compute a safe collective time delta for a multi-clip drag.
 * Ensures none of the dragged clips overlap existing clips on their respective tracks.
 * Each dragged clip stays on its own track (cross-track moves are handled per clip elsewhere).
 */
export function clampMultiClipDelta(
  draggedClips: { id: string; trackId: string; startTime: number; duration: number }[],
  delta: number,
  tracks: Track[],
): number {
  if (delta === 0 || draggedClips.length === 0) return delta

  const draggedIds = draggedClips.map((c) => c.id)
  let safeDelta = delta

  for (const dc of draggedClips) {
    const track = tracks.find((t) => t.id === dc.trackId)
    if (!track) continue
    const bounds = getTrackClipBounds(track, draggedIds)
    const proposed = dc.startTime + delta
    const safe = clampToAvoidOverlap(proposed, dc.duration, bounds)
    const actualDelta = safe - dc.startTime
    if (delta > 0) {
      safeDelta = Math.min(safeDelta, actualDelta)
    } else {
      safeDelta = Math.max(safeDelta, actualDelta)
    }
  }

  return safeDelta
}

/**
 * Whether a track of the given type can accept a clip of the given source type.
 * Single source of truth for drop validation; called on drag-over and from the store on move.
 */
export function canTrackAcceptClip(trackType: TrackType, clipSourceType: ClipSourceType): boolean {
  if (clipSourceType === 'audio') return trackType === 'audio'
  // Visual sources fan out: scene → scene track; video → video; image → image;
  // title → text; avatar → video; everything else → graphics (the catch-all
  // that replaced the legacy 'overlay' kind). Video / graphics still accept
  // anything visual so drag-and-drop into a single "stuff goes here" track
  // keeps working.
  if (clipSourceType === 'scene') return trackType === 'scene' || trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'video') return trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'image') return trackType === 'image' || trackType === 'video' || trackType === 'graphics'
  if (clipSourceType === 'title') return trackType === 'text' || trackType === 'graphics'
  if (clipSourceType === 'avatar') return trackType === 'video' || trackType === 'graphics'
  return trackType === 'graphics'
}

export function canTrackAcceptClipObject(track: Track, clip: Pick<Clip, 'sourceType'>): boolean {
  return canTrackAcceptClip(track.type, clip.sourceType)
}
