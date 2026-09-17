/**
 * Pure positioning helpers for the keyframe overlay.
 *
 * Keep all the math out of the React component so it's unit-testable
 * without mounting the DOM. Returns one entry per keyframe with the px
 * offset relative to the clip's left edge — the component just renders
 * a diamond at that position.
 */

import type { Clip, Keyframe } from '@/lib/types'

export interface KeyframeMarkerData {
  /** Unique key for React reconciliation. */
  key: string
  /** Pixel offset from the clip's left edge. */
  leftPx: number
  /** Property name (carried through for the diamond's tooltip + colour). */
  property: Keyframe['property']
  /** Clip-relative seconds; passed back to handlers verbatim. */
  time: number
  /** Value at this keyframe; surfaced in the tooltip. */
  value: number
  /** Easing name; used to colour the diamond. */
  easing: Keyframe['easing']
}

/**
 * Build the render data for every keyframe on a clip. Filters keyframes
 * whose `time` falls outside `[0, clip.duration]` — those are usually a
 * sign of a stale split that landed before the clip-reducer was wired.
 */
export function buildKeyframeMarkers(clip: Clip, pixelsPerSecond: number): KeyframeMarkerData[] {
  const out: KeyframeMarkerData[] = []
  for (let i = 0; i < clip.keyframes.length; i++) {
    const kf = clip.keyframes[i]
    if (kf.time < 0 || kf.time > clip.duration) continue
    // Key by (clipId, property, sourceIndex) — NOT by `kf.time`. The reducer
    // patches keyframes immutably in place so the index in `clip.keyframes`
    // is stable across drags. Embedding `kf.time` in the key caused the
    // diamond to remount on every pointermove (the same bug we fixed for
    // AudioGainRubberBand in round 2 phase B); React would drop pointer
    // capture and the drag would silently stick.
    out.push({
      key: `${clip.id}:${kf.property}:${i}`,
      leftPx: kf.time * pixelsPerSecond,
      property: kf.property,
      time: kf.time,
      value: kf.value,
      easing: kf.easing,
    })
  }
  return out
}

/**
 * Colour palette for keyframe diamonds, keyed by property. Stays in this
 * pure module so consumers (the marker + the inspector both surface a
 * legend) share one source of truth.
 */
export const KEYFRAME_PROPERTY_COLOR: Record<string, string> = {
  opacity: '#60a5fa', // blue
  x: '#a78bfa', // violet
  y: '#a78bfa',
  scaleX: '#34d399', // emerald
  scaleY: '#34d399',
  rotation: '#fbbf24', // amber
  speed: '#f472b6', // pink
  gain: '#22d3ee', // cyan — audio rubber-band
}

export function colorForKeyframeProperty(property: string): string {
  return KEYFRAME_PROPERTY_COLOR[property] ?? '#94a3b8'
}

/**
 * Convert a horizontal pixel delta (from a pointer drag) to a seconds-delta
 * we can apply to a keyframe's `time`. Negative pps is treated as zero so a
 * drag never produces NaN.
 */
export function deltaXToTimeDelta(deltaPx: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond <= 0) return 0
  return deltaPx / pixelsPerSecond
}

/**
 * Snap a candidate keyframe time into the legal range for a clip, and
 * round to the nearest 1ms so floating-point drift doesn't produce
 * never-equal-to-itself keyframes after a drag.
 */
export function snapKeyframeTime(rawTime: number, clipDuration: number): number {
  const clamped = Math.max(0, Math.min(clipDuration, rawTime))
  return Math.round(clamped * 1000) / 1000
}

/**
 * Round a time value to the nearest frame at the project FPS. Use at the
 * commit edge of moves/trims so clips never land on sub-frame times that
 * would shimmer in the exported MP4.
 */
export function snapToFrame(time: number, fps: number): number {
  if (!Number.isFinite(time) || fps <= 0) return time
  return Math.round(time * fps) / fps
}
