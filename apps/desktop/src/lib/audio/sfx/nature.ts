/**
 * Native SFX — NATURAL ambience synthesis (the noise-based engine).
 *
 * ZzFX and jsfxr are OSCILLATOR synths → everything is a pitched/retro beep. Natural
 * sounds (wind, rain, fire, ocean) are the opposite: filtered NOISE textures with slow
 * amplitude modulation (gusts/swells) and random transients (droplets/crackle). This
 * module synthesizes those with subtractive DSP — pure JS, no samples, $0, deterministic.
 *
 *   brown/pink noise ──► one-pole low/high-pass ──► amplitude LFO (gusts/swells)
 *                                                 + random transients (drops/crackle)
 *                                                 ──► peak-normalize ──► samples
 *
 * Seeded PRNG → identical (category, duration, intensity, seed) renders are reproducible.
 */
import { encodeMonoWavPcm16 } from '../encode-mono-wav-pcm16'

const SAMPLE_RATE = 44100
const MAX_SEC = 30

export const NATURE_CATEGORIES = [
  'wind',
  'rain',
  'fire',
  'ocean',
  'thunder',
  'stream',
  'static',
  'rumble',
  'wind-howl',
  'sizzle',
] as const
export type NatureCategory = (typeof NATURE_CATEGORIES)[number]

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

/** White noise in [-1,1]. */
function white(n: number, rng: () => number): Float64Array {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1
  return out
}
/** Brown (red) noise: leaky-integrated white. Warm, low, un-hissy — the basis of most nature. */
function brown(n: number, rng: () => number): Float64Array {
  const out = new Float64Array(n)
  let last = 0
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (rng() * 2 - 1)) / 1.02
    out[i] = last * 12
  }
  return out
}
/** One-pole low-pass. cutoff in Hz. */
function lowpass(x: Float64Array, cutoffHz: number): Float64Array {
  const dt = 1 / SAMPLE_RATE
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const a = dt / (rc + dt)
  const out = new Float64Array(x.length)
  let y = 0
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y)
    out[i] = y
  }
  return out
}
/** One-pole high-pass (x minus its low-pass). */
function highpass(x: Float64Array, cutoffHz: number): Float64Array {
  const lp = lowpass(x, cutoffHz)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i] - lp[i]
  return out
}

/** Slow sine LFO returning 0..1, used for gust/swell amplitude modulation. */
function lfo(i: number, freqHz: number, phase = 0): number {
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * freqHz * (i / SAMPLE_RATE) + phase)
}

/** Add a short decaying noise transient (droplet / crackle) at frame `at`. */
function addTransient(buf: Float64Array, at: number, lenSamples: number, amp: number, rng: () => number, bright: boolean) {
  const end = Math.min(buf.length, at + lenSamples)
  let lp = 0
  for (let i = at; i < end; i++) {
    const t = (i - at) / lenSamples
    const env = Math.pow(1 - t, bright ? 2 : 3)
    let s = rng() * 2 - 1
    if (!bright) {
      lp += 0.3 * (s - lp) // soften
      s = lp
    }
    buf[i] += s * amp * env
  }
}

function peakNormalize(buf: Float64Array, target = 0.92): Float64Array {
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > peak) peak = a
  }
  if (peak > 0) {
    const k = target / peak
    for (let i = 0; i < buf.length; i++) buf[i] *= k
  }
  return buf
}

export interface NatureSpec {
  /** 1..30s. Default 4. */
  durationSec?: number
  /** 0..1 — louder/denser/brighter. Default 0.6. */
  intensity?: number
  /** Integer-ish variation seed. Default 0. */
  seed?: number
}

export interface NatureResult {
  samples: number[]
  sampleRate: number
  durationSec: number
  category: string
}

/** Synthesize a natural ambience. Returns null for an unknown category. */
export function synthesizeNature(category: string, spec: NatureSpec = {}): NatureResult | null {
  const cat = String(category || '').trim() as NatureCategory
  if (!NATURE_CATEGORIES.includes(cat)) return null

  const durationSec = clamp(spec.durationSec ?? 4, 1, MAX_SEC)
  const intensity = clamp(spec.intensity ?? 0.6, 0, 1)
  const n = Math.floor(durationSec * SAMPLE_RATE)
  const rng = mulberry32(hashStr(`${cat}|${durationSec}|${intensity}|${spec.seed ?? 0}`))

  let buf: Float64Array
  switch (cat) {
    case 'wind': {
      buf = lowpass(brown(n, rng), 200 + 900 * intensity)
      for (let i = 0; i < n; i++) buf[i] *= 0.25 + 0.75 * (0.4 * lfo(i, 0.18) + 0.35 * lfo(i, 0.07, 1.3) + 0.25 * lfo(i, 0.31, 2.1))
      break
    }
    case 'wind-howl': {
      const base = lowpass(brown(n, rng), 300 + 700 * intensity)
      const howl = lowpass(highpass(white(n, rng), 600), 1400) // narrowish band → tonal-ish howl
      buf = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const gust = 0.3 + 0.7 * (0.5 * lfo(i, 0.12) + 0.5 * lfo(i, 0.05, 1.7))
        buf[i] = (base[i] + howl[i] * 0.5 * lfo(i, 0.09, 0.5)) * gust
      }
      break
    }
    case 'rain': {
      buf = lowpass(highpass(white(n, rng), 800), 5000 + 4000 * intensity) // hiss bed
      for (let i = 0; i < n; i++) buf[i] *= 0.45
      const drops = Math.floor(durationSec * (120 + 500 * intensity))
      for (let d = 0; d < drops; d++) addTransient(buf, Math.floor(rng() * n), 60 + Math.floor(rng() * 200), 0.25 + rng() * 0.5, rng, true)
      break
    }
    case 'fire': {
      buf = lowpass(brown(n, rng), 350 + 250 * intensity) // low lapping rumble
      for (let i = 0; i < n; i++) buf[i] *= 0.5 + 0.5 * lfo(i, 0.6 + rng() * 0)
      const cracks = Math.floor(durationSec * (8 + 40 * intensity))
      for (let c = 0; c < cracks; c++) addTransient(buf, Math.floor(rng() * n), 30 + Math.floor(rng() * 120), 0.4 + rng() * 0.6, rng, true)
      break
    }
    case 'ocean': {
      const bed = lowpass(brown(n, rng), 400 + 600 * intensity)
      buf = new Float64Array(n)
      // each wave = a slow swell envelope
      for (let i = 0; i < n; i++) {
        const swell = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 0.12 * (i / SAMPLE_RATE)), 1.6)
        buf[i] = bed[i] * (0.2 + 0.8 * swell)
      }
      break
    }
    case 'thunder': {
      const rumble = lowpass(brown(n, rng), 90 + 60 * intensity)
      buf = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const t = i / n
        const env = t < 0.04 ? t / 0.04 : Math.pow(1 - (t - 0.04) / 0.96, 1.6) // fast attack, long decay
        buf[i] = rumble[i] * env
      }
      const cracks = Math.floor(2 + 4 * intensity)
      for (let c = 0; c < cracks; c++) addTransient(buf, Math.floor(rng() * n * 0.4), 200 + Math.floor(rng() * 600), 0.5 + rng() * 0.5, rng, false)
      break
    }
    case 'stream': {
      buf = lowpass(highpass(white(n, rng), 500), 4000 + 3000 * intensity)
      for (let i = 0; i < n; i++) buf[i] *= 0.4 * (0.7 + 0.3 * lfo(i, 0.5, rng() * 0))
      const bubbles = Math.floor(durationSec * (60 + 200 * intensity))
      for (let b = 0; b < bubbles; b++) addTransient(buf, Math.floor(rng() * n), 80 + Math.floor(rng() * 160), 0.15 + rng() * 0.3, rng, false)
      break
    }
    case 'sizzle': {
      buf = highpass(white(n, rng), 2000)
      for (let i = 0; i < n; i++) buf[i] *= 0.35 + 0.2 * lfo(i, 7)
      const pops = Math.floor(durationSec * (40 + 120 * intensity))
      for (let p = 0; p < pops; p++) addTransient(buf, Math.floor(rng() * n), 10 + Math.floor(rng() * 40), 0.2 + rng() * 0.4, rng, true)
      break
    }
    case 'static': {
      buf = highpass(white(n, rng), 1200)
      for (let i = 0; i < n; i++) buf[i] *= 0.5 + 0.2 * intensity
      break
    }
    case 'rumble': {
      buf = lowpass(brown(n, rng), 60 + 40 * intensity)
      break
    }
    default:
      return null
  }

  peakNormalize(buf, 0.5 + 0.45 * intensity)
  return { samples: Array.from(buf), sampleRate: SAMPLE_RATE, durationSec, category: cat }
}

/** Synthesize a natural ambience to a mono 16-bit PCM WAV. Returns null if unknown. */
export function synthesizeNatureWav(category: string, spec: NatureSpec = {}): { wav: Buffer; durationSec: number; category: string } | null {
  const r = synthesizeNature(category, spec)
  if (!r) return null
  return { wav: encodeMonoWavPcm16(r.samples, r.sampleRate), durationSec: r.durationSec, category: r.category }
}
