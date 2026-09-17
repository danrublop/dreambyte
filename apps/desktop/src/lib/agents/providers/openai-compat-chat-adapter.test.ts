// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  createOpenAICompatChatAdapter,
  deepseekThinkingOverride,
  kimiK3ReasoningEffort,
} from './openai-compat-chat-adapter'
import { getAdapter } from './index'
import type { StreamChatOptions } from './adapter'
import { consumeAdapterStream } from '../adapter-stream-consumer'
import { toCanonicalMessages, toAnthropicMessages } from '../canonical-messages'

// Minimal fake OpenAI client: chat.completions.create → async iterable of chunks.
function fakeClient(chunks: Record<string, unknown>[]) {
  return {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            for (const c of chunks) yield c
          })(),
      },
    },
  } as never
}

const baseOpts = (): StreamChatOptions => ({
  model: 'deepseek-v4-flash',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
  tools: [],
  maxTokens: 256,
})

async function collect(it: AsyncIterable<{ type: string; [k: string]: unknown }>) {
  const out: { type: string; [k: string]: unknown }[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('createOpenAICompatChatAdapter', () => {
  it('uses the injected client + reports the given id', () => {
    const a = createOpenAICompatChatAdapter('deepseek', () => fakeClient([]))
    expect(a.id).toBe('deepseek')
  })

  it('streams text deltas, usage, and a stop event', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('hello world')
    const stop = events.find((e) => e.type === 'message_stop')
    expect(stop?.stopReason).toBe('end_turn')
    const usage = events.find((e) => e.type === 'usage_update')
    expect((usage?.usage as { inputTokens: number })?.inputTokens).toBe(10)
  })

  it('surfaces reasoning_content (DeepSeek reasoner / Qwen3 / Kimi thinking) as thinking deltas', async () => {
    const client = fakeClient([
      { choices: [{ delta: { reasoning_content: 'let me think... ' } }] },
      { choices: [{ delta: { reasoning_content: 'ok.' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const thinking = events
      .filter((e) => e.type === 'thinking_delta')
      .map((e) => e.text)
      .join('')
    expect(thinking).toBe('let me think... ok.')
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('answer')
  })

  it('surfaces a tool call as start + stop', async () => {
    const client = fakeClient([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'foo', arguments: '{"a":1}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(events.find((e) => e.type === 'tool_use_start')?.name).toBe('foo')
    expect(events.some((e) => e.type === 'tool_use_stop')).toBe(true)
    expect(events.find((e) => e.type === 'message_stop')?.stopReason).toBe('tool_use')
  })

  it('retries the initial request on a 429, then streams normally', async () => {
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++
            if (calls === 1) {
              const err = new Error('rate limited') as Error & { status?: number }
              err.status = 429
              throw err
            }
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as never
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(calls).toBe(2) // one 429, one success
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('ok')
    expect(events.find((e) => e.type === 'message_stop')?.stopReason).toBe('end_turn')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  }, 10000)

  it('does NOT retry a 400 (non-retriable) — degrades to error immediately', async () => {
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++
            const err = new Error('bad request') as Error & { status?: number }
            err.status = 400
            throw err
          },
        },
      },
    } as never
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(calls).toBe(1) // no retry on 400
    expect(events.find((e) => e.type === 'error')?.message).toMatch(/bad request/)
  })

  it('degrades to an error event on a non-retriable thrown request', async () => {
    // 400 = client error, not retried (a status-less error WOULD now be retried),
    // so this degrades immediately to the error-event path.
    const client = {
      chat: {
        completions: {
          create: async () => {
            const err = new Error('boom') as Error & { status?: number }
            err.status = 400
            throw err
          },
        },
      },
    } as never
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(events.find((e) => e.type === 'error')?.message).toMatch(/deepseek stream error: boom/)
    expect(events.find((e) => e.type === 'message_stop')?.stopReason).toBe('error')
  })
})

describe('mid-stream retry (terminated / transient drop before committed content)', () => {
  // Client whose create() returns a new stream per attempt (from `streams`), tracking calls.
  function seqClient(streams: Array<() => AsyncIterable<Record<string, unknown>>>) {
    const state = { calls: 0 }
    const client = {
      chat: { completions: { create: async () => streams[state.calls++]() } },
    } as never
    return { client, state }
  }
  const throwsAfterThinking = () =>
    (async function* () {
      yield { choices: [{ delta: { reasoning_content: 'thinking…' } }] }
      throw new Error('terminated') // no .status → retriable transient drop
    })()
  const throwsAfterText = () =>
    (async function* () {
      yield { choices: [{ delta: { content: 'partial ' } }] } // COMMITTED content
      throw new Error('terminated')
    })()
  const goodStream = () =>
    (async function* () {
      yield { choices: [{ delta: { content: 'built' } }] }
      yield { choices: [{ finish_reason: 'stop' }] }
    })()

  it('RETRIES a drop that happens before any committed content, and recovers', async () => {
    const { client, state } = seqClient([throwsAfterThinking, goodStream])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    // One retriable "retrying" signal (the consumer resets on this), then a clean success.
    expect(events.filter((e) => e.type === 'error' && e.retriable === true)).toHaveLength(1)
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'built')).toBe(true)
    const lastStop = events.filter((e) => e.type === 'message_stop').pop()
    expect(lastStop?.stopReason).not.toBe('error') // recovered, not a terminal failure
    expect(state.calls).toBe(2) // opened the stream twice
  }, 8000)

  it('does NOT retry once committed content (a text token) has streamed — terminal', async () => {
    const { client, state } = seqClient([throwsAfterText, goodStream])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'partial ')).toBe(true)
    expect(events.filter((e) => e.type === 'message_stop').pop()?.stopReason).toBe('error')
    expect(state.calls).toBe(1) // NOT retried — a partial answer can't be replayed
  })

  it('does NOT retry a non-retriable open error (e.g. 401)', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            const e = new Error('unauthorized') as Error & { status?: number }
            e.status = 401
            throw e
          },
        },
      },
    } as never
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    expect(events.find((e) => e.type === 'error')?.retriable).toBe(false)
    expect(events.filter((e) => e.type === 'message_stop').pop()?.stopReason).toBe('error')
  })
})

describe('DeepSeek adapter registration', () => {
  it('is registered as a first-class agent provider', () => {
    expect(getAdapter('deepseek')?.id).toBe('deepseek')
  })

  it('`local` is registered too — it is the CATCH-ALL for unrecognised model ids', () => {
    // Without this it fell to the legacy runner branch: no 429 handling, and
    // prompt_tokens counted WITH cached tokens (billing cache hits at full input
    // price). getModelProvider routes anything it doesn't recognise to 'local',
    // so that branch was reachable by far more than Ollama.
    expect(getAdapter('local')?.id).toBe('local')
  })

  it('the local adapter honors a per-call endpoint (the registry is built once, configs are per-run)', async () => {
    let seen: StreamChatOptions | undefined
    const client = fakeClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('local', (o) => {
      seen = o
      return client
    })
    await collect(a.streamChat({ ...baseOpts(), providerOverrides: { endpoint: 'http://box:11434' } }))
    expect(seen?.providerOverrides?.endpoint).toBe('http://box:11434')
  })
})

// Fake client that records every request body it receives.
function capturingClient(chunks: Record<string, unknown>[]) {
  const bodies: Record<string, unknown>[] = []
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body)
          return (async function* () {
            for (const c of chunks) yield c
          })()
        },
      },
    },
  } as never
  return { client, bodies }
}

describe('DeepSeek thinking override (eng-review 1C kill switch)', () => {
  const override = { providerOverrides: { thinking: { type: 'disabled' } } }

  it('passes the thinking param through for deepseek', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    await collect(a.streamChat({ ...baseOpts(), ...override }))
    expect(bodies[0].thinking).toEqual({ type: 'disabled' })
  })

  it('sends NO thinking param without an override (provider default applies)', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    await collect(a.streamChat(baseOpts()))
    expect(bodies[0]).not.toHaveProperty('thinking')
  })

  it('Qwen never receives a thinking param (thinking off by default)', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('qwen', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'qwen-plus', ...override }))
    expect(bodies[0]).not.toHaveProperty('thinking')
  })

  it('Kimi defaults to thinking enabled + keep:all (K2.6 multi-turn tool replay)', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('kimi', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'kimi-k2.6' }))
    expect(bodies[0].thinking).toEqual({ type: 'enabled', keep: 'all' })
  })

  it('Kimi honors an explicit disable (kill switch)', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('kimi', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'kimi-k2.6', ...override }))
    expect(bodies[0].thinking).toEqual({ type: 'disabled' })
  })

  it('Kimi K3 sends top-level reasoning_effort and NO K2.x thinking param', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('kimi', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'kimi-k3', providerOverrides: { reasoningEffort: 'low' } }))
    expect(bodies[0].reasoning_effort).toBe('low')
    expect(bodies[0]).not.toHaveProperty('thinking') // K3 rejects the K2.x thinking param
  })

  it('Kimi K3 defaults reasoning_effort to high when the runner sets no override', async () => {
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('kimi', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'kimi-k3' }))
    expect(bodies[0].reasoning_effort).toBe('high')
    expect(bodies[0]).not.toHaveProperty('thinking')
  })
})

describe('kimiK3ReasoningEffort mapping', () => {
  it('maps thinkingMode → K3 reasoning_effort (off→low, adaptive→high, deep→max)', () => {
    expect(kimiK3ReasoningEffort('off')).toBe('low')
    expect(kimiK3ReasoningEffort('adaptive')).toBe('high')
    expect(kimiK3ReasoningEffort('deep')).toBe('max')
    expect(kimiK3ReasoningEffort(undefined)).toBe('high') // default when unset
  })
})

describe('Compat reasoning replay (CRITICAL regression — the 400 class; DeepSeek/Qwen/Kimi)', () => {
  /**
   * The full production round-trip: turn 1 streams reasoning + a tool call,
   * the consumer reconstructs history blocks, the runner replays history via
   * toCanonicalMessages, and turn 2's request body MUST carry the assistant's
   * reasoning_content — these APIs 400 tool-call conversations without it
   * (DeepSeek V4, Qwen3-thinking, Kimi K2.6 all enforce the same rule).
   */
  async function runTurn1(provider: 'deepseek' | 'qwen' | 'kimi') {
    const turn1Client = fakeClient([
      { choices: [{ delta: { reasoning_content: 'plan: call foo' } }] },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'foo', arguments: '{"a":1}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter(provider, () => turn1Client)
    return consumeAdapterStream(a, baseOpts(), () => {})
  }

  for (const provider of ['deepseek', 'qwen', 'kimi'] as const) {
    it(`[${provider}] turn 1 stores reasoning as a provider-tagged compat_reasoning block`, async () => {
      const turn = await runTurn1(provider)
      expect(turn.assistantContent).toContainEqual({
        type: 'compat_reasoning',
        provider,
        reasoning_content: 'plan: call foo',
      })
      expect(turn.assistantContent.some((b) => (b as { type?: string }).type === 'thinking')).toBe(false)
    })

    it(`[${provider}] turn 2 request body replays reasoning_content on the assistant tool-call turn`, async () => {
      const turn = await runTurn1(provider)
      const history = [
        { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant' as const, content: turn.assistantContent as never },
        { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
      ]
      const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }])
      const a2 = createOpenAICompatChatAdapter(provider, () => client)
      await collect(a2.streamChat({ ...baseOpts(), messages: toCanonicalMessages(history as never) }))

      const assistant = (bodies[0].messages as Record<string, unknown>[]).find((m) => m.role === 'assistant')
      expect(assistant?.reasoning_content).toBe('plan: call foo')
      expect(Array.isArray(assistant?.tool_calls)).toBe(true)
      const toolMsg = (bodies[0].messages as Record<string, unknown>[]).find((m) => m.role === 'tool')
      expect(toolMsg?.tool_call_id).toBe('t1')
    })

    it(`[${provider}] compat_reasoning is skipped by toAnthropicMessages (switch to Claude must not 400)`, async () => {
      const turn = await runTurn1(provider)
      const history = [{ role: 'assistant' as const, content: turn.assistantContent as never }]
      const anthropic = toAnthropicMessages(toCanonicalMessages(history as never))
      expect(JSON.stringify(anthropic)).not.toContain('compat_reasoning')
      expect(JSON.stringify(anthropic)).not.toContain('plan: call foo')
    })
  }

  it('a DIFFERENT compat provider does NOT replay another provider tag (deepseek reasoning not sent to a qwen request)', async () => {
    const turn = await runTurn1('deepseek')
    const history = [
      { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant' as const, content: turn.assistantContent as never },
    ]
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('qwen', () => client)
    await collect(a.streamChat({ ...baseOpts(), model: 'qwen-plus', messages: toCanonicalMessages(history as never) }))
    const assistant = (bodies[0].messages as Record<string, unknown>[]).find((m) => m.role === 'assistant')
    expect(assistant).not.toHaveProperty('reasoning_content') // deepseek-tagged block, qwen request → dropped
  })

  it('kill switch: thinking disabled STILL replays stored reasoning (off ≠ strip history)', async () => {
    const turn = await runTurn1('deepseek')
    const history = [
      { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant' as const, content: turn.assistantContent as never },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
    ]
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }])
    const a2 = createOpenAICompatChatAdapter('deepseek', () => client)
    await collect(
      a2.streamChat({
        ...baseOpts(),
        messages: toCanonicalMessages(history as never),
        providerOverrides: { thinking: { type: 'disabled' } },
      }),
    )
    expect(bodies[0].thinking).toEqual({ type: 'disabled' })
    const assistant = (bodies[0].messages as Record<string, unknown>[]).find((m) => m.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('plan: call foo')
  })

  it('foreign Anthropic thinking blocks are NOT replayed into a deepseek request', async () => {
    const history = [
      { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 'claude reasoning', signature: 'sig123' },
          { type: 'text', text: 'claude answer' },
        ] as never,
      },
    ]
    const { client, bodies } = capturingClient([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    await collect(a.streamChat({ ...baseOpts(), messages: toCanonicalMessages(history as never) }))
    const assistant = (bodies[0].messages as Record<string, unknown>[]).find((m) => m.role === 'assistant')
    expect(assistant).not.toHaveProperty('reasoning_content')
    expect(JSON.stringify(bodies[0].messages)).not.toContain('claude reasoning')
  })

  it('a non-thinking response stores no reasoning block at all', async () => {
    const client = fakeClient([{ choices: [{ delta: { content: 'plain' }, finish_reason: 'stop' }] }])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const turn = await consumeAdapterStream(a, baseOpts(), () => {})
    expect(turn.assistantContent.some((b) => (b as { type?: string }).type === 'compat_reasoning')).toBe(false)
  })
})

describe('DeepSeek cache-hit usage split (8A)', () => {
  it('splits prompt_cache_hit_tokens out of prompt_tokens (additive semantics)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 5 }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
    }
    expect(usage.inputTokens).toBe(20)
    expect(usage.cacheReadTokens).toBe(80)
    expect(usage.outputTokens).toBe(5)
  })

  it('reads OpenAI-style prompt_tokens_details.cached_tokens (qwen/kimi shape)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 2 }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('qwen', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as {
      inputTokens: number
      cacheReadTokens?: number
    }
    expect(usage.inputTokens).toBe(20)
    expect(usage.cacheReadTokens).toBe(30)
  })

  it('no cached tokens → no cacheReadTokens field (unchanged shape)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as Record<string, unknown>
    expect(usage.inputTokens).toBe(10)
    expect(usage).not.toHaveProperty('cacheReadTokens')
  })

  it('clamps cached > prompt_tokens (provider-trust guard): inputTokens floors to 0', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 150, completion_tokens: 2 }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as {
      inputTokens: number
      cacheReadTokens?: number
    }
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheReadTokens).toBe(100) // clamped to prompt, not the bogus 150
  })

  it('coerces non-numeric usage to 0 (no NaN into the cost ledger)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 'bad', completion_tokens: null }, choices: [] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as { inputTokens: number; outputTokens: number }
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(Number.isNaN(usage.inputTokens)).toBe(false)
  })

  it('cumulative usage on multiple chunks is last-wins, not summed', async () => {
    const client = fakeClient([
      { usage: { prompt_tokens: 50, completion_tokens: 1 }, choices: [{ delta: { content: 'a' } }] },
      {
        usage: { prompt_tokens: 50, completion_tokens: 4 },
        choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }],
      },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const usage = events.find((e) => e.type === 'usage_update')?.usage as { inputTokens: number; outputTokens: number }
    expect(usage.inputTokens).toBe(50) // not 100
    expect(usage.outputTokens).toBe(4)
  })
})

describe('deepseekThinkingOverride (runner mapping)', () => {
  it("'off' maps to disabled (kill switch)", () => {
    expect(deepseekThinkingOverride('off')).toEqual({ thinking: { type: 'disabled' } })
  })
  it('adaptive/deep/undefined map to enabled', () => {
    expect(deepseekThinkingOverride('adaptive')).toEqual({ thinking: { type: 'enabled' } })
    expect(deepseekThinkingOverride('deep')).toEqual({ thinking: { type: 'enabled' } })
    expect(deepseekThinkingOverride(undefined)).toEqual({ thinking: { type: 'enabled' } })
  })
})

describe('single-chunk tool arguments (outside-voice finding 9)', () => {
  it('parses tool input delivered whole in one delta chunk', async () => {
    const client = fakeClient([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 't9', function: { name: 'add_scene', arguments: '{"title":"intro","duration":5}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const turn = await consumeAdapterStream(a, baseOpts(), () => {})
    expect(turn.toolUseBlocks).toHaveLength(1)
    expect(JSON.parse(turn.toolUseBlocks[0].input)).toEqual({ title: 'intro', duration: 5 })
    const toolBlock = turn.assistantContent.find((b) => (b as { type?: string }).type === 'tool_use') as {
      input: Record<string, unknown>
    }
    expect(toolBlock.input).toEqual({ title: 'intro', duration: 5 })
  })
})
