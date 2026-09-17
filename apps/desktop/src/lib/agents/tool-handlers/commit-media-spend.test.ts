// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// P1: commitMediaSpend is the shared ledger-commit the image + FAL-avatar + media-library agent
// paid paths use so the per-project session/monthly caps actually accumulate (caps read ONLY the
// apiSpend ledger, fed solely by logSpend).

const logSpend = vi.fn(async () => {})
vi.mock('@/lib/db', () => ({ logSpend: (...a: unknown[]) => logSpend(...(a as [])) }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))

import { commitMediaSpend, drainToolSpend } from './_shared'
import { makeRunCostLedger, commitCost, isOverCap } from '@/lib/agents/run-cost-ledger'
import type { WorldStateMutable } from '@/lib/agents/world-state'

const world = (projectId: string | null) => ({ projectId }) as unknown as WorldStateMutable

describe('commitMediaSpend', () => {
  beforeEach(() => logSpend.mockClear())

  it('logs the spend under the given apiName + actual cost', async () => {
    await commitMediaSpend(world('p1'), 'imageGen', 0.05, 'flux: a cat')
    expect(logSpend).toHaveBeenCalledWith('p1', 'imageGen', 0.05, 'flux: a cat')
  })

  it('bills FAL avatar under the dedicated falAvatar apiName (never a cheaper one)', async () => {
    await commitMediaSpend(world('p1'), 'falAvatar', 0.12, 'fabric: hello')
    expect(logSpend).toHaveBeenCalledWith('p1', 'falAvatar', 0.12, 'fabric: hello')
  })

  it('skips a $0 cost (sandbox / cache hit / free provider) — nothing was billed', async () => {
    await commitMediaSpend(world('p1'), 'imageGen', 0, 'sandbox')
    expect(logSpend).not.toHaveBeenCalled()
  })

  it('skips a non-finite cost (poisoned estimate) without writing the ledger', async () => {
    await commitMediaSpend(world('p1'), 'imageGen', Number.POSITIVE_INFINITY, 'bad')
    expect(logSpend).not.toHaveBeenCalled()
  })

  it('no-ops when there is no projectId to bill against', async () => {
    await commitMediaSpend(world(null), 'imageGen', 0.05, 'no project')
    expect(logSpend).not.toHaveBeenCalled()
  })

  it('is best-effort: a logSpend failure does not throw (the asset is already generated)', async () => {
    logSpend.mockRejectedValueOnce(new Error('db down'))
    await expect(commitMediaSpend(world('p1'), 'imageGen', 0.05, 'x')).resolves.toBeUndefined()
  })
})

// P1-1a: media/generation spend must bind against the RUN cost cap, not only the
// DB apiSpend ledger. commitMediaSpend accumulates onto a per-world side channel;
// the runner drains it after each tool and commits it to the in-memory
// RunCostLedger (this replicates the runner's exact commit step). Before the fix,
// commitMediaSpend fed ONLY the DB ledger, so drainToolSpend returned 0 and a
// media-only run's cap never tripped.
describe('media spend → run cost cap wiring (P1-1a)', () => {
  beforeEach(() => logSpend.mockClear())

  it('a media tool that outspends the cap trips isOverCap once its spend is drained + committed', async () => {
    const w = world('p1')
    const ledger = makeRunCostLedger(0.1) // $0.10 run cap

    // Handler bills $0.50 during execution (e.g. an expensive image/avatar gen).
    await commitMediaSpend(w, 'imageGen', 0.5, 'flux: a cat')

    // The run cap has NOT moved yet — the ledger reads the drained per-tool spend.
    expect(isOverCap(ledger)).toBe(false)

    // Runner's post-tool step: drain this tool's spend and commit to the ledger.
    const spent = drainToolSpend(w)
    expect(spent).toBe(0.5)
    commitCost(ledger, spent)

    // Media-only spend now trips the RUN cap.
    expect(isOverCap(ledger)).toBe(true)
  })

  it('drains exactly once — a second drain returns 0 (no double-count)', async () => {
    const w = world('p1')
    await commitMediaSpend(w, 'falAvatar', 0.2, 'fabric')
    expect(drainToolSpend(w)).toBe(0.2)
    expect(drainToolSpend(w)).toBe(0)
  })

  it('accumulates multiple bills from one tool before the drain (image + background removal)', async () => {
    const w = world('p1')
    await commitMediaSpend(w, 'imageGen', 0.3, 'gen')
    await commitMediaSpend(w, 'backgroundRemoval', 0.05, 'rmbg')
    expect(drainToolSpend(w)).toBeCloseTo(0.35, 6)
  })

  it('counts run-cap spend even without a projectId (the DB write is skipped but the money was spent)', async () => {
    const w = world(null)
    await commitMediaSpend(w, 'imageGen', 0.4, 'no project')
    expect(logSpend).not.toHaveBeenCalled() // no DB ledger without a project
    expect(drainToolSpend(w)).toBe(0.4) // but the run cap still sees it
  })

  it('a $0 / non-finite cost adds nothing to drain', async () => {
    const w = world('p1')
    await commitMediaSpend(w, 'imageGen', 0, 'sandbox')
    await commitMediaSpend(w, 'imageGen', Number.POSITIVE_INFINITY, 'poisoned')
    expect(drainToolSpend(w)).toBe(0)
  })
})
