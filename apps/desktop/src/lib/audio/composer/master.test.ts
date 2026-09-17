import { describe, it, expect } from 'vitest'
import { applyMaster, measureLufs, presetForTemplate, MASTER_PRESETS, type MasterPreset } from './master'

const SR = 44100

/** Deterministic test tone: sine partials + a seeded pseudo-noise bed (no RNG). */
function makeSignal(seconds: number, ampL = 0.5, ampR = 0.5): { L: Float32Array; R: Float32Array } {
  const n = Math.round(seconds * SR)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  let s = 12345 // mulberry-ish deterministic state
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff - 0.5
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const tone = Math.sin(2 * Math.PI * 220 * t) * 0.6 + Math.sin(2 * Math.PI * 440 * t) * 0.3
    const noise = rnd() * 0.1
    L[i] = (tone + noise) * ampL
    R[i] = (tone - noise) * ampR
  }
  return { L, R }
}

const truePeakDb = (L: Float32Array, R: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
    if (i + 1 < L.length) {
      peak = Math.max(peak, Math.abs((L[i] + L[i + 1]) / 2), Math.abs((R[i] + R[i + 1]) / 2))
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

describe('applyMaster — mastering chain', () => {
  it('holds the true-peak ceiling (no sample above -1 dBTP)', () => {
    // Deliberately hot input that would clip without the limiter.
    const { L, R } = makeSignal(2, 1.6, 1.6)
    const m = applyMaster(L, R, MASTER_PRESETS.corporate)
    expect(m.truePeakDb).toBeLessThanOrEqual(-1.0 + 0.05) // small epsilon for TP estimate
    expect(truePeakDb(L, R)).toBeLessThanOrEqual(-1.0 + 0.05)
  })

  it('normalizes to the preset stem LUFS target (±2 LUFS)', () => {
    const { L, R } = makeSignal(3, 0.4, 0.4)
    const preset = MASTER_PRESETS.corporate
    const m = applyMaster(L, R, preset)
    expect(Number.isFinite(m.measuredLufs)).toBe(true)
    expect(Math.abs(m.measuredLufs - preset.stemLufs)).toBeLessThanOrEqual(2)
  })

  it('is deterministic — identical input yields identical bytes', () => {
    const a = makeSignal(1.5)
    const b = makeSignal(1.5)
    applyMaster(a.L, a.R, MASTER_PRESETS.lofi)
    applyMaster(b.L, b.R, MASTER_PRESETS.lofi)
    expect(Array.from(a.L)).toEqual(Array.from(b.L))
    expect(Array.from(a.R)).toEqual(Array.from(b.R))
  })

  it('silence in → silence out, no NaN, LUFS = -Infinity', () => {
    const L = new Float32Array(SR)
    const R = new Float32Array(SR)
    const m = applyMaster(L, R, MASTER_PRESETS.cinematic)
    expect(m.measuredLufs).toBe(-Infinity)
    expect(L.every((x) => x === 0 && !Number.isNaN(x))).toBe(true)
    expect(R.every((x) => x === 0 && !Number.isNaN(x))).toBe(true)
  })

  it('never produces NaN/Infinity samples on a normal signal', () => {
    const { L, R } = makeSignal(2, 0.7, 0.5)
    applyMaster(L, R, MASTER_PRESETS.synthwave)
    expect(L.every((x) => Number.isFinite(x))).toBe(true)
    expect(R.every((x) => Number.isFinite(x))).toBe(true)
  })

  it('every preset renders a distinct, valid result', () => {
    const presets = Object.keys(MASTER_PRESETS)
    expect(presets.length).toBeGreaterThanOrEqual(4)
    const fingerprints = new Set<string>()
    for (const key of presets) {
      const { L, R } = makeSignal(1.5)
      const m = applyMaster(L, R, MASTER_PRESETS[key])
      expect(m.truePeakDb).toBeLessThanOrEqual(-1.0 + 0.05)
      expect(Number.isFinite(m.measuredLufs)).toBe(true)
      fingerprints.add(L.slice(SR, SR + 16).join(','))
    }
    // Different presets should not all collapse to the same output.
    expect(fingerprints.size).toBeGreaterThan(1)
  })

  it('holds the ceiling on SHARP TRANSIENTS (drum-hit-like spikes), checked on raw sample peak', () => {
    // Sparse full-scale spikes — a smooth-sine test misses a misaligned limiter,
    // but a transient leaks the peak. Assert on the raw SAMPLE peak, not interp.
    const n = 2 * SR
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const bed = Math.sin((2 * Math.PI * 110 * i) / SR) * 0.2
      const spike = i % 4000 === 0 ? 1.9 : 0 // hot transient every ~90ms
      L[i] = bed + spike
      R[i] = bed + spike
    }
    applyMaster(L, R, MASTER_PRESETS.corporate)
    let samplePeak = 0
    for (let i = 0; i < n; i++) samplePeak = Math.max(samplePeak, Math.abs(L[i]), Math.abs(R[i]))
    const samplePeakDb = 20 * Math.log10(samplePeak)
    expect(samplePeakDb).toBeLessThanOrEqual(-1.0 + 0.1) // raw sample peak under ceiling
  })

  it('quarantines NaN/Infinity input — no whole-track poisoning, output stays finite', () => {
    const { L, R } = makeSignal(2, 0.5, 0.5)
    L[0] = NaN
    L[100] = Infinity
    R[50] = -Infinity
    const m = applyMaster(L, R, MASTER_PRESETS.corporate)
    // A single bad input sample must NOT zero/NaN the whole track.
    expect(L.every((x) => Number.isFinite(x))).toBe(true)
    expect(R.every((x) => Number.isFinite(x))).toBe(true)
    expect(Number.isFinite(m.measuredLufs) || m.measuredLufs === -Infinity).toBe(true)
    // The rest of the signal survives (not silenced) — RMS well above zero.
    let sum = 0
    for (let i = 0; i < L.length; i++) sum += L[i] * L[i]
    expect(Math.sqrt(sum / L.length)).toBeGreaterThan(0.001)
  })

  it('clamps over-boost on a near-silent stem (no limiter slam / NaN)', () => {
    const { L, R } = makeSignal(2, 0.0008, 0.0008) // ~ -62 dBFS, very quiet
    const m = applyMaster(L, R, MASTER_PRESETS.corporate)
    expect(L.every((x) => Number.isFinite(x))).toBe(true)
    expect(m.truePeakDb).toBeLessThanOrEqual(-1.0 + 0.5) // boost clamp keeps it sane
  })
})

describe('measureLufs', () => {
  it('reports louder LUFS for a louder signal', () => {
    const quiet = makeSignal(2, 0.1, 0.1)
    const loud = makeSignal(2, 0.8, 0.8)
    expect(measureLufs(loud.L, loud.R)).toBeGreaterThan(measureLufs(quiet.L, quiet.R))
  })
  it('returns -Infinity for silence and sub-block-length input', () => {
    expect(measureLufs(new Float32Array(SR), new Float32Array(SR))).toBe(-Infinity)
    expect(measureLufs(new Float32Array(100), new Float32Array(100))).toBe(-Infinity)
  })
})

describe('presetForTemplate', () => {
  it('maps the 9 templates to the 4 presets', () => {
    expect(presetForTemplate('lofi')).toBe(MASTER_PRESETS.lofi)
    expect(presetForTemplate('cinematic')).toBe(MASTER_PRESETS.cinematic)
    expect(presetForTemplate('ambient')).toBe(MASTER_PRESETS.cinematic)
    expect(presetForTemplate('tension')).toBe(MASTER_PRESETS.cinematic)
    expect(presetForTemplate('dnb')).toBe(MASTER_PRESETS.synthwave)
    expect(presetForTemplate('synthwave')).toBe(MASTER_PRESETS.synthwave)
    expect(presetForTemplate('corporate')).toBe(MASTER_PRESETS.corporate)
    expect(presetForTemplate('upbeat')).toBe(MASTER_PRESETS.corporate)
    expect(presetForTemplate('folk')).toBe(MASTER_PRESETS.corporate)
  })
  it('falls back to corporate for unknown/undefined', () => {
    expect(presetForTemplate(undefined)).toBe(MASTER_PRESETS.corporate)
    expect(presetForTemplate('nope' as string)).toBe(MASTER_PRESETS.corporate)
  })
  it('every preset satisfies the MasterPreset shape', () => {
    for (const p of Object.values(MASTER_PRESETS) as MasterPreset[]) {
      expect(p.limiterCeilingDb).toBeLessThanOrEqual(0)
      expect(p.stemLufs).toBeLessThan(0)
      expect(p.comp.ratio).toBeGreaterThanOrEqual(1)
    }
  })
})
