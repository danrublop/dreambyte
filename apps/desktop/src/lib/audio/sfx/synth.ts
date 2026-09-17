/**
 * Native SFX synth (the SFX twin of compose_music).
 *
 * The agent picks an ARCHETYPE (laser, explosion, coin, jump, hit, click…) and a
 * few knobs (pitch, duration, variation); ZzFX synthesizes the sound entirely
 * locally — $0, no provider, no key — and we encode it to a WAV. Archetypes map to
 * the curated ZZFX_SFX_CATEGORIES presets (MIT), so the agent gets named, musical
 * starting points instead of authoring 20 raw DSP parameters.
 *
 * ZzFX parameter indices we tune (the full order is
 * [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, …]):
 *   1 = randomness, 2 = frequency, 4 = sustain, 5 = release.
 *
 * Determinism: ZZFX.buildSamples uses global Math.random for its `randomness`
 * spread. We temporarily swap in a SEEDED PRNG (seed = the spec) around the
 * synchronous buildSamples call, so identical specs → identical WAVs (cacheable),
 * and `variation` just widens the deterministic spread.
 */
import './zzfx-node-env' // side-effect: install the AudioContext stub BEFORE zzfx loads
// @ts-expect-error - no type declarations available for zzfx
import { ZZFX } from 'zzfx/ZzFX.js'
import { encodeMonoWavPcm16 } from '../encode-mono-wav-pcm16'
import { ZZFX_SFX_CATEGORIES } from '../sfx-zzfx-presets'

// Flatten every curated preset by id → its ZzFX param array.
const PRESETS = new Map<string, number[]>()
for (const cat of ZZFX_SFX_CATEGORIES) for (const p of cat.presets) PRESETS.set(p.id, p.zzfx)

/**
 * Semantic archetype names → a representative preset id. The agent can also pass
 * any raw preset id directly. Keep this list tight and intuitive.
 */
export const SFX_ARCHETYPES: Record<string, string> = {
  laser: 'laser',
  'laser-big': 'laser-big',
  zap: 'sfxr-zap',
  shoot: 'sfxr-shoot',
  explosion: 'ex-med',
  'explosion-big': 'ex-noise',
  blast: 'ex-small',
  hit: 'impact-punch',
  punch: 'impact-punch',
  thud: 'impact-thud',
  slam: 'impact-slam',
  hurt: 'sfxr-hurt',
  coin: 'coin',
  pickup: 'coin',
  powerup: 'powerup',
  'level-up': 'level-up',
  star: 'star',
  heart: 'heart',
  gem: 'gem',
  jump: 'sfxr-jump',
  'double-jump': 'sfxr-double-jump',
  click: 'ui-click',
  tick: 'ui-tick',
  tap: 'ui-tap',
  beep: 'ui-beep-hi',
  chime: 'ui-chime',
  success: 'ui-success',
  error: 'ui-deny',
  deny: 'ui-deny',
  notify: 'notify',
  whoosh: 'whoosh',
  swipe: 'ui-swipe',
  'sweep-up': 'sweep-up',
  riser: 'riser',
  downer: 'downer',
  sparkle: 'sparkle-short',
  warp: 'warp',
  teleport: 'teleport',
  shield: 'shield',
  pop: 'pop',
  bonk: 'bonk',
  boing: 'boing',
  alarm: 'alarm-urgent',
  buzzer: 'buzzer',
  glitch: 'glitch-in',
  kick: 'kick',
  snare: 'snare',
  hat: 'hat',
  // material / world
  glass: 'impact-glass',
  wood: 'impact-wood',
  metal: 'impact-metal',
  sword: 'impact-sword',
  footstep: 'impact-body',
  splash: 'impact-bubble',
  wind: 'amb-wind',
  rain: 'amb-rain',
  typewriter: 'ui-type',
  // sci-fi extras
  charge: 'charge',
  scanner: 'scanner',
  drone: 'drone-pass',
  servo: 'servo',
  airlock: 'airlock',
  plasma: 'plasma',
  alien: 'alien',
  hologram: 'hologram',
  // game extras
  bling: 'sfxr-bling',
  'enemy-die': 'sfxr-enemy-die',
  'game-start': 'sfxr-game-start',
  powerdown: 'sfxr-powerdown',
  'game-over': 'game-over',
}

export const SFX_ARCHETYPE_NAMES = Object.keys(SFX_ARCHETYPES)

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

export interface SfxSpec {
  archetype: string
  /** Frequency multiplier 0.25..4 (higher = brighter/squeakier). Default 1. */
  pitch?: number
  /** Length multiplier 0.25..4 (scales sustain + release). Default 1. */
  duration?: number
  /** 0..1 — widens the deterministic randomness spread for variety. Default 0. */
  variation?: number
}

export interface SfxSamples {
  samples: number[]
  sampleRate: number
  durationSec: number
  resolvedId: string
}

/** Resolve an archetype/preset name to a tuned ZzFX parameter array, or null if unknown. */
export function resolveSfxParams(spec: SfxSpec): { params: number[]; resolvedId: string } | null {
  const name = String(spec.archetype || '').trim()
  const resolvedId = SFX_ARCHETYPES[name] ?? name
  const base = PRESETS.get(resolvedId)
  if (!base) return null

  const params = [...base]
  const pitch = clamp(spec.pitch ?? 1, 0.25, 4)
  const duration = clamp(spec.duration ?? 1, 0.25, 4)
  const variation = clamp(spec.variation ?? 0, 0, 1)

  if (pitch !== 1) params[2] = (params[2] ?? 220) * pitch // frequency
  if (duration !== 1) {
    params[4] = (params[4] ?? 0) * duration // sustain
    params[5] = (params[5] ?? 0.1) * duration // release
  }
  params[1] = clamp((params[1] ?? 0.05) + variation * 0.25, 0, 1) // randomness spread

  return { params, resolvedId }
}

/** Synthesize raw samples for an archetype, deterministically. Returns null if unknown. */
export function synthesizeSfx(spec: SfxSpec): SfxSamples | null {
  const resolved = resolveSfxParams(spec)
  if (!resolved) return null

  // Seed Math.random so ZzFX's randomness spread is reproducible for an identical spec.
  // buildSamples is synchronous, so nothing else observes the swap.
  const rng = mulberry32(
    hashStr(`${resolved.resolvedId}|${spec.pitch ?? 1}|${spec.duration ?? 1}|${spec.variation ?? 0}`),
  )
  const orig = Math.random
  Math.random = rng
  let samples: number[]
  try {
    samples = ZZFX.buildSamples(...resolved.params) as number[]
  } finally {
    Math.random = orig
  }
  const sampleRate = (ZZFX.sampleRate as number) || 44100
  return { samples, sampleRate, durationSec: samples.length / sampleRate, resolvedId: resolved.resolvedId }
}

export interface SfxWav {
  wav: Buffer
  durationSec: number
  resolvedId: string
}

/** Synthesize an archetype to a mono 16-bit PCM WAV buffer. Returns null if unknown. */
export function synthesizeSfxWav(spec: SfxSpec): SfxWav | null {
  const r = synthesizeSfx(spec)
  if (!r) return null
  return { wav: encodeMonoWavPcm16(r.samples, r.sampleRate), durationSec: r.durationSec, resolvedId: r.resolvedId }
}

export interface SfxLayer extends SfxSpec {
  /** Per-layer gain 0..2. Default 1. */
  volume?: number
  /** Start offset in milliseconds (lets layers stack into a compound sound). Default 0. */
  offsetMs?: number
}

const MAX_LAYERS = 6
const MAX_LAYERED_SEC = 12

/**
 * Layer several archetypes into one compound sound (e.g. explosion = boom + crackle +
 * debris). Each layer is synthesized deterministically, gain-scaled, offset, and summed;
 * the mix is peak-normalized to avoid clipping. Returns null if ANY layer is an unknown
 * archetype (the handler reports which). Empty list → null.
 */
export function synthesizeLayeredSfx(layers: SfxLayer[]): SfxSamples | null {
  if (!Array.isArray(layers) || layers.length === 0) return null
  const used = layers.slice(0, MAX_LAYERS)
  const rendered = used.map((l) => ({
    s: synthesizeSfx(l),
    gain: clamp(l.volume ?? 1, 0, 2),
    offset: Math.max(0, (l.offsetMs ?? 0) / 1000),
    name: l.archetype,
  }))
  if (rendered.some((r) => r.s === null)) return null

  const sampleRate = rendered[0].s!.sampleRate
  const maxFrames = MAX_LAYERED_SEC * sampleRate
  const total = Math.min(
    maxFrames,
    Math.max(...rendered.map((r) => Math.round(r.offset * sampleRate) + r.s!.samples.length)),
  )

  const out = new Array<number>(total).fill(0)
  for (const r of rendered) {
    const off = Math.round(r.offset * sampleRate)
    const s = r.s!.samples
    const end = Math.min(total, off + s.length)
    for (let i = off; i < end; i++) out[i] += s[i - off] * r.gain
  }

  // Peak-normalize (preserve shape) only if the sum overshoots, leaving a hair of headroom.
  let peak = 0
  for (let i = 0; i < total; i++) {
    const a = Math.abs(out[i])
    if (a > peak) peak = a
  }
  if (peak > 1) {
    const k = 0.99 / peak
    for (let i = 0; i < total; i++) out[i] *= k
  }

  return {
    samples: out,
    sampleRate,
    durationSec: total / sampleRate,
    resolvedId: rendered.map((r) => r.name).join('+'),
  }
}

/** Synthesize a layered compound SFX to a WAV buffer. Returns null if any layer is unknown. */
export function synthesizeLayeredSfxWav(layers: SfxLayer[]): SfxWav | null {
  const r = synthesizeLayeredSfx(layers)
  if (!r) return null
  return { wav: encodeMonoWavPcm16(r.samples, r.sampleRate), durationSec: r.durationSec, resolvedId: r.resolvedId }
}
