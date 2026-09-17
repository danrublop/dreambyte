import { describe, it, expect } from 'vitest'
import { anthropicThinkingParams, DEFAULT_MODELS } from './model-config'
import { MODEL_PRICING } from './types'
import { THINKING_BUDGETS } from './context-builder'

/**
 * `thinking: {type:'enabled', budget_tokens}` is REMOVED on Opus 4.7 / 4.8 /
 * Opus 5 / Sonnet 5 / Fable 5 and returns a hard 400. The runner sent it on
 * every Anthropic turn whenever thinkingMode !== 'off' (default 'adaptive'),
 * and claude-opus-4-8 is enabled + isDefault — so the default model failed 100%
 * of the time. These assertions pin the per-model shape.
 */
describe('anthropicThinkingParams', () => {
  const budget = THINKING_BUDGETS.adaptive

  it('never sends budget_tokens to a 4.6+ model', () => {
    for (const model of [
      'claude-opus-4-6',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-opus-5',
      'claude-sonnet-5',
    ]) {
      for (const mode of ['off', 'adaptive', 'deep'] as const) {
        expect(JSON.stringify(anthropicThinkingParams(model, mode, budget)), `${model}/${mode}`).not.toContain(
          'budget_tokens',
        )
      }
    }
  })

  it('uses adaptive thinking + effort on 4.6+ models', () => {
    expect(anthropicThinkingParams('claude-opus-4-8', 'adaptive', budget)).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    })
    expect(anthropicThinkingParams('claude-opus-4-8', 'deep', budget)).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
  })

  it("'off' is an explicit kill switch — omitting `thinking` runs adaptive from Opus 5 on", () => {
    expect(anthropicThinkingParams('claude-opus-5', 'off', budget)).toEqual({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    })
    // `{type:'disabled'}` 400s above effort `high`; we pin `low`, never xhigh/max.
    expect(anthropicThinkingParams('claude-opus-5', 'off', budget).output_config).toEqual({ effort: 'low' })
  })

  it('never sends xhigh — Opus 4.6 / Sonnet 4.6 reject it', () => {
    for (const mode of ['off', 'adaptive', 'deep'] as const) {
      expect(JSON.stringify(anthropicThinkingParams('claude-opus-4-6', mode, budget))).not.toContain('xhigh')
    }
  })

  it('keeps budget_tokens for pre-4.6 models, which have no effort parameter', () => {
    expect(anthropicThinkingParams('claude-haiku-4-5-20251001', 'adaptive', budget)).toEqual({
      thinking: { type: 'enabled', budget_tokens: budget },
    })
    expect(anthropicThinkingParams('claude-haiku-4-5-20251001', 'off', budget)).toEqual({})
    expect(JSON.stringify(anthropicThinkingParams('claude-haiku-4-5-20251001', 'deep', budget))).not.toContain('effort')
  })

  it('sends no explicit thinking config to Fable/Mythos, which reject all of it', () => {
    expect(anthropicThinkingParams('claude-fable-5', 'off', budget)).toEqual({ output_config: { effort: 'low' } })
  })

  it('every shipped Anthropic model gets a shape its API accepts', () => {
    for (const m of DEFAULT_MODELS.filter((m) => m.provider === 'anthropic')) {
      const params = JSON.stringify(anthropicThinkingParams(m.modelId, 'adaptive', budget))
      const preNativeAdaptive = m.modelId.startsWith('claude-haiku-4-5')
      expect(params.includes('budget_tokens'), `${m.modelId}`).toBe(preNativeAdaptive)
      expect(params.includes('adaptive'), `${m.modelId}`).toBe(!preNativeAdaptive)
    }
  })
})

describe('retired and unpriced Anthropic models', () => {
  it('claude-3-5-sonnet-20241022 is gone — it was retired 2025-10-28 and 404s', () => {
    expect(DEFAULT_MODELS.some((m) => m.modelId === 'claude-3-5-sonnet-20241022')).toBe(false)
    expect(MODEL_PRICING['claude-3-5-sonnet-20241022']).toBeUndefined()
  })

  it('the 5-series is priced, so the run cost cap can trip on it', () => {
    // A model missing from MODEL_PRICING bills $0 and the cap never fires.
    expect(MODEL_PRICING['claude-opus-5']).toEqual({ inputPer1M: 5, outputPer1M: 25 })
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({ inputPer1M: 3, outputPer1M: 15 })
    expect(MODEL_PRICING['claude-fable-5']).toEqual({ inputPer1M: 10, outputPer1M: 50 })
  })
})
