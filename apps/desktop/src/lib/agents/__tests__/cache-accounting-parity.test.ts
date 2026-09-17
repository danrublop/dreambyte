/**
 * A1-3 — cache-token accounting parity across providers.
 *
 * Verified during the resilience audit: OpenAI dropped
 * prompt_tokens_details.cached_tokens / input_tokens_details.cached_tokens,
 * Gemini dropped usageMetadata.cachedContentTokenCount, and calculateCost
 * applied Anthropic's cache ratios (0.1×/1.25×) to every provider. Worse,
 * OpenAI/Gemini prompt counts INCLUDE cached tokens (Anthropic's exclude
 * them) — so naive field-mapping would double-count. These tests pin:
 *   - adapters split cached reads out of the prompt count (additive shape)
 *   - calculateCost applies provider-specific cache multipliers
 *   - no double-counting: input + cacheRead === provider's raw prompt total
 */

import { describe, it, expect, afterEach } from 'vitest'
import { openaiAdapter } from '../providers/openai-adapter'
import { googleAdapter } from '../providers/google-adapter'
import { __setProviderClientsForTesting, resetProviderClients } from '../providers'
import type { NormalizedStreamEvent, StreamChatOptions } from '../providers/adapter'
import { calculateCost, getModelPricing } from '../types'
import type { ModelId } from '../types'

afterEach(() => resetProviderClients())

function arrToStream(arr: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of arr) yield c
    },
  }
}

async function collect(
  adapter: { streamChat: (o: StreamChatOptions) => AsyncIterable<NormalizedStreamEvent> },
  opts: StreamChatOptions,
): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = []
  for await (const e of adapter.streamChat(opts)) out.push(e)
  return out
}

const BASE: StreamChatOptions = {
  model: 'gpt-4o',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
}

describe('OpenAI adapter — cached tokens split out (additive shape)', () => {
  it('Chat Completions: prompt_tokens_details.cached_tokens → cacheReadTokens, input reduced', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            create: async () =>
              arrToStream([
                { choices: [{ delta: { content: 'x' } }] },
                {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: {
                    prompt_tokens: 1000, // INCLUDES the cached portion
                    completion_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 800 },
                  },
                },
              ]),
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(openaiAdapter, BASE)
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    expect(usage.usage.inputTokens).toBe(200) // 1000 - 800
    expect(usage.usage.cacheReadTokens).toBe(800)
    // Additive shape: parts reassemble to the provider's raw total.
    expect(usage.usage.inputTokens + usage.usage.cacheReadTokens).toBe(1000)
  })

  it('Responses API: input_tokens_details.cached_tokens → cacheReadTokens, input reduced', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: { completions: { create: async () => arrToStream([]) } },
        responses: {
          create: async () =>
            arrToStream([
              { type: 'response.output_text.delta', delta: 'x' },
              {
                type: 'response.completed',
                response: {
                  usage: { input_tokens: 1000, output_tokens: 5, input_tokens_details: { cached_tokens: 600 } },
                },
              },
            ]),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(openaiAdapter, {
      ...BASE,
      providerOverrides: { useResponsesApi: true },
    } as StreamChatOptions)
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    expect(usage.usage.inputTokens).toBe(400) // 1000 - 600
    expect(usage.usage.cacheReadTokens).toBe(600)
  })

  it('Math.max guard: cached_tokens > prompt_tokens clamps input to 0, never negative', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            create: async () =>
              arrToStream([
                {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 } },
                },
              ]),
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(openaiAdapter, BASE)
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    expect(usage.usage.inputTokens).toBe(0)
    expect(usage.usage.cacheReadTokens).toBe(150)
  })

  it('Chat path accumulates consistently across multiple usage-bearing chunks', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            create: async () =>
              arrToStream([
                {
                  choices: [{ delta: { content: 'a' } }],
                  usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 40 } },
                },
                {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 40 } },
                },
              ]),
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(openaiAdapter, BASE)
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    // += semantics are pre-existing (include_usage emits ONE usage chunk in
    // practice); the invariant pinned here is that input and cacheRead stay
    // in LOCKSTEP — both doubled together, never one without the other.
    expect(usage.usage.inputTokens).toBe(120) // (100-40) × 2
    expect(usage.usage.cacheReadTokens).toBe(80) // 40 × 2
    expect(usage.usage.inputTokens + usage.usage.cacheReadTokens).toBe(200)
  })

  it('Chat Completions without cache details keeps the old behavior', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            create: async () =>
              arrToStream([
                {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 9, completion_tokens: 2 },
                },
              ]),
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(openaiAdapter, BASE)
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    expect(usage.usage.inputTokens).toBe(9)
    expect(usage.usage.cacheReadTokens).toBeUndefined()
  })
})

describe('Google adapter — cachedContentTokenCount split out', () => {
  it('promptTokenCount INCLUDES cached → inputTokens reduced, cacheReadTokens set', async () => {
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      google: {
        models: {
          generateContentStream: async () =>
            arrToStream([
              {
                candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 7, cachedContentTokenCount: 400 },
              },
            ]),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    const events = await collect(googleAdapter, { ...BASE, model: 'gemini-2.5-flash-preview-05-20' })
    const usage = events.find((e) => e.type === 'usage_update') as unknown as { usage: Record<string, number> }
    expect(usage.usage.inputTokens).toBe(100) // 500 - 400
    expect(usage.usage.cacheReadTokens).toBe(400)
  })
})

describe('calculateCost — provider-aware cache multipliers', () => {
  it('Anthropic: reads at 10%, creation at 125% (unchanged behavior)', () => {
    const id = 'claude-sonnet-4-6' as ModelId
    const { inputPer1M } = getModelPricing(id)
    expect(inputPer1M).toBeGreaterThan(0)
    const cost = calculateCost(id, 0, 0, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(inputPer1M * 1.25 + inputPer1M * 0.1, 6)
  })

  it('OpenAI: cached reads bill at 50% of input, no creation surcharge', () => {
    const id = 'gpt-4o' as ModelId
    const { inputPer1M } = getModelPricing(id)
    const cost = calculateCost(id, 0, 0, 0, 1_000_000)
    expect(cost).toBeCloseTo(inputPer1M * 0.5, 6)
    // A cached-heavy prompt is CHEAPER than the same tokens uncached —
    // previously cached tokens billed at full input rate (overcount).
    expect(calculateCost(id, 200, 0, 0, 800)).toBeLessThan(calculateCost(id, 1000, 0, 0, 0))
  })

  it('Gemini: cached reads bill at 25% of input', () => {
    const id = 'gemini-2.5-flash-preview-05-20' as ModelId
    const { inputPer1M } = getModelPricing(id)
    expect(calculateCost(id, 0, 0, 0, 1_000_000)).toBeCloseTo(inputPer1M * 0.25, 6)
  })

  it('DeepSeek: cached reads bill at 2% of input (published 0.0028/0.14 ratio)', () => {
    const id = 'deepseek-v4-flash' as ModelId
    const { inputPer1M } = getModelPricing(id)
    expect(inputPer1M).toBeGreaterThan(0)
    expect(calculateCost(id, 0, 0, 0, 1_000_000)).toBeCloseTo(inputPer1M * 0.02, 6)
    // Cached-heavy DeepSeek prompt is far cheaper than the same tokens uncached.
    expect(calculateCost(id, 200, 0, 0, 800)).toBeLessThan(calculateCost(id, 1000, 0, 0, 0))
  })

  it('Qwen/Kimi: cached reads bill at each provider’s PUBLISHED hit rate, not a 50% guess', () => {
    // Both used to inherit a 0.5 placeholder, which over-billed the cached share
    // — and Kimi is the default `auto` model, so its cost chip read ~3x high.
    // qwen-plus: $0.08 hit / $0.40 input. kimi-k2.6: $0.16 hit / $0.95 miss.
    expect(calculateCost('qwen-plus' as ModelId, 0, 0, 0, 1_000_000)).toBeCloseTo(
      getModelPricing('qwen-plus' as ModelId).inputPer1M * 0.2,
      6,
    )
    expect(calculateCost('kimi-k2.6' as ModelId, 0, 0, 0, 1_000_000)).toBeCloseTo(
      getModelPricing('kimi-k2.6' as ModelId).inputPer1M * 0.17,
      6,
    )
  })

  it('unknown/local models stay free', () => {
    expect(calculateCost('totally-unknown-model' as ModelId, 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBe(0)
  })
})
