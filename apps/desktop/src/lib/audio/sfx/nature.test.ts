// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { synthesizeNature, synthesizeNatureWav, NATURE_CATEGORIES } from './nature'

const rms = (s: number[]) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length)

describe('natural ambience synthesis', () => {
  it('renders every category to non-silent audio at the requested length', () => {
    for (const cat of NATURE_CATEGORIES) {
      const r = synthesizeNature(cat, { durationSec: 2, intensity: 0.6 })
      expect(r, `${cat} should render`).not.toBeNull()
      expect(r!.samples.length).toBe(2 * r!.sampleRate)
      expect(20 * Math.log10(rms(r!.samples) || 1e-9), `${cat} audible`).toBeGreaterThan(-45)
    }
  })

  it('returns null for an unknown category', () => {
    expect(synthesizeNature('volcano')).toBeNull()
    expect(synthesizeNature('')).toBeNull()
  })

  it('clamps duration (1–30s) and intensity (0–1) instead of throwing', () => {
    const tooLong = synthesizeNature('wind', { durationSec: 9999 })!
    expect(tooLong.durationSec).toBeLessThanOrEqual(30)
    expect(synthesizeNature('rain', { durationSec: -3, intensity: 50 })).not.toBeNull()
  })

  it('is deterministic per (category, duration, intensity, seed)', () => {
    const a = synthesizeNatureWav('fire', { durationSec: 2, seed: 7 })!.wav
    const b = synthesizeNatureWav('fire', { durationSec: 2, seed: 7 })!.wav
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('different seed → a different texture', () => {
    const a = synthesizeNature('rain', { durationSec: 2, seed: 1 })!.samples
    const b = synthesizeNature('rain', { durationSec: 2, seed: 2 })!.samples
    expect(a.some((v, i) => v !== b[i])).toBe(true)
  })

  it('emits a valid mono 16-bit WAV', () => {
    const wav = synthesizeNatureWav('ocean', { durationSec: 1 })!.wav
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt16LE(34)).toBe(16) // 16-bit
  })

  it('wind/ocean are bass-heavy (brown-noise based), not bright hiss like static', () => {
    // Crude brightness proxy: mean absolute first-difference (high-freq energy).
    const bright = (s: number[]) => {
      let d = 0
      for (let i = 1; i < s.length; i++) d += Math.abs(s[i] - s[i - 1])
      return d / s.length
    }
    const wind = bright(synthesizeNature('wind', { durationSec: 2 })!.samples)
    const staticNoise = bright(synthesizeNature('static', { durationSec: 2 })!.samples)
    expect(wind).toBeLessThan(staticNoise) // wind is far less "hissy" than white static
  })
})
