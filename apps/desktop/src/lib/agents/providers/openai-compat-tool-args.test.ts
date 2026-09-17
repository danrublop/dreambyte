// @vitest-environment node
//
// Wave-2 P1-6: compat chat adapters must carry authoritative tool arguments in
// tool_use_stop.finalInput (parsed from the accumulated `arguments` stream),
// not a blind {}. Repro for the dead-end: a provider that streams `arguments`
// in a chunk BEFORE the tool `name` makes the input_delta fire before
// tool_use_start, so the consumer drops it (unmapped id) and the tool would
// dispatch with {} → stuck_invalid_args. The adapter's own accumulator + the
// consumer's finalInput-preference recover it.

import { describe, it, expect } from 'vitest'
import { createOpenAICompatChatAdapter } from './openai-compat-chat-adapter'
import { parseToolArgs } from './openai-adapter'
import type { StreamChatOptions } from './adapter'
import { consumeAdapterStream } from '../adapter-stream-consumer'

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

const toolUseInput = (blocks: unknown[]): Record<string, unknown> | undefined =>
  (blocks.find((b) => (b as { type?: string }).type === 'tool_use') as { input?: Record<string, unknown> } | undefined)
    ?.input

describe('parseToolArgs', () => {
  it('parses a valid object, rejects arrays/scalars/garbage to {}', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArgs('  ')).toEqual({})
    expect(parseToolArgs('')).toEqual({})
    expect(parseToolArgs('[1,2]')).toEqual({})
    expect(parseToolArgs('not json')).toEqual({})
    expect(parseToolArgs('{"a":')).toEqual({}) // truncated
  })
})

describe('compat adapter — tool_use_stop carries parsed finalInput', () => {
  it('args streamed across multiple chunks → finalInput is the parsed object', async () => {
    const client = fakeClient([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'foo', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const stop = events.find((e) => e.type === 'tool_use_stop')
    expect(stop?.finalInput).toEqual({ a: 1 })
  })

  it('REPRO: arguments arrive before the tool name → finalInput still parsed (not {})', async () => {
    const client = fakeClient([
      // arguments first, NO name yet (tool_use_start cannot fire)
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { arguments: '{"a":1}' } }] } }] },
      // name arrives in a later chunk
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'foo' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const events = await collect(a.streamChat(baseOpts()))
    const stop = events.find((e) => e.type === 'tool_use_stop')
    expect(stop?.finalInput).toEqual({ a: 1 })
  })
})

describe('end-to-end: consumer recovers tool input via finalInput', () => {
  it('normal streamed args → tool_use block input is correct (no regression)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'foo', arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const turn = await consumeAdapterStream(a, baseOpts(), () => {})
    expect(toolUseInput(turn.assistantContent as unknown[])).toEqual({ a: 1 })
  })

  it('REPRO end-to-end: args-before-name no longer dispatches the tool with {}', async () => {
    const client = fakeClient([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'foo' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const turn = await consumeAdapterStream(a, baseOpts(), () => {})
    // Before the fix this was {} → stuck_invalid_args.
    expect(toolUseInput(turn.assistantContent as unknown[])).toEqual({ a: 1 })
  })

  it('a tool genuinely called with no arguments still yields {} (not a false recovery)', async () => {
    const client = fakeClient([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'noargs', arguments: '' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const a = createOpenAICompatChatAdapter('deepseek', () => client)
    const turn = await consumeAdapterStream(a, baseOpts(), () => {})
    expect(toolUseInput(turn.assistantContent as unknown[])).toEqual({})
  })
})
