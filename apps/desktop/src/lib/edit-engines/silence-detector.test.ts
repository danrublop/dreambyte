// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { detectSilenceSpans } from './silence-detector'

const SR = 48000

/** Generate `seconds` of silence (zero samples). */
function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR))
}

/** Generate `seconds` of a 1 kHz sine at amplitude `amp`. */
function sine(seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * 1000) / SR
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

describe('detectSilenceSpans', () => {
  it('returns [] for empty input', () => {
    expect(detectSilenceSpans(new Float32Array(0), SR)).toEqual([])
  })

  it('throws on non-positive sample rate', () => {
    expect(() => detectSilenceSpans(silence(1), 0)).toThrow(/sampleRate/)
  })

  it('detects a single silence between two tone bursts', () => {
    const pcm = concat(sine(0.5), silence(0.5), sine(0.5))
    const spans = detectSilenceSpans(pcm, SR, { dbThreshold: -40, minSilenceMs: 200 })
    expect(spans.length).toBe(1)
    expect(spans[0].start).toBeCloseTo(0.5, 1)
    expect(spans[0].end).toBeCloseTo(1.0, 1)
  })

  it('ignores silence shorter than minSilenceMs', () => {
    // 50 ms gap is below the 250 ms default
    const pcm = concat(sine(0.5), silence(0.05), sine(0.5))
    expect(detectSilenceSpans(pcm, SR).length).toBe(0)
  })

  it('detects multiple silences in one buffer', () => {
    const pcm = concat(sine(0.3), silence(0.4), sine(0.3), silence(0.4), sine(0.3))
    const spans = detectSilenceSpans(pcm, SR, { minSilenceMs: 200 })
    expect(spans.length).toBe(2)
  })

  it('respects a higher (looser) threshold', () => {
    // sine at amp 0.005 → about -46 dB. With default -40, that's "silent";
    // with -50 threshold, that's "audio".
    const quiet = sine(1.0, 0.005)
    expect(detectSilenceSpans(quiet, SR, { dbThreshold: -40 }).length).toBeGreaterThan(0)
    expect(detectSilenceSpans(quiet, SR, { dbThreshold: -50 }).length).toBe(0)
  })

  it('closes an open silence run at end-of-buffer', () => {
    const pcm = concat(sine(0.5), silence(0.5))
    const spans = detectSilenceSpans(pcm, SR, { minSilenceMs: 200 })
    expect(spans.length).toBe(1)
    expect(spans[0].end).toBeCloseTo(1.0, 1)
  })

  it('opens a silence run at start-of-buffer', () => {
    const pcm = concat(silence(0.5), sine(0.5))
    const spans = detectSilenceSpans(pcm, SR, { minSilenceMs: 200 })
    expect(spans.length).toBe(1)
    expect(spans[0].start).toBeCloseTo(0, 1)
  })
})
