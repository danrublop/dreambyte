/**
 * Qwen (DashScope) native search wiring: the qwen_web_search marker must flip on
 * `enable_search` + search_options in the request body, and ONLY for that marker (so
 * DeepSeek/Kimi requests through the same shared adapter are unaffected).
 */
import { describe, it, expect, vi } from 'vitest'
import { createOpenAICompatChatAdapter } from './openai-compat-chat-adapter'
import type { StreamChatOptions } from './adapter'

// Minimal OpenAI-SDK-shaped client whose create() captures the request body and
// returns an empty (immediately-complete) stream.
function mockClient(capture: (body: Record<string, unknown>) => void) {
  return {
    chat: {
      completions: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          capture(body)
          return (async function* () {})()
        }),
      },
    },
  } as never
}

async function drain(it: AsyncIterable<unknown>) {
  for await (const _ of it) void _
}

const baseOpts: StreamChatOptions = {
  model: 'qwen-flash',
  systemPrompt: 'sys',
  messages: [],
  maxTokens: 1000,
} as StreamChatOptions

describe('openai-compat adapter — Qwen enable_search', () => {
  it('sets enable_search + search_options when the qwen_web_search marker is present', async () => {
    let body: Record<string, unknown> = {}
    const adapter = createOpenAICompatChatAdapter('qwen', () => mockClient((b) => (body = b)))
    await drain(
      adapter.streamChat({
        ...baseOpts,
        tools: [{ name: 'web_search', type: 'qwen_web_search', description: '', input_schema: { type: 'object' } }],
      } as StreamChatOptions),
    )
    expect(body.enable_search).toBe(true)
    expect(body.search_options).toEqual({ search_strategy: 'agent' })
  })

  it('does NOT set enable_search without the marker (DeepSeek/Kimi path unaffected)', async () => {
    let body: Record<string, unknown> = {}
    const adapter = createOpenAICompatChatAdapter('deepseek', () => mockClient((b) => (body = b)))
    await drain(adapter.streamChat({ ...baseOpts, model: 'deepseek-v4-flash', tools: [] } as StreamChatOptions))
    expect(body.enable_search).toBeUndefined()
    expect(body.search_options).toBeUndefined()
  })

  it('provider boundary: a stray qwen_web_search marker on the DeepSeek adapter is ignored', async () => {
    let body: Record<string, unknown> = {}
    const adapter = createOpenAICompatChatAdapter('deepseek', () => mockClient((b) => (body = b)))
    await drain(
      adapter.streamChat({
        ...baseOpts,
        model: 'deepseek-v4-flash',
        tools: [{ name: 'web_search', type: 'qwen_web_search', description: '', input_schema: { type: 'object' } }],
      } as StreamChatOptions),
    )
    expect(body.enable_search).toBeUndefined() // gated on id === 'qwen', not just the marker
  })
})
