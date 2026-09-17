// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { correlateTimeDomain, correlateFft, crossCorrelate } from './audio-correlate'

/**
 * Build a synthetic energy-envelope-like signal: a few random "transient"
 * bursts on a low-noise floor. Cross-mic alignment relies on these onsets
 * lining up, so this is a faithful stand-in for an RMS envelope.
 */
function makeEnvelope(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length)
  let s = seed
  const rand = () => {
    // Deterministic LCG so tests are reproducible.
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < length; i++) out[i] = 0.02 * rand()
  // Sprinkle bursts.
  for (let b = 0; b < length / 50; b++) {
    const at = Math.floor(rand() * (length - 10))
    const amp = 0.5 + rand()
    for (let k = 0; k < 8; k++) out[at + k] += amp * Math.exp(-k / 3)
  }
  return out
}

/**
 * Shift `src` right by `delay` (positive = content appears later) into a
 * zero-padded buffer of the same length. The correlator's convention is that
 * `lagSamples` is the shift to apply to the *target* to realign it, so when the
 * target is `src` delayed by +delay the recovered lag is `-delay`.
 */
function shift(src: Float32Array, delay: number): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const j = i - delay
    if (j >= 0 && j < src.length) out[i] = src[j]
  }
  return out
}

describe('correlateTimeDomain', () => {
  it('recovers a known delay with high confidence', () => {
    const ref = makeEnvelope(2000, 7)
    const delay = 37
    const target = shift(ref, delay)
    const r = correlateTimeDomain(ref, target, 100)
    expect(r).not.toBeNull()
    // target = ref delayed by `delay` → recovered lag (shift to realign) = -delay.
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.95)
    expect(r!.peakRatio).toBeGreaterThan(1.2)
  })

  it('recovers a negative delay (target earlier than reference)', () => {
    const ref = makeEnvelope(2000, 11)
    const delay = -52
    const target = shift(ref, delay)
    const r = correlateTimeDomain(ref, target, 100)
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.95)
  })

  it('stays gain-invariant (loud camera mic vs quiet recorder)', () => {
    const ref = makeEnvelope(2000, 3)
    const delay = 20
    const target = shift(ref, delay).map((v) => v * 6) as Float32Array
    const r = correlateTimeDomain(ref, target, 100)
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.95)
  })

  it('gives low confidence for uncorrelated noise', () => {
    const ref = makeEnvelope(2000, 1)
    const target = makeEnvelope(2000, 9999)
    const r = correlateTimeDomain(ref, target, 100)
    expect(r).not.toBeNull()
    expect(r!.confidence).toBeLessThan(0.5)
  })

  it('returns null for empty input', () => {
    expect(correlateTimeDomain(new Float32Array(0), makeEnvelope(100), 10)).toBeNull()
    expect(correlateTimeDomain(makeEnvelope(100), new Float32Array(0), 10)).toBeNull()
  })

  it('skips zero-variance (silent) windows without crashing', () => {
    const ref = new Float32Array(500) // all zeros
    const target = makeEnvelope(500, 5)
    const r = correlateTimeDomain(ref, target, 50)
    // No lag has finite variance on the ref side → no valid scores.
    expect(r).toBeNull()
  })
})

describe('correlateFft', () => {
  it('matches the time-domain result on the same input', () => {
    const ref = makeEnvelope(4096, 21)
    const delay = 64
    const target = shift(ref, delay)
    const td = correlateTimeDomain(ref, target, 200)
    const fft = correlateFft(ref, target, 200)
    expect(fft!.lagSamples).toBe(td!.lagSamples)
    expect(fft!.lagSamples).toBe(-delay)
    expect(fft!.confidence).toBeCloseTo(td!.confidence, 5)
  })

  it('recovers lag on a large input and reports high confidence', () => {
    const ref = makeEnvelope(20000, 33)
    const delay = 250
    const target = shift(ref, delay)
    const r = correlateFft(ref, target, 500)
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.95)
  })

  it('gives low confidence for uncorrelated noise', () => {
    const ref = makeEnvelope(8192, 2)
    const target = makeEnvelope(8192, 808080)
    const r = correlateFft(ref, target, 300)
    expect(r!.confidence).toBeLessThan(0.5)
  })

  it('agrees with time-domain on PERIODIC audio — confidence, lag, AND peakRatio', () => {
    // A repeating pattern correlates at many lags, so peakRatio is low — this is
    // exactly the case the FFT path must get right (the periodic-audio guard).
    // The old FFT path argmaxed raw covariance and picked its rival the same way,
    // so it disagreed with the time-domain gate here. Now both compute the same
    // windowed Pearson, so all three gate inputs must match to tolerance.
    const period = 64
    const ref = new Float32Array(4096)
    let s = 3
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff)
    // Periodic bursts (→ many peaks) + per-sample noise (→ the true lag is the
    // unique max, so argmax is deterministic across both paths).
    for (let i = 0; i < ref.length; i++) ref[i] = 0.05 * rand() + (i % period < 5 ? 0.8 : 0)
    const delay = 23
    const target = shift(ref, delay)
    const td = correlateTimeDomain(ref, target, 300)
    const fft = correlateFft(ref, target, 300)
    expect(fft!.lagSamples).toBe(td!.lagSamples)
    expect(fft!.lagSamples).toBe(-delay)
    expect(fft!.confidence).toBeCloseTo(td!.confidence, 5)
    expect(fft!.peakRatio).toBeCloseTo(td!.peakRatio, 4)
    // Sanity: this really is the low-peakRatio (periodic) regime, not a clean peak.
    expect(td!.peakRatio).toBeLessThan(1.5)
  })

  it('derives the peak from the IFFT even with a large DC bias', () => {
    // Energy envelopes are non-negative; add a big constant so the *un-centered*
    // cross-correlation is dominated by mean·mean·overlap and would peak at lag 0
    // regardless of alignment. Recovering -delay here proves the FFT path centers
    // the signals and reads the true peak out of the IFFT covariance — it can't
    // pass by accident or by falling back to the lag-0 overlap maximum.
    const base = makeEnvelope(4096, 77)
    const delay = 48
    const ref = base.map((v) => v + 5) as Float32Array
    const target = shift(base, delay).map((v) => v + 5) as Float32Array
    const r = correlateFft(ref, target, 200)
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.9)
    // And it agrees with the exhaustive reference on the same biased input.
    const td = correlateTimeDomain(ref, target, 200)
    expect(r!.lagSamples).toBe(td!.lagSamples)
    expect(r!.confidence).toBeCloseTo(td!.confidence, 5)
  })
})

describe('crossCorrelate dispatch', () => {
  it('routes large inputs through FFT and still recovers the lag', () => {
    // n·lags > 4M forces the FFT path: 50k samples × (2·2000+1) lags.
    const ref = makeEnvelope(50000, 44)
    const delay = 900
    const target = shift(ref, delay)
    const r = crossCorrelate(ref, target, 2000)
    expect(r!.lagSamples).toBe(-delay)
    expect(r!.confidence).toBeGreaterThan(0.95)
  })

  it('routes small inputs through the time domain', () => {
    const ref = makeEnvelope(1000, 6)
    const delay = 12
    const r = crossCorrelate(ref, shift(ref, delay), 50)
    expect(r!.lagSamples).toBe(-delay)
  })
})
