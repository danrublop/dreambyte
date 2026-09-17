// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildGradeUniforms, lutUrlForPath } from './grade-gl'
import { whiteBalanceGains as wbGains, gradeChannelTransfer, effectiveSaturation } from './clip-grade-css'
import type { ClipColorGrade } from '@/lib/edit-engines/clip-grade'

describe('buildGradeUniforms', () => {
  it('neutral grade → identity uniforms', () => {
    const u = buildGradeUniforms({})
    expect(u.exposure).toBe(0)
    expect(u.contrast).toBe(1)
    expect(u.saturation).toBe(1)
    expect(u.wbGain).toEqual([1, 1, 1])
    expect(u.channelCurve).toBeNull()
    expect(u.hueCurve).toBeNull()
    expect(u.lutSize).toBe(0)
    expect(u.lutIntensity).toBe(1)
  })

  it('clamps primaries to their documented UI ranges', () => {
    const u = buildGradeUniforms({ exposure: 9, contrast: 9, saturation: 9 })
    expect(u.exposure).toBe(3)
    expect(u.contrast).toBe(1.5)
    expect(u.saturation).toBe(2)
  })

  it('white balance gain matches the Tier-A CSS compiler (shared math)', () => {
    const u = buildGradeUniforms({ temperature: 8000, tint: 20 })
    const wb = wbGains(8000, 20)
    expect(u.wbGain).toEqual([wb.r, wb.g, wb.b])
  })

  it('saturation uniform folds vibrance in exactly like the CSS tier', () => {
    const g = { saturation: 1.2, vibrance: 0.4 }
    expect(buildGradeUniforms(g).saturation).toBeCloseTo(effectiveSaturation(g), 10)
  })

  it('channel texture is the CSS tier transfer (tonal + wheels + curves) sampled at 256 points', () => {
    const g: ClipColorGrade = {
      blacks: 0.3,
      shadows: -0.4,
      highlights: 0.5,
      wheels: { shadows: { hue: 180, amount: 0.3, lum: 0.05 }, mids: { gamma: 1.3 }, highlights: { gain: 0.9 } },
      curves: {
        master: [
          { x: 0, y: 0.05 },
          { x: 0.5, y: 0.55 },
          { x: 1, y: 0.95 },
        ],
        red: [
          { x: 0, y: 0 },
          { x: 1, y: 0.9 },
        ],
      },
    }
    const tex = buildGradeUniforms(g).channelCurve!
    expect(tex).toBeInstanceOf(Uint8Array)
    for (const [ci, ch] of [
      [0, 'r'],
      [1, 'g'],
      [2, 'b'],
    ] as const) {
      const f = gradeChannelTransfer(g, ch)
      for (let i = 0; i < 256; i += 17) {
        expect(Math.abs(tex[i * 4 + ci] - Math.round(f(i / 255) * 255))).toBeLessThanOrEqual(1)
      }
    }
  })

  it('tonal-only grade (no curves) still bakes a channel texture', () => {
    expect(buildGradeUniforms({ wheels: { mids: { gamma: 2 } } }).channelCurve).toBeInstanceOf(Uint8Array)
  })

  it('a real master curve builds a 256×4 channel-curve texture; identity → null', () => {
    const real = buildGradeUniforms({
      curves: {
        master: [
          [0, 0.1],
          [1, 0.9],
        ].map(([x, y]) => ({ x, y })),
      },
    })
    expect(real.channelCurve).toBeInstanceOf(Uint8Array)
    expect(real.channelCurve!.length).toBe(256 * 4)
    const identity = buildGradeUniforms({
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    })
    expect(identity.channelCurve).toBeNull()
  })

  it('hue curves build a hue texture', () => {
    const u = buildGradeUniforms({ hueCurves: { targets: [{ targetHue: 30, hueShift: 15 }] } })
    expect(u.hueCurve).toBeInstanceOf(Uint8Array)
    expect(u.hueCurve!.length).toBe(256 * 4)
  })

  it('LUT size comes from the cube dimension; strength clamps to lutIntensity', () => {
    const u = buildGradeUniforms({ lut: { path: '/x/film.cube', dimension: 33, strength: 1.5 } })
    expect(u.lutSize).toBe(33)
    expect(u.lutIntensity).toBe(1)
    // a pathless lut (or dim ≤ 1) → no LUT
    expect(buildGradeUniforms({ lut: { path: '', dimension: 33 } }).lutSize).toBe(0)
  })
})

describe('lutUrlForPath', () => {
  it('maps an absolute stored path to its dreambyte://luts/<basename> URL', () => {
    expect(lutUrlForPath('/Users/me/.dreambyte/luts/Kodak 2383.cube')).toBe('dreambyte://luts/Kodak%202383.cube')
  })
  it('handles Windows separators', () => {
    expect(lutUrlForPath('C:\\Users\\me\\.dreambyte\\luts\\film.cube')).toBe('dreambyte://luts/film.cube')
  })
  it('returns null for empty/missing', () => {
    expect(lutUrlForPath(undefined)).toBeNull()
    expect(lutUrlForPath('')).toBeNull()
  })
})
