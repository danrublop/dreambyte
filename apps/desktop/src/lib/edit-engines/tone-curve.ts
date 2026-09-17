/**
 * Tone curves — pure math, no Pixi/DOM imports.
 *
 * A curve is a list of control points in unit space ((0,0)..(1,1)) per
 * channel: `rgb` is the master curve, `r`/`g`/`b` compose after it
 * (out = channel(master(x))). Interpolation is Fritsch–Carlson monotone
 * cubic — no overshoot between points, so a gentle S-curve can't push
 * values past [0,1] and oscillate like natural cubic splines do.
 *
 * The renderer consumes `buildChannelLuts` (256-entry per-channel lookup
 * tables) — see the `tone-curve` case in src/lib/compositor/filters.ts, which
 * uploads them as a 256×1 texture for both the Pixi preview and export.
 */

export interface ToneCurvePoint {
  /** Input luminance, 0..1. */
  x: number
  /** Output luminance, 0..1. */
  y: number
}

export interface ToneCurveData {
  rgb?: ToneCurvePoint[]
  r?: ToneCurvePoint[]
  g?: ToneCurvePoint[]
  b?: ToneCurvePoint[]
}

export const TONE_CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'] as const
export type ToneCurveChannel = (typeof TONE_CURVE_CHANNELS)[number]

export const IDENTITY_CURVE: ToneCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
]

const LUT_SIZE = 256

/** Minimum x-distance between control points (UI + evaluator guard). */
export const MIN_POINT_GAP = 0.02

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** True when the points describe y = x (or can't describe anything else). */
export function isIdentityCurve(points: ToneCurvePoint[] | undefined): boolean {
  if (!points || points.length < 2) return true
  return points.every((p) => Math.abs(p.y - p.x) < 1e-4)
}

/** True when every channel of the curve is identity (filter is a no-op). */
export function isIdentityToneCurve(curve: ToneCurveData | undefined): boolean {
  if (!curve) return true
  return TONE_CURVE_CHANNELS.every((ch) => isIdentityCurve(curve[ch]))
}

/**
 * Evaluate the monotone cubic through `points` at `x` (all unit space).
 * Points are sorted/deduped defensively; outside the span the curve clamps
 * to the end values (flat extension, the standard curves-tool behavior).
 */
export function evaluateCurve(points: ToneCurvePoint[], x: number): number {
  if (points.length === 0) return clamp01(x)
  const pts = [...points].sort((a, b) => a.x - b.x)
  if (pts.length === 1) return clamp01(pts[0].y)
  if (x <= pts[0].x) return clamp01(pts[0].y)
  if (x >= pts[pts.length - 1].x) return clamp01(pts[pts.length - 1].y)

  const n = pts.length
  // Fritsch–Carlson tangents
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(pts[i + 1].x - pts[i].x, 1e-9)
    dx.push(h)
    slope.push((pts[i + 1].y - pts[i].y) / h)
  }
  const m: number[] = [slope[0]]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m.push(0)
    } else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]))
    }
  }
  m.push(slope[n - 2])

  // Find segment (n is tiny — control points are user-placed)
  let i = 0
  while (i < n - 2 && x > pts[i + 1].x) i++
  const t = (x - pts[i].x) / dx[i]
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return clamp01(h00 * pts[i].y + h10 * dx[i] * m[i] + h01 * pts[i + 1].y + h11 * dx[i] * m[i + 1])
}

export interface ChannelLuts {
  r: Uint8Array
  g: Uint8Array
  b: Uint8Array
}

/**
 * Build 256-entry per-channel LUTs: out = lerp(x, channel(master(x)), intensity).
 * `intensity` (0..1, default 1) fades the whole curve toward identity, the
 * same convention as grade intensity.
 */
export function buildChannelLuts(curve: ToneCurveData, intensity = 1): ChannelLuts {
  const t = clamp01(intensity)
  const master = curve.rgb && !isIdentityCurve(curve.rgb) ? curve.rgb : null
  const out: ChannelLuts = {
    r: new Uint8Array(LUT_SIZE),
    g: new Uint8Array(LUT_SIZE),
    b: new Uint8Array(LUT_SIZE),
  }
  for (const ch of ['r', 'g', 'b'] as const) {
    const chPoints = curve[ch] && !isIdentityCurve(curve[ch]) ? curve[ch]! : null
    for (let i = 0; i < LUT_SIZE; i++) {
      const x = i / (LUT_SIZE - 1)
      let y = master ? evaluateCurve(master, x) : x
      if (chPoints) y = evaluateCurve(chPoints, y)
      const blended = x + (y - x) * t
      out[ch][i] = Math.round(clamp01(blended) * 255)
    }
  }
  return out
}

/**
 * Sanitize user-dragged points: clamp to unit space, sort by x, enforce the
 * minimum gap so two points can't collapse into a vertical cliff.
 */
export function normalizePoints(points: ToneCurvePoint[]): ToneCurvePoint[] {
  const sorted = points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - sorted[i - 1].x < MIN_POINT_GAP) {
      sorted[i] = { ...sorted[i], x: Math.min(1, sorted[i - 1].x + MIN_POINT_GAP) }
    }
  }
  return sorted
}
