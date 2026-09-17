// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  isNeutralGrade,
  gradeNeedsSvgFilter,
  gradeSvgFilterMarkup,
  gradeToCssChain,
  temperatureTintGains,
  wheelTransfer,
  gradeTransferTables,
  sharpenMatrix,
} from './layer-grade'

describe('layer-grade', () => {
  it('neutral detection', () => {
    expect(isNeutralGrade(undefined)).toBe(true)
    expect(isNeutralGrade({})).toBe(true)
    expect(isNeutralGrade({ exposure: 0, contrast: 0 })).toBe(true)
    expect(isNeutralGrade({ exposure: 0.2 })).toBe(false)
    expect(
      isNeutralGrade({
        curves: {
          rgb: [
            { x: 0, y: 0.2 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toBe(false)
  })

  it('CSS-only sliders never demand the SVG filter; temp/tint/curves do', () => {
    expect(gradeNeedsSvgFilter({ exposure: 0.5, contrast: 0.3, saturation: -0.2, hue: 45 })).toBe(false)
    expect(gradeNeedsSvgFilter({ temperature: 0.3 })).toBe(true)
    expect(gradeNeedsSvgFilter({ tint: -0.2 })).toBe(true)
    expect(
      gradeNeedsSvgFilter({
        curves: {
          r: [
            { x: 0, y: 0.1 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toBe(true)
  })

  it('warm temperature raises R gain and lowers B; magenta tint lowers G', () => {
    const warm = temperatureTintGains(1, 0)
    expect(warm.r).toBeGreaterThan(1)
    expect(warm.b).toBeLessThan(1)
    const magenta = temperatureTintGains(0, 1)
    expect(magenta.g).toBeLessThan(1)
    const green = temperatureTintGains(0, -1)
    expect(green.g).toBeGreaterThan(1)
  })

  it('SVG markup contains the matrix and curve tables only when needed', () => {
    expect(gradeSvgFilterMarkup({ exposure: 0.5 }, 'f1')).toBe('')
    const wb = gradeSvgFilterMarkup({ temperature: 0.5 }, 'f1')
    expect(wb).toContain('feColorMatrix')
    expect(wb).toContain('id="f1"')
    expect(wb).toContain('color-interpolation-filters="sRGB"')
    const curved = gradeSvgFilterMarkup(
      {
        curves: {
          rgb: [
            { x: 0, y: 0.2 },
            { x: 1, y: 1 },
          ],
        },
      },
      'f2',
    )
    expect(curved).toContain('feComponentTransfer')
    expect(curved).toContain('feFuncR')
  })

  it('CSS chain composes look + sliders + url reference in stack order', () => {
    const css = gradeToCssChain(
      { exposure: 1, contrast: 0.2, saturation: 0.5, hue: 30, temperature: 0.4 },
      { lookCss: 'sepia(0.18) saturate(1.1)', svgFilterId: 'grade-x' },
    )
    expect(css.startsWith('sepia(0.18) saturate(1.1)')).toBe(true)
    expect(css).toContain('brightness(2)') // 2^1
    expect(css).toContain('contrast(1.2)')
    expect(css).toContain('saturate(1.5)')
    expect(css).toContain('hue-rotate(30deg)')
    expect(css.endsWith('url(#grade-x)')).toBe(true)
    // Neutral grade + no look = empty chain
    expect(gradeToCssChain({}, {})).toBe('')
  })
})

describe('wheels (lift/gamma/gain)', () => {
  const W = (over: Partial<import('./layer-grade').WheelValue>) => ({ r: 0, g: 0, b: 0, master: 0, ...over })

  it('neutral wheels are neutral; any puck/master offset is not', () => {
    expect(isNeutralGrade({ lift: W({}) })).toBe(true)
    expect(isNeutralGrade({ lift: W({ master: 0.2 }) })).toBe(false)
    expect(isNeutralGrade({ gain: W({ r: 0.3 }) })).toBe(false)
    expect(gradeNeedsSvgFilter({ gamma: W({ master: 0.5 }) })).toBe(true)
  })

  it('gain scales highlights, lift raises shadows, gamma bends mids', () => {
    const gainUp = wheelTransfer({ gain: W({ master: 0.5 }) }, 'r')
    expect(gainUp(0.8)).toBeGreaterThan(0.8)
    expect(gainUp(0)).toBeCloseTo(0, 5)
    const liftUp = wheelTransfer({ lift: W({ master: 0.5 }) }, 'r')
    expect(liftUp(0)).toBeGreaterThan(0)
    const gammaUp = wheelTransfer({ gamma: W({ master: 0.5 }) }, 'r')
    expect(gammaUp(0.5)).toBeGreaterThan(0.5)
    expect(gammaUp(0)).toBeCloseTo(0, 5)
    expect(gammaUp(1)).toBeCloseTo(1, 5)
  })

  it('per-channel wheel offsets only move their channel', () => {
    const tables = gradeTransferTables({ lift: W({ r: 0.5 }) })!
    expect(tables.r).not.toBe(tables.g)
    expect(tables.g).toBe(tables.b) // g and b stay identity together
  })

  it('wheels compose with curves in the transfer tables', () => {
    const withBoth = gradeTransferTables({
      gain: W({ master: 0.4 }),
      curves: {
        rgb: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      },
    })!
    const first = Number(withBoth.r.split(' ')[0])
    expect(first).toBeGreaterThan(0) // curve lifted blacks survive composition
  })
})

describe('vignette + sharpen', () => {
  it('sharpen produces a normalized 3×3 kernel only when on', () => {
    expect(sharpenMatrix(0)).toBeNull()
    const k = sharpenMatrix(1)!.split(' ').map(Number)
    expect(k).toHaveLength(9)
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
    expect(gradeNeedsSvgFilter({ sharpen: 0.5 })).toBe(true)
  })

  it('vignette marks the grade non-neutral but needs no SVG filter', () => {
    expect(isNeutralGrade({ vignette: 0.5 })).toBe(false)
    expect(gradeNeedsSvgFilter({ vignette: 0.5 })).toBe(false)
  })
})
