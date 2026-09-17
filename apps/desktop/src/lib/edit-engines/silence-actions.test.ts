// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { silenceSpansToActions } from './silence-actions'
import type { Clip } from '@/lib/types'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    sourceType: 'video',
    sourceId: 'v',
    label: '',
    startTime: 10,
    duration: 20,
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

describe('silenceSpansToActions', () => {
  it('returns empty plan for no spans', () => {
    const plan = silenceSpansToActions(clip(), [])
    expect(plan.actions).toEqual([])
    expect(plan.savedSeconds).toBe(0)
  })

  it('drops zero-length and out-of-range spans during sanitize', () => {
    const plan = silenceSpansToActions(clip({ duration: 10 }), [
      { start: 5, end: 5 }, // zero-length
      { start: -1, end: 0 }, // before clip
      { start: 15, end: 20 }, // after clip
    ])
    expect(plan.actions).toEqual([])
  })

  it('whole-clip silence collapses to one rippleDelete', () => {
    const plan = silenceSpansToActions(clip({ duration: 10 }), [{ start: 0, end: 10 }])
    expect(plan.actions.length).toBe(1)
    expect(plan.actions[0]).toEqual({ type: 'clip/rippleDelete', params: { clipId: 'c1' } })
    expect(plan.savedSeconds).toBeCloseTo(10)
  })

  it('head-aligned span: split at end, rippleDelete left', () => {
    const c = clip({ duration: 10 })
    const plan = silenceSpansToActions(c, [{ start: 0, end: 2 }])
    expect(plan.actions.length).toBe(2)
    expect(plan.actions[0].type).toBe('clip/split')
    expect(plan.actions[0].params).toMatchObject({ clipId: 'c1', time: c.startTime + 2 })
    expect(plan.actions[1]).toEqual({ type: 'clip/rippleDelete', params: { clipId: 'c1' } })
  })

  it('tail-aligned span: split at start, rippleDelete right', () => {
    const c = clip({ duration: 10 })
    const plan = silenceSpansToActions(c, [{ start: 8, end: 10 }])
    expect(plan.actions.length).toBe(2)
    expect(plan.actions[0].type).toBe('clip/split')
    expect(plan.actions[0].params).toMatchObject({ clipId: 'c1', time: c.startTime + 8 })
    const rid = (plan.actions[0].params as { rightClipId: string }).rightClipId
    expect(plan.actions[1]).toEqual({ type: 'clip/rippleDelete', params: { clipId: rid } })
  })

  it('interior span: 2 splits + 1 rippleDelete on the middle', () => {
    const c = clip({ duration: 10 })
    const plan = silenceSpansToActions(c, [{ start: 3, end: 5 }])
    expect(plan.actions.length).toBe(3)
    expect(plan.actions[0].type).toBe('clip/split')
    expect(plan.actions[1].type).toBe('clip/split')
    expect(plan.actions[2].type).toBe('clip/rippleDelete')
  })

  it('merges adjacent spans before generating actions', () => {
    const c = clip({ duration: 10 })
    const plan = silenceSpansToActions(c, [
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ])
    // Should generate the same actions as a single [2, 4] span
    expect(plan.actions.filter((a) => a.type === 'clip/rippleDelete').length).toBe(1)
  })

  it('multiple interior spans → 3 actions per span (split/split/ripple) in reverse order', () => {
    const c = clip({ duration: 20 })
    const plan = silenceSpansToActions(c, [
      { start: 2, end: 4 },
      { start: 10, end: 12 },
    ])
    // 2 interior spans = 6 actions total
    expect(plan.actions.length).toBe(6)
    // First three actions belong to the *later* span (reverse-walk).
    const firstSplitTime = (plan.actions[0].params as { time: number }).time
    expect(firstSplitTime).toBeCloseTo(c.startTime + 10)
  })

  it('savedSeconds totals across all spans', () => {
    const plan = silenceSpansToActions(clip({ duration: 30 }), [
      { start: 5, end: 7 },
      { start: 15, end: 20 },
    ])
    expect(plan.savedSeconds).toBeCloseTo(7)
  })
})
