// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { MOTION_PRESETS, MOTION_PRESET_IDS, getMotionPreset, listMotionPresets } from './presets.generated'

describe('motion preset catalog', () => {
  it('every preset id is unique', () => {
    expect(new Set(MOTION_PRESET_IDS).size).toBe(MOTION_PRESET_IDS.length)
  })

  it('every preset has at least 2 keyframes', () => {
    for (const p of MOTION_PRESETS) {
      expect(p.keyframes.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('every preset has keyframes anchored at at=0 and at=1', () => {
    for (const p of MOTION_PRESETS) {
      const ats = p.keyframes.map((k) => k.at)
      expect(ats[0], `preset ${p.id} starts at 0`).toBe(0)
      expect(ats[ats.length - 1], `preset ${p.id} ends at 1`).toBe(1)
    }
  })

  it('keyframes are in monotonically increasing order', () => {
    for (const p of MOTION_PRESETS) {
      for (let i = 1; i < p.keyframes.length; i++) {
        expect(p.keyframes[i].at >= p.keyframes[i - 1].at, `preset ${p.id} keyframe ${i} not monotone`).toBe(true)
      }
    }
  })

  it('every preset declares at least one compatible renderer', () => {
    for (const p of MOTION_PRESETS) {
      expect(p.compatibleRenderers.length, `preset ${p.id} has no compatible renderers`).toBeGreaterThan(0)
    }
  })

  it('every preset has a non-empty description (used in agent prompt)', () => {
    for (const p of MOTION_PRESETS) {
      expect(p.description.trim().length, `preset ${p.id} description empty`).toBeGreaterThan(0)
    }
  })

  it('catalog covers entrance/exit/emphasis/ambient categories', () => {
    const cats = new Set(MOTION_PRESETS.map((p) => p.category))
    expect(cats).toEqual(new Set(['entrance', 'exit', 'emphasis', 'ambient']))
  })

  it('has at least 20 entrance presets (eng review test target)', () => {
    const entrances = MOTION_PRESETS.filter((p) => p.category === 'entrance')
    expect(entrances.length).toBeGreaterThanOrEqual(20)
  })

  it('default duration frames is positive', () => {
    for (const p of MOTION_PRESETS) {
      expect(p.defaultDurationFrames, `preset ${p.id} duration`).toBeGreaterThan(0)
    }
  })

  it('layout-aware presets are restricted to DOM renderers', () => {
    for (const p of MOTION_PRESETS) {
      if (p.flags.layoutAware) {
        expect(p.compatibleRenderers, `preset ${p.id} layout-aware compat`).toContain('react')
        expect(p.compatibleRenderers).not.toContain('three')
      }
    }
  })
})

describe('getMotionPreset', () => {
  it('returns the named preset', () => {
    const p = getMotionPreset('fadeInUp')
    expect(p?.id).toBe('fadeInUp')
    expect(p?.category).toBe('entrance')
  })

  it('returns null for unknown ids', () => {
    expect(getMotionPreset('not-a-preset')).toBeNull()
  })
})

describe('listMotionPresets', () => {
  it('without filter returns all', () => {
    expect(listMotionPresets().length).toBe(MOTION_PRESETS.length)
  })

  it('filters by category', () => {
    const exits = listMotionPresets({ category: 'exit' })
    expect(exits.length).toBeGreaterThan(0)
    expect(exits.every((p) => p.category === 'exit')).toBe(true)
  })

  it('filters by renderer', () => {
    const threeCompat = listMotionPresets({ renderer: 'three' })
    expect(threeCompat.every((p) => p.compatibleRenderers.includes('three'))).toBe(true)
  })

  it('filters by category and renderer composing', () => {
    const result = listMotionPresets({ category: 'entrance', renderer: 'three' })
    expect(result.every((p) => p.category === 'entrance' && p.compatibleRenderers.includes('three'))).toBe(true)
  })
})
