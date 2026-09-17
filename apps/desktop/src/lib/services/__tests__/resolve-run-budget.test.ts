/**
 * Tests for resolveRunBudgetConfig — maps the Settings → Agents "Run budget"
 * value into the runner's per-run cost circuit breaker (runConfig.maxRunCostUsd).
 *
 * Contract:
 *   undefined  → no override (runner keeps its $25 default)
 *   null       → Unlimited (Infinity)
 *   <= 0       → Unlimited (defensive: a misconfigured 0 must not trap every run)
 *   positive n → that cap
 */

import { describe, it, expect } from 'vitest'
import { resolveRunBudgetConfig } from '../agent-runner'

describe('resolveRunBudgetConfig', () => {
  it('returns undefined when no budget is provided (runner default applies)', () => {
    expect(resolveRunBudgetConfig(undefined)).toBeUndefined()
  })

  it('maps null to Unlimited (Infinity)', () => {
    expect(resolveRunBudgetConfig(null)).toEqual({ maxRunCostUsd: Infinity })
  })

  it('maps a positive number to that exact cap', () => {
    expect(resolveRunBudgetConfig(25)).toEqual({ maxRunCostUsd: 25 })
    expect(resolveRunBudgetConfig(0.5)).toEqual({ maxRunCostUsd: 0.5 })
    expect(resolveRunBudgetConfig(100)).toEqual({ maxRunCostUsd: 100 })
  })

  it('treats 0 as Unlimited rather than a zero cap that traps every run', () => {
    expect(resolveRunBudgetConfig(0)).toEqual({ maxRunCostUsd: Infinity })
  })

  it('treats negative values as Unlimited (defensive)', () => {
    expect(resolveRunBudgetConfig(-5)).toEqual({ maxRunCostUsd: Infinity })
  })
})
