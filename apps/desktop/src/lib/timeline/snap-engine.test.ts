// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { Clip, Timeline } from '@/lib/types'
import { clampToAvoidOverlap, collectSnapTargets, findSnap } from './snap-engine'

function mkClip(overrides: Partial<Clip>): Clip {
  return {
    id: overrides.id ?? 'c',
    trackId: overrides.trackId ?? 't',
    sourceType: overrides.sourceType ?? 'video',
    sourceId: overrides.sourceId ?? 'src',
    label: '',
    startTime: overrides.startTime ?? 0,
    duration: overrides.duration ?? 5,
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
  } as Clip
}

function mkTl(...clips: Clip[]): Timeline {
  return {
    tracks: [{ id: 't1', name: 't1', type: 'video', clips, muted: false, locked: false, position: 0 }],
  }
}

describe('collectSnapTargets', () => {
  it('includes sequence in/out as snap targets', () => {
    const tl: Timeline = {
      tracks: [{ id: 't1', name: 't1', type: 'video', clips: [], muted: false, locked: false, position: 0 }],
      inPoint: 2,
      outPoint: 8,
    }
    const targets = collectSnapTargets(tl)
    const types = targets.map((t) => t.type)
    expect(types).toContain('in-point')
    expect(types).toContain('out-point')
    expect(targets.find((t) => t.type === 'in-point')?.time).toBe(2)
    expect(targets.find((t) => t.type === 'out-point')?.time).toBe(8)
  })

  it('adds playhead, clip edges, and markers', () => {
    const tl: Timeline = {
      tracks: [
        {
          id: 't1',
          name: 't1',
          type: 'video',
          clips: [mkClip({ id: 'a', startTime: 5, duration: 3 })],
          muted: false,
          locked: false,
          position: 0,
        },
      ],
      markers: [{ id: 'm1', time: 12 }],
    }
    const targets = collectSnapTargets(tl, 2)
    const byType = new Map<string, number[]>()
    for (const t of targets) {
      const arr = byType.get(t.type) ?? []
      arr.push(t.time)
      byType.set(t.type, arr)
    }
    expect(byType.get('playhead')).toEqual([2])
    expect(byType.get('clip-start')).toEqual([5])
    expect(byType.get('clip-end')).toEqual([8])
    expect(byType.get('marker')).toEqual([12])
  })

  it('excludes the named clip from edge targets', () => {
    const tl = mkTl(mkClip({ id: 'a', startTime: 0, duration: 5 }), mkClip({ id: 'b', startTime: 10, duration: 5 }))
    const targets = collectSnapTargets(tl, undefined, 'a')
    const clipTargets = targets.filter((t) => t.type === 'clip-start' || t.type === 'clip-end')
    expect(clipTargets.map((t) => t.time).sort((x, y) => x - y)).toEqual([10, 15])
  })

  it('emits frame targets in the visible range when frameSnap is on', () => {
    const tl = mkTl(mkClip({ id: 'a', startTime: 0, duration: 10 }))
    const targets = collectSnapTargets(tl, undefined, undefined, {
      fps: 30,
      frameSnap: true,
      viewStart: 0,
      viewEnd: 1,
    })
    const frames = targets.filter((t) => t.type === 'frame')
    // 0/30 through 30/30 inclusive = 31 frames
    expect(frames.length).toBe(31)
  })

  it('does NOT emit frame targets when frameSnap is off', () => {
    const tl = mkTl(mkClip({ id: 'a' }))
    const targets = collectSnapTargets(tl, undefined, undefined, {
      fps: 30,
      frameSnap: false,
      viewStart: 0,
      viewEnd: 1,
    })
    expect(targets.find((t) => t.type === 'frame')).toBeUndefined()
  })
})

describe('findSnap', () => {
  it('snaps to within threshold (pixels)', () => {
    const targets = [{ time: 1.0, type: 'clip-start' as const, sourceId: 'a' }]
    // pps = 100 → 1s = 100px. Cursor at 1.02s is 2px away from the target. Threshold 6px → snaps.
    const r = findSnap(1.02, 100, 6, targets)
    expect(r.target?.sourceId).toBe('a')
    expect(r.time).toBe(1.0)
  })

  it('does NOT snap beyond the threshold', () => {
    const targets = [{ time: 1.0, type: 'clip-start' as const, sourceId: 'a' }]
    // 1.1 - 1.0 = 0.1s = 10px at pps=100. Threshold = 6px → no snap.
    const r = findSnap(1.1, 100, 6, targets)
    expect(r.target).toBeNull()
    expect(r.time).toBe(1.1)
  })

  it('returns no snap when targets are empty (snap toggle off case)', () => {
    const r = findSnap(0.5, 100, 6, [])
    expect(r.target).toBeNull()
    expect(r.time).toBe(0.5)
  })

  it('prefers higher-priority target on ties (playhead > clip-edge > frame)', () => {
    const targets = [
      { time: 1.0, type: 'frame' as const },
      { time: 1.0, type: 'clip-start' as const, sourceId: 'a' },
      { time: 1.0, type: 'playhead' as const },
    ]
    const r = findSnap(1.0, 100, 6, targets)
    expect(r.target?.type).toBe('playhead')
  })
})

describe('clampToAvoidOverlap', () => {
  const bounds = (...ranges: Array<[number, number]>) => ranges.map(([start, end], i) => ({ start, end, id: `c${i}` }))

  it('keeps a position that already fits', () => {
    expect(clampToAvoidOverlap(6, 2, bounds([0, 5]))).toBe(6)
  })

  it('clamps negative requests to 0 when free', () => {
    expect(clampToAvoidOverlap(-2, 2, bounds([5, 8]))).toBe(0)
  })

  it('does not resolve into the clip it is avoiding (snap-before clamped to 0 regression)', () => {
    // Request t=1 against a clip at 0–5: snap-before is -3, which the old
    // version clamped to 0 — right back inside the clip. Must go after.
    expect(clampToAvoidOverlap(1, 3, bounds([0, 5]))).toBe(5)
  })

  it('does not resolve into a NEIGHBORING clip', () => {
    // Gap before [4,8] is [0,4): width 4 fits duration 3 → 4-3=1 is valid.
    // But with [0,2] also occupied, snap-before lands inside it → must pick
    // a position valid against ALL bounds.
    const b = bounds([0, 2], [4, 8])
    const r = clampToAvoidOverlap(5, 3, b)
    expect(r >= 0).toBe(true)
    expect(b.some((x) => r + 3 > x.start && r < x.end)).toBe(false)
  })

  it('appends past the last clip when no gap fits', () => {
    expect(clampToAvoidOverlap(1, 3, bounds([0, 5], [5, 11]))).toBe(11)
  })

  it('chooses the nearest valid gap edge', () => {
    // Clips at [0,5] and [10,15]; request t=4 with duration 2.
    // Candidates: after first (5, fits in the 5-unit gap), before second (8).
    // 5 is closer to 4.
    expect(clampToAvoidOverlap(4, 2, bounds([0, 5], [10, 15]))).toBe(5)
  })
})
