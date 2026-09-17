/**
 * Native SFX — MODAL / physical-impact synthesis.
 *
 * ZzFX/jsfxr are oscillator synths (retro beeps) and nature.ts is filtered noise
 * (ambience). Neither can make a convincing struck-OBJECT sound. Real impacts are
 * MODAL: a body rings at a set of inharmonic resonant modes, each decaying at its
 * own rate, kicked by a sharp contact transient. This synthesizes that directly.
 *
 *   contact transient (short noise burst)  ─┐
 *   + Σ modes:  gain·e^(−t/τ)·sin(2πf·t)    ─┴► amp env ─► peak-normalize ─► samples
 *
 * ADDITIVE (sum of decaying sinusoids), NOT high-Q resonator biquads: same modal
 * model, but stable by construction — no filter feedback to blow up, no denormals/
 * NaN, fully deterministic. Material = a table of mode (ratio, gain, decay) tuned
 * to real metal/wood/glass/ceramic/membrane spectra. Seeded → reproducible.
 */
import { encodeMonoWavPcm16 } from '../encode-mono-wav-pcm16'

const SAMPLE_RATE = 44100
const MAX_SEC = 8

export const MODAL_MATERIALS = ['metal', 'wood', 'glass', 'ceramic', 'membrane'] as const
export type ModalMaterial = (typeof MODAL_MATERIALS)[number]

interface Mode {
  /** Frequency ratio to the fundamental (inharmonic for real bodies). */
  ratio: number
  /** Relative amplitude. */
  gain: number
  /** Relative decay (×base decay); higher modes damp faster in real materials. */
  decay: number
}

/** Per-material modal spectra (ratios from ideal bars/plates/membranes, tuned). */
const MATERIALS: Record<ModalMaterial, { f0: number; baseDecay: number; modes: Mode[]; noise: number }> = {
  // Struck metal bar/plate: bright, long inharmonic ring.
  metal: {
    f0: 440,
    baseDecay: 1.6,
    noise: 0.18,
    modes: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 2.76, gain: 0.7, decay: 0.8 },
      { ratio: 5.4, gain: 0.5, decay: 0.6 },
      { ratio: 8.93, gain: 0.35, decay: 0.45 },
      { ratio: 13.34, gain: 0.22, decay: 0.3 },
      { ratio: 18.64, gain: 0.12, decay: 0.2 },
    ],
  },
  // Struck glass: clear, bright, medium ring.
  glass: {
    f0: 880,
    baseDecay: 0.9,
    noise: 0.12,
    modes: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 2.32, gain: 0.6, decay: 0.7 },
      { ratio: 4.25, gain: 0.45, decay: 0.5 },
      { ratio: 6.63, gain: 0.3, decay: 0.35 },
      { ratio: 9.38, gain: 0.18, decay: 0.22 },
    ],
  },
  // Struck wood: warm, damped, short.
  wood: {
    f0: 220,
    baseDecay: 0.28,
    noise: 0.3,
    modes: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 1.45, gain: 0.6, decay: 0.7 },
      { ratio: 2.1, gain: 0.4, decay: 0.5 },
      { ratio: 2.81, gain: 0.25, decay: 0.35 },
      { ratio: 3.5, gain: 0.15, decay: 0.25 },
    ],
  },
  // Struck ceramic/tile: bright, pingy, short.
  ceramic: {
    f0: 660,
    baseDecay: 0.5,
    noise: 0.2,
    modes: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 2.7, gain: 0.55, decay: 0.6 },
      { ratio: 5.1, gain: 0.35, decay: 0.4 },
      { ratio: 8.0, gain: 0.2, decay: 0.25 },
    ],
  },
  // Struck membrane (drum/tom): low, inharmonic, medium.
  membrane: {
    f0: 160,
    baseDecay: 0.45,
    noise: 0.35,
    modes: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 1.59, gain: 0.7, decay: 0.8 },
      { ratio: 2.14, gain: 0.5, decay: 0.6 },
      { ratio: 2.3, gain: 0.4, decay: 0.5 },
      { ratio: 2.65, gain: 0.3, decay: 0.4 },
      { ratio: 2.92, gain: 0.2, decay: 0.3 },
    ],
  },
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ModalSpec {
  /** Frequency multiplier (0.25–4): bigger/smaller object. Default 1. */
  pitch?: number
  /** Decay multiplier (0.25–4): how long it rings. Default 1. */
  decay?: number
  /** 0–1: emphasis on high modes (brighter/harder strike). Default 0.6. */
  brightness?: number
  /** 0–1: deterministic per-strike variation (detune + gain jitter). Default 0. */
  variation?: number
}

interface ModalResult {
  samples: number[]
  sampleRate: number
  durationSec: number
  material: string
}

/** Synthesize a struck-object impact. Returns null for an unknown material. */
export function synthesizeModal(material: string, spec: ModalSpec = {}): ModalResult | null {
  const mat = MATERIALS[material as ModalMaterial]
  if (!mat) return null

  const pitch = clamp(spec.pitch ?? 1, 0.25, 4)
  const decayMul = clamp(spec.decay ?? 1, 0.25, 4)
  const brightness = clamp(spec.brightness ?? 0.6, 0, 1)
  const variation = clamp(spec.variation ?? 0, 0, 1)
  const rng = mulberry32(hashStr(`${material}|${pitch}|${decayMul}|${brightness}|${variation}`))

  const f0 = mat.f0 * pitch
  const baseTau = mat.baseDecay * decayMul
  // Size the buffer so the longest mode rings out (~4 time-constants), capped.
  const maxTau = baseTau * Math.max(...mat.modes.map((m) => m.decay))
  const durationSec = clamp(maxTau * 4, 0.05, MAX_SEC)
  const n = Math.floor(durationSec * SAMPLE_RATE)
  const buf = new Float32Array(n)

  // Modal ring: sum of decaying sinusoids. Brightness tilts gain toward high modes.
  for (let mi = 0; mi < mat.modes.length; mi++) {
    const m = mat.modes[mi]
    const detune = 1 + (rng() - 0.5) * 0.02 * variation // ±1% per-mode detune
    const f = f0 * m.ratio * detune
    if (f >= SAMPLE_RATE / 2) continue // skip modes above Nyquist (no aliasing)
    const tau = baseTau * m.decay * SAMPLE_RATE // in samples
    const tilt = mi === 0 ? 1 : Math.pow(0.4 + 0.6 * brightness, 1) * (1 + brightness * mi * 0.15)
    const gain = m.gain * tilt * (1 + (rng() - 0.5) * 0.2 * variation)
    const phase = rng() * Math.PI * 2 * variation
    const w = (2 * Math.PI * f) / SAMPLE_RATE
    for (let i = 0; i < n; i++) {
      buf[i] += gain * Math.exp(-i / tau) * Math.sin(w * i + phase)
    }
  }

  // Contact transient: a short broadband noise burst at the strike (the "tick" of
  // contact) — what sells it as an impact vs a pure tone. Brighter strike = louder.
  const burst = Math.max(2, Math.floor(0.006 * SAMPLE_RATE)) // ~6ms
  const noiseGain = mat.noise * (0.5 + 0.5 * brightness)
  for (let i = 0; i < Math.min(burst, n); i++) {
    const env = Math.exp(-i / (burst * 0.35))
    buf[i] += (rng() * 2 - 1) * noiseGain * env
  }

  // Tiny attack ramp (~0.5ms) so the very first sample isn't a hard discontinuity.
  const atk = Math.max(1, Math.floor(0.0005 * SAMPLE_RATE))
  for (let i = 0; i < Math.min(atk, n); i++) buf[i] *= i / atk

  // Peak-normalize (guard silence + non-finite).
  let peak = 0
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(buf[i])) buf[i] = 0
    const a = Math.abs(buf[i])
    if (a > peak) peak = a
  }
  if (peak > 0) {
    const g = 0.95 / peak
    for (let i = 0; i < n; i++) buf[i] *= g
  }

  return { samples: Array.from(buf), sampleRate: SAMPLE_RATE, durationSec, material }
}

/** Synthesize a modal impact to a mono 16-bit PCM WAV. Returns null if unknown. */
export function synthesizeModalWav(
  material: string,
  spec: ModalSpec = {},
): { wav: Buffer; durationSec: number; material: string } | null {
  const r = synthesizeModal(material, spec)
  if (!r) return null
  return { wav: encodeMonoWavPcm16(r.samples, r.sampleRate), durationSec: r.durationSec, material: r.material }
}
