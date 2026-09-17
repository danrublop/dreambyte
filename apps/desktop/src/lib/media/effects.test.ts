import { describe, it, expect } from 'vitest'
import { EFFECT_PRESETS, getEffectPreset, isEffectId, compileEffect } from './effects'

describe('effects preset library', () => {
  it('every preset has a unique id, a label, and a non-empty prompt', () => {
    const ids = new Set<string>()
    for (const p of EFFECT_PRESETS) {
      expect(p.id, 'id').toBeTruthy()
      expect(ids.has(p.id), `duplicate id ${p.id}`).toBe(false)
      ids.add(p.id)
      expect(p.label).toBeTruthy()
      expect(p.prompt.length).toBeGreaterThan(0)
    }
    expect(EFFECT_PRESETS.length).toBeGreaterThanOrEqual(10)
  })

  it('isEffectId only accepts known ids', () => {
    expect(isEffectId('explosion')).toBe(true)
    expect(isEffectId('glitch')).toBe(true)
    expect(isEffectId('not-an-effect')).toBe(false)
    expect(isEffectId(null)).toBe(false)
    expect(isEffectId(42)).toBe(false)
  })
})

describe('compileEffect', () => {
  // 'runway' is a video provider with camera:'prompt', so bundled camera moves compile in.
  it('returns the VFX prompt for every preset (non-empty)', () => {
    for (const p of EFFECT_PRESETS) {
      expect(compileEffect('runway', p.id).length, p.id).toBeGreaterThan(0)
    }
  })

  it('folds the bundled camera move into the clause (camera-capable provider)', () => {
    const out = compileEffect('runway', 'explosion')
    expect(out).toContain('explosion') // the VFX fragment
    expect(out).toMatch(/Camera movement:/) // the compiled camera clause (crash-zoom-out)
  })

  it('a preset with no bundled camera is just the VFX fragment', () => {
    const out = compileEffect('runway', 'glitch')
    expect(out).toContain('glitch')
    expect(out).not.toMatch(/Camera movement:/)
  })

  it('withCamera:false drops the bundled camera (so it cannot contradict a user-set camera)', () => {
    const out = compileEffect('runway', 'explosion', { withCamera: false })
    expect(out).toContain('explosion')
    expect(out).not.toMatch(/Camera movement:/)
  })

  it('returns empty string for an unknown / missing preset id', () => {
    expect(compileEffect('runway', 'nope')).toBe('')
    expect(compileEffect('runway', null)).toBe('')
    expect(compileEffect('runway', undefined)).toBe('')
  })

  it('getEffectPreset resolves a known id and returns null otherwise', () => {
    expect(getEffectPreset('dreamy')?.label).toBe('Dreamy')
    expect(getEffectPreset('nope')).toBeNull()
  })
})
