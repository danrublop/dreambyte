// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  synthesizeSfx,
  synthesizeSfxWav,
  synthesizeLayeredSfx,
  synthesizeLayeredSfxWav,
  resolveSfxParams,
  SFX_ARCHETYPES,
  SFX_ARCHETYPE_NAMES,
} from './synth'

const rms = (s: number[]) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length)

function readWavHeader(b: Buffer) {
  return {
    riff: b.toString('ascii', 0, 4),
    wave: b.toString('ascii', 8, 12),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
  }
}

describe('SFX synth', () => {
  it('renders every semantic archetype to non-silent audio', () => {
    for (const name of SFX_ARCHETYPE_NAMES) {
      const r = synthesizeSfx({ archetype: name })
      expect(r, `${name} should resolve`).not.toBeNull()
      expect(r!.samples.length).toBeGreaterThan(0)
      expect(20 * Math.log10(rms(r!.samples) || 1e-9), `${name} should be audible`).toBeGreaterThan(-45)
    }
  })

  it('accepts raw preset ids too', () => {
    expect(synthesizeSfx({ archetype: 'sfxr-jump' })).not.toBeNull()
    expect(synthesizeSfx({ archetype: 'ex-noise' })).not.toBeNull()
  })

  it('returns null for an unknown archetype (handler turns this into an error)', () => {
    expect(synthesizeSfx({ archetype: 'definitely-not-a-sound' })).toBeNull()
    expect(synthesizeSfxWav({ archetype: '' })).toBeNull()
  })

  it('is deterministic — identical spec → byte-identical WAV', () => {
    const a = synthesizeSfxWav({ archetype: 'coin', pitch: 1.5, variation: 0.3 })!.wav
    const b = synthesizeSfxWav({ archetype: 'coin', pitch: 1.5, variation: 0.3 })!.wav
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('emits a valid mono 16-bit WAV', () => {
    const h = readWavHeader(synthesizeSfxWav({ archetype: 'laser' })!.wav)
    expect(h.riff).toBe('RIFF')
    expect(h.wave).toBe('WAVE')
    expect(h.channels).toBe(1)
    expect(h.bits).toBe(16)
    expect(h.sampleRate).toBeGreaterThan(0)
  })

  it('pitch raises frequency, duration lengthens the clip', () => {
    const base = resolveSfxParams({ archetype: 'beep' })!
    const high = resolveSfxParams({ archetype: 'beep', pitch: 2 })!
    expect(high.params[2]).toBeCloseTo(base.params[2] * 2, 3) // frequency index

    const short = synthesizeSfx({ archetype: 'whoosh', duration: 0.5 })!
    const long = synthesizeSfx({ archetype: 'whoosh', duration: 2 })!
    expect(long.samples.length).toBeGreaterThan(short.samples.length)
  })

  it('clamps out-of-range knobs instead of throwing', () => {
    expect(synthesizeSfx({ archetype: 'coin', pitch: 999, duration: -5, variation: 50 })).not.toBeNull()
  })

  it('every semantic archetype maps to a real preset', () => {
    for (const [name, presetId] of Object.entries(SFX_ARCHETYPES)) {
      expect(synthesizeSfx({ archetype: presetId }), `${name} → ${presetId}`).not.toBeNull()
    }
  })

  describe('layering', () => {
    it('mixes layers into one compound, non-silent sound', () => {
      const r = synthesizeLayeredSfx([
        { archetype: 'explosion-big' },
        { archetype: 'ex-crunch', offsetMs: 30 },
        { archetype: 'thud', pitch: 0.7, offsetMs: 10 },
      ])
      expect(r).not.toBeNull()
      expect(20 * Math.log10(rms(r!.samples) || 1e-9)).toBeGreaterThan(-45)
      expect(r!.resolvedId).toBe('explosion-big+ex-crunch+thud')
    })

    it('offset extends total length past the longest single layer', () => {
      const single = synthesizeSfx({ archetype: 'coin' })!
      const offset = synthesizeLayeredSfx([
        { archetype: 'coin' },
        { archetype: 'coin', offsetMs: 500 },
      ])!
      expect(offset.samples.length).toBeGreaterThan(single.samples.length)
    })

    it('peak-normalizes so a hot stack never clips past 1.0', () => {
      const r = synthesizeLayeredSfx(Array.from({ length: 6 }, () => ({ archetype: 'kick', volume: 2 })))!
      expect(Math.max(...r.samples.map(Math.abs))).toBeLessThanOrEqual(1.0001)
    })

    it('is deterministic and returns null if any layer is unknown / list is empty', () => {
      const a = synthesizeLayeredSfxWav([{ archetype: 'laser' }, { archetype: 'whoosh', offsetMs: 50 }])!.wav
      const b = synthesizeLayeredSfxWav([{ archetype: 'laser' }, { archetype: 'whoosh', offsetMs: 50 }])!.wav
      expect(Buffer.compare(a, b)).toBe(0)
      expect(synthesizeLayeredSfx([{ archetype: 'laser' }, { archetype: 'nope' }])).toBeNull()
      expect(synthesizeLayeredSfx([])).toBeNull()
    })
  })
})
