// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { __testing } from './spawn-variants'

const { reserveVariantBudget } = __testing

describe('reserveVariantBudget — group budget reservation', () => {
  it('splits a finite group budget evenly across N variants', () => {
    expect(reserveVariantBudget(30, 3)).toBe(10)
    expect(reserveVariantBudget(25, 5)).toBe(5)
  })

  it('sum of per-run reservations never exceeds the group cap', () => {
    const group = 17
    const n = 4
    const perRun = reserveVariantBudget(group, n)!
    expect(perRun * n).toBeLessThanOrEqual(group)
  })

  it('returns undefined (no override) when there is no finite group cap', () => {
    expect(reserveVariantBudget(undefined, 3)).toBeUndefined() // request keeps its own budget
    expect(reserveVariantBudget(null, 3)).toBeUndefined() // explicitly unlimited
    expect(reserveVariantBudget(0, 3)).toBeUndefined() // mis-set 0 → unlimited, not a 0 trap
    expect(reserveVariantBudget(-5, 3)).toBeUndefined()
  })

  it('returns undefined for a non-positive variant count', () => {
    expect(reserveVariantBudget(30, 0)).toBeUndefined()
  })
})
