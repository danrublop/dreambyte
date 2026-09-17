/**
 * Parity guard for the easing fix (security/correctness review F7).
 *
 * The pure sampler eases via `applyEasing(t, name)`; the emit-as-string
 * adapters inline `easedExpr(name, 't')`. These two MUST agree, or previewed
 * scenes (sampler) diverge from exported scenes (emitted JS) — exactly the
 * bug F7 described, where every adapter hardcoded a single ease-out.
 */
import { describe, it, expect } from 'vitest'

import { applyEasing, easedExpr } from './_sample'
import type { EasingName } from '../types'

const EASINGS: EasingName[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'power1.in',
  'power1.out',
  'power1.inOut',
  'power2.in',
  'power2.out',
  'power2.inOut',
  'power3.in',
  'power3.out',
  'power3.inOut',
  'expo.in',
  'expo.out',
  'expo.inOut',
  'back.in',
  'back.out',
  'back.inOut',
  'elastic.in',
  'elastic.out',
  'elastic.inOut',
  'bounce.in',
  'bounce.out',
  'bounce.inOut',
]

const SAMPLE_TS = [0, 0.1, 0.25, 0.49, 0.5, 0.51, 0.75, 0.9, 1]

// eslint-disable-next-line @typescript-eslint/no-implied-eval
function evalExpr(name: EasingName, t: number): number {
  const fn = new Function('t', `return (${easedExpr(name, 't')})`)
  return fn(t) as number
}

describe('easedExpr <-> applyEasing parity (F7)', () => {
  for (const name of EASINGS) {
    it(`${name} matches applyEasing across the unit interval`, () => {
      for (const t of SAMPLE_TS) {
        expect(evalExpr(name, t)).toBeCloseTo(applyEasing(t, name), 10)
      }
    })
  }

  it('produces non-ease-out output for a linear preset (regression: was hardcoded ease-out)', () => {
    // At t=0.5 ease-out yields 0.75; linear must yield 0.5.
    expect(evalExpr('linear', 0.5)).toBeCloseTo(0.5, 10)
    expect(evalExpr('ease-out', 0.5)).toBeCloseTo(0.75, 10)
  })
})
