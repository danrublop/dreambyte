// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  evaluateCurve,
  buildChannelLuts,
  isIdentityCurve,
  isIdentityToneCurve,
  normalizePoints,
  IDENTITY_CURVE,
  MIN_POINT_GAP,
} from './tone-curve'

describe('evaluateCurve', () => {
  it('identity points evaluate to y = x', () => {
    for (const x of [0, 0.25, 0.5, 0.77, 1]) {
      expect(evaluateCurve(IDENTITY_CURVE, x)).toBeCloseTo(x, 6)
    }
  })

  it('passes exactly through control points', () => {
    const pts = [
      { x: 0, y: 0.1 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.9 },
    ]
    expect(evaluateCurve(pts, 0)).toBeCloseTo(0.1, 6)
    expect(evaluateCurve(pts, 0.5)).toBeCloseTo(0.8, 6)
    expect(evaluateCurve(pts, 1)).toBeCloseTo(0.9, 6)
  })

  it('is monotone between monotone control points (no overshoot)', () => {
    // A steep S — natural cubic splines overshoot here; Fritsch–Carlson must not.
    const pts = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.05 },
      { x: 0.6, y: 0.95 },
      { x: 1, y: 1 },
    ]
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const y = evaluateCurve(pts, i / 100)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      prev = y
    }
  })

  it('clamps flat outside the control-point span', () => {
    const pts = [
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.7 },
    ]
    expect(evaluateCurve(pts, 0)).toBeCloseTo(0.3, 6)
    expect(evaluateCurve(pts, 1)).toBeCloseTo(0.7, 6)
  })
})

describe('buildChannelLuts', () => {
  it('identity curve yields identity LUTs', () => {
    const luts = buildChannelLuts({ rgb: IDENTITY_CURVE })
    expect(luts.r[0]).toBe(0)
    expect(luts.r[255]).toBe(255)
    expect(luts.g[128]).toBe(128)
  })

  it('master rgb feeds all channels; per-channel composes after', () => {
    const lift = [
      { x: 0, y: 0.2 },
      { x: 1, y: 1 },
    ]
    const luts = buildChannelLuts({ rgb: lift })
    expect(luts.r[0]).toBe(51) // 0.2 * 255
    expect(luts.b[0]).toBe(51)
    // r-channel crush composes after master lift: r(master(0)) = r(0.2)
    const crush = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.1 },
      { x: 1, y: 1 },
    ]
    const composed = buildChannelLuts({ rgb: lift, r: crush })
    expect(composed.r[0]).toBeLessThan(51)
    expect(composed.g[0]).toBe(51) // g untouched by r curve
  })

  it('intensity 0 is identity, 0.5 is halfway', () => {
    const lift = [
      { x: 0, y: 0.4 },
      { x: 1, y: 1 },
    ]
    expect(buildChannelLuts({ rgb: lift }, 0).r[0]).toBe(0)
    expect(buildChannelLuts({ rgb: lift }, 0.5).r[0]).toBe(51) // 0.2 * 255
  })
})

describe('identity detection + normalize', () => {
  it('detects identity curves and whole-identity tone curves', () => {
    expect(isIdentityCurve(IDENTITY_CURVE)).toBe(true)
    expect(isIdentityCurve(undefined)).toBe(true)
    expect(
      isIdentityCurve([
        { x: 0, y: 0.1 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false)
    expect(isIdentityToneCurve({ rgb: IDENTITY_CURVE })).toBe(true)
    expect(
      isIdentityToneCurve({
        r: [
          { x: 0, y: 0.3 },
          { x: 1, y: 1 },
        ],
      }),
    ).toBe(false)
  })

  it('normalizePoints clamps, sorts, and enforces the min gap', () => {
    const out = normalizePoints([
      { x: 0.5, y: 1.4 },
      { x: -0.2, y: 0 },
      { x: 0.5 + MIN_POINT_GAP / 4, y: 0.5 },
    ])
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[1].y).toBe(1)
    expect(out[2].x - out[1].x).toBeGreaterThanOrEqual(MIN_POINT_GAP - 1e-9)
  })
})
