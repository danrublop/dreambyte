/**
 * Keyframe interpolation engine for clip properties.
 *
 * Evaluates keyframes at a given time for any animatable property.
 * Supports easing curves: linear, ease-in, ease-out, ease-in-out,
 * and cubic-bezier (as "cubic-bezier(x1,y1,x2,y2)" string).
 *
 * Also provides time remapping for variable-speed clips via
 * numerical integration of speed keyframes.
 */

import type { Keyframe } from '../types'

// ── Easing functions ────────────────────────────────────────────────────────

function easeLinear(t: number): number {
  return t
}

function easeIn(t: number): number {
  return t * t
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

/**
 * Attempt to parse a cubic-bezier string like "cubic-bezier(0.4, 0, 0.2, 1)"
 * and return the easing function. Falls back to linear if parsing fails.
 */
function parseCubicBezier(str: string): (t: number) => number {
  const m = str.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)
  if (!m) return easeLinear
  const [, x1s, y1s, x2s, y2s] = m
  const x1 = parseFloat(x1s),
    y1 = parseFloat(y1s)
  const x2 = parseFloat(x2s),
    y2 = parseFloat(y2s)
  if ([x1, y1, x2, y2].some(isNaN)) return easeLinear
  return cubicBezierEasing(x1, y1, x2, y2)
}

/**
 * Attempt to produce a cubic bezier easing function.
 * Uses Newton's method to invert the X bezier curve,
 * then evaluates the Y curve at that parameter.
 */
function cubicBezierEasing(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // Find bezier parameter for X=t using Newton-Raphson (8 iterations)
    let u = t
    for (let i = 0; i < 8; i++) {
      const xVal = bezier(u, x1, x2) - t
      const xDeriv = bezierDeriv(u, x1, x2)
      if (Math.abs(xDeriv) < 1e-10) break
      u -= xVal / xDeriv
      u = Math.max(0, Math.min(1, u))
    }
    return bezier(u, y1, y2)
  }
}

function bezier(t: number, p1: number, p2: number): number {
  // cubic bezier: B(t) = 3(1-t)^2*t*p1 + 3(1-t)*t^2*p2 + t^3
  return 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3
}

function bezierDeriv(t: number, p1: number, p2: number): number {
  return 3 * (1 - t) ** 2 * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t ** 2 * (1 - p2)
}

function getEasingFn(easing: string): (t: number) => number {
  switch (easing) {
    case 'linear':
      return easeLinear
    case 'ease-in':
      return easeIn
    case 'ease-out':
      return easeOut
    case 'ease-in-out':
      return easeInOut
    default:
      if (easing.startsWith('cubic-bezier')) return parseCubicBezier(easing)
      return easeLinear
  }
}

// ── Keyframe evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a property at a given time using the provided keyframes.
 * Returns null if no keyframes exist for this property.
 *
 * @param keyframes - All keyframes on the clip
 * @param property - The property name to evaluate (e.g. 'x', 'opacity', 'speed')
 * @param time - Time in seconds relative to clip start
 * @param defaultValue - Value to return if no keyframes match
 */
export function evaluateKeyframes(
  keyframes: Keyframe[],
  property: string,
  time: number,
  defaultValue?: number,
): number | null {
  const propKfs = keyframes.filter((k) => k.property === property).sort((a, b) => a.time - b.time)

  if (propKfs.length === 0) return defaultValue ?? null

  // Before first keyframe — hold first value
  if (time <= propKfs[0].time) return propKfs[0].value

  // After last keyframe — hold last value
  if (time >= propKfs[propKfs.length - 1].time) return propKfs[propKfs.length - 1].value

  // Find bracketing keyframes
  for (let i = 0; i < propKfs.length - 1; i++) {
    const a = propKfs[i]
    const b = propKfs[i + 1]
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time
      if (span <= 0) return a.value
      const t = (time - a.time) / span
      const eased = getEasingFn(b.easing)(t)
      return a.value + (b.value - a.value) * eased
    }
  }

  return propKfs[propKfs.length - 1].value
}

/**
 * Evaluate all animatable properties at a given time.
 * Returns an object with only the properties that have keyframes.
 */
export function evaluateAllKeyframes(keyframes: Keyframe[], time: number): Record<string, number> {
  const properties = new Set(keyframes.map((k) => k.property))
  const result: Record<string, number> = {}
  for (const prop of properties) {
    const val = evaluateKeyframes(keyframes, prop, time)
    if (val !== null) result[prop] = val
  }
  return result
}

// ── Time remapping (variable speed) ─────────────────────────────────────────

/**
 * Compute the source-media time for a clip at a given local time,
 * accounting for variable speed via keyframes.
 *
 * For constant speed: sourceTime = trimStart + localTime * speed
 * For variable speed: sourceTime = trimStart + integral(speed(t), 0, localTime)
 *
 * Uses trapezoidal integration with 100 steps for accuracy.
 *
 * @param localTime - Time relative to clip start (seconds)
 * @param baseSpeed - Clip's base speed (constant component)
 * @param trimStart - Source in-point
 * @param keyframes - Clip keyframes (speed keyframes used for ramp)
 */
export function remapTime(localTime: number, baseSpeed: number, trimStart: number, keyframes: Keyframe[]): number {
  const speedKfs = keyframes.filter((k) => k.property === 'speed')

  // No speed keyframes — simple constant speed
  if (speedKfs.length === 0) {
    return trimStart + localTime * baseSpeed
  }

  // Numerical integration of speed over [0, localTime]
  const steps = 100
  const dt = localTime / steps
  let integral = 0

  for (let i = 0; i < steps; i++) {
    const t0 = i * dt
    const t1 = (i + 1) * dt
    const s0 = evaluateKeyframes(keyframes, 'speed', t0, baseSpeed) ?? baseSpeed
    const s1 = evaluateKeyframes(keyframes, 'speed', t1, baseSpeed) ?? baseSpeed
    integral += ((s0 + s1) / 2) * dt // trapezoidal rule
  }

  return trimStart + integral
}
