/**
 * Reframe planner.
 *
 * Given per-frame face/pose detections + target aspect ratio + clip
 * duration, produce a list of `clip/keyframe` payloads that pan the
 * compositor's render origin so the detected subject stays roughly
 * centered. Two outputs:
 *
 *   - `x` keyframes (camera x, in compositor pixels)
 *   - `y` keyframes (camera y)
 *
 * The compositor already supports keyframed clip position (see
 * `src/lib/compositor/pixi-preview.ts:renderVideoClip` — `kfValues.x`/`.y`
 * override clip defaults). Each keyframe lands as a `keyframe/add` on
 * the parent clip.
 *
 * Pipeline:
 *   1. Sort detections by `time` and EMA-smooth the centroid so the
 *      camera doesn't jitter every frame.
 *   2. Downsample to at most `maxKeyframes` (default 12). Too many
 *      keyframes bloat the action_log and don't help quality.
 *   3. Subtract from canvas center to produce a translation in px.
 *
 * Pure — no Pixi, no MediaPipe.
 */

import type { Keyframe } from '@/lib/types'

export interface FrameDetection {
  /** Clip-relative time in seconds. */
  time: number
  /** Subject centroid x (px in source coords; 0 = left edge). */
  centerX: number
  /** Subject centroid y (px in source coords; 0 = top edge). */
  centerY: number
  /** Optional confidence 0..1; below `minConfidence` the detection is dropped. */
  confidence?: number
}

export interface ReframePlanArgs {
  detections: FrameDetection[]
  /** Source media width in px. */
  sourceWidth: number
  /** Source media height in px. */
  sourceHeight: number
  /** Output canvas width in px (typically the project's render dimensions). */
  targetWidth: number
  /** Output canvas height in px. */
  targetHeight: number
  /** Maximum number of keyframes per axis. Default 12. */
  maxKeyframes?: number
  /** EMA smoothing factor (0..1). Higher = more responsive, lower = smoother. Default 0.25. */
  smoothing?: number
  /** Drop detections below this confidence; if no detections survive, returns []. Default 0.5. */
  minConfidence?: number
  /** Easing applied to every emitted keyframe. Default 'ease-in-out'. */
  easing?: Keyframe['easing']
}

export interface ReframeKeyframe {
  time: number
  property: 'x' | 'y'
  value: number
  easing: Keyframe['easing']
}

const DEFAULT_MAX_KEYFRAMES = 12
const DEFAULT_SMOOTHING = 0.25
const DEFAULT_MIN_CONFIDENCE = 0.5

/**
 * Run the full pipeline and emit the keyframe payloads. Returns an empty
 * array when no detection survives filtering — the caller should treat
 * that as "no reframe needed" rather than an error.
 */
export function framesToReframeKeyframes(args: ReframePlanArgs): ReframeKeyframe[] {
  const maxKeyframes = args.maxKeyframes ?? DEFAULT_MAX_KEYFRAMES
  const alpha = args.smoothing ?? DEFAULT_SMOOTHING
  const minConfidence = args.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const easing = args.easing ?? 'ease-in-out'

  // 1. Filter + sort.
  const filtered = args.detections
    .filter((d) => (d.confidence ?? 1) >= minConfidence)
    .slice()
    .sort((a, b) => a.time - b.time)
  if (filtered.length === 0) return []

  // 2. EMA smooth in both axes.
  const smoothed: FrameDetection[] = []
  let ex = filtered[0].centerX
  let ey = filtered[0].centerY
  for (const d of filtered) {
    ex = alpha * d.centerX + (1 - alpha) * ex
    ey = alpha * d.centerY + (1 - alpha) * ey
    smoothed.push({ time: d.time, centerX: ex, centerY: ey, confidence: d.confidence })
  }

  // 3. Downsample to at most `maxKeyframes`. Pick evenly-spaced indexes —
  // visual quality is fine for the typical 5–30s clip + we keep the
  // action_log small.
  const downsampled = downsampleEvenly(smoothed, maxKeyframes)

  // 4. Convert centroid → translation. Output is the offset we want to
  // apply to the clip's `position.x` / `position.y` so the subject ends
  // up at canvas center: translate = (targetCenter / scale) - sourceCenter
  // We assume the scale stays at 1 (callers can layer a scale keyframe
  // separately). The compositor adds `clip.position` to the sprite, so
  // the value here is `position.x` in clip-local px.
  const cxTarget = args.targetWidth / 2
  const cyTarget = args.targetHeight / 2

  const out: ReframeKeyframe[] = []
  for (const d of downsampled) {
    out.push({ time: d.time, property: 'x', value: cxTarget - d.centerX, easing })
    out.push({ time: d.time, property: 'y', value: cyTarget - d.centerY, easing })
  }
  return out
}

/** Pick `count` items evenly across `arr`. Always includes first + last. */
function downsampleEvenly<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return arr.slice()
  const out: T[] = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (count - 1))
    out.push(arr[idx])
  }
  return out
}
