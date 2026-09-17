// @vitest-environment node

import { describe, it, expect } from 'vitest'

import {
  buildKeyframeMarkers,
  colorForKeyframeProperty,
  deltaXToTimeDelta,
  snapKeyframeTime,
  snapToFrame,
} from './keyframe-position'
import type { Clip, Keyframe } from '@/lib/types'

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

const kf = (
  time: number,
  property: Keyframe['property'],
  value: number,
  easing: Keyframe['easing'] = 'linear',
): Keyframe => ({
  time,
  property,
  value,
  easing,
})

describe('buildKeyframeMarkers', () => {
  it('returns one marker per keyframe at time × pps', () => {
    const c = clip({
      keyframes: [kf(0, 'opacity', 0), kf(2.5, 'x', 100), kf(5, 'opacity', 1)],
    })
    const m = buildKeyframeMarkers(c, 40) // 40 px/s
    expect(m.map((x) => x.leftPx)).toEqual([0, 100, 200])
  })

  it('filters out keyframes whose time is outside [0, duration]', () => {
    const c = clip({
      duration: 5,
      keyframes: [kf(-1, 'opacity', 0), kf(0, 'opacity', 1), kf(5, 'opacity', 0), kf(6, 'opacity', 0)],
    })
    const m = buildKeyframeMarkers(c, 10)
    expect(m.length).toBe(2)
    expect(m.map((x) => x.time)).toEqual([0, 5])
  })

  it('produces stable React keys', () => {
    const c = clip({
      keyframes: [kf(1, 'opacity', 0.5), kf(1, 'x', 100)],
    })
    const m = buildKeyframeMarkers(c, 10)
    expect(new Set(m.map((x) => x.key)).size).toBe(2)
  })
})

describe('colorForKeyframeProperty', () => {
  it('returns the palette colour for known properties', () => {
    expect(colorForKeyframeProperty('opacity')).toBe('#60a5fa')
    expect(colorForKeyframeProperty('speed')).toBe('#f472b6')
  })

  it('falls back to neutral for unknown properties', () => {
    expect(colorForKeyframeProperty('unknown')).toBe('#94a3b8')
  })
})

describe('deltaXToTimeDelta', () => {
  it('inverts pixelsPerSecond cleanly', () => {
    expect(deltaXToTimeDelta(20, 10)).toBe(2)
    expect(deltaXToTimeDelta(-20, 10)).toBe(-2)
  })

  it('returns 0 for non-positive pps (no divide-by-zero, no NaN)', () => {
    expect(deltaXToTimeDelta(20, 0)).toBe(0)
    expect(deltaXToTimeDelta(20, -1)).toBe(0)
  })
})

describe('snapKeyframeTime', () => {
  it('clamps to [0, duration] and rounds to 1ms', () => {
    expect(snapKeyframeTime(-1, 10)).toBe(0)
    expect(snapKeyframeTime(11, 10)).toBe(10)
    expect(snapKeyframeTime(1.23456, 10)).toBeCloseTo(1.235, 5)
  })
})

describe('snapToFrame', () => {
  it('rounds to the nearest frame at 30 fps', () => {
    expect(snapToFrame(0.516, 30)).toBeCloseTo(0.5, 4) // 15/30
    expect(snapToFrame(0.524, 30)).toBeCloseTo(0.5333, 4) // 16/30
    expect(snapToFrame(1.0, 30)).toBe(1) // already on frame
  })

  it('handles 60 fps', () => {
    expect(snapToFrame(0.508, 60)).toBeCloseTo(0.5, 4) // 30/60
    expect(snapToFrame(0.5083, 60)).toBeCloseTo(0.5, 4)
  })

  it('returns the input unchanged for non-finite values or zero fps', () => {
    expect(snapToFrame(Number.NaN, 30)).toBeNaN()
    expect(snapToFrame(1.5, 0)).toBe(1.5)
    expect(snapToFrame(1.5, -10)).toBe(1.5)
  })

  it('handles negative times', () => {
    expect(snapToFrame(-0.516, 30)).toBeCloseTo(-0.5, 4)
  })
})
