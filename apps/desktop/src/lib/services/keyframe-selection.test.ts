// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { selectKeyframes } from './keyframe-selection'

describe('selectKeyframes', () => {
  it('returns all frames (sorted) when under budget', () => {
    const out = selectKeyframes([{ timeSec: 3 }, { timeSec: 1 }, { timeSec: 2 }], 12)
    expect(out.map((f) => f.timeSec)).toEqual([1, 2, 3])
  })

  it('returns empty for non-positive budget or no candidates', () => {
    expect(selectKeyframes([{ timeSec: 1 }], 0)).toEqual([])
    expect(selectKeyframes([], 5)).toEqual([])
  })

  it('uniform mode keeps first and last and spreads evenly', () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ timeSec: i }))
    const out = selectKeyframes(frames, 4)
    expect(out).toHaveLength(4)
    expect(out[0].timeSec).toBe(0)
    expect(out[out.length - 1].timeSec).toBe(9)
    // chronological
    expect(out.map((f) => f.timeSec)).toEqual([...out].map((f) => f.timeSec).sort((a, b) => a - b))
  })

  it('scene-scored mode prefers high-novelty frames but keeps the ends', () => {
    const frames = [
      { timeSec: 0, sceneScore: 0.1 },
      { timeSec: 1, sceneScore: 0.9 }, // high novelty
      { timeSec: 2, sceneScore: 0.05 },
      { timeSec: 3, sceneScore: 0.8 }, // high novelty
      { timeSec: 4, sceneScore: 0.02 },
    ]
    const out = selectKeyframes(frames, 4)
    const times = out.map((f) => f.timeSec)
    expect(times).toContain(0) // first kept
    expect(times).toContain(4) // last kept
    expect(times).toContain(1) // highest middle score
    expect(times).toContain(3) // next score
    expect(times).not.toContain(2) // lowest dropped
    // chronological order
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})
