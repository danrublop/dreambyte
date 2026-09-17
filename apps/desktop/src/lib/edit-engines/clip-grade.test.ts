import { describe, it, expect } from 'vitest'
import {
  isNeutralClipGrade,
  gradeRenderTier,
  mergeClipGrade,
  wheelChromaOffset,
  hasLut,
  hasHueCurves,
  type ClipColorGrade,
} from './clip-grade'

describe('isNeutralClipGrade', () => {
  it('treats absent / empty as neutral', () => {
    expect(isNeutralClipGrade(undefined)).toBe(true)
    expect(isNeutralClipGrade(null)).toBe(true)
    expect(isNeutralClipGrade({})).toBe(true)
  })

  it('treats explicit neutral values as neutral', () => {
    expect(isNeutralClipGrade({ exposure: 0, contrast: 1, saturation: 1, temperature: 6500 })).toBe(true)
  })

  it('detects a non-neutral exposure', () => {
    expect(isNeutralClipGrade({ exposure: 0.5 })).toBe(false)
  })

  it('detects a non-neutral wheel', () => {
    expect(isNeutralClipGrade({ wheels: { shadows: { hue: 180, amount: 0.2 } } })).toBe(false)
  })

  it('detects a LUT', () => {
    expect(isNeutralClipGrade({ lut: { path: '/x.cube', dimension: 33 } })).toBe(false)
  })
})

describe('gradeRenderTier', () => {
  it('none for neutral', () => {
    expect(gradeRenderTier({})).toBe('none')
  })
  it('css for primaries/wheels/curves', () => {
    expect(gradeRenderTier({ exposure: 1 })).toBe('css')
    expect(gradeRenderTier({ wheels: { mids: { hue: 30, amount: 0.3 } } })).toBe('css')
    expect(
      gradeRenderTier({
        curves: {
          master: [
            { x: 0, y: 0.1 },
            { x: 1, y: 0.9 },
          ],
        },
      }),
    ).toBe('css')
  })
  it('webgl when a LUT is present', () => {
    expect(gradeRenderTier({ lut: { path: '/x.cube', dimension: 33, strength: 1 } })).toBe('webgl')
  })
  it('webgl when hue curves are present', () => {
    expect(gradeRenderTier({ hueCurves: { targets: [{ targetHue: 30, satScale: 0.5 }] } })).toBe('webgl')
  })
})

describe('mergeClipGrade', () => {
  it('only changes passed scalars (nudge one knob)', () => {
    const prev: ClipColorGrade = { exposure: 0.5, contrast: 1.2 }
    const next = mergeClipGrade(prev, { contrast: 1.3 })
    expect(next.exposure).toBe(0.5)
    expect(next.contrast).toBe(1.3)
  })

  it('reset starts from neutral', () => {
    const prev: ClipColorGrade = { exposure: 0.5, contrast: 1.2 }
    const next = mergeClipGrade(prev, { saturation: 1.4 }, { reset: true })
    expect(next.exposure).toBeUndefined()
    expect(next.contrast).toBeUndefined()
    expect(next.saturation).toBe(1.4)
  })

  it('merges wheels per zone and field', () => {
    const prev: ClipColorGrade = { wheels: { shadows: { hue: 180, amount: 0.2 } } }
    const next = mergeClipGrade(prev, { wheels: { shadows: { amount: 0.3 }, highlights: { hue: 30, amount: 0.1 } } })
    expect(next.wheels?.shadows).toEqual({ hue: 180, amount: 0.3 })
    expect(next.wheels?.highlights).toEqual({ hue: 30, amount: 0.1 })
  })

  it('replaces a curve channel', () => {
    const prev: ClipColorGrade = {
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    }
    const next = mergeClipGrade(prev, {
      curves: {
        red: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      },
    })
    expect(next.curves?.master).toBeDefined()
    expect(next.curves?.red).toBeDefined()
  })

  it('lut strength-only re-blends existing', () => {
    const prev: ClipColorGrade = { lut: { path: '/film.cube', dimension: 33, strength: 1 } }
    const next = mergeClipGrade(prev, { lut: { path: '', dimension: 0, strength: 0.5 } })
    expect(next.lut?.path).toBe('/film.cube')
    expect(next.lut?.strength).toBe(0.5)
  })

  it('lut path replaces', () => {
    const prev: ClipColorGrade = { lut: { path: '/a.cube', dimension: 17 } }
    const next = mergeClipGrade(prev, { lut: { path: '/b.cube', dimension: 33 } })
    expect(next.lut?.path).toBe('/b.cube')
    expect(next.lut?.dimension).toBe(33)
  })
})

describe('wheelChromaOffset', () => {
  it('is zero at amount 0', () => {
    expect(wheelChromaOffset(180, 0)).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('is luma-neutral (sums to ~0)', () => {
    const o = wheelChromaOffset(120, 0.5)
    expect(o.r + o.g + o.b).toBeCloseTo(0, 5)
  })

  it('pushes toward the target hue', () => {
    // red hue (0°) → positive R offset
    const red = wheelChromaOffset(0, 1)
    expect(red.r).toBeGreaterThan(0)
    // cyan (180°) → negative R, positive G/B
    const cyan = wheelChromaOffset(180, 1)
    expect(cyan.r).toBeLessThan(0)
  })
})

describe('hasLut / hasHueCurves', () => {
  it('hasLut requires a path and positive strength', () => {
    expect(hasLut({ lut: { path: '/x.cube', dimension: 33, strength: 1 } })).toBe(true)
    expect(hasLut({ lut: { path: '', dimension: 33 } })).toBe(false)
    expect(hasLut({ lut: { path: '/x.cube', dimension: 33, strength: 0 } })).toBe(false)
  })

  it('hasHueCurves requires a non-neutral target', () => {
    expect(hasHueCurves({ hueCurves: { targets: [{ targetHue: 30 }] } })).toBe(false)
    expect(hasHueCurves({ hueCurves: { targets: [{ targetHue: 30, satScale: 0.5 }] } })).toBe(true)
  })
})

describe('clip grade edge cases', () => {
  it('an identity curve and a neutral wheel zone are neutral', () => {
    expect(
      isNeutralClipGrade({
        curves: {
          master: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toBe(true)
    expect(isNeutralClipGrade({ wheels: { mids: { hue: 90, amount: 0, gamma: 1 } } })).toBe(true)
    // on-diagonal knots that stop short of the domain clamp flat → not identity
    expect(
      isNeutralClipGrade({
        curves: {
          red: [
            { x: 0.2, y: 0.2 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ).toBe(false)
    expect(isNeutralClipGrade({ wheels: { highlights: { gain: 1.2 } } })).toBe(false)
  })

  it('merge does not mutate prev and hue curves replace wholesale', () => {
    const prev: ClipColorGrade = {
      wheels: { mids: { gamma: 1.2 } },
      hueCurves: { targets: [{ targetHue: 30, satScale: 0.5 }] },
    }
    const snapshot = structuredClone(prev)
    const next = mergeClipGrade(prev, {
      wheels: { mids: { hue: 200, amount: 0.1 } },
      hueCurves: { targets: [{ targetHue: 210, hueShift: 10 }] },
    })
    expect(prev).toEqual(snapshot)
    expect(next.wheels?.mids).toEqual({ gamma: 1.2, hue: 200, amount: 0.1 })
    expect(next.hueCurves?.targets).toEqual([{ targetHue: 210, hueShift: 10 }])
  })

  it('a strength-only lut patch with no existing lut adds nothing (incl. after reset)', () => {
    const lutPatch = { lut: { path: '', dimension: 0, strength: 0.5 } }
    expect(mergeClipGrade({}, lutPatch).lut).toBeUndefined()
    const prev: ClipColorGrade = { lut: { path: '/a.cube', dimension: 33 } }
    expect(mergeClipGrade(prev, lutPatch, { reset: true }).lut).toBeUndefined()
  })

  it('wheel offset direction follows the hue and scales with amount', () => {
    const cyan = wheelChromaOffset(180, 1)
    expect(cyan.g).toBeGreaterThan(0)
    expect(cyan.b).toBeGreaterThan(0)
    const half = wheelChromaOffset(240, 0.5)
    const full = wheelChromaOffset(240, 1)
    expect(half.b).toBeCloseTo(full.b / 2, 9)
    expect(full.b).toBeGreaterThan(Math.max(full.r, full.g))
  })
})
