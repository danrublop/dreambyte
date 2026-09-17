import { describe, it, expect } from 'vitest'
import { evaluateCurve } from '@/lib/edit-engines/tone-curve'
import {
  compileClipGradeCss,
  clipGradeSvgFilterMarkup,
  whiteBalanceGains,
  evalCurve,
  gradeTransferTables,
} from './clip-grade-css'

describe('compileClipGradeCss', () => {
  it('returns empty for a neutral grade', () => {
    expect(compileClipGradeCss(undefined)).toEqual({ filterCss: '', svgFilterContent: '', vignette: 0 })
    expect(compileClipGradeCss({})).toEqual({ filterCss: '', svgFilterContent: '', vignette: 0 })
  })

  it('maps exposure to brightness 2^EV', () => {
    const c = compileClipGradeCss({ exposure: 1 })
    expect(c.filterCss).toContain('brightness(2)')
  })

  it('maps contrast and saturation to CSS functions', () => {
    const c = compileClipGradeCss({ contrast: 1.2, saturation: 0.8 })
    expect(c.filterCss).toContain('contrast(1.2)')
    expect(c.filterCss).toContain('saturate(0.8)')
  })

  it('emits a white-balance feColorMatrix for temperature/tint', () => {
    const c = compileClipGradeCss({ temperature: 8000, tint: 20 })
    expect(c.svgFilterContent).toContain('feColorMatrix')
  })

  it('emits a feComponentTransfer for wheels/curves', () => {
    const c = compileClipGradeCss({ wheels: { shadows: { hue: 200, amount: 0.2 } } })
    expect(c.svgFilterContent).toContain('feComponentTransfer')
    expect(c.svgFilterContent).toContain('feFuncR')
  })

  it('passes vignette through clamped', () => {
    expect(compileClipGradeCss({ vignette: 0.4 }).vignette).toBe(0.4)
    expect(compileClipGradeCss({ vignette: 2 }).vignette).toBe(1)
  })

  it('ignores LUT / hue curves (those are the WebGL tier)', () => {
    const c = compileClipGradeCss({ lut: { path: '/x.cube', dimension: 33 } })
    // a LUT-only grade contributes nothing to the CSS tier
    expect(c.filterCss).toBe('')
    expect(c.svgFilterContent).toBe('')
  })
})

describe('clipGradeSvgFilterMarkup', () => {
  it('wraps content in a <filter> with the given id', () => {
    const m = clipGradeSvgFilterMarkup({ temperature: 8000 }, 'clip-grade-abc')
    expect(m).toContain('<filter id="clip-grade-abc"')
    expect(m).toContain('color-interpolation-filters="sRGB"')
  })

  it('returns empty when there is no SVG work', () => {
    expect(clipGradeSvgFilterMarkup({ exposure: 1 }, 'id')).toBe('')
  })
})

describe('whiteBalanceGains', () => {
  it('warms (more R, less B) above 6500 K', () => {
    const g = whiteBalanceGains(9000, 0)
    expect(g.r).toBeGreaterThan(1)
    expect(g.b).toBeLessThan(1)
  })
  it('cools below 6500 K', () => {
    const g = whiteBalanceGains(4000, 0)
    expect(g.r).toBeLessThan(1)
    expect(g.b).toBeGreaterThan(1)
  })
})

describe('evalCurve', () => {
  it('identity by default', () => {
    expect(evalCurve(undefined, 0.5)).toBeCloseTo(0.5, 5)
  })
  it('interpolates a lifted toe', () => {
    const pts = [
      { x: 0, y: 0.1 },
      { x: 1, y: 1 },
    ]
    expect(evalCurve(pts, 0)).toBeCloseTo(0.1, 5)
    expect(evalCurve(pts, 1)).toBeCloseTo(1, 5)
  })
  it('clamps flat outside the range', () => {
    const pts = [
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.7 },
    ]
    expect(evalCurve(pts, 0)).toBeCloseTo(0.3, 5)
    expect(evalCurve(pts, 1)).toBeCloseTo(0.7, 5)
  })
})

describe('white balance / transfer tables', () => {
  it('is exactly neutral at 6500 K and tint 0', () => {
    expect(whiteBalanceGains(6500, 0)).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('positive tint pushes green, negative pushes magenta', () => {
    const green = whiteBalanceGains(6500, 50)
    expect(green.g).toBeGreaterThan(green.r)
    expect(green.g).toBeGreaterThan(green.b)
    const magenta = whiteBalanceGains(6500, -50)
    expect(magenta.g).toBeLessThan(magenta.r)
  })

  it('transfer tables are null for neutral grades and identity curves', () => {
    expect(gradeTransferTables({})).toBeNull()
    expect(gradeTransferTables({ exposure: 1, temperature: 9000 })).toBeNull()
    expect(
      gradeTransferTables({
        curves: {
          master: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toBeNull()
  })

  it('a lifted-toe master curve raises the table floor on every channel', () => {
    const t = gradeTransferTables({
      curves: {
        master: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      },
    })!
    for (const ch of [t.r, t.g, t.b]) {
      const vals = ch.split(' ').map(Number)
      expect(vals[0]).toBeCloseTo(0.1, 4)
      expect(vals[vals.length - 1]).toBeCloseTo(1, 4)
    }
  })

  it('a shadows teal push lowers red and raises green/blue at the low end', () => {
    const t = gradeTransferTables({ wheels: { shadows: { hue: 180, amount: 0.3 } } })!
    const first = (s: string) => Number(s.split(' ')[1])
    expect(first(t.r)).toBeLessThan(first(t.g))
    expect(first(t.b)).toBeCloseTo(first(t.g), 4)
  })

  it('primaries CSS output composes brightness/contrast/saturate in order', () => {
    expect(compileClipGradeCss({ exposure: -1, contrast: 1.1, saturation: 1.5 }).filterCss).toBe(
      'brightness(0.5) contrast(1.1) saturate(1.5)',
    )
  })
})

describe('evalCurve interpolation', () => {
  it('passes through unsorted control points and is the same monotone cubic the curve editor draws', () => {
    const pts = [
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
    ]
    expect(evalCurve(pts, 0.5)).toBeCloseTo(0.8, 5)
    for (let x = 0; x <= 1; x += 0.05) expect(evalCurve(pts, x)).toBeCloseTo(evaluateCurve(pts, x), 10)
    // smooth, not piecewise-linear: bows above the chord between control points
    expect(evalCurve(pts, 0.25)).toBeGreaterThan(0.4)
    // monotone: no overshoot between points
    let prev = -1
    for (let x = 0; x <= 1; x += 0.01) {
      const y = evalCurve(pts, x)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })
})
