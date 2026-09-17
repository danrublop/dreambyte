// @vitest-environment node
/**
 * Unit tests for the OpenAI adapter. A mock openai client is injected via
 * providers.ts's test seam. Covers the Chat Completions path (text, incremental
 * tool-call args, usage, citations, stop reason) and the Responses API path
 * (output_text deltas + completion usage).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { openaiAdapter } from './openai-adapter'
import { __setProviderClientsForTesting, resetProviderClients } from '../providers'
import { __setRetrySleepForTesting, __resetRetrySleepForTesting } from './retry'
import type { NormalizedStreamEvent, StreamChatOptions } from './adapter'

async function* arrToStream<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockOpenAI(opts: { chat?: any[]; responses?: any[] }) {
  return {
    chat: {
      completions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async (_p: any) => arrToStream(opts.chat ?? []),
      },
    },
    responses: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (_p: any) => arrToStream(opts.responses ?? []),
    },
  }
}

const OPTS: StreamChatOptions = {
  model: 'gpt-4o',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
}

async function collect(adapterOpts: StreamChatOptions): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = []
  for await (const e of openaiAdapter.streamChat(adapterOpts)) out.push(e)
  return out
}

afterEach(() => resetProviderClients())

describe('openaiAdapter — Chat Completions', () => {
  it('streams text, accumulates usage, ends with end_turn', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        chat: [
          { choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        ],
      }),
    })
    const events = await collect(OPTS)
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text)).toEqual(['Hel', 'lo'])
    expect(events.find((e) => e.type === 'usage_update')).toMatchObject({ usage: { inputTokens: 9, outputTokens: 2 } })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('assembles an incremental tool call into start + arg deltas + stop, reports tool_use', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        chat: [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'add_layer' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sceneId":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"s1"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ],
      }),
    })
    const events = await collect(OPTS)
    expect(events.find((e) => e.type === 'tool_use_start')).toMatchObject({ name: 'add_layer', id: 'call_1' })
    const deltas = events.filter((e) => e.type === 'tool_use_input_delta').map((e) => (e as any).partialJson)
    expect(deltas.join('')).toBe('{"sceneId":"s1"}')
    expect(events.find((e) => e.type === 'tool_use_stop')).toMatchObject({ id: 'call_1' })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'tool_use' })
  })

  it('collects url_citation annotations from chat deltas', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        chat: [
          {
            choices: [
              {
                delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A' } }] },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
      }),
    })
    const events = await collect(OPTS)
    expect(events.find((e) => e.type === 'citation')).toEqual({
      type: 'citation',
      sourceUri: 'https://a.com',
      title: 'A',
    })
  })

  it('sends max_tokens (not max_completion_tokens) for non-o-series models', async () => {
    let captured: any
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: async (p: any) => {
              captured = p
              return arrToStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
            },
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    await collect({ ...OPTS, model: 'gpt-4o' })
    expect(captured.max_tokens).toBe(1000)
    expect(captured.max_completion_tokens).toBeUndefined()
  })

  it('sends max_completion_tokens (not max_tokens) for o-series models (o3-mini)', async () => {
    let captured: any
    __setProviderClientsForTesting({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: {
        chat: {
          completions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: async (p: any) => {
              captured = p
              return arrToStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
            },
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    await collect({ ...OPTS, model: 'o3-mini' })
    // Fails pre-fix: the chat body hardcoded max_tokens, which o-series rejects.
    expect(captured.max_completion_tokens).toBe(1000)
    expect(captured.max_tokens).toBeUndefined()
    // temperature must stay omitted (o-series only supports the default).
    expect(captured.temperature).toBeUndefined()
  })

  it('maps finish_reason length to max_tokens', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({ chat: [{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }] }),
    })
    const events = await collect(OPTS)
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'max_tokens' })
  })
})

describe('openaiAdapter — foreign provider_raw tool_result degradation', () => {
  it('answers a claude-origin (provider_raw) tool_result with a role:tool message', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let captured: any = null
    __setProviderClientsForTesting({
      openai: {
        chat: {
          completions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: async (params: any) => {
              captured = params
              return arrToStream([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
            },
          },
        },
        responses: { create: async () => arrToStream([]) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    await collect({
      ...OPTS,
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'provider_raw',
              provider: 'anthropic',
              block: {
                type: 'tool_result',
                tool_use_id: 'call_x',
                content: [
                  { type: 'text', text: 'frame:' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
                ],
              },
            },
          ],
        },
      ],
    })
    const toolMsg = captured.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'call_x', content: 'frame:' })
    // D6: the Chat Completions schema takes a plain string on a role:'tool'
    // message, so the captured pixels follow as a user turn rather than being
    // flattened to "[image omitted]" for a vision-capable model.
    const userMsg = captured.messages.find((m: { role: string }) => m.role === 'user')
    expect(userMsg.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }])
    expect(JSON.stringify(captured.messages)).not.toContain('[image omitted]')
  })
})

describe('openaiAdapter — Responses API', () => {
  it('streams output_text deltas and completion usage', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        responses: [
          { type: 'response.output_text.delta', delta: 'Re' },
          { type: 'response.output_text.delta', delta: 'ply' },
          { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 5 }, output: [] } },
        ],
      }),
    })
    const events = await collect({ ...OPTS, providerOverrides: { useResponsesApi: true } })
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text)).toEqual(['Re', 'ply'])
    expect(events.find((e) => e.type === 'usage_update')).toMatchObject({ usage: { inputTokens: 20, outputTokens: 5 } })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('reports max_tokens when the response is incomplete (truncated)', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        responses: [
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.incomplete',
            response: {
              usage: { input_tokens: 9, output_tokens: 9 },
              incomplete_details: { reason: 'max_output_tokens' },
              output: [],
            },
          },
        ],
      }),
    })
    const events = await collect({ ...OPTS, providerOverrides: { useResponsesApi: true } })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'max_tokens' })
  })

  it('surfaces hosted web search as a server_tool pill (start + stop)', async () => {
    __setProviderClientsForTesting({
      openai: mockOpenAI({
        responses: [
          { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
          { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1' } },
          { type: 'response.output_text.delta', delta: 'done' },
          { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 }, output: [] } },
        ],
      }),
    })
    const events = await collect({ ...OPTS, providerOverrides: { useResponsesApi: true } })
    const pills = events.filter((e) => e.type === 'server_tool')
    expect(pills).toEqual([
      { type: 'server_tool', name: 'web_search', phase: 'start' },
      { type: 'server_tool', name: 'web_search', phase: 'stop' },
    ])
  })
})

describe('openaiAdapter — retry (C2)', () => {
  it('retries a rate-limit error then succeeds', async () => {
    __setRetrySleepForTesting(() => Promise.resolve())
    let calls = 0
    __setProviderClientsForTesting({
      openai: {
        chat: {
          completions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: async (_p: any) => {
              calls++
              if (calls === 1) throw Object.assign(new Error('Rate limit reached'), { status: 429 })
              return arrToStream([
                { choices: [{ delta: { content: 'ok' } }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
              ])
            },
          },
        },
        responses: { create: async () => arrToStream([]) },
      } as any,
    })
    const events = await collect(OPTS)
    __resetRetrySleepForTesting()
    expect(calls).toBe(2)
    expect((events[0] as any).retriable).toBe(true) // backoff signal
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('surfaces a non-retriable 400 immediately without retrying', async () => {
    __setRetrySleepForTesting(() => Promise.resolve())
    let calls = 0
    __setProviderClientsForTesting({
      openai: {
        chat: {
          completions: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            create: async (_p: any) => {
              calls++
              throw Object.assign(new Error('bad request'), { status: 400 })
            },
          },
        },
        responses: { create: async () => arrToStream([]) },
      } as any,
    })
    const events = await collect(OPTS)
    __resetRetrySleepForTesting()
    expect(calls).toBe(1) // no retry on a 400
    expect(events.find((e) => e.type === 'error')).toMatchObject({ retriable: false })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'error' })
  })
})
