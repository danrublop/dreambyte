/**
 * Per-clip color grade model (`clip.grade`) plus the small pure helpers the agent
 * tool, inspector panel, compositor and reducers share. No DOM/React imports.
 *
 * The shape is persisted in project files, so field names are a stable contract.
 * Every field is optional; an absent field means "neutral" for that control.
 * Rendering is split in two tiers (see gradeRenderTier):
 *   css   — primaries, white balance, wheels, curves, vignette (CSS filter + SVG <filter>)
 *   webgl — anything that needs per-pixel hue math or a 3D lookup (hue curves, LUT)
 */

/** One control point of a tone curve, both axes in 0..1 (input → output). */
export interface CurvePoint {
  x: number
  y: number
}

/** A tonal-zone color wheel: a hue push plus that zone's brightness control. */
export interface WheelZone {
  /** Direction of the color push, degrees 0..360 (0 red, 120 green, 240 blue). */
  hue?: number
  /** Strength of the color push, 0..1 (0 = no push). */
  amount?: number
  /** Shadows zone only: lift, -0.5..0.5 (0 neutral). */
  lum?: number
  /** Midtones zone only: gamma, 0.5..2 (1 neutral; >1 brightens mids). */
  gamma?: number
  /** Highlights zone only: gain, 0.5..1.5 (1 neutral). */
  gain?: number
}

/** A qualified (hue-keyed) secondary adjustment. */
export interface HueCurveTarget {
  /** Source hue to select, degrees 0..360. */
  targetHue: number
  /** Hue rotation applied to the selection, degrees -30..30 (0 neutral). */
  hueShift?: number
  /** Saturation multiplier for the selection, 0..2 (1 neutral). */
  satScale?: number
  /** Lightness offset for the selection, -0.5..0.5 (0 neutral). */
  lumShift?: number
}

/** A 3D .cube LUT stored in project LUT storage. */
export interface ClipLut {
  /** Absolute path to the stored .cube file ('' in a strength-only patch). */
  path: string
  /** Cube edge length (e.g. 17, 33, 65). */
  dimension: number
  /** Blend with the un-LUT'd image, 0..1 (default 1). */
  strength?: number
}

export interface ClipColorGrade {
  /** Exposure in EV, -3..3 (0 neutral). */
  exposure?: number
  /** Contrast multiplier, 0.5..1.5 (1 neutral). */
  contrast?: number
  /** Saturation multiplier, 0..2 (1 neutral). */
  saturation?: number
  /** Vibrance, -1..1 (0 neutral). */
  vibrance?: number
  /** Look temperature in Kelvin, 2000..11000 (6500 neutral; higher = warmer). */
  temperature?: number
  /** Tint, -100..100 (0 neutral; positive = green, negative = magenta). */
  tint?: number
  /** Highlight recovery/boost, -1..1 (0 neutral). */
  highlights?: number
  /** Shadow deepen/lift, -1..1 (0 neutral). */
  shadows?: number
  /** Black point, -1..1 (0 neutral; positive = faded/lifted). */
  blacks?: number
  /** White point, -1..1 (0 neutral). */
  whites?: number
  /** Lift / gamma / gain wheels. */
  wheels?: {
    shadows?: WheelZone
    mids?: WheelZone
    highlights?: WheelZone
  }
  /** Tone curves; master applies first, then the per-channel curve. */
  curves?: {
    master?: CurvePoint[]
    red?: CurvePoint[]
    green?: CurvePoint[]
    blue?: CurvePoint[]
  }
  /** Hue-keyed secondaries (webgl tier). */
  hueCurves?: {
    targets: HueCurveTarget[]
  }
  /** 3D LUT applied after the primary grade (webgl tier). */
  lut?: ClipLut
  /** Edge darkening, 0..1 (0 neutral). */
  vignette?: number
}

const EPS = 1e-4

const near = (v: number | undefined, neutral: number, eps = EPS): boolean =>
  v === undefined || !Number.isFinite(v) || Math.abs(v - neutral) < eps

function isNeutralZone(z: WheelZone | undefined): boolean {
  if (!z) return true
  return near(z.amount, 0) && near(z.lum, 0) && near(z.gamma, 1) && near(z.gain, 1)
}

/**
 * A piecewise-linear curve is the identity iff every knot sits on the diagonal and
 * the knots span the whole 0..1 domain (outside the knots the curve holds flat).
 * Fewer than two points is treated as "no curve".
 */
function isIdentityCurve(pts: CurvePoint[] | undefined): boolean {
  if (!pts || pts.length < 2) return true
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    if (Math.abs(p.y - p.x) >= EPS) return false
    lo = Math.min(lo, p.x)
    hi = Math.max(hi, p.x)
  }
  return lo < EPS && hi > 1 - EPS
}

export function isNeutralClipGrade(g: ClipColorGrade | undefined | null): boolean {
  if (!g) return true
  const scalarsNeutral =
    near(g.exposure, 0) &&
    near(g.contrast, 1) &&
    near(g.saturation, 1) &&
    near(g.vibrance, 0) &&
    near(g.temperature, 6500, 1) &&
    near(g.tint, 0) &&
    near(g.highlights, 0) &&
    near(g.shadows, 0) &&
    near(g.blacks, 0) &&
    near(g.whites, 0) &&
    near(g.vignette, 0)
  if (!scalarsNeutral) return false
  const w = g.wheels
  if (w && !(isNeutralZone(w.shadows) && isNeutralZone(w.mids) && isNeutralZone(w.highlights))) return false
  const c = g.curves
  if (
    c &&
    !(isIdentityCurve(c.master) && isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue))
  )
    return false
  return !hasHueCurves(g) && !hasLut(g)
}

/** True when at least one hue target actually changes something. */
export function hasHueCurves(g: ClipColorGrade | undefined | null): boolean {
  const targets = g?.hueCurves?.targets
  if (!Array.isArray(targets)) return false
  return targets.some((t) => !near(t.hueShift, 0) || !near(t.satScale, 1) || !near(t.lumShift, 0))
}

/** True when a LUT with a stored file and a positive blend strength is attached. */
export function hasLut(g: ClipColorGrade | undefined | null): boolean {
  const lut = g?.lut
  return !!lut && typeof lut.path === 'string' && lut.path.length > 0 && (lut.strength ?? 1) > 0
}

export type GradeRenderTier = 'none' | 'css' | 'webgl'

/** Cheapest render path that can represent the whole grade. */
export function gradeRenderTier(g: ClipColorGrade | undefined | null): GradeRenderTier {
  if (isNeutralClipGrade(g)) return 'none'
  return hasLut(g) || hasHueCurves(g) ? 'webgl' : 'css'
}

const SCALAR_KEYS = [
  'exposure',
  'contrast',
  'saturation',
  'vibrance',
  'temperature',
  'tint',
  'highlights',
  'shadows',
  'blacks',
  'whites',
  'vignette',
] as const

/** Copy only the keys whose value is defined (a patch never clears by omission). */
function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k]
  return out
}

/**
 * Apply a partial grade on top of an existing one without mutating either.
 *   scalars   — patched keys replace, others kept
 *   wheels    — merged per zone, per field
 *   curves    — merged per channel (a passed channel replaces that channel)
 *   hueCurves — replaced wholesale
 *   lut       — a non-empty path replaces the LUT; an empty path with a strength
 *               re-blends the existing LUT (dropped if there is none)
 * `reset` discards `prev` first.
 */
export function mergeClipGrade(
  prev: ClipColorGrade | undefined | null,
  patch: ClipColorGrade,
  opts?: { reset?: boolean },
): ClipColorGrade {
  const base: ClipColorGrade = opts?.reset || !prev ? {} : prev
  const next: ClipColorGrade = { ...base }

  for (const k of SCALAR_KEYS) {
    if (patch[k] !== undefined) next[k] = patch[k]
  }

  if (patch.wheels) {
    const wheels = { ...base.wheels }
    for (const zone of ['shadows', 'mids', 'highlights'] as const) {
      const p = patch.wheels[zone]
      if (p) wheels[zone] = { ...wheels[zone], ...defined(p) }
    }
    next.wheels = wheels
  }

  if (patch.curves) {
    next.curves = { ...base.curves, ...defined(patch.curves) }
  }

  if (patch.hueCurves) {
    next.hueCurves = { targets: patch.hueCurves.targets.map((t) => ({ ...t })) }
  }

  if (patch.lut) {
    if (patch.lut.path) {
      next.lut = { ...patch.lut }
    } else if (patch.lut.strength !== undefined) {
      if (base.lut) next.lut = { ...base.lut, strength: patch.lut.strength }
      else delete next.lut
    }
  }

  return next
}

const TWO_THIRDS_PI = (2 * Math.PI) / 3
// Offset magnitude for a full-strength (amount 1) push on the strongest channel.
const CHROMA_SCALE = 0.5

/**
 * Zero-mean RGB offset pointing toward `hueDeg`, scaled by `amount`. The three
 * channels are cosines 120° apart, so they always sum to zero (the push shifts
 * color without shifting average brightness). Same hue→RGB mapping the inspector's
 * wheel adapter uses, so the on-screen puck and the render agree.
 */
export function wheelChromaOffset(hueDeg: number, amount: number): { r: number; g: number; b: number } {
  if (!Number.isFinite(hueDeg) || !Number.isFinite(amount) || Math.abs(amount) < 1e-9) return { r: 0, g: 0, b: 0 }
  const a = (hueDeg * Math.PI) / 180
  const k = amount * CHROMA_SCALE
  return {
    r: Math.cos(a) * k,
    g: Math.cos(a - TWO_THIRDS_PI) * k,
    b: Math.cos(a + TWO_THIRDS_PI) * k,
  }
}
