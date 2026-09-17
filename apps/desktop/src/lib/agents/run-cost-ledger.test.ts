// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  makeRunCostLedger,
  commitCost,
  refundCost,
  isOverCap,
  shouldWarn80,
  commitMediaGen,
  isOverMediaGenCap,
  DEFAULT_MEDIA_GEN_CAP,
} from './run-cost-ledger'

describe('RunCostLedger', () => {
  it('accumulates committed cost', () => {
    const l = makeRunCostLedger(10)
    expect(commitCost(l, 3)).toBe(3)
    expect(commitCost(l, 2.5)).toBe(5.5)
    expect(l.spentUsd).toBe(5.5)
  })

  it('ignores zero/negative deltas (cost is monotonic)', () => {
    const l = makeRunCostLedger(10)
    commitCost(l, 4)
    commitCost(l, -1)
    commitCost(l, 0)
    expect(l.spentUsd).toBe(4)
  })

  it('isOverCap flips strictly above the cap', () => {
    const l = makeRunCostLedger(5)
    commitCost(l, 5)
    expect(isOverCap(l)).toBe(false) // exactly at cap is not over
    commitCost(l, 0.01)
    expect(isOverCap(l)).toBe(true)
  })

  it('Infinity cap is never over', () => {
    const l = makeRunCostLedger(Infinity)
    commitCost(l, 9999)
    expect(isOverCap(l)).toBe(false)
  })

  it('shouldWarn80 fires once when crossing 80% of a finite cap', () => {
    const l = makeRunCostLedger(10)
    commitCost(l, 7.9)
    expect(shouldWarn80(l)).toBe(false)
    commitCost(l, 0.2) // 8.1, crosses 80%
    expect(shouldWarn80(l)).toBe(true)
    expect(shouldWarn80(l)).toBe(false) // one-shot
  })

  it('shouldWarn80 never fires for an Infinity cap', () => {
    const l = makeRunCostLedger(Infinity)
    commitCost(l, 1e9)
    expect(shouldWarn80(l)).toBe(false)
  })
})

describe('makeRunCostLedger seedSpentUsd (P1: resume must not reset the cap to $0)', () => {
  it('a fresh (non-resume) run starts at 0', () => {
    const l = makeRunCostLedger(5)
    expect(l.spentUsd).toBe(0)
  })

  it('a resumed run starts at the prior spend, not 0', () => {
    // Run was stopped at the $5 cap having spent $4.80; on resume the ledger
    // must continue from $4.80 so it cannot get a fresh $5 budget.
    const l = makeRunCostLedger(5, 4.8)
    expect(l.spentUsd).toBe(4.8)
    // It is already 96% of the cap — one more small charge trips it.
    commitCost(l, 0.3)
    expect(isOverCap(l)).toBe(true)
  })

  it('seeded spend at/above cap is immediately over-cap on the next charge', () => {
    const l = makeRunCostLedger(5, 5)
    expect(l.spentUsd).toBe(5)
    expect(isOverCap(l)).toBe(false) // exactly at cap is not over
    commitCost(l, 0.01)
    expect(isOverCap(l)).toBe(true)
  })

  it('guards a missing/NaN/negative seed back to 0 (malformed checkpoint cannot go negative)', () => {
    expect(makeRunCostLedger(5).spentUsd).toBe(0)
    expect(makeRunCostLedger(5, NaN).spentUsd).toBe(0)
    expect(makeRunCostLedger(5, -3).spentUsd).toBe(0)
    expect(makeRunCostLedger(5, Infinity).spentUsd).toBe(0)
  })

  it('records seedUsd so chain-spend (spentUsd - seedUsd) excludes the resume seed', () => {
    // The cost chip DISPLAYS this run chain's own spend, not the pre-pause total
    // a resumed run already showed. `spentUsd - seedUsd` is that figure.
    const fresh = makeRunCostLedger(5)
    expect(fresh.seedUsd).toBe(0)
    commitCost(fresh, 1.25)
    expect(fresh.spentUsd - fresh.seedUsd).toBeCloseTo(1.25) // whole spend on a fresh run

    const resumed = makeRunCostLedger(5, 4.8)
    expect(resumed.seedUsd).toBe(4.8)
    commitCost(resumed, 0.15)
    // chain-spend counts only THIS leg (0.15), never re-counting the $4.80 the
    // pre-pause message already displayed — so summing per-message costs is exact.
    expect(resumed.spentUsd - resumed.seedUsd).toBeCloseTo(0.15)
  })

  it('seedUsd matches the guarded seed (malformed → 0)', () => {
    expect(makeRunCostLedger(5, NaN).seedUsd).toBe(0)
    expect(makeRunCostLedger(5, -3).seedUsd).toBe(0)
    expect(makeRunCostLedger(5, 4.8).seedUsd).toBe(4.8)
  })
})

describe('refundCost (R4 follow-up)', () => {
  it('un-does a paired reservation', () => {
    const l = makeRunCostLedger(1)
    commitCost(l, 0.3)
    expect(refundCost(l, 0.3)).toBe(0)
  })

  it('clamps at zero — an unpaired refund cannot under-count real spend', () => {
    const l = makeRunCostLedger(1)
    commitCost(l, 0.1)
    expect(refundCost(l, 5)).toBe(0)
  })

  it('ignores zero/negative deltas', () => {
    const l = makeRunCostLedger(1)
    commitCost(l, 0.2)
    refundCost(l, 0)
    refundCost(l, -1)
    expect(l.spentUsd).toBeCloseTo(0.2, 10)
  })
})

describe('media-gen backstop (⑥ / D4 defense-in-depth)', () => {
  it('starts at zero with the default backstop, shared by reference across sub-agents', () => {
    const l = makeRunCostLedger(10)
    expect(l.mediaGenCount).toBe(0)
    expect(l.mediaGenCap).toBe(DEFAULT_MEDIA_GEN_CAP)
  })

  it('commitMediaGen accumulates and only trips the cap when EXCEEDED', () => {
    const l = makeRunCostLedger(10, 0, 3)
    commitMediaGen(l, 3)
    expect(l.mediaGenCount).toBe(3)
    expect(isOverMediaGenCap(l)).toBe(false) // at the cap is allowed
    commitMediaGen(l) // +1 → 4 > 3
    expect(l.mediaGenCount).toBe(4)
    expect(isOverMediaGenCap(l)).toBe(true)
  })

  it('ignores zero/negative counts (monotonic, like commitCost)', () => {
    const l = makeRunCostLedger(10, 0, 5)
    commitMediaGen(l, 2)
    commitMediaGen(l, 0)
    commitMediaGen(l, -3)
    expect(l.mediaGenCount).toBe(2)
  })

  it('an Infinity backstop never trips (Unlimited media)', () => {
    const l = makeRunCostLedger(10, 0, Infinity)
    commitMediaGen(l, 10_000)
    expect(isOverMediaGenCap(l)).toBe(false)
  })

  it('catches the $0/free-provider loop the dollar cap misses (count rises while spend stays $0)', () => {
    const l = makeRunCostLedger(100, 0, 4) // huge dollar cap, small media backstop
    for (let i = 0; i < 5; i++) commitMediaGen(l) // 5 free gens, $0 billed
    expect(l.spentUsd).toBe(0)
    expect(isOverCap(l)).toBe(false) // dollar cap never fires — nothing billed
    expect(isOverMediaGenCap(l)).toBe(true) // the count backstop does
  })
})
