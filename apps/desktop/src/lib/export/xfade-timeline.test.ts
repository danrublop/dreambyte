import { describe, it, expect } from 'vitest'
// render-server is excluded from vitest *discovery* but can still be imported.
import {
  computeXfadeTimeline,
  getXfadeType,
  CUT_TRANSITION_SECONDS,
} from '@dreambyte/render-server/xfade-timeline.js'

const xf = (duration = 0.5) => ({ type: 'crossfade', duration })

describe('getXfadeType', () => {
  it('maps known transition ids to ffmpeg names', () => {
    expect(getXfadeType('crossfade')).toBe('fade')
    expect(getXfadeType('dissolve')).toBe('dissolve')
    expect(getXfadeType('wipe-left')).toBe('wipeleft')
    expect(getXfadeType('fade-black')).toBe('fadeblack')
  })
  it('falls back to fade for unknown / undefined', () => {
    expect(getXfadeType('not-a-real-transition')).toBe('fade')
    expect(getXfadeType(undefined)).toBe('fade')
  })
})

describe('computeXfadeTimeline', () => {
  it('2-scene crossfade: single offset = firstDuration - transDur', () => {
    const { joins, finalLength } = computeXfadeTimeline([6, 8], [xf(0.5)])
    expect(joins).toHaveLength(1)
    expect(joins[0].offset).toBeCloseTo(5.5, 6)
    expect(joins[0].transDur).toBeCloseTo(0.5, 6)
    expect(joins[0].xfadeType).toBe('fade')
    // 6 + 8 - 0.5
    expect(finalLength).toBeCloseTo(13.5, 6)
  })

  // REGRESSION (stitcher.js bug): 3+ scene crossfades must use the SHORTENED
  // running stream length for each offset, not Σ raw durations. The pre-fix bug
  // put offset[1] at 14 (6+8) instead of 13 and truncated the final scene,
  // yielding ~13.5s instead of ~21s for a 6+8+8 set.
  it('3-scene crossfade: cumulative offsets account for prior overlaps (regression)', () => {
    const durations = [6, 8, 8]
    const { joins, finalLength } = computeXfadeTimeline(durations, [xf(0.5), xf(0.5)])
    expect(joins).toHaveLength(2)
    expect(joins[0].offset).toBeCloseTo(5.5, 6) // 6 - 0.5
    expect(joins[1].offset).toBeCloseTo(13.0, 6) // (6+8-0.5) - 0.5  ← NOT 14
    // Σdurations - ΣtransDur = 22 - 1.0
    expect(finalLength).toBeCloseTo(21.0, 6)
  })

  it('final length tolerance is within 1 frame at the export FPS', () => {
    const fps = 30
    const durations = [6, 8, 8]
    const { finalLength } = computeXfadeTimeline(durations, [xf(0.5), xf(0.5)])
    const expected = 6 + 8 + 8 - 0.5 - 0.5
    expect(Math.abs(finalLength - expected)).toBeLessThanOrEqual(1 / fps)
  })

  it('treats "none" as a near-instant cut inside the xfade graph', () => {
    const { joins } = computeXfadeTimeline([5, 5], [{ type: 'none', duration: 0.5 }])
    expect(joins[0].isCut).toBe(true)
    expect(joins[0].transDur).toBeCloseTo(CUT_TRANSITION_SECONDS, 6)
  })

  it('clamps the cut transDur when the next scene is shorter than the near-cut', () => {
    // A 1-frame (0.02s) scene is shorter than the 0.04s near-cut — clamp so the
    // (now-fatal) xfade graph stays valid.
    const { joins } = computeXfadeTimeline([5, 0.02], [{ type: 'none', duration: 0.5 }])
    expect(joins[0].isCut).toBe(true)
    expect(joins[0].transDur).toBeCloseTo(0.02, 6)
  })

  it('clamps a negative offset to 0 when a scene is shorter than the transition', () => {
    const { joins } = computeXfadeTimeline([0.2, 5], [xf(0.5)])
    expect(joins[0].offset).toBe(0)
  })

  it('clamps a blend transDur to the shorter adjacent input (short next scene)', () => {
    // The next scene is 0.3s but the crossfade asks for 0.5s — clamp to 0.3 so
    // ffmpeg xfade (duration must be <= both inputs) does not error/fail loud.
    const { joins } = computeXfadeTimeline([5, 0.3], [xf(0.5)])
    expect(joins[0].transDur).toBeCloseTo(0.3, 6)
    expect(joins[0].offset).toBeCloseTo(4.7, 6) // 5 - 0.3
  })

  it('single scene: no joins, finalLength = its duration', () => {
    const { joins, finalLength } = computeXfadeTimeline([7], [])
    expect(joins).toHaveLength(0)
    expect(finalLength).toBe(7)
  })
})
