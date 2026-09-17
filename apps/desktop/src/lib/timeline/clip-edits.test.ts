import { describe, it, expect } from 'vitest'
import type { Clip } from '@/lib/types'
import { trimToPlayhead, cloneForDuplicate, trimEndFor, MIN_CLIP_DURATION } from './clip-edits'

/** A full Clip with overridable fields so tests can vary trim/speed/nested data. */
const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: 'c1',
    trackId: 'v1',
    sourceType: 'video',
    sourceId: 'asset-a',
    label: 'A',
    startTime: 10,
    duration: 6,
    trimStart: 2,
    trimEnd: 8,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  }) as Clip

/** The geometric invariant every (duration, trimEnd) pair must satisfy. */
const outPoint = (trimStart: number, duration: number, speed: number) =>
  trimStart + duration * speed

describe('trimToPlayhead', () => {
  it('trims the head to the playhead: moves start, advances trimStart, shrinks duration', () => {
    // clip [10..16], trimStart 2, playhead at 13 → remove 3s of head
    const patch = trimToPlayhead(clip(), 'start', 13)
    expect(patch.startTime).toBe(13)
    expect(patch.duration).toBeCloseTo(3) // 6 - 3
    expect(patch.trimStart).toBeCloseTo(5) // 2 + 3*1
    // out-point is unchanged by a head trim: trimStart + duration*speed === orig trimEnd
    expect(outPoint(patch.trimStart!, patch.duration!, 1)).toBeCloseTo(8)
  })

  it('trims the tail to the playhead: shrinks duration, re-derives trimEnd from new duration', () => {
    // clip [10..16], playhead at 13 → remove 3s of tail, keep 3s
    const patch = trimToPlayhead(clip(), 'end', 13)
    expect(patch.startTime).toBeUndefined() // tail trim never moves the clip
    expect(patch.duration).toBeCloseTo(3)
    expect(patch.trimEnd).toBeCloseTo(trimEndFor(2, 3, 1)) // 2 + 3 = 5
  })

  it('keeps trimEnd === trimStart + duration*speed for a speed-ramped clip (no floor divergence)', () => {
    // speed 2: 6s timeline => 12s of source. Tail trim to remove 2 timeline-seconds.
    const c = clip({ speed: 2, trimStart: 4, trimEnd: 16, duration: 6 }) // 4..16 = 12s @2x
    const patch = trimToPlayhead(c, 'end', 14) // remove 2s tail → duration 4
    expect(patch.duration).toBeCloseTo(4)
    expect(patch.trimEnd).toBeCloseTo(outPoint(c.trimStart, patch.duration!, 2)) // 4 + 4*2 = 12
    // The bug this guards: a hand-rolled floor of `trimStart + MIN` on the end
    // edge would diverge from the duration floor when speed !== 1.
  })

  it('head trim advances trimStart speed-aware', () => {
    const c = clip({ speed: 2, trimStart: 4, trimEnd: 16, duration: 6 })
    const patch = trimToPlayhead(c, 'start', 12) // remove 2s head
    expect(patch.startTime).toBe(12)
    expect(patch.duration).toBeCloseTo(4)
    expect(patch.trimStart).toBeCloseTo(8) // 4 + 2*2
    // out-point preserved: 8 + 4*2 = 16 === original trimEnd
    expect(outPoint(patch.trimStart!, patch.duration!, 2)).toBeCloseTo(16)
  })

  it('honours the MIN_CLIP_DURATION floor at an extreme head trim', () => {
    // playhead almost at the clip end → duration would go below the floor
    const patch = trimToPlayhead(clip(), 'start', 15.99)
    expect(patch.duration).toBe(MIN_CLIP_DURATION)
  })

  it('keeps the invariant when an extreme head trim hits the floor (no source over-run)', () => {
    // Regression: a head trim within MIN of the tail must NOT advance trimStart
    // past what the floored duration can back. startTime+consumed, not raw playhead.
    const c = clip() // [10..16], trimStart 2, trimEnd 8, speed 1
    const patch = trimToPlayhead(c, 'start', 15.99) // duration floors to 0.1
    expect(patch.duration).toBe(MIN_CLIP_DURATION)
    // trimStart must satisfy trimStart + duration*speed === original out-point (8)
    expect(outPoint(patch.trimStart!, patch.duration!, 1)).toBeCloseTo(8)
    // startTime backs off from the raw playhead so the floored clip still fits its source
    expect(patch.startTime).toBeCloseTo(15.9) // 10 + (6 - 0.1)
  })

  it('keeps the floor invariant for a speed-ramped extreme head trim', () => {
    const c = clip({ speed: 2, trimStart: 4, trimEnd: 16, duration: 6 }) // 4..16 @2x
    const patch = trimToPlayhead(c, 'start', 15.99) // floors duration to 0.1
    expect(patch.duration).toBe(MIN_CLIP_DURATION)
    expect(outPoint(patch.trimStart!, patch.duration!, 2)).toBeCloseTo(16) // out-point preserved
  })

  it('end-trim turns a null trimEnd into a concrete out-point', () => {
    const c = clip({ trimEnd: null })
    const patch = trimToPlayhead(c, 'end', 13)
    expect(patch.trimEnd).not.toBeNull()
    expect(Number.isFinite(patch.trimEnd as number)).toBe(true)
    expect(patch.trimEnd).toBeCloseTo(trimEndFor(c.trimStart, patch.duration!, 1))
  })

  it('keeps the floor invariant for a speed-ramped extreme tail trim', () => {
    const c = clip({ speed: 2, trimStart: 4, trimEnd: 16, duration: 6 })
    const patch = trimToPlayhead(c, 'end', 10.01) // floors duration to 0.1
    expect(patch.duration).toBe(MIN_CLIP_DURATION)
    expect(patch.trimEnd).toBeCloseTo(outPoint(c.trimStart, MIN_CLIP_DURATION, 2)) // 4 + 0.1*2
  })

  it('clamps trimStart at 0 (never negative source in-point)', () => {
    const c = clip({ trimStart: 0, startTime: 10 })
    const patch = trimToPlayhead(c, 'start', 10.0001)
    expect(patch.trimStart).toBeGreaterThanOrEqual(0)
  })
})

describe('cloneForDuplicate', () => {
  it('strips identity + grouping fields', () => {
    const c = clip({ linkGroupId: 'lg1', groupId: 'g1' })
    const copy = cloneForDuplicate(c)
    expect('id' in copy).toBe(false)
    expect('trackId' in copy).toBe(false)
    expect(copy.linkGroupId).toBeUndefined()
    expect(copy.groupId).toBeUndefined()
  })

  it('preserves the non-identity payload (label/source/trim/speed)', () => {
    const copy = cloneForDuplicate(clip({ label: 'B', speed: 1.5 }))
    expect(copy.label).toBe('B')
    expect(copy.sourceId).toBe('asset-a')
    expect(copy.speed).toBe(1.5)
    expect(copy.trimStart).toBe(2)
  })

  it('deep-clones keyframes — editing the copy does not bleed into the original', () => {
    const c = clip({ keyframes: [{ time: 0, property: 'opacity', value: 1 } as any] })
    const copy = cloneForDuplicate(c)
    expect(copy.keyframes).not.toBe(c.keyframes) // different array ref
    expect(copy.keyframes[0]).not.toBe(c.keyframes[0]) // different object ref
    ;(copy.keyframes[0] as any).value = 0
    expect((c.keyframes[0] as any).value).toBe(1) // original untouched
  })

  it('deep-clones transition — editing the copy does not bleed into the original', () => {
    const c = clip({ transition: { type: 'crossfade', duration: 1 } })
    const copy = cloneForDuplicate(c)
    expect(copy.transition).not.toBe(c.transition) // different object ref
    copy.transition!.duration = 5
    expect(c.transition!.duration).toBe(1) // original untouched
  })

  it('preserves a null transition without wrapping it', () => {
    const copy = cloneForDuplicate(clip({ transition: null }))
    expect(copy.transition).toBeNull()
  })

  it('deep-clones filters/position/scale', () => {
    const c = clip({ filters: [{ filter: 'blur(2px)' } as any] })
    const copy = cloneForDuplicate(c)
    expect(copy.filters).not.toBe(c.filters)
    expect(copy.filters[0]).not.toBe(c.filters[0])
    expect(copy.position).not.toBe(c.position)
    expect(copy.scale).not.toBe(c.scale)
    copy.position.x = 999
    expect(c.position.x).toBe(0)
  })
})
