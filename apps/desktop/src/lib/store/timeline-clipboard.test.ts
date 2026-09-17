// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { collidesOnTrack, resolvePasteDelta, type Span, type PlaceableClip } from './timeline-clipboard'

describe('collidesOnTrack', () => {
  const spans: Span[] = [{ start: 5, end: 10 }]
  it('detects overlap', () => {
    expect(collidesOnTrack(4, 3, spans)).toBe(true) // 4..7 hits 5..10
    expect(collidesOnTrack(7, 2, spans)).toBe(true) // inside
  })
  it('allows flush-adjacent placement (half-open)', () => {
    expect(collidesOnTrack(0, 5, spans)).toBe(false) // 0..5 ends where span starts
    expect(collidesOnTrack(10, 5, spans)).toBe(false) // starts where span ends
  })
  it('no spans → never collides', () => {
    expect(collidesOnTrack(0, 100, [])).toBe(false)
  })
})

describe('resolvePasteDelta — single clip', () => {
  it('returns 0 when the target spot is free', () => {
    const clips: PlaceableClip[] = [{ trackId: 'v1', startTime: 20, duration: 5 }]
    const spans = new Map<string, Span[]>([['v1', [{ start: 0, end: 10 }]]])
    expect(resolvePasteDelta(clips, spans)).toBe(0)
  })
  it('shifts to the nearest free gap on collision (after, when after is closer)', () => {
    // proposed 8..13 collides with 5..15; after = 15-8 = 7, before = 0-8 = -8 (negative, but clip dur 5 → start 0 ok? before delta = span.start - dur - start = 5-5-8 = -8 → start 0). after closer in magnitude? |−8| vs |7| → 7 wins.
    const clips: PlaceableClip[] = [{ trackId: 'v1', startTime: 8, duration: 5 }]
    const spans = new Map<string, Span[]>([['v1', [{ start: 5, end: 15 }]]])
    const delta = resolvePasteDelta(clips, spans)
    expect(delta).toBe(7) // lands flush at 15
    expect(collidesOnTrack(8 + delta, 5, spans.get('v1')!)).toBe(false)
  })
  it('never lets a clip start before 0', () => {
    const clips: PlaceableClip[] = [{ trackId: 'v1', startTime: 2, duration: 5 }]
    const spans = new Map<string, Span[]>([['v1', [{ start: 0, end: 4 }]]])
    const delta = resolvePasteDelta(clips, spans)
    expect(2 + delta).toBeGreaterThanOrEqual(0)
    expect(collidesOnTrack(2 + delta, 5, spans.get('v1')!)).toBe(false)
  })
})

describe('resolvePasteDelta — multi-clip preserves relative offsets', () => {
  it('applies one shared delta so offsets are preserved', () => {
    // Two clips 10s apart, both colliding; a single delta must clear both.
    const clips: PlaceableClip[] = [
      { trackId: 'v1', startTime: 0, duration: 5 },
      { trackId: 'v1', startTime: 10, duration: 5 },
    ]
    const spans = new Map<string, Span[]>([['v1', [{ start: 0, end: 12 }]]])
    const delta = resolvePasteDelta(clips, spans)
    const a = 0 + delta
    const b = 10 + delta
    expect(b - a).toBe(10) // relative offset preserved
    expect(collidesOnTrack(a, 5, spans.get('v1')!)).toBe(false)
    expect(collidesOnTrack(b, 5, spans.get('v1')!)).toBe(false)
  })
  it('clears clips on different tracks with one shared delta', () => {
    const clips: PlaceableClip[] = [
      { trackId: 'v1', startTime: 0, duration: 5 },
      { trackId: 'a1', startTime: 0, duration: 5 },
    ]
    const spans = new Map<string, Span[]>([
      ['v1', [{ start: 0, end: 8 }]],
      ['a1', [{ start: 0, end: 3 }]],
    ])
    const delta = resolvePasteDelta(clips, spans)
    expect(collidesOnTrack(0 + delta, 5, spans.get('v1')!)).toBe(false)
    expect(collidesOnTrack(0 + delta, 5, spans.get('a1')!)).toBe(false)
    expect(delta).toBe(8) // must clear the longer obstacle (v1 ends at 8)
  })
})

describe('resolvePasteDelta — edge cases', () => {
  it('empty clip list → 0', () => {
    expect(resolvePasteDelta([], new Map())).toBe(0)
  })
  it('no existing spans → 0 (paste in place)', () => {
    const clips: PlaceableClip[] = [{ trackId: 'v1', startTime: 30, duration: 5 }]
    expect(resolvePasteDelta(clips, new Map())).toBe(0)
  })
  it('densely packed track parks the group after the furthest end', () => {
    // proposed 0..5 over a wall of clips 0..20; before is negative, after = 20.
    const clips: PlaceableClip[] = [{ trackId: 'v1', startTime: 0, duration: 5 }]
    const spans = new Map<string, Span[]>([['v1', [{ start: 0, end: 20 }]]])
    const delta = resolvePasteDelta(clips, spans)
    expect(delta).toBe(20)
    expect(collidesOnTrack(0 + delta, 5, spans.get('v1')!)).toBe(false)
  })
})
