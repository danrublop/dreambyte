import { describe, it, expect } from 'vitest'
import { clipLocalTime, fadeRemaining } from './preview-time'

describe('clipLocalTime — source → clip-local timeline time', () => {
  it('is identity for an untrimmed, speed-1 clip (the common case)', () => {
    expect(clipLocalTime(3, 0, 1)).toBe(3)
    expect(clipLocalTime(0, 0, 1)).toBe(0)
  })

  it('treats a missing clip (gap / no V1 clip) as identity', () => {
    // trimStart/speed undefined ⇒ start 0, speed 1.
    expect(clipLocalTime(4.2, undefined, undefined)).toBe(4.2)
    expect(clipLocalTime(4.2, null, null)).toBe(4.2)
  })

  it('subtracts trimStart for a left-trimmed / split-right-half clip', () => {
    // source clock starts at trimStart=2; at the clip's left edge the timeline time is 0.
    expect(clipLocalTime(2, 2, 1)).toBe(0)
    expect(clipLocalTime(5, 2, 1)).toBe(3)
  })

  it('divides by speed so a sped clip advances one timeline-second per second', () => {
    // speed 2: source advances 2× as fast as the timeline.
    expect(clipLocalTime(4, 0, 2)).toBe(2)
    // trimmed AND sped: (6 - 2) / 2 = 2
    expect(clipLocalTime(6, 2, 2)).toBe(2)
  })

  it('matches the seek map inverse: sourceT = trimStart + localT*speed', () => {
    const trimStart = 1.5
    const speed = 1.25
    for (const localT of [0, 1, 2.4, 7]) {
      const sourceT = trimStart + localT * speed
      expect(clipLocalTime(sourceT, trimStart, speed)).toBeCloseTo(localT, 10)
    }
  })

  it('clamps a corrupt speed (0 / negative / NaN) to 1, never Infinity or a backwards clock', () => {
    expect(clipLocalTime(3, 0, 0)).toBe(3)
    expect(clipLocalTime(3, 0, -2)).toBe(3)
    expect(clipLocalTime(3, 0, NaN)).toBe(3)
    expect(Number.isFinite(clipLocalTime(3, 0, 0))).toBe(true)
  })
})

describe('fadeRemaining — clip-local time left before the out-point (v5 B2)', () => {
  // Table: [name, sourceTime, clip, expected remaining (timeline seconds)]
  const cases: Array<[string, number, { duration: number; trimStart?: number | null; speed?: number | null }, number]> =
    [
      // trim only: source clock starts at trimStart=2, so source 5 is 3s into an
      // 8s (timeline) clip → 5s remain. Old math: 8 - 5*1 = 3 — it leaked the 2s
      // trim into the elapsed time and started the fade 2s early.
      ['trim only', 5, { duration: 8, trimStart: 2, speed: 1 }, 5],
      // speed only: speed 2 halves the timeline length; source 4 is 2 timeline-s
      // in. Old math: 5 - 4*2 = -3 (window already "over" — fade never ran).
      ['speed only', 4, { duration: 5, trimStart: 0, speed: 2 }, 3],
      // both: (6 - 2) / 2 = 2 timeline-s elapsed of a 4s clip → 2s remain.
      ['trim + speed', 6, { duration: 4, trimStart: 2, speed: 2 }, 2],
      // at the out-point the remaining hits exactly 0.
      ['at out-point', 10, { duration: 4, trimStart: 2, speed: 2 }, 0],
      // missing trim/speed (gap-shaped clip) behaves as trim 0 / speed 1.
      ['null trim/speed', 3, { duration: 8, trimStart: null, speed: null }, 5],
    ]

  it.each(cases)('%s', (_name, sourceTime, clip, expected) => {
    expect(fadeRemaining(sourceTime, clip)).toBeCloseTo(expected, 10)
  })

  it('[REGRESSION] speed=1 / trim=0 reproduces exactly the old `duration - t` values', () => {
    for (const t of [0, 0.5, 1, 2.25, 7.9, 8]) {
      expect(fadeRemaining(t, { duration: 8, trimStart: 0, speed: 1 })).toBe(8 - t)
    }
  })
})
