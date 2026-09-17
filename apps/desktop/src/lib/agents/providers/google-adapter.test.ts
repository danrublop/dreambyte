// @vitest-environment node
/**
 * Unit tests for the Google Gemini adapter. A mock @google/genai client is
 * injected via providers.ts's test seam; we assert the normalized event stream
 * produced for text, function calls, grounding citations, usage, and errors.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { googleAdapter } from './google-adapter'
import { __setProviderClientsForTesting, resetProviderClients } from '../providers'
import { __setRetrySleepForTesting, __resetRetrySleepForTesting } from './retry'
import type { NormalizedStreamEvent, StreamChatOptions } from './adapter'

async function* arrToStream<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockGoogle(chunks: any[], onParams?: (p: any) => void) {
  return {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateContentStream: async (params: any) => {
        onParams?.(params)
        return arrToStream(chunks)
      },
    },
  }
}

const OPTS: StreamChatOptions = {
  model: 'gemini-2.5-flash',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
}

async function collect(adapterOpts: StreamChatOptions): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = []
  for await (const e of googleAdapter.streamChat(adapterOpts)) out.push(e)
  return out
}

afterEach(() => resetProviderClients())

describe('googleAdapter', () => {
  it('streams text deltas, then cumulative usage and end_turn stop', async () => {
    __setProviderClientsForTesting({
      google: mockGoogle([
        { text: 'Hello ' },
        { text: 'world', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } },
        { candidates: [{ finishReason: 'STOP' }] },
      ]),
    })
    const events = await collect(OPTS)
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text)).toEqual(['Hello ', 'world'])
    expect(events.find((e) => e.type === 'usage_update')).toMatchObject({ usage: { inputTokens: 12, outputTokens: 4 } })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('emits tool_use_start + tool_use_stop for a function call and reports tool_use stop', async () => {
    __setProviderClientsForTesting({
      google: mockGoogle([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'add_layer', args: { sceneId: 's1' } } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    })
    const events = await collect(OPTS)
    const start = events.find((e) => e.type === 'tool_use_start')
    const stop = events.find((e) => e.type === 'tool_use_stop')
    expect(start).toMatchObject({ type: 'tool_use_start', name: 'add_layer' })
    expect(stop).toMatchObject({ type: 'tool_use_stop', finalInput: { sceneId: 's1' } })
    // Same id links start and stop.
    expect((start as any).id).toBe((stop as any).id)
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'tool_use' })
  })

  it('converts grounding metadata into citation events', async () => {
    __setProviderClientsForTesting({
      google: mockGoogle([
        {
          candidates: [
            {
              groundingMetadata: { groundingChunks: [{ web: { uri: 'https://x.com', title: 'X' } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    })
    const events = await collect(OPTS)
    expect(events.find((e) => e.type === 'citation')).toEqual({
      type: 'citation',
      sourceUri: 'https://x.com',
      title: 'X',
    })
  })

  it('passes function declarations and a googleSearch entry built from tools', async () => {
    let captured: any = null
    __setProviderClientsForTesting({
      google: mockGoogle([{ text: 'ok' }], (p) => {
        captured = p
      }),
    })
    await collect({
      ...OPTS,
      tools: [
        { name: 'add_layer', description: 'd', input_schema: { type: 'object' } },
        // native search marker (server tool: carries a type, no input_schema)
        { type: 'google_search', name: 'google_search', description: '', input_schema: {} } as any,
      ],
    })
    const entries = captured.config.tools
    expect(entries).toContainEqual({
      functionDeclarations: [{ name: 'add_layer', description: 'd', parameters: { type: 'object' } }],
    })
    expect(entries).toContainEqual({ googleSearch: {} })
  })

  it('surfaces a non-rate-limit server error as a retriable error event + error stop (no retry)', async () => {
    let calls = 0
    __setProviderClientsForTesting({
      google: {
        models: {
          generateContentStream: async () => {
            calls++
            // 500 with a plain message: retriable flag true, but NOT a rate
            // limit — so it surfaces immediately without the retry loop.
            throw Object.assign(new Error('internal error'), { status: 500 })
          },
        },
      },
    })
    const events = await collect(OPTS)
    expect(calls).toBe(1) // surfaced on the first try, not retried
    expect(events.find((e) => e.type === 'error')).toMatchObject({ retriable: true })
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'error' })
  })

  it('retries a rate-limit error then succeeds (C2)', async () => {
    __setRetrySleepForTesting(() => Promise.resolve()) // no real backoff
    let calls = 0
    __setProviderClientsForTesting({
      google: {
        models: {
          generateContentStream: async () => {
            calls++
            if (calls === 1) throw Object.assign(new Error('429 rate limit'), { status: 429 })
            // Second attempt: a minimal successful stream.
            return (async function* () {
              yield { text: 'hi', candidates: [{ finishReason: 'STOP' }] }
            })()
          },
        },
      },
    })
    const events = await collect(OPTS)
    __resetRetrySleepForTesting()
    expect(calls).toBe(2) // retried once
    // First event is the retriable backoff signal; the run then completes cleanly.
    expect((events[0] as any).retriable).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'end_turn' })
  })

  it('does NOT retry when the run is aborted, even on a rate-limit (F2)', async () => {
    __setRetrySleepForTesting(() => Promise.resolve())
    const ac = new AbortController()
    let calls = 0
    __setProviderClientsForTesting({
      google: {
        models: {
          generateContentStream: async () => {
            calls++
            ac.abort() // simulate client disconnect during the request
            throw Object.assign(new Error('429 rate limit'), { status: 429 })
          },
        },
      },
    })
    const events = await collect({ ...OPTS, abortSignal: ac.signal })
    __resetRetrySleepForTesting()
    expect(calls).toBe(1) // aborted → no retry despite being a rate limit
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'error' })
  })

  it('does NOT retry a rate-limit thrown after events were yielded (partial-stream safety)', async () => {
    __setRetrySleepForTesting(() => Promise.resolve())
    let calls = 0
    __setProviderClientsForTesting({
      google: {
        models: {
          generateContentStream: async () => {
            calls++
            return (async function* () {
              yield { text: 'partial' }
              throw Object.assign(new Error('429 rate limit'), { status: 429 })
            })()
          },
        },
      },
    })
    const events = await collect(OPTS)
    __resetRetrySleepForTesting()
    expect(calls).toBe(1) // no retry — a partial stream can't be re-run
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'error' })
  })
})

describe('multi-turn tool use — the functionResponse must name the FUNCTION, not our id', () => {
  // Gemini pairs a functionResponse to its functionCall BY NAME. The adapter used
  // to send `name: block.toolUseId`, and toolUseId is a randomUUID() minted while
  // streaming — so every tool turn after the first sent a response that matched
  // nothing. Google has no fallback path, so this broke every Gemini agent run
  // past its first tool call.
  it('round-trips a second tool turn with the real function name', async () => {
    // ── Turn 1: the model calls a tool. Capture the id the adapter minted. ──
    __setProviderClientsForTesting({
      google: mockGoogle([
        { candidates: [{ content: { parts: [{ functionCall: { name: 'write_scene_code', args: { id: 's1' } } }] } }] },
        { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } },
      ]),
    })
    const turn1 = await collect(OPTS)
    const start = turn1.find((e) => e.type === 'tool_use_start') as { id: string; name: string }
    expect(start.name).toBe('write_scene_code')
    expect(start.id).not.toBe('write_scene_code') // it's a UUID, which is the whole problem

    // ── Turn 2: history now carries the tool_use + its tool_result. ──
    let sent: any
    __setProviderClientsForTesting({
      google: mockGoogle([{ candidates: [{ finishReason: 'STOP' }] }], (p) => {
        sent = p
      }),
    })
    await collect({
      ...OPTS,
      messages: [
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: start.id, name: start.name, input: { id: 's1' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: start.id, content: 'ok' }] },
      ],
    })

    const responses = sent.contents.flatMap((c: any) => c.parts.filter((p: any) => p.functionResponse))
    expect(responses).toHaveLength(1)
    expect(responses[0].functionResponse.name, 'Gemini matches by name — a UUID here matches nothing').toBe(
      'write_scene_code',
    )
  })

  it('names an Anthropic-format tool_result carried through provider_raw', async () => {
    // Array-content tool_results (the capture_frame path) ride as provider_raw;
    // they need the same name lookup or they are unmatchable too.
    let sent: any
    __setProviderClientsForTesting({
      google: mockGoogle([{ candidates: [{ finishReason: 'STOP' }] }], (p) => {
        sent = p
      }),
    })
    await collect({
      ...OPTS,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'uuid-1', name: 'capture_frame', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'provider_raw',
              provider: 'anthropic',
              block: {
                type: 'tool_result',
                tool_use_id: 'uuid-1',
                content: [
                  { type: 'text', text: 'frame' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
                ],
              },
            },
          ],
        },
      ],
    })
    const parts = sent.contents.flatMap((c: any) => c.parts)
    expect(parts.find((p: any) => p.functionResponse).functionResponse.name).toBe('capture_frame')
    // D6: Gemini is vision-capable — the captured pixels ride alongside the
    // response as inlineData instead of collapsing to "[image omitted]".
    expect(parts.find((p: any) => p.inlineData)?.inlineData).toEqual({ mimeType: 'image/png', data: 'AAA' })
    expect(JSON.stringify(parts)).not.toContain('[image omitted]')
  })
})
