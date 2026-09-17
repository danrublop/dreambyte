/**
 * Native SFX — generative mode via jsfxr (the full sfxr engine, UNLICENSE/public domain).
 *
 * Complements the ZzFX archetypes (src/lib/audio/sfx/synth.ts): where ZzFX gives EXACT
 * curated presets, jsfxr's category GENERATORS produce a fresh, richer, varied sound
 * each seed ("give me AN explosion", not "the explosion"). $0, fully local, no provider.
 *
 * Determinism: sfxr.generate + SoundEffect.generate both use global Math.random. We
 * seed it (seed = category + variation) around the synchronous calls, so a given
 * (category, variation) is reproducible/cacheable, and bumping variation yields a new
 * take. No AudioContext is needed — jsfxr builds the WAV in pure JS.
 */
// jsfxr is CJS (module.exports = { sfxr, SoundEffect, ... }); named ESM imports don't
// resolve cleanly under esbuild interop, so grab the namespace and unwrap default.
// @ts-expect-error - no type declarations for jsfxr
import * as jsfxrNs from 'jsfxr'
const jsfxr = ((jsfxrNs as Record<string, unknown>).default ?? jsfxrNs) as {
  sfxr: { generate: (preset: string) => unknown }
  SoundEffect: new (params: unknown) => { generate: () => { dataURI: string } }
}
const sfxr = jsfxr.sfxr
const SoundEffect = jsfxr.SoundEffect

/** Friendly category names → jsfxr generator presets. */
export const SFXR_CATEGORIES: Record<string, string> = {
  explosion: 'explosion',
  laser: 'laserShoot',
  shoot: 'laserShoot',
  coin: 'pickupCoin',
  pickup: 'pickupCoin',
  powerup: 'powerUp',
  hit: 'hitHurt',
  hurt: 'hitHurt',
  jump: 'jump',
  blip: 'blipSelect',
  select: 'blipSelect',
  tone: 'tone',
  random: 'random',
}

export const SFXR_CATEGORY_NAMES = Object.keys(SFXR_CATEGORIES)

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

export interface SfxrResult {
  wav: Buffer
  durationSec: number
  category: string
}

/**
 * Generate a fresh sfxr sound for a category, deterministically per (category, variation).
 * Returns null for an unknown category.
 */
export function generateSfxr(category: string, variation = 0): SfxrResult | null {
  const name = String(category || '').trim()
  const preset = SFXR_CATEGORIES[name] ?? name
  if (!Object.values(SFXR_CATEGORIES).includes(preset)) return null

  const rng = mulberry32(hashStr(`${preset}|${variation}`))
  const orig = Math.random
  Math.random = rng
  let dataURI: string
  try {
    const params = sfxr.generate(preset)
    const out = new SoundEffect(params).generate() as { dataURI: string }
    dataURI = out.dataURI
  } finally {
    Math.random = orig
  }
  if (!dataURI || !dataURI.startsWith('data:audio/wav;base64,')) return null

  const wav = Buffer.from(dataURI.split(',')[1], 'base64')
  // mono PCM WAV: frames = (dataChunkBytes) / (channels * bytesPerSample). Header is 44 bytes;
  // sfxr emits 8-bit mono, so 1 byte/frame. Read rate/bits from the header to be safe.
  const sampleRate = wav.length > 28 ? wav.readUInt32LE(24) : 44100
  const bits = wav.length > 36 ? wav.readUInt16LE(34) : 8
  const frames = Math.max(0, (wav.length - 44) / Math.max(1, bits / 8))
  return { wav, durationSec: frames / (sampleRate || 44100), category: preset }
}
