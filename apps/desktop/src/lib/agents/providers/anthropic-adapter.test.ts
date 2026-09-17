// @vitest-environment node

/**
 * Tests for the AnthropicAdapter (src/lib/agents/providers/anthropic-adapter.ts).
 *
 * Uses MockAnthropicClient from src/lib/agents/mock-anthropic.ts to inject
 * scripted stream events without hitting the real Anthropic API.
 *
 * The adapter is imported directly (not via the registry) so tests don't need
 * to reset the global registry between runs.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  anthropicAdapter,
  buildSystemBlocks,
  __setBackoffSleepForTesting,
  __resetBackoffSleepForTesting,
} from './anthropic-adapter'
import { MockAnthropicClient, type ScriptedResponse, type ScriptedStreamEvent } from '../mock-anthropic'
import type { NormalizedStreamEvent, StreamChatOptions } from './adapter'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Run the adapter against a scripted mock client, capturing all emitted
 * NormalizedStreamEvents. Returns the events array.
 *
 * Injects the mock client via the `providers.ts` module-level variable by
 * mocking the module — mirrors how runner tests inject test clients, but
 * scoped to the providers module that the adapter imports.
 */
async function runAdapter(
  scripted: ScriptedResponse[],
  opts?: Partial<StreamChatOptions>,
): Promise<NormalizedStreamEvent[]> {
  const mockClient = new MockAnthropicClient(scripted)

  // Patch the lazy-init variable in the providers module
  const providersModule = await import('../providers')
  providersModule.__setProviderClientsForTesting({ anthropic: mockClient as unknown })

  const defaultOpts: StreamChatOptions = {
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 1024,
    ...opts,
  }

  const events: NormalizedStreamEvent[] = []
  for await (const ev of anthropicAdapter.streamChat(defaultOpts)) {
    events.push(ev)
  }

  return events
}

/** Build a minimal Anthropic.Message for use as finalMessage. */
function makeFinalMessage(
  overrides: Partial<{
    stop_reason: string
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
  }> = {},
) {
  return {
    id: 'msg_test',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-sonnet-4-6',
    content: [],
    stop_reason: (overrides.stop_reason ?? 'end_turn') as any,
    stop_sequence: null,
    usage: {
      input_tokens: overrides.inputTokens ?? 100,
      output_tokens: overrides.outputTokens ?? 50,
      cache_creation_input_tokens: overrides.cacheCreation ?? 0,
      cache_read_input_tokens: overrides.cacheRead ?? 0,
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('anthropicAdapter.id', () => {
  it('is "anthropic"', () => {
    expect(anthropicAdapter.id).toBe('anthropic')
  })
})

// ── Simple text response ───────────────────────────────────────────────────

describe('simple text response', () => {
  it('emits text_delta events and message_stop with end_turn', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'end_turn', inputTokens: 10, outputTokens: 5 }),
      },
    ])

    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas).toHaveLength(2)
    expect((textDeltas[0] as any).text).toBe('Hello')
    expect((textDeltas[1] as any).text).toBe(' world')

    const stopEvent = events[events.length - 1]
    expect(stopEvent.type).toBe('message_stop')
    expect((stopEvent as any).stopReason).toBe('end_turn')
  })

  it('emits usage_update before message_stop', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ inputTokens: 20, outputTokens: 8 }),
      },
    ])

    const usageIdx = events.findIndex((e) => e.type === 'usage_update')
    const stopIdx = events.findIndex((e) => e.type === 'message_stop')
    expect(usageIdx).toBeGreaterThanOrEqual(0)
    expect(usageIdx).toBeLessThan(stopIdx)
  })

  it('always ends with message_stop', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage(),
      },
    ])

    expect(events[events.length - 1].type).toBe('message_stop')
  })
})

// ── Tool use ───────────────────────────────────────────────────────────────

describe('tool use', () => {
  it('emits tool_use_start, tool_use_input_delta, tool_use_stop, message_stop with tool_use', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_001', name: 'write_scene_code' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"sceneId":' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"s1","code":"x"}' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'tool_use', inputTokens: 50, outputTokens: 20 }),
      },
    ])

    const start = events.find((e) => e.type === 'tool_use_start') as any
    expect(start).toBeDefined()
    expect(start.id).toBe('tu_001')
    expect(start.name).toBe('write_scene_code')

    const deltas = events.filter((e) => e.type === 'tool_use_input_delta') as any[]
    expect(deltas).toHaveLength(2)
    expect(deltas[0].partialJson).toBe('{"sceneId":')
    expect(deltas[1].partialJson).toBe('"s1","code":"x"}')

    const stop = events.find((e) => e.type === 'tool_use_stop') as any
    expect(stop).toBeDefined()
    expect(stop.id).toBe('tu_001')
    expect(stop.finalInput).toEqual({ sceneId: 's1', code: 'x' })

    const msgStop = events[events.length - 1] as any
    expect(msgStop.type).toBe('message_stop')
    expect(msgStop.stopReason).toBe('tool_use')
  })

  it('handles empty tool input as empty object', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_002', name: 'get_scenes' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'tool_use' }),
      },
    ])

    const stop = events.find((e) => e.type === 'tool_use_stop') as any
    expect(stop).toBeDefined()
    expect(stop.finalInput).toEqual({})
  })

  it('emits error for malformed JSON but does not crash the stream', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_003', name: 'bad_tool' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{broken' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'tool_use' }),
      },
    ])

    const errorEvent = events.find((e) => e.type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.retriable).toBe(false)
    expect(errorEvent.message).toMatch(/bad_tool/)

    // Stream still ends with message_stop
    expect(events[events.length - 1].type).toBe('message_stop')
  })
})

// ── Thinking blocks ────────────────────────────────────────────────────────

describe('thinking blocks', () => {
  it('emits thinking_delta events for each thinking chunk', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'thinking' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ' carefully' } },
          { type: 'content_block_stop' },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ inputTokens: 30, outputTokens: 15 }),
      },
    ])

    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta') as any[]
    expect(thinkingDeltas).toHaveLength(2)
    expect(thinkingDeltas[0].text).toBe('Let me think')
    expect(thinkingDeltas[1].text).toBe(' carefully')

    const textDeltas = events.filter((e) => e.type === 'text_delta') as any[]
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].text).toBe('Answer')
  })
})

// ── Usage parsing ──────────────────────────────────────────────────────────

describe('usage parsing', () => {
  it('emits usage_update with cache tokens from finalMessage', async () => {
    const events = await runAdapter([
      {
        events: [
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 100,
                output_tokens: 0,
                cache_creation_input_tokens: 5000,
                cache_read_input_tokens: 2000,
              },
            },
          },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Cached response' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({
          inputTokens: 100,
          outputTokens: 25,
          cacheCreation: 5000,
          cacheRead: 2000,
        }),
      },
    ])

    const usageEvent = events.find((e) => e.type === 'usage_update') as any
    expect(usageEvent).toBeDefined()
    expect(usageEvent.usage.inputTokens).toBe(100)
    expect(usageEvent.usage.outputTokens).toBe(25)
    expect(usageEvent.usage.cacheCreationTokens).toBe(5000)
    expect(usageEvent.usage.cacheReadTokens).toBe(2000)
  })

  it('omits cacheCreationTokens/cacheReadTokens fields when zero', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ inputTokens: 50, outputTokens: 10 }),
      },
    ])

    const usageEvent = events.find((e) => e.type === 'usage_update') as any
    expect(usageEvent).toBeDefined()
    expect(usageEvent.usage.cacheCreationTokens).toBeUndefined()
    expect(usageEvent.usage.cacheReadTokens).toBeUndefined()
  })
})

// ── Error paths ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('emits retriable error for 429 then retries and succeeds', async () => {
    // Override the sleep function so the exponential back-off resolves
    // instantly instead of waiting 15+ seconds.
    __setBackoffSleepForTesting(() => Promise.resolve())

    const providersModule = await import('../providers')
    let callCount = 0
    const scriptedResponse: ScriptedResponse = {
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } } as ScriptedStreamEvent,
        { type: 'content_block_start', content_block: { type: 'text' } } as ScriptedStreamEvent,
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } as ScriptedStreamEvent,
        { type: 'content_block_stop' } as ScriptedStreamEvent,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        } as ScriptedStreamEvent,
        { type: 'message_stop' } as ScriptedStreamEvent,
      ],
      finalMessage: makeFinalMessage(),
    }
    const successMock = new MockAnthropicClient([scriptedResponse])

    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (params: any) => {
            callCount++
            if (callCount === 1) {
              const err: any = new Error('rate_limit_error')
              err.status = 429
              throw err
            }
            return successMock.messages.stream(params)
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    __resetBackoffSleepForTesting()

    // First event must be the retriable error from the 429 attempt
    expect(events[0].type).toBe('error')
    expect((events[0] as any).retriable).toBe(true)

    // Stream ultimately succeeded
    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.type).toBe('message_stop')
    expect(stopEvent.stopReason).toBe('end_turn')
    expect(callCount).toBe(2)
  })

  it('retries on 429 thrown DURING iteration before any events yielded (M1)', async () => {
    // M1 of the gap-review fix: the SDK surfaces 429s during iteration,
    // not at synchronous stream creation. The retry envelope must cover
    // iteration too, as long as no normalized events have been yielded yet.
    __setBackoffSleepForTesting(() => Promise.resolve())

    const providersModule = await import('../providers')
    let callCount = 0
    const scriptedResponse: ScriptedResponse = {
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } } as ScriptedStreamEvent,
        { type: 'content_block_start', content_block: { type: 'text' } } as ScriptedStreamEvent,
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'recovered' } } as ScriptedStreamEvent,
        { type: 'content_block_stop' } as ScriptedStreamEvent,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        } as ScriptedStreamEvent,
        { type: 'message_stop' } as ScriptedStreamEvent,
      ],
      finalMessage: makeFinalMessage(),
    }
    const successMock = new MockAnthropicClient([scriptedResponse])

    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (params: any) => {
            callCount++
            if (callCount === 1) {
              // Creation succeeds — but iteration throws 429 before yielding.
              const err: any = new Error('rate_limit_error during stream')
              err.status = 429
              return {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      throw err
                    },
                  }
                },
                async finalMessage() {
                  throw err
                },
              }
            }
            return successMock.messages.stream(params)
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    __resetBackoffSleepForTesting()

    // Sequence we expect:
    //  1. retriable error (the 429 backoff signal)
    //  2. text_delta('recovered') from the second attempt
    //  3. usage_update
    //  4. message_stop end_turn
    expect(events[0].type).toBe('error')
    expect((events[0] as any).retriable).toBe(true)
    expect((events[0] as any).message).toMatch(/Rate limit hit/)

    const textDeltas = events.filter((e) => e.type === 'text_delta') as any[]
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].text).toBe('recovered')

    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.type).toBe('message_stop')
    expect(stopEvent.stopReason).toBe('end_turn')

    expect(callCount).toBe(2)
  })

  it('does NOT retry on 429 thrown AFTER events have been yielded (M1 safety)', async () => {
    // Once a text_delta has been shipped to the consumer, we can't "unyield"
    // it — so a 429 mid-stream must propagate as a terminal error rather
    // than triggering retry.
    __setBackoffSleepForTesting(() => Promise.resolve())

    const providersModule = await import('../providers')
    let callCount = 0
    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (_params: any) => {
            callCount++
            const err: any = new Error('rate_limit_error mid-stream')
            err.status = 429
            return {
              [Symbol.asyncIterator]() {
                let step = 0
                return {
                  async next() {
                    step++
                    if (step === 1) {
                      return { done: false, value: { type: 'message_start', message: { usage: { input_tokens: 5 } } } }
                    }
                    if (step === 2) {
                      return {
                        done: false,
                        value: { type: 'content_block_start', content_block: { type: 'text' } },
                      }
                    }
                    if (step === 3) {
                      return {
                        done: false,
                        value: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
                      }
                    }
                    // Now throw 429 AFTER a text_delta has been yielded
                    throw err
                  },
                }
              },
              async finalMessage() {
                throw err
              },
            }
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    __resetBackoffSleepForTesting()

    // Should NOT retry — partial text was already shipped.
    expect(callCount).toBe(1)

    // The partial text_delta was yielded, then a terminal error stop.
    const textDeltas = events.filter((e) => e.type === 'text_delta') as any[]
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].text).toBe('partial')

    const errorEvent = events.find((e) => e.type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.message).toMatch(/stream error/)

    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.type).toBe('message_stop')
    expect(stopEvent.stopReason).toBe('error')
  })

  it('retries on 429 thrown AFTER only thinking has streamed (no committed content)', async () => {
    // Anthropic's per-minute input-token limit frequently 429s after
    // message_start / some thinking has streamed but BEFORE any text or
    // tool_use. The old `!anyYielded` gate made that fatal because a
    // thinking_delta had already been yielded. The `!anyCommittedContent`
    // gate retries here: thinking is not replayed as authoritative output,
    // so re-running the attempt can't duplicate visible content.
    __setBackoffSleepForTesting(() => Promise.resolve())

    const providersModule = await import('../providers')
    let callCount = 0
    const scriptedResponse: ScriptedResponse = {
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } } as ScriptedStreamEvent,
        { type: 'content_block_start', content_block: { type: 'text' } } as ScriptedStreamEvent,
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'recovered' } } as ScriptedStreamEvent,
        { type: 'content_block_stop' } as ScriptedStreamEvent,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        } as ScriptedStreamEvent,
        { type: 'message_stop' } as ScriptedStreamEvent,
      ],
      finalMessage: makeFinalMessage(),
    }
    const successMock = new MockAnthropicClient([scriptedResponse])

    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (params: any) => {
            callCount++
            if (callCount === 1) {
              const err: any = new Error('rate_limit_error after thinking')
              err.status = 429
              return {
                [Symbol.asyncIterator]() {
                  let step = 0
                  return {
                    async next() {
                      step++
                      if (step === 1) {
                        return {
                          done: false,
                          value: { type: 'message_start', message: { usage: { input_tokens: 5 } } },
                        }
                      }
                      if (step === 2) {
                        return {
                          done: false,
                          value: { type: 'content_block_start', content_block: { type: 'thinking' } },
                        }
                      }
                      if (step === 3) {
                        return {
                          done: false,
                          value: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
                        }
                      }
                      // 429 strikes after thinking but before any text/tool_use.
                      throw err
                    },
                  }
                },
                async finalMessage() {
                  throw err
                },
              }
            }
            return successMock.messages.stream(params)
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
    }

    __resetBackoffSleepForTesting()

    // Retried (thinking is safe to discard), then succeeded on the 2nd attempt.
    expect(callCount).toBe(2)

    // A thinking_delta was emitted on the first attempt before the 429...
    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta') as any[]
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(1)

    // ...a retriable error (backoff signal) was surfaced...
    const errorEvent = events.find((e) => e.type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.retriable).toBe(true)

    // ...and the committed text only appears ONCE (no duplication).
    const textDeltas = events.filter((e) => e.type === 'text_delta') as any[]
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].text).toBe('recovered')

    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.type).toBe('message_stop')
    expect(stopEvent.stopReason).toBe('end_turn')
  })

  it('emits non-retriable error for 400 stream creation failure', async () => {
    const providersModule = await import('../providers')
    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: () => {
            const err: any = new Error('invalid_request_error')
            err.status = 400
            throw err
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
      if (ev.type === 'message_stop') break
    }

    const errorEvent = events.find((e) => e.type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.retriable).toBe(false)
  })

  it('emits error with retriable:true for 500 server error during streaming', async () => {
    const providersModule = await import('../providers')
    const streamErr: any = new Error('internal_server_error')
    streamErr.status = 500
    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: () => {
            // Returns an iterable that throws mid-stream
            return {
              [Symbol.asyncIterator]() {
                let called = false
                return {
                  async next() {
                    if (!called) {
                      called = true
                      return { done: false, value: { type: 'message_start', message: { usage: { input_tokens: 1 } } } }
                    }
                    throw streamErr
                  },
                }
              },
              async finalMessage() {
                throw new Error('never')
              },
            }
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      events.push(ev)
      if (ev.type === 'message_stop') break
    }

    const errorEvent = events.find((e) => e.type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.retriable).toBe(true)

    expect(events[events.length - 1].type).toBe('message_stop')
    expect((events[events.length - 1] as any).stopReason).toBe('error')
  })
})

// ── Abort signal placement (regression) ─────────────────────────────────────
//
// Regression guard for the 400 "signal: Extra inputs are not permitted" bug:
// the abort signal must ride in `messages.stream()`'s SECOND request-options
// argument, NOT be merged into the request body params. Putting it in the body
// serializes `signal` into the JSON request and the API rejects the run with a
// 400. The shared MockAnthropicClient only records the first arg, so these
// tests use an inline mock that captures BOTH args (same pattern as the 429
// retry tests above).
describe('abort signal placement (regression — 400 "signal: Extra inputs")', () => {
  function makeOkStream() {
    return {
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        let i = 0
        return {
          async next() {
            if (i < events.length) return { done: false, value: events[i++] }
            return { done: true, value: undefined }
          },
        }
      },
      async finalMessage() {
        return makeFinalMessage()
      },
    }
  }

  it('forwards the abort signal in the request-options arg and NOT in the body params', async () => {
    const providersModule = await import('../providers')
    const captured: { params: any; options: any }[] = []
    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (params: any, options: any) => {
            captured.push({ params, options })
            return makeOkStream()
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    const controller = new AbortController()
    const events: NormalizedStreamEvent[] = []
    for await (const ev of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      abortSignal: controller.signal,
    })) {
      events.push(ev)
    }

    expect(captured).toHaveLength(1)
    // The body params must NOT carry `signal` — that's the bug being guarded.
    expect(captured[0].params).not.toHaveProperty('signal')
    // The signal must ride in the request OPTIONS (second arg) instead.
    expect(captured[0].options).toEqual({ signal: controller.signal })
    // Stream still completes normally.
    expect(events[events.length - 1].type).toBe('message_stop')
  })

  it('passes undefined request options (no signal anywhere) when no abortSignal is given', async () => {
    const providersModule = await import('../providers')
    const captured: { params: any; options: any }[] = []
    providersModule.__setProviderClientsForTesting({
      anthropic: {
        messages: {
          stream: (params: any, options: any) => {
            captured.push({ params, options })
            return makeOkStream()
          },
          create: async () => {
            throw new Error('not used')
          },
        },
      } as unknown,
    })

    for await (const _ of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    })) {
      /* consume all */
    }

    expect(captured).toHaveLength(1)
    expect(captured[0].params).not.toHaveProperty('signal')
    expect(captured[0].options).toBeUndefined()
  })
})

// ── Cache breakpoints ──────────────────────────────────────────────────────

describe('buildSystemBlocks — multi-segment system (cache split)', () => {
  it('emits one block per segment, caching only the segments marked cache:true', () => {
    const blocks = buildSystemBlocks('joined fallback', undefined, [
      { text: 'static persona + rules', cache: true },
      { text: 'dynamic world state' },
    ])
    expect(blocks).toEqual([
      { type: 'text', text: 'static persona + rules', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'dynamic world state' },
    ])
  })

  it('drops empty segments', () => {
    const blocks = buildSystemBlocks('fallback', undefined, [{ text: 'static', cache: true }, { text: '' }])
    expect(blocks).toEqual([{ type: 'text', text: 'static', cache_control: { type: 'ephemeral', ttl: '1h' } }])
  })

  it('falls back to single systemPrompt block (cached via breakpoint) when no segments', () => {
    const blocks = buildSystemBlocks('the whole prompt', [{ position: 'system', type: 'ephemeral' }])
    expect(blocks).toEqual([
      { type: 'text', text: 'the whole prompt', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
  })

  it('falls back to a single uncached block when neither segments nor breakpoint given', () => {
    expect(buildSystemBlocks('plain')).toEqual([{ type: 'text', text: 'plain' }])
  })
})

describe('cache breakpoints', () => {
  it('attaches cache_control to system block when system breakpoint is specified', async () => {
    const mockClient = new MockAnthropicClient([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage(),
      },
    ])

    const providersModule = await import('../providers')
    providersModule.__setProviderClientsForTesting({ anthropic: mockClient as unknown })

    for await (const _ of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Static system prompt',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      cacheBreakpoints: [{ position: 'system', type: 'ephemeral' }],
    })) {
      /* consume all */
    }

    expect(mockClient.requests).toHaveLength(1)
    const params = mockClient.requests[0].params as any
    expect(params.system).toHaveLength(1)
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(params.system[0].text).toBe('Static system prompt')
  })

  it('attaches cache_control to last tool when tool_definitions breakpoint is specified', async () => {
    const mockClient = new MockAnthropicClient([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage(),
      },
    ])

    const providersModule = await import('../providers')
    providersModule.__setProviderClientsForTesting({ anthropic: mockClient as unknown })

    for await (const _ of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      tools: [
        { name: 'tool_a', description: 'First tool', input_schema: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'Last tool', input_schema: { type: 'object', properties: {} } },
      ],
      cacheBreakpoints: [{ position: 'tool_definitions', type: 'ephemeral' }],
    })) {
      /* consume all */
    }

    expect(mockClient.requests).toHaveLength(1)
    const params = mockClient.requests[0].params as any
    expect(params.tools).toHaveLength(2)
    // Only the last tool gets cache_control
    expect(params.tools[0].cache_control).toBeUndefined()
    expect(params.tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('sends no cache_control on system block when no breakpoints specified', async () => {
    const mockClient = new MockAnthropicClient([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage(),
      },
    ])

    const providersModule = await import('../providers')
    providersModule.__setProviderClientsForTesting({ anthropic: mockClient as unknown })

    for await (const _ of anthropicAdapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'No cache',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      // No cacheBreakpoints
    })) {
      /* consume all */
    }

    const params = mockClient.requests[0].params as any
    expect(params.system[0].cache_control).toBeUndefined()
  })
})

// ── Multiple tools in one response ────────────────────────────────────────

describe('multiple tools', () => {
  it('tracks separate tool slots independently', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 80 } } },
          // First tool
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_a', name: 'create_scene' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"name":"Intro"}' } },
          { type: 'content_block_stop' },
          // Second tool
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_b', name: 'set_scene_duration' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"duration":5}' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'tool_use' }),
      },
    ])

    const starts = events.filter((e) => e.type === 'tool_use_start') as any[]
    expect(starts).toHaveLength(2)
    expect(starts[0].id).toBe('tu_a')
    expect(starts[1].id).toBe('tu_b')

    const stops = events.filter((e) => e.type === 'tool_use_stop') as any[]
    expect(stops).toHaveLength(2)
    expect(stops[0].id).toBe('tu_a')
    expect(stops[0].finalInput).toEqual({ name: 'Intro' })
    expect(stops[1].id).toBe('tu_b')
    expect(stops[1].finalInput).toEqual({ duration: 5 })
  })
})

// ── Citations ──────────────────────────────────────────────────────────────

describe('citations', () => {
  it('emits citation events for web_search_tool_result blocks', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 40 } } },
          {
            type: 'content_block_start',
            content_block: {
              type: 'web_search_tool_result',
              tool_use_id: 'ws_001',
              content: [
                { type: 'web_search_result', url: 'https://example.com', title: 'Example Site' },
                { type: 'web_search_result', url: 'https://docs.example.com', title: 'Docs' },
              ],
            },
          },
          { type: 'content_block_stop' },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Based on search...' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage(),
      },
    ])

    const citations = events.filter((e) => e.type === 'citation') as any[]
    expect(citations).toHaveLength(2)
    expect(citations[0].sourceUri).toBe('https://example.com')
    expect(citations[0].title).toBe('Example Site')
    expect(citations[1].sourceUri).toBe('https://docs.example.com')
  })
})

// ── max_tokens stop reason ─────────────────────────────────────────────────

describe('stop reason mapping', () => {
  it('maps max_tokens to normalized max_tokens', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'truncated' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1024 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'max_tokens' }),
      },
    ])

    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.stopReason).toBe('max_tokens')
  })

  it('maps unknown stop reasons to "other"', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'stop_sequence' }),
      },
    ])

    const stopEvent = events[events.length - 1] as any
    expect(stopEvent.stopReason).toBe('other')
  })
})

// R5: native server tools (web_search) run on Anthropic's side. They must be
// surfaced as a non-executable `server_tool` pill, NOT `tool_use_start` — the
// latter makes the consumer add them to executable toolUseBlocks and the runner
// run web_search locally with empty args.
describe('anthropicAdapter — native server_tool_use is NOT executable (R5)', () => {
  it('emits server_tool (start+stop), never tool_use_start, for server_tool_use blocks', async () => {
    const events = await runAdapter([
      {
        events: [
          { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
          { type: 'content_block_start', content_block: { type: 'server_tool_use', id: 'st_1', name: 'web_search' } },
          { type: 'content_block_stop' },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop' },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ] as ScriptedStreamEvent[],
        finalMessage: makeFinalMessage({ stop_reason: 'end_turn', inputTokens: 30, outputTokens: 5 }),
      },
    ])

    // No tool_use_* events for the server tool — it must never reach toolUseBlocks.
    expect(events.some((e) => e.type === 'tool_use_start')).toBe(false)
    expect(events.some((e) => e.type === 'tool_use_stop')).toBe(false)
    // Surfaced as a server_tool pill instead.
    const pills = events.filter((e) => e.type === 'server_tool') as any[]
    expect(pills.map((p) => p.phase)).toEqual(['start', 'stop'])
    expect(pills[0].name).toBe('web_search')
  })
})
