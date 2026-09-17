import { describe, it, expect } from 'vitest'
import { synthesizeModal, synthesizeModalWav, MODAL_MATERIALS } from './modal'

const rms = (s: number[]) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length)
const peak = (s: number[]) => s.reduce((m, x) => Math.max(m, Math.abs(x)), 0)

describe('synthesizeModal', () => {
  it('renders every material to a finite, non-silent, peak-normalized buffer', () => {
    for (const m of MODAL_MATERIALS) {
      const r = synthesizeModal(m)!
      expect(r).not.toBeNull()
      expect(r.samples.length).toBeGreaterThan(1000)
      expect(r.samples.every(Number.isFinite)).toBe(true) // no NaN/Inf (additive = stable)
      expect(rms(r.samples)).toBeGreaterThan(0.02) // not silent
      expect(peak(r.samples)).toBeLessThanOrEqual(0.96) // peak-normalized, no clipping
    }
  })

  it('is deterministic for identical params', () => {
    const a = synthesizeModal('glass', { pitch: 1.2, decay: 1.5, brightness: 0.8, variation: 0.5 })!
    const b = synthesizeModal('glass', { pitch: 1.2, decay: 1.5, brightness: 0.8, variation: 0.5 })!
    expect(a.samples).toEqual(b.samples)
  })

  it('returns null for an unknown material', () => {
    expect(synthesizeModal('plasma')).toBeNull()
    expect(synthesizeModal('')).toBeNull()
  })

  it('decay multiplier lengthens the ring', () => {
    const short = synthesizeModal('metal', { decay: 0.5 })!
    const long = synthesizeModal('metal', { decay: 2 })!
    expect(long.durationSec).toBeGreaterThan(short.durationSec)
  })

  it('pitch multiplier shifts the spectral centroid up', () => {
    // Rough proxy: higher pitch → more zero-crossings (higher frequency content).
    const zc = (s: number[]) => {
      let c = 0
      for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 !== s[i] < 0) c++
      return c / s.length
    }
    const low = synthesizeModal('metal', { pitch: 0.5 })!
    const high = synthesizeModal('metal', { pitch: 2 })!
    expect(zc(high.samples)).toBeGreaterThan(zc(low.samples))
  })

  it('clamps out-of-range params (no NaN, no blowup)', () => {
    const r = synthesizeModal('wood', { pitch: 99, decay: -5, brightness: 50, variation: 9 })!
    expect(r.samples.every(Number.isFinite)).toBe(true)
    expect(peak(r.samples)).toBeLessThanOrEqual(0.96)
  })

  it('materials are timbrally distinct', () => {
    const sigs = MODAL_MATERIALS.map((m) => synthesizeModal(m)!.samples.slice(2000, 2008).join(','))
    expect(new Set(sigs).size).toBe(MODAL_MATERIALS.length)
  })
})

describe('synthesizeModalWav', () => {
  it('returns a non-trivial WAV buffer with a RIFF header', () => {
    const r = synthesizeModalWav('ceramic')!
    expect(r.wav.length).toBeGreaterThan(2000)
    expect(r.wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(r.material).toBe('ceramic')
  })
  it('returns null for an unknown material', () => {
    expect(synthesizeModalWav('nope')).toBeNull()
  })
})
