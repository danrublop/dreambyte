import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetBudgets,
  getBudgetSnapshot,
  reconcileSpend,
  recordActualSpend,
  releaseSpend,
  reserveSpend,
  sweepStaleReservations,
} from './budget-tracker'

beforeEach(() => {
  __resetBudgets()
})

describe('reserveSpend / reconcileSpend', () => {
  it('reports reserved cost while a call is in-flight', () => {
    reserveSpend('p1', 'veo3', 1.25)
    const snap = getBudgetSnapshot('p1')
    expect(snap.reservedUsd).toBe(1.25)
    expect(snap.actualUsd).toBe(0)
    expect(snap.committedUsd).toBe(1.25)
  })

  it('moves reservation into actual on reconcile', () => {
    const r = reserveSpend('p1', 'veo3', 1.25)
    reconcileSpend('p1', r.id, 1.12)
    const snap = getBudgetSnapshot('p1')
    expect(snap.reservedUsd).toBe(0)
    expect(snap.actualUsd).toBe(1.12)
    expect(snap.reservationCount).toBe(0)
  })

  it('release drops the reservation without touching actual', () => {
    const r = reserveSpend('p1', 'veo3', 1.25)
    releaseSpend('p1', r.id)
    const snap = getBudgetSnapshot('p1')
    expect(snap.reservedUsd).toBe(0)
    expect(snap.actualUsd).toBe(0)
  })

  it('reconcile on unknown reservation is a no-op', () => {
    const result = reconcileSpend('p1', 'nonexistent', 5)
    expect(result).toBe(null)
  })

  it('concurrent reservations stack, committing the worst case', () => {
    const r1 = reserveSpend('p1', 'veo3', 1.0)
    const r2 = reserveSpend('p1', 'kling', 0.45)
    expect(getBudgetSnapshot('p1').committedUsd).toBeCloseTo(1.45)

    reconcileSpend('p1', r1.id, 0.9)
    expect(getBudgetSnapshot('p1').committedUsd).toBeCloseTo(1.35)

    reconcileSpend('p1', r2.id, 0.5)
    expect(getBudgetSnapshot('p1').committedUsd).toBeCloseTo(1.4)
    expect(getBudgetSnapshot('p1').reservedUsd).toBe(0)
  })

  it('isolates projects from each other', () => {
    reserveSpend('p1', 'veo3', 1.0)
    reserveSpend('p2', 'veo3', 0.5)
    expect(getBudgetSnapshot('p1').committedUsd).toBe(1.0)
    expect(getBudgetSnapshot('p2').committedUsd).toBe(0.5)
  })

  it('recordActualSpend adds actual cost without a reservation', () => {
    recordActualSpend('p1', 0.12)
    expect(getBudgetSnapshot('p1').actualUsd).toBe(0.12)
  })

  it('sweepStaleReservations removes reservations older than the TTL', async () => {
    reserveSpend('p1', 'veo3', 1.0)
    // maxAge -1 → cutoff is now+1, so any reservation older than "the future" sweeps.
    const swept = sweepStaleReservations(-1)
    expect(swept).toBe(1)
    expect(getBudgetSnapshot('p1').reservedUsd).toBe(0)
  })

  it('negative values clamp to 0', () => {
    const r = reserveSpend('p1', 'veo3', -5)
    reconcileSpend('p1', r.id, -10)
    expect(getBudgetSnapshot('p1').actualUsd).toBe(0)
  })
})
