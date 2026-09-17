// @vitest-environment node
//
// Guards the $0-cost-cap-bypass bug: the runtime cost ledger
// (calculateCost -> getModelPricing) reads MODEL_PRICING in types.ts, NOT the
// costPer1M* fields in model-config.ts. If a paid model is added to
// DEFAULT_MODELS but its API `modelId` is missing from MODEL_PRICING, every run
// on that model prices at $0 and the run cost cap never trips. This test fails
// the build when the two tables drift, so the gap is caught before merge rather
// than as a surprise $0 bill that silently disables the cap.

import { describe, expect, it } from 'vitest'
import { MODEL_PRICING } from './types'
import { DEFAULT_MODELS } from './model-config'

// Zero-cost models (local Ollama, claude-code / codex CLI passthrough) are free
// by design — $0 is the correct price, so they need no MODEL_PRICING entry.
const PAID_MODELS = DEFAULT_MODELS.filter((m) => m.costPer1MInput > 0 || m.costPer1MOutput > 0)

describe('MODEL_PRICING stays in sync with model-config DEFAULT_MODELS', () => {
  it('has paid models to check (guards against an empty filter passing vacuously)', () => {
    expect(PAID_MODELS.length).toBeGreaterThan(0)
  })

  // Match on `modelId` (the API model string the provider + cost ledger see),
  // NOT `id` (the UI dropdown identifier).
  it.each(PAID_MODELS.map((m) => [m.modelId, m.id, m.costPer1MInput, m.costPer1MOutput] as const))(
    'modelId "%s" (%s) has a MODEL_PRICING entry with exact prices',
    (modelId, uiId, costIn, costOut) => {
      const pricing = MODEL_PRICING[modelId]
      expect(
        pricing,
        `MODEL_PRICING is missing "${modelId}" (${uiId}). A paid model absent from the pricing ` +
          `table prices at $0 at runtime, so the run cost cap never trips. Add it to MODEL_PRICING in types.ts.`,
      ).toBeDefined()
      expect(pricing.inputPer1M, `input price drift for "${modelId}"`).toBe(costIn)
      expect(pricing.outputPer1M, `output price drift for "${modelId}"`).toBe(costOut)
    },
  )

  it('every zero-cost model is genuinely free (local / CLI passthrough), not an un-priced paid model', () => {
    const freeModels = DEFAULT_MODELS.filter((m) => m.costPer1MInput === 0 && m.costPer1MOutput === 0)
    for (const m of freeModels) {
      expect(
        ['local', 'claude-code', 'codex-cli'],
        `model "${m.id}" (provider ${m.provider}) has $0 cost but isn't a known free provider — ` +
          `it may be a paid model missing its cost, which would bypass the cost cap.`,
      ).toContain(m.provider)
    }
  })
})
