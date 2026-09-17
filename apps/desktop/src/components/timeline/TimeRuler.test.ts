import { describe, it, expect } from 'vitest'
import { getTickInterval } from './TimeRuler'

// The ruler's contract: at every zoom level, adjacent major labels stay at
// least ~80px apart (so they never overlap) and minor ticks at least ~8px
// apart (so they read as ticks, not a solid line). Standard NLE behaviour: the
// pixel spacing stays constant; only the *interval* each tick represents
// changes with zoom.
//
// Without these guarantees the ruler renders crammed-together labels like
// "02:03:04:05..." at moderate zoom — the bug that triggered this rewrite.

const MIN_MAJOR_PX = 80
const MIN_MINOR_PX = 8

describe('getTickInterval — major label spacing', () => {
  // Sweep pps across the zoom range Dreambyte actually uses (zoom-out at
  // <1px/s up to frame-level zoom-in at >fps px/s).
  const pps_values = [0.5, 1, 2, 5, 10, 20, 30, 50, 80, 120, 200, 400, 800, 1500, 3000]

  for (const pps of pps_values) {
    it(`at pps=${pps}, major * pps stays >= ${MIN_MAJOR_PX}px`, () => {
      const { major } = getTickInterval(pps, 30)
      expect(major * pps).toBeGreaterThanOrEqual(MIN_MAJOR_PX)
    })

    it(`at pps=${pps}, minor * pps stays >= ${MIN_MINOR_PX}px`, () => {
      const { minor } = getTickInterval(pps, 30)
      expect(minor * pps).toBeGreaterThanOrEqual(MIN_MINOR_PX)
    })

    it(`at pps=${pps}, major is a clean multiple of minor`, () => {
      const { major, minor } = getTickInterval(pps, 30)
      // Use index-based ratio (matches the renderer) so floating-point
      // sub-second intervals (1/30 etc.) still pass.
      const ratio = Math.round(major / minor)
      expect(Math.abs(major - ratio * minor)).toBeLessThan(1e-6)
      expect(ratio).toBeGreaterThanOrEqual(1)
    })
  }

  it('picks frame-level ticks when zoomed past 1 frame ≈ MIN_MAJOR_PX', () => {
    // 30fps × 80px ≈ 2400 pps before we're forced to 1-frame majors.
    const { major } = getTickInterval(3000, 30)
    expect(major).toBeLessThanOrEqual(1 / 30 + 1e-6)
  })

  it('falls back to hour-level intervals when fully zoomed out', () => {
    // 0.01 pps × 3600s = 36px — below MIN_MAJOR_PX, so the picker should
    // settle on the largest candidate (7200s) without crashing.
    const { major } = getTickInterval(0.01, 30)
    expect(major).toBeGreaterThanOrEqual(3600)
  })

  it('respects fps when computing frame-aligned intervals', () => {
    // At 60fps the 1-frame candidate is 1/60s, half the 30fps value, so the
    // first qualifying major at high pps should drop to 1/60 sooner.
    const r30 = getTickInterval(2500, 30)
    const r60 = getTickInterval(2500, 60)
    expect(r60.major).toBeLessThanOrEqual(r30.major + 1e-6)
  })
})
