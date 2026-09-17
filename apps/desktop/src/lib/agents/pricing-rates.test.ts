import { describe, it, expect } from 'vitest'
import { MODEL_PRICING, calculateCost } from './types'
import { DEFAULT_MODELS } from './model-config'

/**
 * Mutation testing found that multiplying the Sonnet rate by 100 in BOTH pricing
 * tables turned nothing red across 149 pricing/routing/ledger tests. Every cost test
 * in the repo asserts a RATIO or a self-derived total — `expected = tokens * rate`
 * using the same constant the code used — so the tables can say anything at all and
 * the suite agrees. These are the dollars on the user's bill; something has to pin
 * them to a literal.
 *
 * Rates are per 1M tokens, USD, published list price. When a vendor genuinely changes
 * a price: update the literal here in the same commit and say so — that is the point,
 * a rate change should be a decision, not a drift.
 */
// EVERY entry in MODEL_PRICING, pinned. Pinning only six let gemini-2.5-flash sit
// at gpt-4o-mini's rate for months — 4.17x low on output, so the $25 run cap
// under-tripped ~4x whenever someone enabled it. Sources checked 2026-08-04:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   Google     https://ai.google.dev/gemini-api/docs/pricing
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
//   Moonshot   https://platform.kimi.ai/docs/pricing/chat-k26 (and /chat-k3)
//   Qwen       https://www.eesel.ai/blog/qwen-pricing (Model Studio list rates)
const PUBLISHED_RATES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-8': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-5': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-sonnet-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-fable-5': { inputPer1M: 10.0, outputPer1M: 50.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
  o1: { inputPer1M: 15.0, outputPer1M: 60.0 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'gemini-2.5-flash-preview-05-20': { inputPer1M: 0.3, outputPer1M: 2.5 },
  // Pro is prompt-length tiered; the <=200k rate is what an agent turn pays.
  'gemini-2.5-pro-preview-05-06': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'deepseek-v4-pro': { inputPer1M: 0.435, outputPer1M: 0.87 },
  'qwen-flash': { inputPer1M: 0.05, outputPer1M: 0.4 },
  'qwen-plus': { inputPer1M: 0.4, outputPer1M: 1.2 },
  // K2.5 is off Moonshot's current pricing page (superseded by K2.6); last
  // published rate, kept because existing runs still reference the id.
  'kimi-k2.5': { inputPer1M: 0.6, outputPer1M: 3.0 },
  'kimi-k2.6': { inputPer1M: 0.95, outputPer1M: 4.0 },
  'kimi-k3': { inputPer1M: 3.0, outputPer1M: 15.0 },
}

/** Cache-READ price as a fraction of base input, per provider. The ledger applies
 *  these to cache_read tokens, so a wrong one bills a long agent session wrong in
 *  the direction of the error. Derived from the published cached-input rates. */
const PUBLISHED_CACHE_READ_RATIO: Record<string, { model: string; ratio: number }> = {
  // $0.10 hit / $1.00 input on Haiku 4.5 — Anthropic documents a flat 0.1x.
  anthropic: { model: 'claude-haiku-4-5-20251001', ratio: 0.1 },
  // gpt-4o: $1.25 cached / $2.50 input.
  openai: { model: 'gpt-4o', ratio: 0.5 },
  // Gemini implicit caching: 75% discount on the cached share.
  google: { model: 'gemini-2.5-flash-preview-05-20', ratio: 0.25 },
  // v4-flash: $0.0028 hit / $0.14 miss.
  deepseek: { model: 'deepseek-v4-flash', ratio: 0.02 },
  // qwen-plus: $0.08 hit / $0.40 input.
  qwen: { model: 'qwen-plus', ratio: 0.2 },
  // K2.6: $0.16 hit / $0.95 miss ≈ 0.168, rounded to 0.17.
  kimi: { model: 'kimi-k2.6', ratio: 0.17 },
}

describe('model pricing is pinned to real dollars', () => {
  it('MODEL_PRICING matches published list price for the top-billed models', () => {
    for (const [model, rate] of Object.entries(PUBLISHED_RATES)) {
      expect(MODEL_PRICING[model], `${model} missing from MODEL_PRICING`).toBeDefined()
      expect(MODEL_PRICING[model], `${model} rate drifted from published price`).toEqual(rate)
    }
  })

  it('every MODEL_PRICING entry is pinned — a new model may not ship unchecked', () => {
    const unpinned = Object.keys(MODEL_PRICING).filter((m) => !(m in PUBLISHED_RATES))
    expect(unpinned, 'add these to PUBLISHED_RATES with the vendor URL you checked, in the same commit').toEqual([])
  })

  it('cache-read multipliers match the published cached-input rates', () => {
    // calculateCost is the only consumer; drive it rather than reaching into the
    // private CACHE_PRICING_BY_PROVIDER map. 1M cache-read tokens, nothing else.
    for (const [provider, { model, ratio }] of Object.entries(PUBLISHED_CACHE_READ_RATIO)) {
      const inputPer1M = MODEL_PRICING[model].inputPer1M
      const cost = calculateCost(model, 0, 0, 0, 1_000_000)
      expect(cost, `${provider} cache-read ratio drifted (via ${model})`).toBeCloseTo(inputPer1M * ratio, 6)
    }
  })

  it('the two pricing tables agree — a rate must not be right in one and wrong in the other', () => {
    // MODEL_PRICING (types.ts) is what the cost ledger reads; DEFAULT_MODELS
    // (model-config.ts) is what the UI and tier routing read. They are separate
    // literals for the same dollars, so they can disagree silently.
    const mismatches: string[] = []
    for (const cfg of DEFAULT_MODELS) {
      const priced = MODEL_PRICING[cfg.modelId]
      if (!priced) continue // local/dynamic models are legitimately unpriced
      if (cfg.costPer1MInput !== priced.inputPer1M || cfg.costPer1MOutput !== priced.outputPer1M) {
        mismatches.push(
          `${cfg.modelId}: model-config ${cfg.costPer1MInput}/${cfg.costPer1MOutput} vs MODEL_PRICING ${priced.inputPer1M}/${priced.outputPer1M}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('no rate is absurd — catches an order-of-magnitude slip in any entry', () => {
    // A backstop for the models not individually pinned above. Nothing legitimately
    // costs more than $100/1M today; a 100x fat-finger lands far outside this.
    const absurd = Object.entries(MODEL_PRICING).filter(
      ([, r]) => r.inputPer1M > 100 || r.outputPer1M > 100 || r.inputPer1M < 0 || r.outputPer1M < 0,
    )
    expect(absurd.map(([m]) => m)).toEqual([])
  })
})
