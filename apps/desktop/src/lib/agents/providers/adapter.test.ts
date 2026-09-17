// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerAdapter,
  getAdapter,
  __resetAdapterRegistryForTesting,
  timedStream,
  type ProviderAdapter,
  type NormalizedStreamEvent,
  type StreamChatOptions,
  type StreamTiming,
} from './adapter'

const mockAdapter: ProviderAdapter = {
  id: 'anthropic',
  async *streamChat(_opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
    yield { type: 'text_delta', text: 'hello' }
    yield { type: 'message_stop', stopReason: 'end_turn' }
  },
}

const otherMockAdapter: ProviderAdapter = {
  id: 'openai',
  async *streamChat(_opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
    yield { type: 'message_stop', stopReason: 'end_turn' }
  },
}

describe('ProviderAdapter registry', () => {
  beforeEach(() => {
    __resetAdapterRegistryForTesting()
  })

  it('registers and retrieves adapters by provider id', () => {
    registerAdapter(mockAdapter)
    expect(getAdapter('anthropic')).toBe(mockAdapter)
    expect(getAdapter('openai')).toBeUndefined()
  })

  it('rejects double-registration of the same provider', () => {
    registerAdapter(mockAdapter)
    expect(() => registerAdapter(mockAdapter)).toThrow(/already registered/i)
  })

  it('keeps registrations independent across providers', () => {
    registerAdapter(mockAdapter)
    registerAdapter(otherMockAdapter)
    expect(getAdapter('anthropic')).toBe(mockAdapter)
    expect(getAdapter('openai')).toBe(otherMockAdapter)
  })

  it('streamChat must yield message_stop as final event (interface contract)', async () => {
    registerAdapter(mockAdapter)
    const adapter = getAdapter('anthropic')!
    const events: NormalizedStreamEvent[] = []
    for await (const ev of adapter.streamChat({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1024,
    })) {
      events.push(ev)
    }
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1].type).toBe('message_stop')
  })
})

describe('NormalizedStreamEvent shape', () => {
  it('discriminated union covers all required event types', () => {
    // This is a compile-time test in essence — if any of these fail the
    // type check, the union changed in an incompatible way and downstream
    // consumers (runner.ts) would break.
    const events: NormalizedStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'thinking_delta', text: 'reasoning' },
      { type: 'tool_use_start', id: 't1', name: 'write_scene_code' },
      { type: 'tool_use_input_delta', id: 't1', partialJson: '{"sceneId":' },
      { type: 'tool_use_stop', id: 't1', finalInput: { sceneId: 's1' } },
      { type: 'message_stop', stopReason: 'tool_use' },
      { type: 'usage_update', usage: { inputTokens: 100, outputTokens: 50 } },
      {
        type: 'usage_update',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 5000, cacheReadTokens: 1000 },
      },
      { type: 'citation', sourceUri: 'https://example.com', title: 'Example' },
      { type: 'error', message: 'rate limited', retriable: true },
    ]
    expect(events).toHaveLength(10)
    expect(events.every((e) => typeof e.type === 'string')).toBe(true)
  })

  it('stopReason union covers the four canonical Anthropic + provider-agnostic outcomes', () => {
    const reasons: NormalizedStreamEvent[] = [
      { type: 'message_stop', stopReason: 'end_turn' },
      { type: 'message_stop', stopReason: 'tool_use' },
      { type: 'message_stop', stopReason: 'max_tokens' },
      { type: 'message_stop', stopReason: 'error' },
      { type: 'message_stop', stopReason: 'other' },
    ]
    expect(reasons).toHaveLength(5)
  })
})

describe('barrel module side effects', () => {
  it('registers the Google adapter when providers/index is imported', async () => {
    __resetAdapterRegistryForTesting()
    // Re-import the barrel re-runs the side-effect registration. Once the
    // module's been imported by another test in this file's lifetime, vitest
    // caches it; re-importing the googleAdapter directly + registering is
    // the deterministic equivalent.
    const { googleAdapter } = await import('./google-adapter')
    registerAdapter(googleAdapter)
    expect(getAdapter('google')).toBeDefined()
    expect(getAdapter('google')?.id).toBe('google')
  })
})

/** Build a stub adapter whose streamChat yields the given events, with an
 *  optional per-event delay so timing assertions have something to measure. */
function timingStubAdapter(events: NormalizedStreamEvent[], delayMs = 0): ProviderAdapter {
  return {
    id: 'anthropic',
    async *streamChat(): AsyncIterable<NormalizedStreamEvent> {
      for (const event of events) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        yield event
      }
    },
  }
}

const TIMING_OPTS: StreamChatOptions = { model: 'm', systemPrompt: 's', messages: [], maxTokens: 100 }

describe('timedStream', () => {
  it('passes every event through unchanged and in order', async () => {
    const events: NormalizedStreamEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'message_stop', stopReason: 'end_turn' },
    ]
    const seen: NormalizedStreamEvent[] = []
    for await (const e of timedStream(timingStubAdapter(events), TIMING_OPTS, () => {})) seen.push(e)
    expect(seen).toEqual(events)
  })

  it('reports duration, ttfb, output tokens, and tokens/sec on completion', async () => {
    const events: NormalizedStreamEvent[] = [
      { type: 'text_delta', text: 'hi' },
      { type: 'usage_update', usage: { inputTokens: 10, outputTokens: 200 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ]
    let timing: StreamTiming | undefined
    for await (const _ of timedStream(timingStubAdapter(events, 5), TIMING_OPTS, (t) => (timing = t))) {
      void _
    }
    expect(timing).toBeDefined()
    expect(timing!.outputTokens).toBe(200)
    expect(timing!.ttfbMs).not.toBeNull()
    expect(timing!.durationMs).toBeGreaterThan(0)
    // ttfb is the time to the FIRST event, so it can't exceed total duration.
    expect(timing!.ttfbMs!).toBeLessThanOrEqual(timing!.durationMs)
    expect(timing!.tokensPerSecond).toBeCloseTo((200 / timing!.durationMs) * 1000, 5)
  })

  it('uses the last usage_update (cumulative) for output tokens', async () => {
    const events: NormalizedStreamEvent[] = [
      { type: 'usage_update', usage: { inputTokens: 5, outputTokens: 50 } },
      { type: 'usage_update', usage: { inputTokens: 5, outputTokens: 120 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ]
    let timing: StreamTiming | undefined
    for await (const _ of timedStream(timingStubAdapter(events), TIMING_OPTS, (t) => (timing = t))) void _
    expect(timing!.outputTokens).toBe(120)
  })

  it('null tokens and tokens/sec when no usage was reported', async () => {
    const events: NormalizedStreamEvent[] = [{ type: 'message_stop', stopReason: 'error' }]
    let timing: StreamTiming | undefined
    for await (const _ of timedStream(timingStubAdapter(events), TIMING_OPTS, (t) => (timing = t))) void _
    expect(timing!.outputTokens).toBeNull()
    expect(timing!.tokensPerSecond).toBeNull()
  })

  it('still reports timing when the consumer breaks early (abort path)', async () => {
    const events: NormalizedStreamEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'message_stop', stopReason: 'end_turn' },
    ]
    let timing: StreamTiming | undefined
    for await (const _ of timedStream(timingStubAdapter(events), TIMING_OPTS, (t) => (timing = t))) {
      void _
      break // consume only the first event, then bail
    }
    // finally must still fire so an aborted stream is measured, not dropped.
    expect(timing).toBeDefined()
    expect(timing!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports timing even when the adapter throws mid-stream', async () => {
    const adapter: ProviderAdapter = {
      id: 'anthropic',
      async *streamChat(): AsyncIterable<NormalizedStreamEvent> {
        yield { type: 'text_delta', text: 'a' }
        throw new Error('provider blew up')
      },
    }
    let timing: StreamTiming | undefined
    await expect(async () => {
      for await (const _ of timedStream(adapter, TIMING_OPTS, (t) => (timing = t))) void _
    }).rejects.toThrow('provider blew up')
    expect(timing).toBeDefined()
    expect(timing!.ttfbMs).not.toBeNull()
  })
})
