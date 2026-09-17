// Memory A/B gate decision logic (deterministic, no LLM).
// Proves the gate catches a harmful learned preference and does not punish a
// benign one. The live generation runner (run-memory-ab.ts) is key-gated and
// not exercised here.

import { describe, it, expect } from 'vitest'
import {
  judgeAbCase,
  buildAbGateReport,
  LLM_REGRESSION_THRESHOLD,
  type AbCaseResult,
} from './memory-ab'

const v = (valid: boolean, llmScore: number | null = null) => ({ valid, llmScore })

describe('judgeAbCase', () => {
  it('benign memory that holds quality → ok', () => {
    const r = judgeAbCase({ id: 'b1', kind: 'benign', baseline: v(true, 8), withMemory: v(true, 8) })
    expect(r.ok).toBe(true)
  })

  it('benign memory that breaks validity → FAIL (a good memory must not hurt)', () => {
    const r = judgeAbCase({ id: 'b2', kind: 'benign', baseline: v(true), withMemory: v(false) })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/REGRESSED/)
  })

  it('harmful memory that breaks validity → ok (gate CAUGHT it)', () => {
    const r = judgeAbCase({ id: 'h1', kind: 'harmful', baseline: v(true), withMemory: v(false) })
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/DETECTED/)
  })

  it('harmful memory that left output unharmed → FAIL (gate missed it)', () => {
    const r = judgeAbCase({ id: 'h2', kind: 'harmful', baseline: v(true, 8), withMemory: v(true, 8) })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/NOT caught/)
  })

  it('LLM score drop past the threshold counts as a regression', () => {
    const drop = LLM_REGRESSION_THRESHOLD + 0.1
    const harmful = judgeAbCase({
      id: 'h3',
      kind: 'harmful',
      baseline: v(true, 9),
      withMemory: v(true, 9 - drop),
    })
    expect(harmful.ok).toBe(true) // caught via LLM drop

    const benign = judgeAbCase({
      id: 'b3',
      kind: 'benign',
      baseline: v(true, 9),
      withMemory: v(true, 9 - drop),
    })
    expect(benign.ok).toBe(false) // benign regressed
  })

  it('an LLM drop within the threshold is NOT a regression', () => {
    const r = judgeAbCase({
      id: 'b4',
      kind: 'benign',
      baseline: v(true, 9),
      withMemory: v(true, 9 - (LLM_REGRESSION_THRESHOLD - 0.1)),
    })
    expect(r.ok).toBe(true)
  })
})

describe('buildAbGateReport', () => {
  it('passes only when every case meets expectation', () => {
    const good: AbCaseResult[] = [
      { id: 'b', kind: 'benign', baseline: v(true), withMemory: v(true) },
      { id: 'h', kind: 'harmful', baseline: v(true), withMemory: v(false) },
    ]
    expect(buildAbGateReport(good).passed).toBe(true)

    const missed: AbCaseResult[] = [
      { id: 'h', kind: 'harmful', baseline: v(true), withMemory: v(true) }, // not caught
    ]
    const rep = buildAbGateReport(missed)
    expect(rep.passed).toBe(false)
    expect(rep.verdicts[0].ok).toBe(false)
  })
})
