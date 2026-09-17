import { describe, it, expect } from 'vitest'
import { clipFiltersToCss, clipBlendModeToCss } from './clip-filter-css'
import type { ClipFilter } from '../types'

const f = (type: ClipFilter['type'], value: number): ClipFilter => ({ type, value })

describe('clipFiltersToCss', () => {
  it('maps each of the 7 CSS-mappable filters', () => {
    expect(clipFiltersToCss([f('blur', 3)])).toBe('blur(3px)')
    expect(clipFiltersToCss([f('brightness', 1.2)])).toBe('brightness(1.2)')
    expect(clipFiltersToCss([f('contrast', 0.8)])).toBe('contrast(0.8)')
    expect(clipFiltersToCss([f('saturate', 2)])).toBe('saturate(2)')
    expect(clipFiltersToCss([f('grayscale', 0.5)])).toBe('grayscale(0.5)')
    expect(clipFiltersToCss([f('sepia', 1)])).toBe('sepia(1)')
    expect(clipFiltersToCss([f('hue-rotate', 90)])).toBe('hue-rotate(90deg)')
  })

  it('space-joins multiple filters in order', () => {
    expect(clipFiltersToCss([f('blur', 2), f('brightness', 1.1), f('saturate', 1.3)])).toBe(
      'blur(2px) brightness(1.1) saturate(1.3)',
    )
  })

  it('SKIPS tone-curve (no CSS LUT) without throwing, keeping the rest', () => {
    expect(clipFiltersToCss([{ type: 'tone-curve', value: 1 } as ClipFilter])).toBe('')
    expect(clipFiltersToCss([f('blur', 1), { type: 'tone-curve', value: 1 } as ClipFilter, f('contrast', 1.5)])).toBe(
      'blur(1px) contrast(1.5)',
    )
  })

  it('clamps grayscale/sepia to [0,1] and blur/brightness to >= 0', () => {
    expect(clipFiltersToCss([f('grayscale', 2)])).toBe('grayscale(1)')
    expect(clipFiltersToCss([f('sepia', -1)])).toBe('sepia(0)')
    expect(clipFiltersToCss([f('blur', -5)])).toBe('blur(0px)')
    expect(clipFiltersToCss([f('brightness', -0.5)])).toBe('brightness(0)')
  })

  it('empty / undefined / null → empty string (caller omits the property)', () => {
    expect(clipFiltersToCss([])).toBe('')
    expect(clipFiltersToCss(undefined)).toBe('')
    expect(clipFiltersToCss(null)).toBe('')
  })
})

describe('clipBlendModeToCss', () => {
  it('maps the 1:1 CSS mix-blend-mode names', () => {
    for (const m of [
      'multiply',
      'screen',
      'overlay',
      'darken',
      'lighten',
      'color-dodge',
      'color-burn',
      'hard-light',
      'soft-light',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ]) {
      expect(clipBlendModeToCss(m)).toBe(m)
    }
  })

  it('add → plus-lighter (additive); subtract → "" (no CSS equiv, degrade)', () => {
    expect(clipBlendModeToCss('add')).toBe('plus-lighter')
    expect(clipBlendModeToCss('subtract')).toBe('')
  })

  it('normal / undefined / null / "" / unknown → "" (caller omits)', () => {
    expect(clipBlendModeToCss('normal')).toBe('')
    expect(clipBlendModeToCss(undefined)).toBe('')
    expect(clipBlendModeToCss(null)).toBe('')
    expect(clipBlendModeToCss('')).toBe('')
    expect(clipBlendModeToCss('bogus')).toBe('')
  })
})
