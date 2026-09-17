import { describe, it, expect } from 'vitest'
import { clampSceneDuration, plannedDurationFor, PLAN_OVERRUN_FACTOR } from './scene-duration'

describe('clampSceneDuration', () => {
  it('applies the absolute [3,30] floor/ceiling when no plan is known', () => {
    expect(clampSceneDuration(1)).toBe(3)
    expect(clampSceneDuration(45)).toBe(30)
    expect(clampSceneDuration(12)).toBe(12)
  })

  it('caps the upper bound at planned*1.3 to stop dead-air ballooning', () => {
    // planned 10s → cap at 13s. A drift to the 30s ceiling is reined in.
    expect(clampSceneDuration(30, 10)).toBe(13)
    expect(clampSceneDuration(12, 10)).toBe(12) // within tolerance, untouched
    expect(PLAN_OVERRUN_FACTOR).toBe(1.3)
  })

  it('never goes below the absolute floor even with a tiny plan', () => {
    expect(clampSceneDuration(1, 2)).toBe(3)
  })

  it('a zero/negative planned duration falls back to the plain [3,30] clamp', () => {
    expect(clampSceneDuration(30, 0)).toBe(30)
    expect(clampSceneDuration(30, -5)).toBe(30)
  })
})

describe('plannedDurationFor', () => {
  const world = { scenePlan: { scenes: [{ id: 'a', duration: 10 }, { id: 'b', duration: 0 }] } }

  it('returns the planned duration for a scene id in the active plan', () => {
    expect(plannedDurationFor(world, 'a')).toBe(10)
  })

  it('returns undefined for an unknown scene, a non-positive duration, or no plan', () => {
    expect(plannedDurationFor(world, 'missing')).toBeUndefined()
    expect(plannedDurationFor(world, 'b')).toBeUndefined() // duration 0 → not a real cap
    expect(plannedDurationFor({}, 'a')).toBeUndefined()
  })
})
