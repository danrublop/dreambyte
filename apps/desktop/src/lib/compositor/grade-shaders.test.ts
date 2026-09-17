// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  buildChannelCurveTexture,
  buildHueCurveTexture,
  decodeHueCurveByte,
  GRADE_FRAGMENT_SHADER,
  GRADE_VERTEX_SHADER,
} from './grade-shaders'

describe('buildChannelCurveTexture', () => {
  it('identity → R/G/B ramp 0..255, alpha 255', () => {
    const id = (x: number) => x
    const tex = buildChannelCurveTexture(id, id, id)
    expect(tex.length).toBe(256 * 4)
    for (const i of [0, 1, 64, 128, 200, 255]) {
      expect(tex[i * 4]).toBe(i)
      expect(tex[i * 4 + 1]).toBe(i)
      expect(tex[i * 4 + 2]).toBe(i)
      expect(tex[i * 4 + 3]).toBe(255)
    }
  })

  it('packs each channel from its own function and clamps into [0,255]', () => {
    const tex = buildChannelCurveTexture(
      () => 5,
      (x) => x,
      () => -3,
    )
    for (const i of [10, 120, 240]) {
      expect(tex[i * 4]).toBe(255)
      expect(tex[i * 4 + 1]).toBe(i)
      expect(tex[i * 4 + 2]).toBe(0)
    }
  })
})

describe('buildHueCurveTexture', () => {
  const texel = (deg: number) => Math.round((deg / 360) * 255)
  const hueDeg = (tex: Uint8Array, i: number) => decodeHueCurveByte(tex[i * 4]) * 60
  const satScale = (tex: Uint8Array, i: number) => 1 + decodeHueCurveByte(tex[i * 4 + 1])
  const lum = (tex: Uint8Array, i: number) => decodeHueCurveByte(tex[i * 4 + 2])

  it('returns null when there are no targets / only neutral targets', () => {
    expect(buildHueCurveTexture(undefined)).toBeNull()
    expect(buildHueCurveTexture([])).toBeNull()
    expect(buildHueCurveTexture([{ targetHue: 120, hueShift: 0, satScale: 1, lumShift: 0 }])).toBeNull()
  })

  it('neutral bytes decode to EXACTLY zero shift / unit saturation', () => {
    expect(decodeHueCurveByte(128)).toBe(0)
    const tex = buildHueCurveTexture([{ targetHue: 0, hueShift: 20 }])!
    const far = texel(180)
    expect(Array.from(tex.slice(far * 4, far * 4 + 3))).toEqual([128, 128, 128])
    expect(satScale(tex, far)).toBe(1)
  })

  it('encodes the full shift at the target hue for each channel', () => {
    const tex = buildHueCurveTexture([{ targetHue: 0, hueShift: 30, satScale: 1.5, lumShift: -0.2 }])!
    expect(tex.length).toBe(256 * 4)
    expect(hueDeg(tex, 0)).toBeCloseTo(30, 0)
    expect(satScale(tex, 0)).toBeCloseTo(1.5, 1)
    expect(lum(tex, 0)).toBeCloseTo(-0.2, 1)
  })

  it('only hues within ±22° of the target are affected', () => {
    const tex = buildHueCurveTexture([{ targetHue: 90, hueShift: 30 }])!
    expect(hueDeg(tex, texel(90))).toBeGreaterThan(25)
    expect(tex[texel(60) * 4]).toBe(128)
    expect(tex[texel(120) * 4]).toBe(128)
  })

  it('wraps around 360° (a hue near 360 feels a 0° target)', () => {
    const tex = buildHueCurveTexture([{ targetHue: 0, hueShift: 30 }])!
    expect(hueDeg(tex, texel(353))).toBeGreaterThan(5)
    expect(hueDeg(tex, 255)).toBeCloseTo(hueDeg(tex, 0), 5) // 360° == 0°
  })

  it('falls off smoothly toward the edge of the window', () => {
    const tex = buildHueCurveTexture([{ targetHue: 180, hueShift: 30 }])!
    const at = hueDeg(tex, texel(180))
    const near = hueDeg(tex, texel(188))
    const edge = hueDeg(tex, texel(199))
    expect(at).toBeGreaterThan(near)
    expect(near).toBeGreaterThan(edge)
    expect(edge).toBeGreaterThanOrEqual(0)
  })
})

describe('GRADE_FRAGMENT_SHADER', () => {
  it('is WebGL2 GLSL ES 3.00 and declares the uniforms the driver uploads', () => {
    expect(GRADE_FRAGMENT_SHADER).toContain('#version 300 es')
    // Every uniform grade-gl.ts / composite-host.ts look up must be declared.
    const uniforms = [
      'sampler2D uImage',
      'sampler2D uChannelCurve',
      'sampler2D uHueCurve',
      'sampler2D uLut',
      'float uLutSize',
      'float uLutIntensity',
      'int uHasChannelCurve',
      'int uHasHueCurve',
      'float uExposure',
      'float uContrast',
      'float uSaturation',
      'vec3 uWbGain',
    ]
    for (const u of uniforms) expect(GRADE_FRAGMENT_SHADER).toContain(u)
    expect(GRADE_VERTEX_SHADER).toContain('in vec2 aPos')
    expect(GRADE_FRAGMENT_SHADER).not.toContain('${') // template constants got interpolated
  })
})
