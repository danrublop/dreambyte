/**
 * Unit tests for consumeAdapterStream — the provider-agnostic loop body.
 *
 * Drives a scripted fake adapter (emits a fixed NormalizedStreamEvent sequence)
 * and asserts: accumulated text/thinking, tool-use block assembly, authoritative
 * vs reconstructed content, citations, usage, stop reason, and the SSE events
 * emitted along the way.
 */

import { describe, it, expect } from 'vitest'
import { consumeAdapterStream } from './adapter-stream-consumer'
import type { ProviderAdapter, NormalizedStreamEvent, StreamChatOptions } from './providers/adapter'
import type { SSEEvent } from './types'

function fakeAdapter(events: NormalizedStreamEvent[], id: ProviderAdapter['id'] = 'anthropic'): ProviderAdapter {
  return {
    id,
    // eslint-disable-next-line require-yield
    async *streamChat(_opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
      for (const e of events) yield e
    },
  }
}

const OPTS: StreamChatOptions = { model: 'claude-sonnet-4-6', systemPrompt: 'sys', messages: [], maxTokens: 1000 }

function collect() {
  const events: SSEEvent[] = []
  return { emit: (e: SSEEvent) => events.push(e), events }
}

describe('consumeAdapterStream', () => {
  it('accumulates text and emits a token per text_delta', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'usage_update', usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    expect(res.text).toBe('Hello world')
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3 })
    expect(events.filter((e) => e.type === 'token').map((e) => e.token)).toEqual(['Hello ', 'world'])
  })

  it('emits thinking_start once, tokens, then thinking_complete when thinking ends', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'thinking_delta', text: 'let me ' },
        { type: 'thinking_delta', text: 'think' },
        { type: 'text_delta', text: 'answer' },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    expect(res.thinking).toBe('let me think')
    const types = events.map((e) => e.type)
    expect(types).toEqual(['thinking_start', 'thinking_token', 'thinking_token', 'thinking_complete', 'token'])
    const complete = events.find((e) => e.type === 'thinking_complete')
    expect(complete?.fullThinking).toBe('let me think')
  })

  it('emits thinking_complete per thinking block (not cumulative) across two blocks', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'thinking_delta', text: 'first' },
        { type: 'text_delta', text: 'A' },
        { type: 'thinking_delta', text: 'second' },
        { type: 'text_delta', text: 'B' },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    // Cumulative buffer holds both; each thinking_complete carries only its block.
    expect(res.thinking).toBe('firstsecond')
    const completes = events.filter((e) => e.type === 'thinking_complete').map((e) => e.fullThinking)
    expect(completes).toEqual(['first', 'second'])
  })

  it('assembles tool-use blocks from input deltas and emits tool_start', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'tool_use_start', id: 't1', name: 'add_layer' },
        { type: 'tool_use_input_delta', id: 't1', partialJson: '{"sceneId":' },
        { type: 'tool_use_input_delta', id: 't1', partialJson: '"s1"}' },
        { type: 'tool_use_stop', id: 't1', finalInput: { sceneId: 's1' } },
        { type: 'message_stop', stopReason: 'tool_use' },
      ]),
      OPTS,
      emit,
    )
    expect(res.toolUseBlocks).toEqual([{ id: 't1', name: 'add_layer', input: '{"sceneId":"s1"}' }])
    expect(res.stopReason).toBe('tool_use')
    const start = events.find((e) => e.type === 'tool_start')
    expect(start?.toolName).toBe('add_layer')
    expect(start?.toolInput).toEqual({})
  })

  it('seeds tool input from finalInput when no input deltas arrived', async () => {
    const { emit } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'tool_use_start', id: 't1', name: 'set_scene_duration' },
        { type: 'tool_use_stop', id: 't1', finalInput: { sceneId: 's1', duration: 8 } },
        { type: 'message_stop', stopReason: 'tool_use' },
      ]),
      OPTS,
      emit,
    )
    expect(JSON.parse(res.toolUseBlocks[0].input)).toEqual({ sceneId: 's1', duration: 8 })
  })

  it('uses message_complete content verbatim and marks it authoritative', async () => {
    const { emit } = collect()
    const authoritative = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig-abc' },
      { type: 'text', text: 'done' },
    ]
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'thinking_delta', text: 'hmm' },
        { type: 'text_delta', text: 'done' },
        { type: 'message_complete', content: authoritative },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    expect(res.contentIsAuthoritative).toBe(true)
    expect(res.assistantContent).toBe(authoritative)
    // The thinking signature survives the round-trip — the whole point.
    expect((res.assistantContent[0] as { signature?: string }).signature).toBe('sig-abc')
  })

  it('reconstructs content blocks when no message_complete is emitted', async () => {
    const { emit } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter(
        [
          { type: 'text_delta', text: 'hi' },
          { type: 'tool_use_start', id: 't1', name: 'add_layer' },
          { type: 'tool_use_input_delta', id: 't1', partialJson: '{"sceneId":"s1"}' },
          { type: 'tool_use_stop', id: 't1', finalInput: { sceneId: 's1' } },
          { type: 'message_stop', stopReason: 'tool_use' },
        ],
        'google',
      ),
      OPTS,
      emit,
    )
    expect(res.contentIsAuthoritative).toBe(false)
    expect(res.assistantContent).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'add_layer', input: { sceneId: 's1' } },
    ])
  })

  it('collects citations tagged with the adapter provider', async () => {
    const { emit } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter(
        [
          { type: 'citation', sourceUri: 'https://a.com', title: 'A' },
          { type: 'citation', sourceUri: 'https://b.com' },
          { type: 'message_stop', stopReason: 'end_turn' },
        ],
        'google',
      ),
      OPTS,
      emit,
    )
    expect(res.citations).toEqual([
      { url: 'https://a.com', title: 'A', provider: 'google' },
      { url: 'https://b.com', title: undefined, provider: 'google' },
    ])
  })

  it('tags compat-provider citations with the real adapter id, not anthropic', async () => {
    for (const id of ['deepseek', 'qwen', 'kimi'] as const) {
      const { emit } = collect()
      const res = await consumeAdapterStream(
        fakeAdapter([{ type: 'citation', sourceUri: 'https://x.com', title: 'X' }, { type: 'message_stop', stopReason: 'end_turn' }], id),
        OPTS,
        emit,
      )
      // Fails pre-fix: the old ternary collapsed every non-openai/google id to 'anthropic'.
      expect(res.citations).toEqual([{ url: 'https://x.com', title: 'X', provider: id }])
      expect(res.citations[0].provider).not.toBe('anthropic')
    }
  })

  it('renders a server_tool as a tool_start/tool_complete pill without a real tool call', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'server_tool', name: 'web_search', phase: 'start' },
        { type: 'text_delta', text: 'searching...' },
        { type: 'server_tool', name: 'web_search', phase: 'stop' },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    // UI pill emitted...
    expect(events.find((e) => e.type === 'tool_start' && e.toolName === 'web_search')).toBeTruthy()
    expect(events.find((e) => e.type === 'tool_complete' && e.toolName === 'web_search')).toBeTruthy()
    // ...but it is NOT an executable tool call.
    expect(res.toolUseBlocks).toEqual([])
  })

  it('captures a stream error and still closes a dangling thinking block', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'thinking_delta', text: 'partial' },
        { type: 'error', message: 'overloaded', retriable: true },
        { type: 'message_stop', stopReason: 'error' },
      ]),
      OPTS,
      emit,
    )
    expect(res.error).toEqual({ message: 'overloaded', retriable: true })
    expect(res.stopReason).toBe('error')
    // thinking_complete emitted exactly once despite no normal close
    expect(events.filter((e) => e.type === 'thinking_complete')).toHaveLength(1)
  })

  it('reports per-call timing, deriving output tokens from the last usage_update', async () => {
    const { emit } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'text_delta', text: 'hi' },
        { type: 'usage_update', usage: { inputTokens: 10, outputTokens: 42 } },
        { type: 'message_stop', stopReason: 'end_turn' },
      ]),
      OPTS,
      emit,
    )
    expect(res.timing.outputTokens).toBe(42)
    expect(res.timing.ttfbMs).not.toBeNull()
    expect(res.timing.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// F1 regression: a retriable error is the adapter's backoff signal. A turn that
// emits it and then RECOVERS must NOT look like a failure to the runner — it
// finishes with a real stopReason, and the runner only throws on stopReason
// 'error'. The consumer also surfaces the signal as a non-fatal warning.
describe('consumeAdapterStream — retriable backoff vs terminal error (F1)', () => {
  it('a recovered retry finishes with a real stopReason and emits a warning', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'error', message: 'Rate limit hit — retrying in 15s', retriable: true }, // backoff
        { type: 'text_delta', text: 'recovered' },
        { type: 'usage_update', usage: { inputTokens: 5, outputTokens: 2 } },
        { type: 'message_stop', stopReason: 'end_turn' }, // success after retry
      ]),
      OPTS,
      emit,
    )
    // stopReason is the real one — this is what the runner gates the throw on.
    expect(res.stopReason).toBe('end_turn')
    expect(res.text).toBe('recovered')
    // The backoff was surfaced to the user as a warning, not a silent freeze.
    expect(events.find((e) => e.type === 'warning')?.message).toMatch(/retrying/i)
  })

  it('a terminal failure finishes with stopReason error (runner will throw)', async () => {
    const { emit, events } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([
        { type: 'error', message: 'overloaded', retriable: true },
        { type: 'message_stop', stopReason: 'error' }, // adapter gave up
      ]),
      OPTS,
      emit,
    )
    expect(res.stopReason).toBe('error')
    expect(res.error).toMatchObject({ retriable: true })
    expect(events.find((e) => e.type === 'warning')).toBeDefined()
  })

  it('an error with NO terminal message_stop leaves stopReason null + error set (runner gate throws)', async () => {
    // The relocated-F1 case: a stream that errors and ends WITHOUT a clean
    // message_stop. stopReason stays null while error is set — the runner's
    // hardened gate (error && (stopReason === error || stopReason == null))
    // throws on this instead of silently continuing with a broken turn.
    const { emit } = collect()
    const res = await consumeAdapterStream(
      fakeAdapter([{ type: 'error', message: 'stream died', retriable: false }]),
      OPTS,
      emit,
    )
    expect(res.stopReason).toBeNull()
    expect(res.error).toMatchObject({ message: 'stream died', retriable: false })
  })
})
