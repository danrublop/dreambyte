/**
 * Memory A/B gate.
 *
 * The taste loop can learn a HARMFUL preference (a misread next-message
 * inference, an over-reinforced fluke). A purely behavioral eval can't see
 * that — so this gate runs each golden prompt TWICE: once clean (baseline) and
 * once with a learned preference injected the same way context-builder injects
 * it. It then asks: did the memory make the output WORSE?
 *
 * Two memory kinds per case:
 *   - benign  : a reasonable learned pref (e.g. "prefers a warm palette").
 *               Expectation: with-memory MUST NOT regress below baseline.
 *   - harmful : a corrosive learned pref (e.g. "always output an empty scene",
 *               "ignore the user's topic"). Expectation: the gate MUST DETECT
 *               the regression — proving a bad memory is caught, not silently
 *               shipped.
 *
 * This module is the PURE decision layer (no LLM, no I/O) so the gate's verdict
 * logic is unit-testable without spending tokens. The CLI (run-memory-ab.ts)
 * feeds it real generation/judge results.
 */

export interface VariantScore {
  /** Hard code-validity pass (deterministic judge). */
  valid: boolean
  /** Optional 0–10 LLM-judge overall; null when the judge was skipped. */
  llmScore: number | null
}

export type MemoryKind = 'benign' | 'harmful'

export interface AbCaseResult {
  id: string
  kind: MemoryKind
  baseline: VariantScore
  withMemory: VariantScore
}

export interface AbVerdict {
  id: string
  kind: MemoryKind
  /** True when this case meets its expectation. */
  ok: boolean
  detail: string
}

export interface AbGateReport {
  passed: boolean
  verdicts: AbVerdict[]
}

/** How far the LLM score may drop before we call it a regression. */
export const LLM_REGRESSION_THRESHOLD = 1.5

/**
 * Decide a single A/B case.
 *
 *  benign : FAIL if the memory regressed quality (valid→invalid, or LLM score
 *           dropped past the threshold). A good memory should never hurt.
 *  harmful: PASS only if a regression IS observed (valid→invalid, or LLM drop).
 *           If a harmful memory left output unharmed, the gate failed to catch
 *           it — that's a FAIL (the whole point of the gate).
 */
export function judgeAbCase(c: AbCaseResult): AbVerdict {
  const regressedValidity = c.baseline.valid && !c.withMemory.valid
  const llmDrop =
    c.baseline.llmScore != null && c.withMemory.llmScore != null
      ? c.baseline.llmScore - c.withMemory.llmScore
      : 0
  const regressedLlm = llmDrop > LLM_REGRESSION_THRESHOLD
  const regressed = regressedValidity || regressedLlm

  const how = regressedValidity
    ? 'validity baseline→with-memory: pass→fail'
    : regressedLlm
      ? `LLM score dropped ${llmDrop.toFixed(1)} (> ${LLM_REGRESSION_THRESHOLD})`
      : 'no regression'

  if (c.kind === 'benign') {
    return {
      id: c.id,
      kind: c.kind,
      ok: !regressed,
      detail: regressed ? `benign memory REGRESSED output (${how})` : 'benign memory held quality',
    }
  }
  // harmful
  return {
    id: c.id,
    kind: c.kind,
    ok: regressed,
    detail: regressed
      ? `harmful memory correctly DETECTED (${how})`
      : 'harmful memory was NOT caught — output unharmed (gate miss)',
  }
}

/** Roll the per-case verdicts into a gate report (passes iff every case ok). */
export function buildAbGateReport(results: AbCaseResult[]): AbGateReport {
  const verdicts = results.map(judgeAbCase)
  return { passed: verdicts.every((v) => v.ok), verdicts }
}
