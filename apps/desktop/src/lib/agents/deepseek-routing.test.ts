// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { getModelProvider } from './types'
import { DEFAULT_MODELS } from './model-config'

describe('DeepSeek provider routing', () => {
  it('routes deepseek-* model IDs to deepseek provider via prefix', () => {
    expect(getModelProvider('deepseek-chat')).toBe('deepseek')
    expect(getModelProvider('deepseek-reasoner')).toBe('deepseek')
  })

  it('routes via modelConfigs lookup when provider field is "deepseek"', () => {
    expect(
      getModelProvider('custom-model-id', [
        { id: 'custom-model-id', modelId: 'custom-model-id', provider: 'deepseek' } as any,
      ]),
    ).toBe('deepseek')
  })

  it('does NOT route Claude/GPT/Gemini IDs to DeepSeek', () => {
    expect(getModelProvider('claude-sonnet-4-6')).toBe('anthropic')
    expect(getModelProvider('gpt-4o')).toBe('openai')
    expect(getModelProvider('gemini-2.5-flash-preview-05-20')).toBe('google')
  })

  it('DEFAULT_MODELS includes the DeepSeek V4 models with non-zero pricing', () => {
    const ds = DEFAULT_MODELS.filter((m) => m.provider === 'deepseek')
    expect(ds.length).toBeGreaterThanOrEqual(2)
    const chat = ds.find((m) => m.modelId === 'deepseek-v4-flash')
    expect(chat).toBeDefined()
    expect(chat!.costPer1MInput).toBeGreaterThan(0)
    expect(chat!.costPer1MOutput).toBeGreaterThan(0)
    // DeepSeek must be cheaper than Sonnet on both axes — that's the point
    const sonnet = DEFAULT_MODELS.find((m) => m.modelId === 'claude-sonnet-4-6')!
    expect(chat!.costPer1MInput).toBeLessThan(sonnet.costPer1MInput)
    expect(chat!.costPer1MOutput).toBeLessThan(sonnet.costPer1MOutput)
  })

  it('DeepSeek models are disabled by default (opt-in)', () => {
    const ds = DEFAULT_MODELS.filter((m) => m.provider === 'deepseek')
    for (const m of ds) {
      expect(m.enabled, `${m.id} should default to disabled`).toBe(false)
    }
  })

  it('DeepSeek V4 Flash is budget tier; V4 Pro is balanced', () => {
    const chat = DEFAULT_MODELS.find((m) => m.modelId === 'deepseek-v4-flash')!
    const reasoner = DEFAULT_MODELS.find((m) => m.modelId === 'deepseek-v4-pro')!
    expect(chat.tier).toBe('budget')
    expect(reasoner.tier).toBe('balanced')
  })
})
