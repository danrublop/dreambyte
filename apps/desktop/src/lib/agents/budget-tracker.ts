// ── Budget lifecycle: estimate → reserve → reconcile ───────────────────────
//
// The existing permission gate + circuit breaker check accumulated spend
// post-hoc. That leaves a race: two expensive tool calls fired in parallel
// can each individually pass the "are we under the cap?" check and
// collectively blow the cap.
//
// This tracker adds an in-memory reservation step that sits between estimate
// and final logSpend:
//
//   1. `reserve(api, estimateUsd)`     — deducts from the projected budget
//                                         and returns a reservation token
//   2. `reconcile(token, actualUsd)`   — replaces the reservation with the
//                                         real cost once the call completes
//   3. `release(token)`                — cancels a reservation on failure
//
// Queries always sum `reserved + actual` so decisions see the worst case.
// Projects get their own tracker to avoid cross-contamination; the map is
// process-local (fine for single-instance deployments; would need a shared
// store like Redis for horizontally scaled deployments — flagged as such).

export interface BudgetReservation {
  id: string
  api: string
  estimateUsd: number
  createdAt: number
}

export interface ProjectBudgetSnapshot {
  /** Confirmed actual spend — from completed tool calls. */
  actualUsd: number
  /** In-flight reservations — tool calls not yet reconciled. */
  reservedUsd: number
  /** Sum of actual + reserved. Use this for budget checks. */
  committedUsd: number
  reservationCount: number
}

class ProjectBudget {
  private actual = 0
  private reservations = new Map<string, BudgetReservation>()
  private counter = 0

  reserve(api: string, estimateUsd: number): BudgetReservation {
    const id = `${Date.now().toString(36)}-${(++this.counter).toString(36)}`
    const r: BudgetReservation = { id, api, estimateUsd: Math.max(0, estimateUsd), createdAt: Date.now() }
    this.reservations.set(id, r)
    return r
  }

  reconcile(reservationId: string, actualUsd: number): BudgetReservation | null {
    const r = this.reservations.get(reservationId)
    if (!r) return null
    this.reservations.delete(reservationId)
    this.actual += Math.max(0, actualUsd)
    return r
  }

  release(reservationId: string): BudgetReservation | null {
    const r = this.reservations.get(reservationId)
    if (!r) return null
    this.reservations.delete(reservationId)
    return r
  }

  addActual(costUsd: number): void {
    this.actual += Math.max(0, costUsd)
  }

  snapshot(): ProjectBudgetSnapshot {
    let reserved = 0
    for (const r of this.reservations.values()) reserved += r.estimateUsd
    return {
      actualUsd: this.actual,
      reservedUsd: reserved,
      committedUsd: this.actual + reserved,
      reservationCount: this.reservations.size,
    }
  }

  /** Remove reservations older than `maxAgeMs` — guards against leaks when
   *  a tool handler forgets to reconcile/release. */
  sweepStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs
    let swept = 0
    for (const [id, r] of this.reservations.entries()) {
      if (r.createdAt < cutoff) {
        this.reservations.delete(id)
        swept += 1
      }
    }
    return swept
  }
}

const projects = new Map<string, ProjectBudget>()

function getOrCreate(projectId: string): ProjectBudget {
  let p = projects.get(projectId)
  if (!p) {
    p = new ProjectBudget()
    projects.set(projectId, p)
  }
  return p
}

export function reserveSpend(projectId: string, api: string, estimateUsd: number): BudgetReservation {
  return getOrCreate(projectId).reserve(api, estimateUsd)
}

export function reconcileSpend(projectId: string, reservationId: string, actualUsd: number): BudgetReservation | null {
  const p = projects.get(projectId)
  if (!p) return null
  return p.reconcile(reservationId, actualUsd)
}

export function releaseSpend(projectId: string, reservationId: string): BudgetReservation | null {
  const p = projects.get(projectId)
  if (!p) return null
  return p.release(reservationId)
}

export function recordActualSpend(projectId: string, costUsd: number): void {
  getOrCreate(projectId).addActual(costUsd)
}

export function getBudgetSnapshot(projectId: string): ProjectBudgetSnapshot {
  const p = projects.get(projectId)
  if (!p) {
    return { actualUsd: 0, reservedUsd: 0, committedUsd: 0, reservationCount: 0 }
  }
  return p.snapshot()
}

/** Sweep stale reservations across every project. Call periodically from a
 *  long-lived runtime (cron, interval) to prevent leaks. Returns the total
 *  count swept. Default TTL: 10 minutes — any tool call that hasn't
 *  reconciled in 10 minutes is almost certainly dead. */
export function sweepStaleReservations(maxAgeMs = 10 * 60 * 1000): number {
  let swept = 0
  for (const p of projects.values()) swept += p.sweepStale(maxAgeMs)
  return swept
}

/** Test utility — resets all project budgets. */
export function __resetBudgets(): void {
  projects.clear()
}
