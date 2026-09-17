// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { calculateCost } from './types'
import type { ModelConfig } from './model-config'

// P1-1b: calculateCost prices custom / BYOK models at $0 when it only knows the
// built-in MODEL_PRICING map — which silently let the run cost cap never trip for
// a user's own model. The OPTIONAL modelConfigs param delegates pricing to the
// user's registry so a custom model bills its real rate. Default behavior (no
// configs) is UNCHANGED so the ~10 existing callers compile + behave identically.

const customModel: ModelConfig = {
  id: 'my-custom-llm',
  provider: 'local',
  modelId: 'my-custom-llm',
  displayName: 'My Custom LLM',
  tier: 'custom',
  enabled: true,
  isDefault: false,
  costPer1MInput: 2, // $2 / 1M in
  costPer1MOutput: 8, // $8 / 1M out
  maxTokens: 128_000,
  supportsTools: true,
  supportsStreaming: true,
}

describe('calculateCost — optional modelConfigs delegation (P1-1b)', () => {
  it('prices a custom model at $0 WITHOUT configs (the built-in map does not know it)', () => {
    expect(calculateCost('my-custom-llm', 1_000_000, 1_000_000)).toBe(0)
  })

  it('prices the SAME custom model non-zero WHEN its config is supplied', () => {
    // 1M in @ $2 + 1M out @ $8 = $10.
    const cost = calculateCost('my-custom-llm', 1_000_000, 1_000_000, 0, 0, [customModel])
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeCloseTo(10, 6)
  })

  it('resolves by the provider modelId as well as the config id', () => {
    const byModelId = calculateCost(customModel.modelId, 500_000, 0, 0, 0, [customModel])
    expect(byModelId).toBeCloseTo(1, 6) // 0.5M @ $2 = $1
  })

  it('leaves built-in model pricing unchanged whether or not configs are passed', () => {
    const noConfigs = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)
    const withConfigs = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0, [customModel])
    expect(noConfigs).toBeGreaterThan(0)
    // The custom-only registry doesn't shadow a built-in id; getModelPricing
    // falls back to DEFAULT_MODELS, so the built-in rate still applies.
    expect(withConfigs).toBeCloseTo(noConfigs, 6)
  })

  it('an unknown model with an empty config registry is still $0 (no accidental billing)', () => {
    expect(calculateCost('totally-unknown', 1_000_000, 1_000_000, 0, 0, [])).toBe(0)
  })
})
