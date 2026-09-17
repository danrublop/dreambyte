// @vitest-environment node
//
// T4 test debt: completeText is the single provider-agnostic dispatch seam for
// all text generation. budget-routing.test.ts covers resolveTextModel + the
// no-key guard + the compat (deepseek/qwen/kimi) branch via __testCallOpenAICompat.
// This locks in the OTHER half: that completeText actually dispatches to the
// resolved provider's client and computes costUsd from MODEL_PRICING + truncated
// from the provider response. The Anthropic branch is the default and the most
// common path (it replaced the deleted Anthropic-only logic in generation.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Partial-mock the providers module: only swap the Anthropic client factory.
vi.mock('../agents/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/providers')>()),
  getAnthropicClient: vi.fn(),
}))

import { completeText } from './generate'
import { getAnthropicClient } from '../agents/providers'

const anthropicReturning = (over: Record<string, unknown> = {}) => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'GENERATED' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
    stop_reason: 'end_turn',
    ...over,
  })
  vi.mocked(getAnthropicClient).mockReturnValue({ messages: { create } } as never)
  return create
}

let savedKey: string | undefined
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  vi.clearAllMocks()
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedKey
})

describe('completeText — Anthropic dispatch + cost/usage mapping', () => {
  it('dispatches to the Anthropic client and returns its text + token counts', async () => {
    const create = anthropicReturning()
    const r = await completeText('claude-sonnet-4-6', 'sys', 'user', 256)
    expect(create).toHaveBeenCalledOnce()
    expect(r.raw).toBe('GENERATED')
    expect(r.inputTokens).toBe(1000)
    expect(r.outputTokens).toBe(500)
  })

  it('computes costUsd from MODEL_PRICING (sonnet = $3/$15 per 1M)', async () => {
    anthropicReturning()
    const r = await completeText('claude-sonnet-4-6', 'sys', 'user', 256)
    // (1000/1e6)*3 + (500/1e6)*15 = 0.003 + 0.0075
    expect(r.costUsd).toBeCloseTo(0.0105, 10)
  })

  it('maps stop_reason="max_tokens" to truncated:true', async () => {
    anthropicReturning({ stop_reason: 'max_tokens' })
    const r = await completeText('claude-sonnet-4-6', 'sys', 'user', 256)
    expect(r.truncated).toBe(true)
  })

  it('returns empty raw when the response has no text block', async () => {
    anthropicReturning({ content: [] })
    const r = await completeText('claude-sonnet-4-6', 'sys', 'user', 256)
    expect(r.raw).toBe('')
  })
})
