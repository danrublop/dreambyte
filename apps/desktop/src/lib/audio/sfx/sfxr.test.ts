// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { generateSfxr, SFXR_CATEGORIES, SFXR_CATEGORY_NAMES } from './sfxr'

const rmsDb = (wav: Buffer) => {
  // 8-bit unsigned PCM mono after the 44-byte header.
  let sum = 0
  const n = wav.length - 44
  for (let i = 44; i < wav.length; i++) {
    const v = (wav[i] - 128) / 128
    sum += v * v
  }
  return 20 * Math.log10(Math.sqrt(sum / n) || 1e-9)
}

describe('jsfxr generative SFX', () => {
  it('generates a non-silent sound for every category', () => {
    for (const name of SFXR_CATEGORY_NAMES) {
      const r = generateSfxr(name, 0)
      expect(r, `${name} should generate`).not.toBeNull()
      expect(r!.wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(r!.durationSec).toBeGreaterThan(0)
      expect(rmsDb(r!.wav), `${name} audible`).toBeGreaterThan(-45)
    }
  })

  it('returns null for an unknown category', () => {
    expect(generateSfxr('not-a-category')).toBeNull()
    expect(generateSfxr('')).toBeNull()
  })

  it('is deterministic per (category, variation)', () => {
    const a = generateSfxr('explosion', 0.5)!.wav
    const b = generateSfxr('explosion', 0.5)!.wav
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('different variation → a different sound', () => {
    const a = generateSfxr('explosion', 0)!.wav
    const b = generateSfxr('explosion', 0.7)!.wav
    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('accepts raw jsfxr preset names too', () => {
    expect(generateSfxr('laserShoot', 0)).not.toBeNull()
    expect(generateSfxr('pickupCoin', 0)).not.toBeNull()
  })

  it('every alias maps to a real jsfxr preset', () => {
    for (const [alias, preset] of Object.entries(SFXR_CATEGORIES)) {
      expect(generateSfxr(preset, 0), `${alias} → ${preset}`).not.toBeNull()
    }
  })
})
