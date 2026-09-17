// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { getModelProvider, getModelPricing } from './types'
import { DEFAULT_MODELS } from './model-config'
import { getAdapter } from './providers/index'

describe('Qwen / Kimi provider routing', () => {
  it('routes qwen-* / qwen3* model IDs to the qwen provider via prefix', () => {
    expect(getModelProvider('qwen-flash')).toBe('qwen')
    expect(getModelProvider('qwen-plus')).toBe('qwen')
    expect(getModelProvider('qwen3-max')).toBe('qwen')
  })

  it('routes kimi-* / moonshot-* model IDs to the kimi provider via prefix', () => {
    expect(getModelProvider('kimi-k2.5')).toBe('kimi')
    expect(getModelProvider('kimi-k2.6')).toBe('kimi')
    expect(getModelProvider('moonshot-v1-8k')).toBe('kimi')
  })

  it('routes via modelConfigs lookup when the provider field is set', () => {
    expect(getModelProvider('custom', [{ id: 'custom', modelId: 'custom', provider: 'qwen' } as never])).toBe('qwen')
    expect(getModelProvider('custom', [{ id: 'custom', modelId: 'custom', provider: 'kimi' } as never])).toBe('kimi')
  })

  it('does NOT misroute Claude/GPT/Gemini/DeepSeek IDs', () => {
    expect(getModelProvider('claude-sonnet-4-6')).toBe('anthropic')
    expect(getModelProvider('gpt-4o')).toBe('openai')
    expect(getModelProvider('gemini-2.5-flash-preview-05-20')).toBe('google')
    expect(getModelProvider('deepseek-v4-flash')).toBe('deepseek')
  })

  it('does NOT route a local Ollama colon-tag to cloud Qwen (any version punctuation)', () => {
    // A colon is the Ollama `name:tag` separator — these are local regardless of
    // whether the version uses a dot or hyphen. Cloud Qwen ids never have a colon.
    expect(getModelProvider('qwen3:8b')).toBe('local')
    expect(getModelProvider('qwen3.5:8b')).toBe('local')
    expect(getModelProvider('qwen2.5vl:7b')).toBe('local')
  })

  it('every DeepSeek/Qwen/Kimi DEFAULT_MODELS entry prices non-zero via getModelPricing (no $0)', () => {
    // Regression guard: getModelPricing now derives from DEFAULT_MODELS (one
    // source of truth), so a paid model can't silently price at $0 and disable
    // the run cost cap. Asserts these cheap providers are actually priced.
    const cheap = DEFAULT_MODELS.filter(
      (m) => m.provider === 'deepseek' || m.provider === 'qwen' || m.provider === 'kimi',
    )
    expect(cheap.length).toBeGreaterThanOrEqual(6)
    for (const m of cheap) {
      const p = getModelPricing(m.modelId)
      expect(p.inputPer1M, `${m.modelId} input price out of sync with model-config`).toBe(m.costPer1MInput)
      expect(p.outputPer1M, `${m.modelId} output price out of sync with model-config`).toBe(m.costPer1MOutput)
      expect(p.inputPer1M).toBeGreaterThan(0)
      expect(p.outputPer1M).toBeGreaterThan(0)
    }
  })

  it('DEFAULT_MODELS ships tool-capable Qwen + Kimi models cheaper than Sonnet', () => {
    const sonnet = DEFAULT_MODELS.find((m) => m.modelId === 'claude-sonnet-4-6')!
    for (const id of ['qwen-flash', 'qwen-plus', 'kimi-k2.5', 'kimi-k2.6']) {
      const m = DEFAULT_MODELS.find((x) => x.modelId === id)!
      expect(m, `${id} should be registered`).toBeDefined()
      expect(m.supportsTools, `${id} must support tools to drive the agent`).toBe(true)
      expect(m.costPer1MInput).toBeGreaterThan(0)
      expect(m.costPer1MInput).toBeLessThan(sonnet.costPer1MInput)
    }
  })

  it('Qwen + Kimi models are disabled by default (opt-in like other cloud providers)', () => {
    const cheap = DEFAULT_MODELS.filter((m) => m.provider === 'qwen' || m.provider === 'kimi')
    // 2 qwen (flash, plus) + 3 kimi (k2.5, k2.6, k3-flagship) — all opt-in/off by default.
    expect(cheap.length).toBe(5)
    for (const m of cheap) expect(m.enabled, `${m.id} should default to disabled`).toBe(false)
  })
})

describe('Qwen / Kimi adapter registration', () => {
  it('registers both as first-class agent providers', () => {
    expect(getAdapter('qwen')?.id).toBe('qwen')
    expect(getAdapter('kimi')?.id).toBe('kimi')
  })
})
