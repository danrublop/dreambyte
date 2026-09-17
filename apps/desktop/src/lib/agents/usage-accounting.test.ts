/**
 * C1/T6 — Anthropic usage must accumulate (the money bug).
 *
 * The runner used to OVERWRITE the run-total token counters each turn for
 * Anthropic (adapter branch AND legacy streaming branch) while every other
 * provider accumulated with `+=`. The ledger ended up holding ~one turn's
 * cost, so the per-run cost cap under-enforced and logSpend/logAgentUsage
 * under-reported multi-turn runs on the default provider.
 *
 * Three layers of protection here:
 *   1. Unit tests on the pure helpers (usage-accounting.ts) both runner
 *      branches now route through — table-driven across providers.
 *   2. Two-phase legacy semantics: stream deltas then a finalMessage
 *      correction must sum to exactly Σ finalMessage usage per turn (no
 *      double-count, no overwrite).
 *   3. A source-parity test on runner.ts that FORBIDS plain overwrite
 *      assignments into the totals while ALLOWING the helper-result shapes
 *      (`= next.…` from accumulateTurnUsage, `= corrected.totals.…` from
 *      correctTurnUsageFromFinalMessage) and the `let … = 0` declarations.
 *
 * Multi-turn behavior through the real runner loop (both branches) is covered
 * in runner.integration.test.ts ("usage accumulates across turns").
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  accumulateTurnUsage,
  correctTurnUsageFromFinalMessage,
  type UsageTotals,
  type TurnUsage,
} from './usage-accounting'

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

// ── 1. Adapter-branch accumulation (table-driven per provider) ────────────────

describe('accumulateTurnUsage — per-call usage sums across turns for every provider', () => {
  // Per-turn usage shapes as each adapter actually reports them. Anthropic
  // reports both cache fields; OpenAI/Google/DeepSeek/Kimi/Qwen report
  // cacheReadTokens only (A1-3); local models report no cache fields at all.
  const cases: Array<{ provider: string; turns: TurnUsage[]; expected: UsageTotals }> = [
    {
      provider: 'anthropic',
      turns: [
        { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 1000, cacheReadTokens: 0 },
        { inputTokens: 150, outputTokens: 60, cacheCreationTokens: 0, cacheReadTokens: 1000 },
        { inputTokens: 200, outputTokens: 70, cacheCreationTokens: 0, cacheReadTokens: 1000 },
      ],
      expected: { inputTokens: 450, outputTokens: 180, cacheCreationTokens: 1000, cacheReadTokens: 2000 },
    },
    {
      provider: 'openai',
      turns: [
        { inputTokens: 200, outputTokens: 5, cacheReadTokens: 800 },
        { inputTokens: 300, outputTokens: 7, cacheReadTokens: 900 },
      ],
      expected: { inputTokens: 500, outputTokens: 12, cacheCreationTokens: 0, cacheReadTokens: 1700 },
    },
    {
      provider: 'google',
      turns: [
        { inputTokens: 100, outputTokens: 7, cacheReadTokens: 400 },
        { inputTokens: 120, outputTokens: 9 },
      ],
      expected: { inputTokens: 220, outputTokens: 16, cacheCreationTokens: 0, cacheReadTokens: 400 },
    },
    {
      provider: 'deepseek (openai-compat)',
      turns: [
        { inputTokens: 50, outputTokens: 10 },
        { inputTokens: 60, outputTokens: 20 },
        { inputTokens: 70, outputTokens: 30 },
      ],
      expected: { inputTokens: 180, outputTokens: 60, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
  ]

  it.each(cases)('$provider: totals are the sum of per-turn usage', ({ turns, expected }) => {
    let totals = ZERO
    for (const turn of turns) totals = accumulateTurnUsage(totals, turn)
    expect(totals).toEqual(expected)
  })

  it('[REGRESSION] a single-turn run reports exactly that turn (unchanged behavior)', () => {
    const totals = accumulateTurnUsage(ZERO, {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 7,
      cacheReadTokens: 3,
    })
    expect(totals).toEqual({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 7, cacheReadTokens: 3 })
  })

  it('a zero-usage turn is a no-op (historical >0 gate preserved)', () => {
    const before: UsageTotals = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 1, cacheReadTokens: 2 }
    expect(accumulateTurnUsage(before, { inputTokens: 0, outputTokens: 0 })).toEqual(before)
  })

  it('missing cache fields are treated as 0, never NaN', () => {
    const totals = accumulateTurnUsage(ZERO, { inputTokens: 5, outputTokens: 5 })
    expect(totals.cacheCreationTokens).toBe(0)
    expect(totals.cacheReadTokens).toBe(0)
  })
})

// ── 2. Legacy two-phase accounting ────────────────────────────────────────────

/** Simulate one legacy turn: stream deltas land in the totals, then the
 *  finalMessage correction runs — exactly the runner's sequence. */
function legacyTurn(
  totals: UsageTotals,
  streamDeltas: { input: number; output: number; cacheCreation?: number; cacheRead?: number },
  finalUsage: Parameters<typeof correctTurnUsageFromFinalMessage>[2],
): { totals: UsageTotals; streamedInput: number; streamedOutput: number } {
  const turnStart = { ...totals }
  const current: UsageTotals = {
    inputTokens: totals.inputTokens + streamDeltas.input,
    outputTokens: totals.outputTokens + streamDeltas.output,
    cacheCreationTokens: totals.cacheCreationTokens + (streamDeltas.cacheCreation ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (streamDeltas.cacheRead ?? 0),
  }
  return correctTurnUsageFromFinalMessage(turnStart, current, finalUsage)
}

describe('correctTurnUsageFromFinalMessage — stream deltas + finalMsg sum to exactly Σ finalMsg', () => {
  it('three turns: totals equal the sum of each turn’s finalMessage usage (no double-count)', () => {
    // Stream deltas deliberately UNDER-count finalMsg by a few % — the exact
    // situation the finalMessage correction exists for.
    const turns = [
      { stream: { input: 95, output: 48 }, final: { input_tokens: 100, output_tokens: 50 } },
      { stream: { input: 240, output: 70 }, final: { input_tokens: 250, output_tokens: 75 } },
      { stream: { input: 390, output: 110 }, final: { input_tokens: 400, output_tokens: 120 } },
    ]
    let totals = ZERO
    for (const t of turns) totals = legacyTurn(totals, t.stream, t.final).totals
    expect(totals.inputTokens).toBe(100 + 250 + 400)
    expect(totals.outputTokens).toBe(50 + 75 + 120)
  })

  it('[REGRESSION] single-turn totals equal that turn’s finalMessage usage (unchanged)', () => {
    const { totals } = legacyTurn(ZERO, { input: 95, output: 48 }, { input_tokens: 100, output_tokens: 50 })
    expect(totals).toEqual({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 })
  })

  it('reports this turn’s stream-counted slice for the discrepancy warning', () => {
    const first = legacyTurn(ZERO, { input: 95, output: 48 }, { input_tokens: 100, output_tokens: 50 })
    expect(first.streamedInput).toBe(95)
    expect(first.streamedOutput).toBe(48)
    // Second turn: streamed slice is THIS turn's deltas, not the running total.
    const second = legacyTurn(first.totals, { input: 200, output: 60 }, { input_tokens: 210, output_tokens: 65 })
    expect(second.streamedInput).toBe(200)
    expect(second.streamedOutput).toBe(60)
    expect(second.totals.inputTokens).toBe(100 + 210)
  })

  it('zero finalMessage usage (finalMessage() failed fallback) → stream deltas stand', () => {
    const { totals } = legacyTurn(ZERO, { input: 95, output: 48 }, { input_tokens: 0, output_tokens: 0 })
    expect(totals.inputTokens).toBe(95)
    expect(totals.outputTokens).toBe(48)
    // …and the next turn still sums on top of the delta-counted turn.
    const next = legacyTurn(totals, { input: 100, output: 10 }, { input_tokens: 105, output_tokens: 12 })
    expect(next.totals.inputTokens).toBe(95 + 105)
    expect(next.totals.outputTokens).toBe(48 + 12)
  })

  it('cache fields: finalMsg values re-base on the turn snapshot; missing fields keep stream-accumulated values', () => {
    // Turn 1: finalMsg reports cache fields → turnStart(0) + finalMsg.
    const t1 = legacyTurn(
      ZERO,
      { input: 10, output: 5, cacheCreation: 900, cacheRead: 100 },
      { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200 },
    )
    expect(t1.totals.cacheCreationTokens).toBe(1000)
    expect(t1.totals.cacheReadTokens).toBe(200)
    // Turn 2: finalMsg omits cache fields → this turn's stream-accumulated
    // cache deltas stand, summed on top of turn 1.
    const t2 = legacyTurn(
      t1.totals,
      { input: 20, output: 5, cacheCreation: 0, cacheRead: 500 },
      { input_tokens: 20, output_tokens: 5 },
    )
    expect(t2.totals.cacheCreationTokens).toBe(1000)
    expect(t2.totals.cacheReadTokens).toBe(200 + 500)
  })
})

// ── 3. Source parity: no plain overwrites into the run totals ─────────────────
//
// The totals live as four `let` counters inside runAgent, so the accounting
// can't be import-tested directly. This pins the SHAPE at the source level:
// every assignment into total{Input,Output,CacheCreation,CacheRead}Tokens must
// be one of
//   - the `let … = 0` declaration,
//   - an accumulation (`+=`),
//   - the adapter helper result (`= next.…` from accumulateTurnUsage),
//   - the legacy finalMsg correction result (`= corrected.totals.…`).
// A plain overwrite (`= turn.usage.inputTokens`, `= finalMsg.usage.…`) is the
// money bug coming back — fail loudly.

describe('runner.ts source parity — usage totals are never plainly overwritten (C1/T6)', () => {
  it('forbids overwrite assignments into the totals outside the allowed shapes', () => {
    const runnerSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/agents/runner.ts'), 'utf8')
    const lines = runnerSrc.split('\n')
    const assignRe = /total(?:Input|Output|CacheCreation|CacheRead)Tokens\s*(\+=|-=|\*=|=)(?!=)\s*(.*)$/
    const offenders: string[] = []
    for (const [i, line] of lines.entries()) {
      const m = line.match(assignRe)
      if (!m) continue
      const [, op, rhsRaw] = m
      if (op === '+=') continue // accumulation — the correct default
      if (op === '-=' || op === '*=') {
        offenders.push(`${i + 1}: ${line.trim()}`)
        continue
      }
      const rhs = rhsRaw.trim()
      const allowed = /^0\b/.test(rhs) || /^next\./.test(rhs) || /^corrected\.totals\./.test(rhs)
      if (!allowed) offenders.push(`${i + 1}: ${line.trim()}`)
    }
    expect(offenders, `plain overwrite into usage totals:\n${offenders.join('\n')}`).toEqual([])
  })

  it('sanity: the runner still references all four totals (the regex is not dead)', () => {
    const runnerSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/agents/runner.ts'), 'utf8')
    for (const name of ['totalInputTokens', 'totalOutputTokens', 'totalCacheCreationTokens', 'totalCacheReadTokens']) {
      expect(runnerSrc.includes(`let ${name} = 0`)).toBe(true)
      // Accumulated either directly (`+=`, sub-agent roll-up) or through
      // accumulateTurnUsage (`= next.x`) — both are allowed by the scan above.
      expect(new RegExp(`${name} (\\+=|= next\\.)`).test(runnerSrc)).toBe(true)
    }
  })
})
