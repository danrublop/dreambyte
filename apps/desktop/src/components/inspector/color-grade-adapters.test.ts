// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  zoneToWheelValue,
  wheelValueToZone,
  clipCurvesToTone,
  toneToClipCurves,
} from './ColorGradePanel'

describe('wheel zone ⇄ WheelValue adapter', () => {
  it('hue+amount round-trips through the RGB puck (shadows/lum)', () => {
    const z = { hue: 180, amount: 0.4, lum: 0.25 }
    const round = wheelValueToZone(zoneToWheelValue(z, 'lum'), 'lum')
    expect(round.hue).toBeCloseTo(180, 0)
    expect(round.amount).toBeCloseTo(0.4, 4)
    expect(round.lum).toBeCloseTo(0.25, 4)
  })

  it('midtone gamma maps through master (log2) and back', () => {
    const z = { hue: 90, amount: 0.2, gamma: 1.5 }
    const round = wheelValueToZone(zoneToWheelValue(z, 'gamma'), 'gamma')
    expect(round.gamma).toBeCloseTo(1.5, 4)
    expect(round.amount).toBeCloseTo(0.2, 4)
  })

  it('highlight gain maps through master and back', () => {
    const z = { hue: 300, amount: 0.3, gain: 1.25 }
    const round = wheelValueToZone(zoneToWheelValue(z, 'gain'), 'gain')
    expect(round.gain).toBeCloseTo(1.25, 4)
  })

  it('a neutral zone is the neutral wheel value', () => {
    const v = zoneToWheelValue(undefined, 'gamma')
    expect(v.r).toBeCloseTo(0, 6)
    expect(v.g).toBeCloseTo(0, 6)
    expect(v.b).toBeCloseTo(0, 6)
    expect(v.master).toBeCloseTo(0, 6) // log2(1) = 0
  })
})

describe('curves ⇄ ToneCurveData adapter', () => {
  it('maps master/red/green/blue ⇄ rgb/r/g/b and round-trips', () => {
    const curves = {
      master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
      red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }
    const tone = clipCurvesToTone(curves)
    expect(tone.rgb).toBe(curves.master)
    expect(tone.r).toBe(curves.red)
    expect(tone.g).toBeUndefined()
    const back = toneToClipCurves(tone)
    expect(back.master).toEqual(curves.master)
    expect(back.red).toEqual(curves.red)
    expect('green' in back).toBe(false)
  })

  it('undefined curves → empty tone data', () => {
    expect(clipCurvesToTone(undefined)).toEqual({ rgb: undefined, r: undefined, g: undefined, b: undefined })
  })
})
