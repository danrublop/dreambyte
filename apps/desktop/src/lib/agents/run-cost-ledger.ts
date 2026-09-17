/**
 * Shared, run-scoped cost ledger (Workstream C hardening).
 *
 * One ledger per top-level agent run, shared BY REFERENCE with every sub-agent
 * the orchestrator spawns. It lets the combined LLM spend of the parent + all
 * parallel sub-agents (including aborted/retried attempts, whose cost is
 * committed as it's incurred) be enforced against the run cap in real time —
 * not just reconciled at batch boundaries.
 *
 * Concurrency: sub-agents are recursive `runAgent()` calls on the SAME
 * single-threaded event loop, not workers. Increments happen between `await`s
 * and are therefore atomic — no locks are needed. Do NOT move sub-agents into
 * worker threads/processes without revisiting this assumption.
 */
export interface RunCostLedger {
  /** Committed actual LLM cost across parent + all sub-agents, in USD. */
  spentUsd: number
  /** The spend this ledger was seeded with (resume carry-over). Immutable after
   *  construction. `spentUsd - seedUsd` is THIS chain's own spend — what the
   *  live cost chip should show (monotonic across parent + sub-runs, and it
   *  excludes the pre-pause total a resumed run already displayed). Shared by
   *  reference so parent and every sub-agent read the same seed. */
  seedUsd: number
  /** The run cap, in USD. `Infinity` means "Unlimited". */
  capUsd: number
  /** One-shot guard for the 80%-of-cap soft warning, shared so it fires once
   *  per run rather than once per sub-agent. */
  warned80?: boolean
  /** Count of paid VISUAL/VIDEO asset generations dispatched across parent + all
   *  sub-agents (image / sticker / i2i / variation / avatar / veo3). Shared by
   *  reference so the whole run — not each sub-agent — is bounded. */
  mediaGenCount: number
  /** Hard backstop on `mediaGenCount`. `Infinity` disables it. This is DELIBERATELY
   *  independent of the dollar cap: `commitMediaSpend` skips $0 generations, so a free
   *  or $0-reporting provider in a runaway loop bypasses the cost cap entirely — this
   *  count catches that class (a real cap-evasion gap). Set generous so it only ever
   *  fires on a pathological loop, never a legitimate multi-scene build. */
  mediaGenCap: number
  /** Count of research tool calls (web_search / fetch_url_content / find_stock_* /
   *  find_archival_footage) across parent + all sub-agents. Shared by reference so the
   *  whole RUN is bounded — a per-agent count can't, because every sub-agent (the
   *  director's scene-builders, correctives, Explore) is its own agent and would each
   *  research uncapped. Research is $0, so the dollar cap never catches a research loop. */
  researchCount: number
  /** Hard run-wide ceiling on `researchCount` (`Infinity` disables). Generous — a real
   *  multi-scene build researches well under this; only a runaway search loop trips it. */
  researchCap: number
}

/** Generous per-run backstop on paid visual/video generations. An 8-scene video with
 *  1–2 images per scene plus a few avatars sits well under this; only a runaway loop
 *  (a bug, or a free-provider spin) trips it. Not a budget — a safety ceiling. */
export const DEFAULT_MEDIA_GEN_CAP = 60

/** Generous run-wide backstop on research tool calls (parent + every sub-agent). A
 *  Kept deliberately LOW so the agent researches BRIEFLY and starts building fast — the
 *  #1 "every prompt takes forever" cause was a front-loaded, invisible ~28-call research
 *  marathon before a single scene appeared, so the user bailed. A build that genuinely
 *  needs more depth can dispatch another Explore; the default should not stall the run. */
export const DEFAULT_RESEARCH_CAP = 8

/**
 * Create a run-scoped ledger.
 *
 * `seedSpentUsd` pre-loads already-incurred spend so a resumed cap-checkpoint
 * run continues from its prior total instead of getting a fresh budget — without
 * it, stop→resume loops spend N× the ceiling. A missing/NaN/negative seed
 * is treated as 0 so a malformed checkpoint can't drive the ledger negative
 * (which would under-count real spend and under-enforce the cap).
 */
export function makeRunCostLedger(
  capUsd: number,
  seedSpentUsd = 0,
  mediaGenCap: number = DEFAULT_MEDIA_GEN_CAP,
  researchCap: number = DEFAULT_RESEARCH_CAP,
): RunCostLedger {
  const seed = Number.isFinite(seedSpentUsd) && seedSpentUsd > 0 ? seedSpentUsd : 0
  return {
    spentUsd: seed,
    seedUsd: seed,
    capUsd,
    warned80: false,
    mediaGenCount: 0,
    mediaGenCap,
    researchCount: 0,
    researchCap,
  }
}

/**
 * Add a model call's incremental cost to the ledger. Negative/zero deltas are
 * ignored (cost is monotonic; a stale lower reading must never reduce the
 * total). Returns the new running total.
 */
export function commitCost(ledger: RunCostLedger, deltaUsd: number): number {
  if (deltaUsd > 0) ledger.spentUsd += deltaUsd
  return ledger.spentUsd
}

/**
 * Undo a RESERVATION that the provider never billed (e.g.
 * cut/motion-review reserve the estimate BEFORE their VLM await so a
 * concurrent burst can't all pass the cap gate, then refund when the call
 * throws / returns empty / parses unreviewable — those paths were never
 * billed, and keeping the reservation would wrongly trip the cap for later
 * work).
 *
 * This deliberately does NOT violate commitCost's "cost is monotonic" rule:
 * a refund must be paired 1:1 with a prior reservation of the same amount —
 * it un-does bookkeeping, never real spend. Clamped at zero so a buggy
 * unpaired refund can't drive the ledger negative (and thereby under-count
 * real spend).
 */
export function refundCost(ledger: RunCostLedger, deltaUsd: number): number {
  if (deltaUsd > 0) ledger.spentUsd = Math.max(0, ledger.spentUsd - deltaUsd)
  return ledger.spentUsd
}

/** True once committed spend has crossed the cap. Always false for an Infinity cap. */
export function isOverCap(ledger: RunCostLedger): boolean {
  return ledger.spentUsd > ledger.capUsd
}

/** Record `n` paid visual/video generations against the run's shared media-gen
 *  count. Negative/zero deltas are ignored (monotonic, mirrors commitCost). */
export function commitMediaGen(ledger: RunCostLedger, n = 1): number {
  if (n > 0) ledger.mediaGenCount += n
  return ledger.mediaGenCount
}

/** True once the run has dispatched more paid media generations than its backstop.
 *  Always false for an Infinity cap ("Unlimited"). */
export function isOverMediaGenCap(ledger: RunCostLedger): boolean {
  return Number.isFinite(ledger.mediaGenCap) && ledger.mediaGenCount > ledger.mediaGenCap
}

/** True the first time spend crosses 80% of a finite cap; flips the shared
 *  one-shot guard so the caller emits the soft warning exactly once per run. */
export function shouldWarn80(ledger: RunCostLedger): boolean {
  if (ledger.warned80) return false
  if (!Number.isFinite(ledger.capUsd)) return false
  if (ledger.spentUsd < ledger.capUsd * 0.8) return false
  ledger.warned80 = true
  return true
}
