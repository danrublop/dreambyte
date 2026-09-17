// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { validateMotionRef, suggestPresetId } from './validate'

describe('validateMotionRef', () => {
  it('accepts a valid preset ref', () => {
    expect(validateMotionRef({ kind: 'preset', preset: 'fadeInUp' })).toEqual({ ok: true })
  })

  it('accepts a preset ref with spring + duration overrides', () => {
    expect(
      validateMotionRef({
        kind: 'preset',
        preset: 'bounceIn',
        spring: 'wobbly',
        durationFrames: 24,
        delayFrames: 6,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects unknown preset and suggests close matches', () => {
    const r = validateMotionRef({ kind: 'preset', preset: 'fadInUp' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown preset/)
      expect(r.suggestions).toContain('fadeInUp')
    }
  })

  it('rejects an unknown spring name with explicit list', () => {
    const r = validateMotionRef({ kind: 'preset', preset: 'fadeInUp', spring: 'springy' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/gentle, wobbly, stiff, slow, molasses/)
  })

  it('rejects a spring ref without spring name', () => {
    expect(validateMotionRef({ kind: 'spring', from: { x: 0 }, to: { x: 100 } }).ok).toBe(false)
  })

  it('accepts a valid spring ref', () => {
    expect(validateMotionRef({ kind: 'spring', from: { x: 0 }, to: { x: 100 }, spring: 'gentle' })).toEqual({
      ok: true,
    })
  })

  it('rejects custom ref with too few keyframes', () => {
    const r = validateMotionRef({ kind: 'custom', keyframes: [{ at: 0 }], durationFrames: 30 })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid custom ref', () => {
    expect(
      validateMotionRef({
        kind: 'custom',
        keyframes: [
          { at: 0, opacity: 0 },
          { at: 1, opacity: 1 },
        ],
        durationFrames: 30,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects bogus kind values', () => {
    const r = validateMotionRef({ kind: 'magic' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/preset \| spring \| custom/)
  })

  it('rejects non-object input', () => {
    expect(validateMotionRef(null).ok).toBe(false)
    expect(validateMotionRef('preset').ok).toBe(false)
  })
})

describe('suggestPresetId', () => {
  it('finds the obvious typo', () => {
    expect(suggestPresetId('fadInUp')[0]).toBe('fadeInUp')
  })

  it('returns sorted by edit distance', () => {
    // 'shake' is a real preset so it should top its own list
    expect(suggestPresetId('shake')[0]).toBe('shake')
  })

  it('caps suggestions to max', () => {
    expect(suggestPresetId('zoom', 2).length).toBeLessThanOrEqual(2)
  })

  it('returns empty for total junk', () => {
    expect(suggestPresetId('xyzqrptlmkasdf').length).toBe(0)
  })
})
