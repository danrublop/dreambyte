import { describe, it, expect } from 'vitest'
import {
  UNITY_GAIN,
  MAX_STAGE_GAIN,
  MAX_VOICE_GAIN,
  MIN_FADER_DB,
  MAX_FADER_DB,
  dbToLinear,
  linearToDb,
  faderToGain,
  gainToFader,
  clipBaseGain,
  resolveVoiceGain,
} from './mix-math'

describe('dbToLinear / linearToDb', () => {
  it('unity round-trips', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 10)
    expect(linearToDb(1)).toBeCloseTo(0, 10)
  })

  it('+6 dB ≈ 2.0, -6 dB ≈ 0.5', () => {
    expect(dbToLinear(6)).toBeCloseTo(1.9953, 3)
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3)
    expect(linearToDb(2)).toBeCloseTo(6.0206, 3)
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3)
  })

  it('silence maps both ways', () => {
    expect(dbToLinear(-Infinity)).toBe(0)
    expect(linearToDb(0)).toBe(-Infinity)
    expect(linearToDb(-1)).toBe(-Infinity)
  })

  it('round-trips across a dB sweep', () => {
    for (let db = -48; db <= 6; db += 3) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 6)
    }
  })

  it('NaN dB falls back to unity, not NaN gain', () => {
    expect(dbToLinear(NaN)).toBe(UNITY_GAIN)
  })
})

describe('faderToGain / gainToFader', () => {
  it('endpoints: bottom is true silence, top is +6 dB', () => {
    expect(faderToGain(0)).toBe(0)
    expect(faderToGain(1)).toBeCloseTo(dbToLinear(MAX_FADER_DB), 10)
  })

  it('clamps out-of-range positions', () => {
    expect(faderToGain(-0.5)).toBe(0)
    expect(faderToGain(1.5)).toBeCloseTo(dbToLinear(MAX_FADER_DB), 10)
  })

  it('unity (0 dB) sits where the dB taper puts it', () => {
    const expected = (0 - MIN_FADER_DB) / (MAX_FADER_DB - MIN_FADER_DB)
    expect(gainToFader(1)).toBeCloseTo(expected, 10)
    expect(faderToGain(expected)).toBeCloseTo(1, 10)
  })

  it('is monotonic in position', () => {
    let prev = -1
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const g = faderToGain(p)
      expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
  })

  it('round-trips position → gain → position for p in (0,1]', () => {
    for (let p = 0.05; p <= 1.0001; p += 0.05) {
      expect(gainToFader(faderToGain(p))).toBeCloseTo(p, 6)
    }
  })

  it('gainToFader floors silence and clamps above +6 dB', () => {
    expect(gainToFader(0)).toBe(0)
    expect(gainToFader(-1)).toBe(0)
    expect(gainToFader(100)).toBe(1)
  })
})

describe('clipBaseGain', () => {
  it('multiplies volume × envelope', () => {
    expect(clipBaseGain(1, 1)).toBe(1)
    expect(clipBaseGain(0.5, 0.5)).toBeCloseTo(0.25, 10)
  })

  it('clamps each factor and the product to the stage ceiling', () => {
    expect(clipBaseGain(2, 2)).toBe(MAX_STAGE_GAIN) // 4 → clamped to 2
    expect(clipBaseGain(5, 1)).toBe(MAX_STAGE_GAIN) // factor clamped to 2
    expect(clipBaseGain(-1, 1)).toBe(0)
  })

  it('non-finite inputs floor to 0, never NaN', () => {
    expect(clipBaseGain(NaN, 1)).toBe(0)
    expect(clipBaseGain(1, Infinity)).toBe(MAX_STAGE_GAIN)
  })
})

describe('resolveVoiceGain — the one true chain', () => {
  it('all-unity is unity', () => {
    expect(resolveVoiceGain({ clipGain: 1 })).toBe(1)
  })

  it('multiplies clip × track × master × bus', () => {
    expect(
      resolveVoiceGain({ clipGain: 0.5, trackVolume: 0.5, masterVolume: 0.5, busGain: 2 }),
    ).toBeCloseTo(0.25, 10)
  })

  it('defaults track/master/bus to unity', () => {
    expect(resolveVoiceGain({ clipGain: 0.8 })).toBeCloseTo(0.8, 10)
  })

  it('mute wins over everything', () => {
    expect(resolveVoiceGain({ clipGain: 2, trackVolume: 2, masterVolume: 2, muted: true })).toBe(0)
  })

  it('solo gating: non-soloed track is silenced when any solo is active', () => {
    expect(resolveVoiceGain({ clipGain: 1, anySolo: true, solo: false })).toBe(0)
    expect(resolveVoiceGain({ clipGain: 1, anySolo: true, solo: true })).toBe(1)
    // no solo anywhere → plays normally
    expect(resolveVoiceGain({ clipGain: 1, anySolo: false, solo: false })).toBe(1)
  })

  it('hard-caps the composed voice at +12 dB even when every stage maxes out', () => {
    expect(
      resolveVoiceGain({ clipGain: 2, trackVolume: 2, masterVolume: 2, busGain: 4 }),
    ).toBe(MAX_VOICE_GAIN)
  })

  it('clamps individual over-range factors before composing', () => {
    // trackVolume 10 is clamped to MAX_STAGE_GAIN (2); 1×2×1×1 = 2
    expect(resolveVoiceGain({ clipGain: 1, trackVolume: 10 })).toBe(2)
  })

  it('exhaustive small matrix stays within [0, MAX_VOICE_GAIN]', () => {
    const vals = [0, 0.5, 1, 1.5, 2]
    for (const clipGain of vals)
      for (const trackVolume of vals)
        for (const masterVolume of vals)
          for (const busGain of [0, 1, 2, 4]) {
            const g = resolveVoiceGain({ clipGain, trackVolume, masterVolume, busGain })
            expect(g).toBeGreaterThanOrEqual(0)
            expect(g).toBeLessThanOrEqual(MAX_VOICE_GAIN)
          }
  })
})
