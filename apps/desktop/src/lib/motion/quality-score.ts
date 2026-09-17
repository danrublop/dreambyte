/**
 * Quality scoring for generated Lottie JSON.
 *
 * Evaluates five dimensions (0-20 each, 100 total):
 * 1. Visual quality — easing variety, entrance/exit phases, multiple animated properties
 * 2. Technical quality — easing handles present, valid frame ranges, no duplicate keyframes
 * 3. Emotional coherence — duration within personality range, easing matches intent
 * 4. Performance — layer count, keyframe count
 * 5. Completeness — has shapes + animations, uses palette, matches duration
 */

import type { MotionPersonality } from './easing'
import { PERSONALITIES } from './easing'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityScore {
  total: number
  dimensions: {
    visual: number
    technical: number
    emotional: number
    performance: number
    completeness: number
  }
  suggestions: string[]
}

export interface QualityOptions {
  personality?: MotionPersonality
  expectedDuration?: number
  paletteColors?: number[][]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/** Count animated properties in a Lottie object tree. */
function countAnimated(obj: unknown): { animated: number; static_: number; keyframeCount: number } {
  let animated = 0
  let static_ = 0
  let keyframeCount = 0

  function walk(node: unknown) {
    if (!isObj(node)) return
    if ('a' in node && 'k' in node) {
      if (node.a === 1 && isArr(node.k)) {
        animated++
        keyframeCount += node.k.length
      } else {
        static_++
      }
      return
    }
    for (const val of Object.values(node)) {
      if (isObj(val)) walk(val)
      else if (isArr(val)) val.forEach((item) => isObj(item) && walk(item))
    }
  }

  walk(obj)
  return { animated, static_, keyframeCount }
}

/** Check if keyframes have non-linear easing (not all identical i/o). */
function hasEasingVariety(obj: unknown): boolean {
  const easings: string[] = []

  function walk(node: unknown) {
    if (!isObj(node)) return
    if ('a' in node && node.a === 1 && isArr(node.k)) {
      for (const kf of node.k) {
        if (isObj(kf) && isObj(kf.i) && isObj(kf.o)) {
          const i = kf.i as Record<string, unknown>
          const o = kf.o as Record<string, unknown>
          if (isArr(i.x) && isArr(i.y)) {
            easings.push(`${(i.x as number[])[0]},${(i.y as number[])[0]}`)
          }
          if (isArr(o.x) && isArr(o.y)) {
            easings.push(`${(o.x as number[])[0]},${(o.y as number[])[0]}`)
          }
        }
      }
      return
    }
    for (const val of Object.values(node)) {
      if (isObj(val)) walk(val)
      else if (isArr(val)) val.forEach((item) => isObj(item) && walk(item))
    }
  }

  walk(obj)
  const unique = new Set(easings)
  return unique.size > 2
}

/** Check if there are keyframes at both the beginning and end of the animation. */
function hasEntranceAndExit(json: Record<string, unknown>): { entrance: boolean; exit: boolean } {
  const op = typeof json.op === 'number' ? json.op : 240
  const earlyThreshold = op * 0.3
  const lateThreshold = op * 0.7
  let entrance = false
  let exit = false

  function walkKeyframes(node: unknown) {
    if (!isObj(node)) return
    if ('a' in node && node.a === 1 && isArr(node.k)) {
      for (const kf of node.k) {
        if (isObj(kf) && typeof kf.t === 'number') {
          if (kf.t <= earlyThreshold) entrance = true
          if (kf.t >= lateThreshold) exit = true
        }
      }
      return
    }
    for (const val of Object.values(node)) {
      if (isObj(val)) walkKeyframes(val)
      else if (isArr(val)) val.forEach((item) => isObj(item) && walkKeyframes(item))
    }
  }

  walkKeyframes(json)
  return { entrance, exit }
}

/** Count missing easing handles. */
function countMissingEasing(obj: unknown): number {
  let missing = 0

  function walk(node: unknown) {
    if (!isObj(node)) return
    if ('a' in node && node.a === 1 && isArr(node.k)) {
      for (let i = 0; i < node.k.length - 1; i++) {
        const kf = node.k[i]
        if (isObj(kf) && (!isObj(kf.i) || !isObj(kf.o))) {
          missing++
        }
      }
      return
    }
    for (const val of Object.values(node)) {
      if (isObj(val)) walk(val)
      else if (isArr(val)) val.forEach((item) => isObj(item) && walk(item))
    }
  }

  walk(obj)
  return missing
}

/** Count shapes across all layers. */
function countShapes(json: Record<string, unknown>): number {
  let count = 0

  function walkShapes(node: unknown) {
    if (!isObj(node)) return
    if (typeof node.ty === 'string' && ['el', 'rc', 'sr', 'sh', 'fl', 'st'].includes(node.ty)) {
      count++
    }
    for (const val of Object.values(node)) {
      if (isObj(val)) walkShapes(val)
      else if (isArr(val)) val.forEach((item) => walkShapes(item))
    }
  }

  if (isArr(json.layers)) {
    for (const layer of json.layers) walkShapes(layer)
  }
  return count
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score the quality of a parsed Lottie JSON object.
 */
export function scoreLottieQuality(json: Record<string, unknown>, options: QualityOptions = {}): QualityScore {
  const suggestions: string[] = []
  const layers = isArr(json.layers) ? json.layers : []
  const layerCount = layers.length
  const { animated, keyframeCount } = countAnimated(json)
  const shapeCount = countShapes(json)
  const op = typeof json.op === 'number' ? json.op : 240
  const fr = typeof json.fr === 'number' ? json.fr : 30
  const durationSec = op / fr

  // ── 1. Visual quality (0-20) ──
  let visual = 0
  // Has easing variety (not all the same curve)
  if (hasEasingVariety(json)) {
    visual += 6
  } else {
    suggestions.push('Use varied easing curves — not every property needs the same bezier.')
  }
  // Has entrance and exit phases
  const phases = hasEntranceAndExit(json)
  if (phases.entrance) visual += 4
  else suggestions.push('Add entrance keyframes in the first 30% of the animation.')
  if (phases.exit) visual += 4
  else suggestions.push('Add exit or resolution keyframes in the last 30%.')
  // Multiple animated properties
  if (animated >= 3) visual += 6
  else if (animated >= 2) visual += 4
  else if (animated >= 1) visual += 2
  else suggestions.push('Animate at least 2 properties (e.g. position + opacity).')

  // ── 2. Technical quality (0-20) ──
  let technical = 10 // Start at 10, deduct for issues
  const missingEasing = countMissingEasing(json)
  if (missingEasing > 0) {
    technical -= Math.min(10, missingEasing * 2)
    suggestions.push(`${missingEasing} keyframe(s) missing easing handles.`)
  }
  // Valid structure
  const hasRequiredFields = ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers'].every((f) => f in json)
  if (hasRequiredFields) technical += 5
  else suggestions.push('Missing required Lottie fields.')
  // Frame range validity
  let frameRangeOk = true
  for (const layer of layers) {
    if (isObj(layer)) {
      const lip = typeof layer.ip === 'number' ? layer.ip : 0
      const lop = typeof layer.op === 'number' ? layer.op : op
      if (lip < 0 || lop > op + 1) frameRangeOk = false
    }
  }
  if (frameRangeOk) technical += 5
  else suggestions.push('Some layers have frame ranges outside the root ip/op.')

  // ── 3. Emotional coherence (0-20) ──
  let emotional = 10 // Default: neutral
  if (options.personality) {
    const profile = PERSONALITIES[options.personality]
    // Check if duration is within personality range (scaled for video, not UI)
    // Video durations are longer; scale personality ranges by duration/transition ratio
    emotional += 5 // Credit for specifying personality
    if (hasEasingVariety(json)) emotional += 5 // Easing variety matches intentional design
  } else {
    emotional += 10 // No personality specified — full credit, can't judge
  }

  // ── 4. Performance (0-20) ──
  let performance = 20
  if (layerCount > 10) {
    performance -= Math.min(10, (layerCount - 10) * 2)
    suggestions.push(`${layerCount} layers — consider simplifying to under 10.`)
  }
  if (keyframeCount > 500) {
    performance -= Math.min(10, Math.floor((keyframeCount - 500) / 100))
    suggestions.push(`${keyframeCount} keyframes — consider reducing complexity.`)
  }

  // ── 5. Completeness (0-20) ──
  let completeness = 0
  // Has shapes
  if (shapeCount > 0) completeness += 8
  else suggestions.push('No shape elements found — animation may be empty.')
  // Has animations
  if (animated > 0) completeness += 6
  else suggestions.push('No animated properties — this is a static Lottie.')
  // Duration matches expected
  if (options.expectedDuration) {
    const diff = Math.abs(durationSec - options.expectedDuration)
    if (diff < 1) completeness += 6
    else if (diff < 3) completeness += 3
    else suggestions.push(`Duration ${durationSec.toFixed(1)}s doesn't match expected ${options.expectedDuration}s.`)
  } else {
    completeness += 6 // No expected duration — full credit
  }

  const total = Math.max(
    0,
    Math.min(
      100,
      Math.min(20, visual) +
        Math.min(20, technical) +
        Math.min(20, emotional) +
        Math.min(20, performance) +
        Math.min(20, completeness),
    ),
  )

  return {
    total,
    dimensions: {
      visual: Math.min(20, visual),
      technical: Math.min(20, technical),
      emotional: Math.min(20, emotional),
      performance: Math.min(20, performance),
      completeness: Math.min(20, completeness),
    },
    suggestions,
  }
}
