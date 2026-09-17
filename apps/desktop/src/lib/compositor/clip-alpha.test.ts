// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { computeClipAlpha } from './clip-alpha'
import type { Clip } from '@/lib/types'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'v',
    label: '',
    startTime: 0,
    duration: 10,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...overrides,
  }
}

describe('computeClipAlpha', () => {
  it('returns clip.opacity when no fade / blendOpacity is set', () => {
    const c = clip({ opacity: 0.7 })
    expect(computeClipAlpha(c, 5)).toBeCloseTo(0.7)
  })

  it('falls back to clip.opacity when kfOpacity is undefined', () => {
    expect(computeClipAlpha(clip({ opacity: 0.6 }), 5, undefined)).toBeCloseTo(0.6)
  })

  it('prefers kfOpacity over clip.opacity when provided', () => {
    expect(computeClipAlpha(clip({ opacity: 1 }), 5, 0.3)).toBeCloseTo(0.3)
  })

  describe('fadeIn ramp', () => {
    it('starts at 0 and rises linearly to base over fadeIn seconds', () => {
      const c = clip({ opacity: 1, fadeIn: 2 })
      expect(computeClipAlpha(c, 0)).toBe(0)
      expect(computeClipAlpha(c, 1)).toBeCloseTo(0.5)
      expect(computeClipAlpha(c, 2)).toBeCloseTo(1)
      // Past the fade-in window we hold steady
      expect(computeClipAlpha(c, 5)).toBeCloseTo(1)
    })

    it('clamps negative clipLocalTime to 0', () => {
      const c = clip({ opacity: 1, fadeIn: 2 })
      expect(computeClipAlpha(c, -1)).toBe(0)
    })
  })

  describe('fadeOut ramp', () => {
    it('starts at base and falls to 0 over the last fadeOut seconds', () => {
      const c = clip({ opacity: 1, duration: 10, fadeOut: 2 })
      // Before the fade-out window: steady at base
      expect(computeClipAlpha(c, 5)).toBeCloseTo(1)
      // Halfway through the tail (1s left of 2s fade): 0.5
      expect(computeClipAlpha(c, 9)).toBeCloseTo(0.5)
      // End of clip: 0
      expect(computeClipAlpha(c, 10)).toBe(0)
    })
  })

  it('layers fadeIn + fadeOut + base + blendOpacity multiplicatively', () => {
    const c = clip({ opacity: 0.5, duration: 10, fadeIn: 2, fadeOut: 2, blendOpacity: 0.5 })
    // At t=1 (mid fade-in): base 0.5 × fadeP 0.5 × blendOp 0.5 = 0.125
    expect(computeClipAlpha(c, 1)).toBeCloseTo(0.125)
    // At t=9 (mid fade-out): base 0.5 × tailP 0.5 × blendOp 0.5 = 0.125
    expect(computeClipAlpha(c, 9)).toBeCloseTo(0.125)
    // At mid-clip (no fade active): 0.5 × 0.5 = 0.25
    expect(computeClipAlpha(c, 5)).toBeCloseTo(0.25)
  })

  it('clamps blendOpacity outside [0, 1]', () => {
    const c = clip({ opacity: 1, blendOpacity: 2 })
    expect(computeClipAlpha(c, 5)).toBe(1)
    const c2 = clip({ opacity: 1, blendOpacity: -1 })
    expect(computeClipAlpha(c2, 5)).toBe(0)
  })

  it('clamps the final result to [0, 1]', () => {
    // Pathological inputs (kfOpacity past 1, no blend) — result must clamp
    expect(computeClipAlpha(clip(), 5, 2)).toBe(1)
    expect(computeClipAlpha(clip(), 5, -1)).toBe(0)
  })

  it('a clip with both fadeIn === duration and fadeOut === duration produces a triangle wave', () => {
    const c = clip({ opacity: 1, duration: 4, fadeIn: 4, fadeOut: 4 })
    expect(computeClipAlpha(c, 0)).toBeCloseTo(0)
    // Mid-point t=2: fade-in p=0.5, fade-out p=0.5 → 1 × 0.5 × 0.5 = 0.25
    expect(computeClipAlpha(c, 2)).toBeCloseTo(0.25)
    expect(computeClipAlpha(c, 4)).toBe(0)
  })
})
