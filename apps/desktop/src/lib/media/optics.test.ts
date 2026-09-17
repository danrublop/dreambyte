import { describe, it, expect } from 'vitest'
import {
  compileOpticsToPrompt,
  focalDescriptor,
  apertureDescriptor,
  resolveOpticsPreset,
  OPTICS_PRESETS,
} from './optics'

describe('focalDescriptor', () => {
  it('bands focal length into wide/normal/telephoto', () => {
    expect(focalDescriptor(12)).toMatch(/ultra-wide-angle/)
    expect(focalDescriptor(24)).toMatch(/wide-angle/)
    expect(focalDescriptor(50)).toMatch(/normal/)
    expect(focalDescriptor(85)).toMatch(/short-telephoto portrait/)
    expect(focalDescriptor(135)).toMatch(/telephoto/)
    expect(focalDescriptor(300)).toMatch(/super-telephoto/)
  })
  it('clamps out-of-range focal lengths', () => {
    expect(focalDescriptor(2)).toMatch(/^8mm/)
    expect(focalDescriptor(999)).toMatch(/^300mm/)
  })
})

describe('apertureDescriptor', () => {
  it('maps f-number to depth of field (smaller f = shallower)', () => {
    expect(apertureDescriptor(1.4)).toMatch(/very shallow depth of field.*f\/1.4/)
    expect(apertureDescriptor(2.8)).toMatch(/shallow depth of field.*f\/2.8/)
    expect(apertureDescriptor(8)).toMatch(/balanced focus.*f\/8/)
    expect(apertureDescriptor(16)).toMatch(/deep focus.*f\/16/)
  })
})

describe('compileOpticsToPrompt', () => {
  it('returns "" for empty/null specs', () => {
    expect(compileOpticsToPrompt(null)).toBe('')
    expect(compileOpticsToPrompt({})).toBe('')
  })

  it('composes film stock, focal, depth of field, and framing in cinematic order', () => {
    const out = compileOpticsToPrompt({ filmStock: '70mm', focalLengthMm: 50, aperture: 8, shotSize: 'wide' })
    expect(out).toMatch(/^Shot on 70mm film/)
    expect(out).toContain('50mm normal lens')
    expect(out).toContain('balanced focus (f/8)')
    expect(out).toContain('wide shot')
    expect(out.endsWith('.')).toBe(true)
  })

  it('uses the named lens style and avoids redundant focal text for wide/telephoto', () => {
    expect(compileOpticsToPrompt({ lens: 'wide-angle', focalLengthMm: 24 })).toBe('Wide-angle lens.')
    // a non-wide/tele lens (anamorphic) keeps the focal descriptor too
    const ana = compileOpticsToPrompt({ lens: 'anamorphic', focalLengthMm: 40 })
    expect(ana).toMatch(/anamorphic lens/i)
    expect(ana).toContain('40mm')
  })

  it('capitalizes the clause and joins with commas', () => {
    expect(compileOpticsToPrompt({ aperture: 1.4 })).toMatch(/^Very shallow depth of field/)
  })

  it('skips NaN/Infinity focal+aperture (no "NaNmm"/"f/NaN" leaking into the prompt or cache key)', () => {
    expect(compileOpticsToPrompt({ focalLengthMm: NaN, aperture: NaN })).toBe('')
    expect(compileOpticsToPrompt({ focalLengthMm: Infinity })).toBe('')
    // a valid field still renders even if a sibling is garbage
    const out = compileOpticsToPrompt({ focalLengthMm: NaN, filmStock: '70mm' })
    expect(out).not.toMatch(/NaN/)
    expect(out).toMatch(/70mm film/)
  })
})

describe('presets', () => {
  it('every preset compiles to a non-empty clause', () => {
    for (const id of Object.keys(OPTICS_PRESETS)) {
      expect(compileOpticsToPrompt(resolveOpticsPreset(id)).length).toBeGreaterThan(0)
    }
  })
  it('resolves a known preset and returns null for unknown', () => {
    expect(resolveOpticsPreset('portrait-85')).toMatchObject({ focalLengthMm: 85, aperture: 1.4 })
    expect(resolveOpticsPreset('nope')).toBeNull()
  })
})
