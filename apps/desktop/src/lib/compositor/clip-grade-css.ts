/**
 * CSS tier of the per-clip color grade: compiles a ClipColorGrade into
 *   - a CSS `filter` string for what CSS can express natively (exposure → brightness,
 *     contrast, saturation/vibrance → saturate)
 *   - SVG <filter> primitives for the rest: a white-balance feColorMatrix followed by
 *     one feComponentTransfer whose per-channel tables bake tonal primaries, the
 *     lift/gamma/gain wheels and the tone curves
 *   - the vignette amount (drawn by the host as an overlay)
 *
 * Pure strings, shared by the preview (src/components/preview/ClipGradeSvgFilter.tsx builds
 * the same nodes as JSX) and the export host, so both resolve an identical filter.
 * LUTs and hue curves are not representable here; they belong to the WebGL tier.
 */

import type { ClipColorGrade, CurvePoint } from '@/lib/edit-engines/clip-grade'
import { isNeutralClipGrade, wheelChromaOffset } from '@/lib/edit-engines/clip-grade'
import { evaluateCurve } from '@/lib/edit-engines/tone-curve'

export interface ClipGradeCss {
  /** Space-separated CSS filter functions ('' when none). */
  filterCss: string
  /** Inner markup for an SVG <filter> ('' when no SVG work is needed). */
  svgFilterContent: string
  /** Vignette amount clamped to 0..1. */
  vignette: number
}

const EPS = 1e-4
const TABLE_SIZE = 64

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const round4 = (v: number): number => Math.round(v * 10000) / 10000
const num = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

// Rec.709 luma weights, used to keep white balance brightness-neutral.
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/**
 * Per-channel multipliers for a temperature (K) / tint look. Temperature maps
 * linearly from 2000..6500..11000 K onto a -1..0..1 warmth that trades red against
 * blue; tint (-100..100) trades green against red+blue. The result is divided by its
 * own luma so overall brightness stays put. Exactly {1,1,1} at 6500 K / tint 0.
 */
export function whiteBalanceGains(temperatureK: number, tint: number): { r: number; g: number; b: number } {
  const k = num(temperatureK, 6500)
  const warm = k >= 6500 ? clamp((k - 6500) / 4500, 0, 1) : clamp((k - 6500) / 4500, -1, 0)
  const green = clamp(num(tint, 0) / 100, -1, 1)
  const r = (1 + 0.25 * warm) * (1 - 0.1 * green)
  const g = 1 + 0.2 * green
  const b = (1 - 0.25 * warm) * (1 - 0.1 * green)
  const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b
  return { r: round4(r / luma), g: round4(g / luma), b: round4(b / luma) }
}

/**
 * Evaluate a tone curve at `x` with the same monotone cubic the curve editor draws
 * (src/lib/edit-engines/tone-curve.ts), so what the user shapes is what renders. Beyond
 * the first/last point the curve holds that point's y. A missing curve, or one with
 * fewer than two points, is the identity.
 */
export function evalCurve(points: CurvePoint[] | undefined, x: number): number {
  if (!points || points.length < 2) return x
  return evaluateCurve(points, x)
}

function needsWhiteBalance(g: ClipColorGrade): boolean {
  return Math.abs(num(g.temperature, 6500) - 6500) > 1 || Math.abs(num(g.tint, 0)) > EPS
}

type Channel = 'r' | 'g' | 'b'

/**
 * The per-channel 0..1 → 0..1 transfer for tonal primaries, wheels and curves. Both
 * tiers bake it into a lookup table (SVG feComponentTransfer here, the channel-curve
 * texture in grade-gl.ts), so they cannot disagree on these ops.
 */
export function gradeChannelTransfer(g: ClipColorGrade, ch: Channel): (x: number) => number {
  const blacks = clamp(num(g.blacks, 0), -1, 1) * 0.1
  const whites = clamp(num(g.whites, 0), -1, 1) * 0.15
  const shadows = clamp(num(g.shadows, 0), -1, 1) * 1.35
  const highlights = clamp(num(g.highlights, 0), -1, 1) * 1.35

  const sh = g.wheels?.shadows
  const md = g.wheels?.mids
  const hi = g.wheels?.highlights
  const lift = num(sh?.lum, 0) + wheelChromaOffset(num(sh?.hue, 0), num(sh?.amount, 0))[ch]
  const gamma = Math.max(0.05, num(md?.gamma, 1) + wheelChromaOffset(num(md?.hue, 0), num(md?.amount, 0))[ch])
  const gain = num(hi?.gain, 1) + wheelChromaOffset(num(hi?.hue, 0), num(hi?.amount, 0))[ch]

  const master = g.curves?.master
  const channelCurve = ch === 'r' ? g.curves?.red : ch === 'g' ? g.curves?.green : g.curves?.blue

  return (x: number) => {
    let y = x
    // Tonal primaries: black/white points as linear remaps, shadows/highlights as
    // smooth bumps that vanish at both ends (peaking near 1/3 and 2/3).
    y = blacks >= 0 ? blacks + y * (1 - blacks) : (y + blacks) / (1 + blacks)
    y = clamp(y * (1 + whites), 0, 1)
    y = y + shadows * y * (1 - y) * (1 - y) + highlights * y * y * (1 - y)
    // Wheels: lift raises the floor keeping white fixed, gain scales, gamma bends mids.
    y = clamp(lift + y * (1 - lift), 0, 1)
    y = clamp(y * gain, 0, 1)
    y = Math.pow(y, 1 / gamma)
    // Curves: master, then the channel's own curve.
    y = evalCurve(channelCurve, evalCurve(master, y))
    return clamp(y, 0, 1)
  }
}

/**
 * feComponentTransfer `tableValues` per channel, or null when the transfer would be
 * the identity on every channel (no tonal primaries, wheels or curves in effect).
 */
export function gradeTransferTables(g: ClipColorGrade): { r: string; g: string; b: string } | null {
  const out = { r: '', g: '', b: '' }
  let identity = true
  for (const ch of ['r', 'g', 'b'] as const) {
    const f = gradeChannelTransfer(g, ch)
    const values: number[] = []
    for (let i = 0; i < TABLE_SIZE; i++) {
      const x = i / (TABLE_SIZE - 1)
      const y = round4(f(x))
      if (Math.abs(y - x) > EPS) identity = false
      values.push(y)
    }
    out[ch] = values.join(' ')
  }
  return identity ? null : out
}

/** Global saturation actually applied (vibrance folded in), shared by both tiers. */
export function effectiveSaturation(g: ClipColorGrade): number {
  // Vibrance approximated as a gentler global saturation; true
  // saturation-weighted vibrance needs per-pixel math.
  return clamp(num(g.saturation, 1), 0, 2) * (1 + 0.5 * clamp(num(g.vibrance, 0), -1, 1))
}

function filterCssFor(g: ClipColorGrade): string {
  const parts: string[] = []
  const exposure = clamp(num(g.exposure, 0), -3, 3)
  if (Math.abs(exposure) > EPS) parts.push(`brightness(${round4(Math.pow(2, exposure))})`)
  const contrast = clamp(num(g.contrast, 1), 0.5, 1.5)
  if (Math.abs(contrast - 1) > EPS) parts.push(`contrast(${round4(contrast)})`)
  const saturation = effectiveSaturation(g)
  if (Math.abs(saturation - 1) > EPS) parts.push(`saturate(${round4(saturation)})`)
  return parts.join(' ')
}

function svgContentFor(g: ClipColorGrade): string {
  let out = ''
  if (needsWhiteBalance(g)) {
    const wb = whiteBalanceGains(num(g.temperature, 6500), num(g.tint, 0))
    out += `<feColorMatrix type="matrix" values="${wb.r} 0 0 0 0  0 ${wb.g} 0 0 0  0 0 ${wb.b} 0 0  0 0 0 1 0"/>`
  }
  const t = gradeTransferTables(g)
  if (t) {
    out +=
      '<feComponentTransfer>' +
      `<feFuncR type="table" tableValues="${t.r}"/>` +
      `<feFuncG type="table" tableValues="${t.g}"/>` +
      `<feFuncB type="table" tableValues="${t.b}"/>` +
      '</feComponentTransfer>'
  }
  return out
}

export function compileClipGradeCss(g: ClipColorGrade | undefined | null): ClipGradeCss {
  if (!g || isNeutralClipGrade(g)) return { filterCss: '', svgFilterContent: '', vignette: 0 }
  return {
    filterCss: filterCssFor(g),
    svgFilterContent: svgContentFor(g),
    vignette: clamp(num(g.vignette, 0), 0, 1),
  }
}

/** Complete `<filter>` element for the grade's SVG part, or '' when there is none. */
export function clipGradeSvgFilterMarkup(g: ClipColorGrade | undefined | null, filterId: string): string {
  if (!g) return ''
  const content = svgContentFor(g)
  return content ? `<filter id="${filterId}" color-interpolation-filters="sRGB">${content}</filter>` : ''
}
