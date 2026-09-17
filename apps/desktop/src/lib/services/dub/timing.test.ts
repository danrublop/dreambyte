import { describe, it, expect } from 'vitest'
import { planSegmentTiming, totalDriftMs, MIN_ATEMPO, MAX_ATEMPO } from './timing'

describe('planSegmentTiming', () => {
  it('clamps a slow-down to MIN_ATEMPO and pads the rest', () => {
    // ttsMs/windowMs = 3000/4000 = 0.75 → clamped up to 0.8; adjusted = 3000/0.8 = 3750; pad 250.
    const p = planSegmentTiming(4000, 3000)
    expect(p.atempo).toBe(MIN_ATEMPO)
    expect(p.padMsAfter).toBe(250)
    expect(p.overflows).toBe(false)
    expect(p.resultMs).toBe(4000)
  })

  it('speeds up (atempo>1) when the dub is moderately longer, fitting the window', () => {
    // 4800/4000 = 1.2 (within MAX 1.3) → adjusted = 4800/1.2 = 4000; fits exactly, no pad.
    const p = planSegmentTiming(4000, 4800)
    expect(p.atempo).toBeCloseTo(1.2, 5)
    expect(p.padMsAfter).toBe(0)
    expect(p.overflows).toBe(false)
    expect(p.resultMs).toBeCloseTo(4000, 0)
  })

  it('clamps an extreme speed-up to MAX_ATEMPO and marks overflow (spills past the cue)', () => {
    // 8000/4000 = 2.0 → clamped to 1.3; adjusted = 8000/1.3 ≈ 6154 > window → overflow, no pad.
    const p = planSegmentTiming(4000, 8000)
    expect(p.atempo).toBe(MAX_ATEMPO)
    expect(p.overflows).toBe(true)
    expect(p.padMsAfter).toBe(0)
    expect(p.resultMs).toBeGreaterThan(4000)
  })

  it('is a safe no-op on a zero/negative window or audio', () => {
    expect(planSegmentTiming(0, 3000)).toMatchObject({ atempo: 1, padMsAfter: 0, overflows: false })
    expect(planSegmentTiming(4000, 0)).toMatchObject({ atempo: 1, padMsAfter: 0 })
  })
})

describe('totalDriftMs', () => {
  it('sums only the overflow spill across cues (0 when everything fits)', () => {
    const windows = [4000, 4000]
    const fits = [planSegmentTiming(4000, 3000), planSegmentTiming(4000, 4400)]
    expect(totalDriftMs(windows, fits)).toBe(0)
    const overflow = [planSegmentTiming(4000, 8000), planSegmentTiming(4000, 3000)]
    expect(totalDriftMs(windows, overflow)).toBeGreaterThan(0)
  })
})
