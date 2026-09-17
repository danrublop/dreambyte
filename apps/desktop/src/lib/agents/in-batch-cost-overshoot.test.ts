// @vitest-environment node
//
// P1-16 — in-batch cost overshoot.
//
// When the orchestrator dispatches MAX_PARALLEL_SUB_AGENTS sub-agents that SHARE
// one RunCostLedger by reference, the shared cap used to be enforced only at the
// iteration boundary (top-of-loop) and AFTER a sub-agent's tool round (post-tool
// check). Each sub-agent's expensive iteration is roughly:
//
//     [commit model spend] -> [dispatch tools] -> [post-tool commit + cap check]
//
// With the cap check only AFTER tools ran, the first sub-agent to cross the
// shared cap couldn't stop the others — they had each already launched their
// (possibly expensive image/video) tool round before re-reading the aggregate.
// A 3-wide batch could therefore overshoot the cap by ~3x one scene's tool cost.
//
// The fix (runner.ts `stopForCostCapBeforeTools`, wired into BOTH the
// OpenAI/compat tool-dispatch site and the adapter/Anthropic one): right after
// the model turn — where this iteration's largest cost delta is committed to the
// SHARED ledger — re-read the aggregate and STOP before dispatching tools if the
// run is already over the cap.
//
// This test models that per-iteration loop directly (the real loop lives deep in
// runner.runAgent and is not unit-reachable). Each "sub-agent" shares one ledger,
// commits its model spend, optionally consults the pre-tool gate, then dispatches
// a tool. We assert that WITH the gate the total overshoot is bounded to ~one
// in-flight model turn per sub-agent — NOT N x one full (model + tool) iteration —
// while WITHOUT it the overshoot is the ~3x the audit describes.

import { describe, it, expect } from 'vitest'
import { makeRunCostLedger, commitCost, isOverCap, type RunCostLedger } from './run-cost-ledger'

/** A yield point so concurrently-dispatched sub-agents interleave on the single
 *  event loop the way real sub-agents (recursive runAgent awaits) do. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const MODEL_COST = 1 // cost of one model turn
const TOOL_COST = 4 // cost of one expensive tool round (image/video)

/**
 * One sub-agent iteration, mirroring runner.ts.
 *
 * `preToolGate=true` reproduces `stopForCostCapBeforeTools`: after committing
 * the model turn's spend to the SHARED ledger, re-check the aggregate and stop
 * before dispatching the (expensive) tool if already over cap.
 */
async function runSubAgentIteration(
  ledger: RunCostLedger,
  opts: { preToolGate: boolean },
): Promise<void> {
  // ── Top-of-loop check (always present, both before and after the fix) ──
  // Mirrors runner.ts:2737 overCostCap(): commit prior spend + read shared total.
  if (isOverCap(ledger)) return

  // ── Model turn: cost incurred, committed to the SHARED ledger. ──
  // (`commitRunningCost` writes only the new delta; here that is MODEL_COST.)
  await tick() // model call is async — other sub-agents interleave here
  commitCost(ledger, MODEL_COST)

  // ── P1-16 pre-tool gate ──
  // After the model turn flushed its spend to the shared ledger, re-read the
  // aggregate before launching tools. The FIRST sub-agent to push the shared
  // total over the cap stops the others HERE, before they each run a tool round.
  if (opts.preToolGate && isOverCap(ledger)) return

  // ── Tool round: the expensive in-flight work. Once dispatched it cannot be
  // un-billed (the unavoidable residual overshoot). ──
  await tick()
  commitCost(ledger, TOOL_COST)

  // ── Post-tool check (runner.ts:4696). With the gate this is now redundant for
  // the in-batch case; without it, it is the ONLY cap check after tools ran. ──
  if (isOverCap(ledger)) return
}

/** Dispatch a batch of N sub-agents that SHARE the ledger, concurrently. */
async function runBatch(
  ledger: RunCostLedger,
  n: number,
  opts: { preToolGate: boolean },
): Promise<void> {
  await Promise.all(
    Array.from({ length: n }, () => runSubAgentIteration(ledger, opts)),
  )
}

describe('P1-16 — in-batch cost overshoot', () => {
  it('reproduces the unbounded overshoot WITHOUT the pre-tool gate', async () => {
    // Cap sits just below the start of this batch, so the batch should do at most
    // ~one in-flight unit of work each. With no gate, all 3 run a full tool round.
    const cap = 9.5
    const ledger = makeRunCostLedger(cap)
    commitCost(ledger, 9) // prior spend leaves the run right under the cap

    await runBatch(ledger, 3, { preToolGate: false })

    // Each of 3 sub-agents ran model ($1) + tool ($4) = $5, on top of $9.
    // Overshoot above the cap is ~3 * (MODEL+TOOL) = $15 — the audit's ~3x.
    expect(ledger.spentUsd).toBe(9 + 3 * (MODEL_COST + TOOL_COST)) // 24
    expect(ledger.spentUsd - cap).toBeGreaterThan(2 * TOOL_COST) // far over
  })

  it('bounds overshoot to ~one in-flight model turn per sub-agent WITH the gate', async () => {
    const cap = 9.5
    const ledger = makeRunCostLedger(cap)
    commitCost(ledger, 9)

    await runBatch(ledger, 3, { preToolGate: true })

    // All 3 enter (run was under cap), each commits its MODEL turn ($1) which
    // collectively crosses the cap; the pre-tool gate then stops every one of
    // them BEFORE its $4 tool round. No tool round runs.
    expect(ledger.spentUsd).toBe(9 + 3 * MODEL_COST) // 12
    // Overshoot is bounded to the in-flight model turns (3 * $1), NOT a single
    // tool round, and is MUCH smaller than the un-gated 3x-tool overshoot.
    const overshoot = ledger.spentUsd - cap
    expect(overshoot).toBeLessThanOrEqual(3 * MODEL_COST)
    expect(overshoot).toBeLessThan(TOOL_COST) // never even one full tool round
  })

  it('the gate cuts the batch overshoot by the full tool cost vs. no gate', async () => {
    const cap = 9.5
    const gated = makeRunCostLedger(cap)
    const ungated = makeRunCostLedger(cap)
    commitCost(gated, 9)
    commitCost(ungated, 9)

    await runBatch(gated, 3, { preToolGate: true })
    await runBatch(ungated, 3, { preToolGate: false })

    expect(ungated.spentUsd).toBeGreaterThan(gated.spentUsd)
    // The saving is exactly the 3 tool rounds the gate prevented.
    expect(ungated.spentUsd - gated.spentUsd).toBe(3 * TOOL_COST)
  })

  it('does not regress a single (non-orchestrated) agent: the gate stops it too', async () => {
    // One agent, its own ledger (opts.costLedger undefined -> makeRunCostLedger).
    // The pre-tool gate reads the same ledger isOverCap, so behavior is identical
    // to the existing post-tool check — it just fires one step earlier.
    const cap = 0.5
    const ledger = makeRunCostLedger(cap)

    await runSubAgentIteration(ledger, { preToolGate: true })

    // The model turn ($1) alone crosses $0.5; the gate stops before the $4 tool.
    expect(ledger.spentUsd).toBe(MODEL_COST)
    expect(isOverCap(ledger)).toBe(true)
  })

  it('lets work proceed when still under cap (no false-positive stop)', async () => {
    // Plenty of headroom: the gate must NOT stop a sub-agent that is under cap.
    const cap = 100
    const ledger = makeRunCostLedger(cap)

    await runBatch(ledger, 3, { preToolGate: true })

    // All 3 ran model + tool fully: 3 * (1 + 4) = 15, well under 100.
    expect(ledger.spentUsd).toBe(3 * (MODEL_COST + TOOL_COST))
    expect(isOverCap(ledger)).toBe(false)
  })

  it('does not double-count: the shared ledger aggregates, the gate only READS it', async () => {
    // The gate calls isOverCap(ledger) — a pure read. commitCost is the only
    // writer, and it adds each turn's delta exactly once. Crossing the cap must
    // not inflate spend beyond the real per-turn deltas committed.
    const cap = 9.5
    const ledger = makeRunCostLedger(cap)
    commitCost(ledger, 9)

    await runBatch(ledger, 3, { preToolGate: true })

    // Exactly 3 model deltas of $1 each were committed on top of $9 — no more.
    expect(ledger.spentUsd).toBe(12)
  })
})
