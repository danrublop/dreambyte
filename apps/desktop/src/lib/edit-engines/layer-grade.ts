/**
 * Advanced per-layer color grading (NLE-style) for SCENE media
 * layers — pure math + markup generation, no React/DOM imports.
 *
 * The model stacks like Lumetri:
 *   Look (preset CSS in `layer.filter`, handled by grade-css.ts)
 *   + Correction (this module): exposure · contrast · saturation ·
 *     temperature · tint · hue · per-channel tone curves
 *
 * Exposure/contrast/saturation/hue map onto plain CSS filter functions.
 * Temperature/tint need a channel-gain color matrix and curves need
 * per-channel transfer tables — neither exists in CSS, so those compile to
 * an SVG <filter> (feColorMatrix + feComponentTransfer) that the scene
 * template bakes next to the media element and references via url(#…).
 * The editor preview injects the SAME markup into the editor document and
 * filters the scene iframe with it, so hover/drag previews use identical
 * math to the committed render and the export.
 */

import type { ToneCurveData } from './tone-curve'
import { buildChannelLuts, isIdentityToneCurve } from './tone-curve'

export interface LayerColorGrade {
  /** Exposure in stops-ish (−1..1, 0 neutral → brightness 2^x approx). */
  exposure?: number
  /** Contrast −1..1 (0 neutral). */
  contrast?: number
  /** Saturation −1..1 (0 neutral, −1 grayscale, +1 = 2×). */
  saturation?: number
  /** Temperature −1..1 (warm +, cool −). */
  temperature?: number
  /** Tint −1..1 (magenta +, green −). */
  tint?: number
  /** Hue rotation in degrees (−180..180). */
  hue?: number
  /** Per-channel tone curves (unit space, monotone cubic). */
  curves?: ToneCurveData
  /** Lift wheel — shadows offset. r/g/b are color-puck offsets, master is the
   *  luminance ring; all −1..1, 0 neutral. */
  lift?: WheelValue
  /** Gamma wheel — midtone power. Same shape as lift. */
  gamma?: WheelValue
  /** Gain wheel — highlight slope. Same shape as lift. */
  gain?: WheelValue
  /** Vignette amount 0..1 (rendered as a radial overlay, not part of the SVG filter). */
  vignette?: number
  /** Sharpen amount 0..1 (unsharp 3×3 feConvolveMatrix). */
  sharpen?: number
}

export interface WheelValue {
  r: number
  g: number
  b: number
  master: number
}

export const NEUTRAL_WHEEL: WheelValue = { r: 0, g: 0, b: 0, master: 0 }

export function isNeutralWheel(w: WheelValue | undefined | null): boolean {
  if (!w) return true
  return Math.abs(w.r) < 1e-4 && Math.abs(w.g) < 1e-4 && Math.abs(w.b) < 1e-4 && Math.abs(w.master) < 1e-4
}

const EPS = 1e-4

export function isNeutralGrade(g: LayerColorGrade | undefined | null): boolean {
  if (!g) return true
  return (
    Math.abs(g.exposure ?? 0) < EPS &&
    Math.abs(g.contrast ?? 0) < EPS &&
    Math.abs(g.saturation ?? 0) < EPS &&
    Math.abs(g.temperature ?? 0) < EPS &&
    Math.abs(g.tint ?? 0) < EPS &&
    Math.abs(g.hue ?? 0) < EPS &&
    Math.abs(g.vignette ?? 0) < EPS &&
    Math.abs(g.sharpen ?? 0) < EPS &&
    isNeutralWheel(g.lift) &&
    isNeutralWheel(g.gamma) &&
    isNeutralWheel(g.gain) &&
    isIdentityToneCurve(g.curves)
  )
}

/** True when the grade needs the SVG filter (matrix/curve work CSS can't do). */
export function gradeNeedsSvgFilter(g: LayerColorGrade | undefined | null): boolean {
  if (!g) return false
  return (
    Math.abs(g.temperature ?? 0) > EPS ||
    Math.abs(g.tint ?? 0) > EPS ||
    Math.abs(g.sharpen ?? 0) > EPS ||
    !isNeutralWheel(g.lift) ||
    !isNeutralWheel(g.gamma) ||
    !isNeutralWheel(g.gain) ||
    !isIdentityToneCurve(g.curves)
  )
}

/** True when the grade has per-channel transfer work (wheels or curves). */
function hasTransferWork(g: LayerColorGrade): boolean {
  return (
    !isNeutralWheel(g.lift) || !isNeutralWheel(g.gamma) || !isNeutralWheel(g.gain) || !isIdentityToneCurve(g.curves)
  )
}

/**
 * CDL-style per-channel transfer from the three wheels:
 *   out = clamp(in × slope + offset) ^ power
 * gain → slope (highlight scale), lift → offset (shadow floor),
 * gamma → power (midtone bend; wheel up = brighter mids = power < 1).
 */
export function wheelTransfer(g: LayerColorGrade, channel: 'r' | 'g' | 'b'): (x: number) => number {
  const lift = ((g.lift?.[channel] ?? 0) + (g.lift?.master ?? 0)) * 0.25
  const gainV = 1 + ((g.gain?.[channel] ?? 0) + (g.gain?.master ?? 0)) * 0.5
  const gammaV = Math.pow(2, -((g.gamma?.[channel] ?? 0) + (g.gamma?.master ?? 0)) * 0.75)
  return (x: number) => {
    const v = clamp(x * gainV + lift, 0, 1)
    return Math.pow(v, gammaV)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** Channel gains for the white-balance matrix (warm = +R −B, magenta = −G). */
export function temperatureTintGains(temperature: number, tint: number): { r: number; g: number; b: number } {
  const t = clamp(temperature, -1, 1)
  const ti = clamp(tint, -1, 1)
  return {
    r: round(1 + 0.18 * t + 0.06 * ti),
    g: round(1 - 0.12 * ti),
    b: round(1 - 0.18 * t + 0.06 * ti),
  }
}

const CURVE_TABLE_SAMPLES = 64

/** feComponentTransfer tableValues (downsampled from the 256-LUT). */
function curveTable(lut: Uint8Array): string {
  const out: string[] = []
  for (let i = 0; i < CURVE_TABLE_SAMPLES; i++) {
    const idx = Math.round((i / (CURVE_TABLE_SAMPLES - 1)) * 255)
    out.push(String(Math.round((lut[idx] / 255) * 1000) / 1000))
  }
  return out.join(' ')
}

/**
 * Inner markup for an SVG <filter> implementing the matrix/curve part of the
 * grade. Returns '' when nothing needs the SVG path. `color-interpolation-
 * filters: sRGB` keeps the math in the same space the CSS functions use.
 */
export function gradeSvgFilterContent(g: LayerColorGrade): string {
  const parts: string[] = []
  const needsWb = Math.abs(g.temperature ?? 0) > EPS || Math.abs(g.tint ?? 0) > EPS
  if (needsWb) {
    const { r, g: gg, b } = temperatureTintGains(g.temperature ?? 0, g.tint ?? 0)
    parts.push(`<feColorMatrix type="matrix" values="${r} 0 0 0 0  0 ${gg} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0"/>`)
  }
  const tables = gradeTransferTables(g)
  if (tables) {
    parts.push(
      `<feComponentTransfer>` +
        `<feFuncR type="table" tableValues="${tables.r}"/>` +
        `<feFuncG type="table" tableValues="${tables.g}"/>` +
        `<feFuncB type="table" tableValues="${tables.b}"/>` +
        `</feComponentTransfer>`,
    )
  }
  const sharpenKernel = sharpenMatrix(g.sharpen ?? 0)
  if (sharpenKernel) {
    parts.push(`<feConvolveMatrix order="3" kernelMatrix="${sharpenKernel}" preserveAlpha="true"/>`)
  }
  return parts.join('')
}

/** Unsharp 3×3 kernel (sums to 1) — null when sharpen is off. */
export function sharpenMatrix(amount: number): string | null {
  const a = clamp(amount, 0, 1) * 0.8
  if (a < EPS) return null
  const edge = round(-a)
  const center = round(1 + 4 * a)
  return `0 ${edge} 0 ${edge} ${center} ${edge} 0 ${edge} 0`
}

/**
 * Per-channel feComponentTransfer tableValues — the WHEELS' CDL transfer
 * composed with the tone CURVES (curves evaluate after the wheels, matching
 * the DaVinci node order: primaries → curves). Null = identity.
 */
export function gradeTransferTables(g: LayerColorGrade | undefined | null): { r: string; g: string; b: string } | null {
  if (!g || !hasTransferWork(g)) return null
  const curveLuts = isIdentityToneCurve(g.curves) ? null : buildChannelLuts(g.curves ?? {}, 1)
  const out = { r: '', g: '', b: '' }
  for (const ch of ['r', 'g', 'b'] as const) {
    const transfer = wheelTransfer(g, ch)
    const lut = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const x = transfer(i / 255)
      const y = curveLuts ? curveLuts[ch][Math.round(clamp(x, 0, 1) * 255)] / 255 : x
      lut[i] = Math.round(clamp(y, 0, 1) * 255)
    }
    out[ch] = curveTable(lut)
  }
  return out
}

/** Full <filter> element (id + sRGB interpolation), '' when not needed. */
export function gradeSvgFilterMarkup(g: LayerColorGrade | undefined | null, filterId: string): string {
  if (!g || !gradeNeedsSvgFilter(g)) return ''
  const content = gradeSvgFilterContent(g)
  if (!content) return ''
  return `<filter id="${filterId}" color-interpolation-filters="sRGB">${content}</filter>`
}

/**
 * CSS filter chain for the grade: the CSS-expressible sliders, plus a
 * url(#…) reference when the SVG part is in play. `lookCss` (the preset
 * Look from grade-css.ts) composes in front, matching the Lumetri stack
 * order: Look first, correction after.
 */
export function gradeToCssChain(
  g: LayerColorGrade | undefined | null,
  opts?: { lookCss?: string; svgFilterId?: string | null },
): string {
  const parts: string[] = []
  if (opts?.lookCss?.trim()) parts.push(opts.lookCss.trim())
  if (g) {
    const exposure = clamp(g.exposure ?? 0, -1, 1)
    const contrast = clamp(g.contrast ?? 0, -1, 1)
    const saturation = clamp(g.saturation ?? 0, -1, 1)
    const hue = clamp(g.hue ?? 0, -180, 180)
    if (Math.abs(exposure) > EPS) parts.push(`brightness(${round(Math.pow(2, exposure))})`)
    if (Math.abs(contrast) > EPS) parts.push(`contrast(${round(1 + contrast)})`)
    if (Math.abs(saturation) > EPS) parts.push(`saturate(${round(1 + saturation)})`)
    if (Math.abs(hue) > EPS) parts.push(`hue-rotate(${round(hue)}deg)`)
    if (opts?.svgFilterId && gradeNeedsSvgFilter(g)) parts.push(`url(#${opts.svgFilterId})`)
  }
  return parts.join(' ')
}
