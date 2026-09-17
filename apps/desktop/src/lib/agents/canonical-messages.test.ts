/**
 * Round-trip identity tests for the Anthropic <-> Canonical message converters.
 *
 * The migration's correctness hinges on this: toCanonical(toAnthropic) and
 * toAnthropic(toCanonical) must be identity for every block type the runner
 * actually produces — text, image, tool_use, string + array tool_result, and
 * (the reason this exists) thinking blocks WITH signatures and redacted_thinking.
 * A drop here = a rejected next API call or lost context in production.
 */

import { describe, it, expect } from 'vitest'
import {
  toCanonicalMessages,
  toAnthropicMessages,
  extractRawToolResult,
  stripCompatReasoningBlocks,
  markConversationCache,
} from './canonical-messages'

describe('markConversationCache — cache the history, not just the system prefix', () => {
  const cc = { type: 'ephemeral' }

  it('stamps the last block of the last message', () => {
    const out = markConversationCache([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
    expect(out[0].content).toEqual([{ type: 'text', text: 'a' }])
    expect(out[1].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: cc }])
  })

  it('leaves a string body alone rather than reshaping it — steers must stay plain strings (D1.11)', () => {
    const input = [{ role: 'user', content: 'STEER-MARKER make scene 2 blue' }]
    expect(markConversationCache(input)).toBe(input)
  })

  it('never mutates the input — a stamped provider_raw block would come back every later turn', () => {
    const shared = { type: 'text', text: 'raw' }
    const input = [{ role: 'assistant', content: [shared] }]
    markConversationCache(input)
    expect(shared).toEqual({ type: 'text', text: 'raw' })
    expect(input[0].content[0]).toBe(shared)
  })

  it('skips block types the API rejects a marker on', () => {
    const input = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }] }]
    expect(markConversationCache(input)).toBe(input)
  })

  it('leaves empty input alone', () => {
    expect(markConversationCache([])).toEqual([])
    expect(markConversationCache([{ role: 'user', content: [] }])[0].content).toEqual([])
  })
})

describe('extractRawToolResult — degrade foreign tool_results for non-origin adapters', () => {
  it('extracts string content verbatim', () => {
    expect(extractRawToolResult({ type: 'tool_result', tool_use_id: 't1', content: 'done' })).toEqual({
      toolUseId: 't1',
      text: 'done',
      images: [],
    })
  })

  it('lifts image blocks OUT of array content so a vision provider can be handed them', () => {
    // D6: these used to collapse to the literal "[image omitted]" for every
    // non-Anthropic provider, four of which can actually see. The images come
    // back separately because neither an OpenAI role:'tool' message nor a Gemini
    // functionResponse has a slot for them — the caller attaches them alongside.
    const raw = {
      type: 'tool_result',
      tool_use_id: 'cap1',
      content: [
        { type: 'text', text: 'frame captured:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      ],
    }
    expect(extractRawToolResult(raw)).toEqual({
      toolUseId: 'cap1',
      text: 'frame captured:',
      images: [{ mimeType: 'image/jpeg', dataBase64: 'AAAA' }],
    })
    // Text-only providers (deepseek, local) opt out and get the honest placeholder.
    expect(extractRawToolResult(raw, true)).toEqual({
      toolUseId: 'cap1',
      text: 'frame captured:\n[image omitted]',
      images: [],
    })
  })

  it('returns null for non-tool_result raw blocks (e.g. thinking)', () => {
    expect(extractRawToolResult({ type: 'thinking', thinking: 'hmm', signature: 'x' })).toBeNull()
    expect(extractRawToolResult({ type: 'tool_result' })).toBeNull() // missing tool_use_id
    expect(extractRawToolResult(null)).toBeNull()
  })
})

describe('canonical message round-trip', () => {
  it('preserves a thinking block with its signature (the whole point)', () => {
    const anthropic = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 'reasoning here', signature: 'sig-xyz-123' },
          { type: 'text', text: 'the answer' },
        ],
      },
    ]
    const canonical = toCanonicalMessages(anthropic)
    // Thinking rides through as an opaque provider_raw block.
    expect(canonical[0].content).toEqual([
      { type: 'provider_raw', provider: 'anthropic', block: anthropic[0].content[0] },
      { type: 'text', text: 'the answer' },
    ])
    // And reconstructs byte-identically.
    expect(toAnthropicMessages(canonical)).toEqual(anthropic)
  })

  it('preserves redacted_thinking blocks', () => {
    const anthropic = [{ role: 'assistant' as const, content: [{ type: 'redacted_thinking', data: 'encrypted-blob' }] }]
    expect(toAnthropicMessages(toCanonicalMessages(anthropic))).toEqual(anthropic)
  })

  it('round-trips text, tool_use, and string tool_result through typed forms', () => {
    const anthropic = [
      { role: 'user' as const, content: 'make a scene' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'building' },
          { type: 'tool_use', id: 't1', name: 'add_layer', input: { sceneId: 's1' } },
        ],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done', is_error: false }],
      },
    ]
    expect(toAnthropicMessages(toCanonicalMessages(anthropic))).toEqual(anthropic)
  })

  it('round-trips base64 image blocks through the typed image form', () => {
    const anthropic = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]
    const canonical = toCanonicalMessages(anthropic)
    expect(canonical[0].content).toContainEqual({ type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' })
    expect(toAnthropicMessages(canonical)).toEqual(anthropic)
  })

  it('preserves array-content tool_result (capture-flow image frames) verbatim', () => {
    const anthropic = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'cap1',
            content: [
              { type: 'text', text: 'frame:' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
            ],
          },
        ],
      },
    ]
    // Array content can't fit the typed string form, so it rides through opaquely
    // and reconstructs exactly.
    expect(toAnthropicMessages(toCanonicalMessages(anthropic))).toEqual(anthropic)
  })

  it('drops foreign-provider provider_raw blocks when building an Anthropic request', () => {
    const canonical = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'hi' },
          { type: 'provider_raw' as const, provider: 'google' as const, block: { type: 'gemini_thing' } },
        ],
      },
    ]
    expect(toAnthropicMessages(canonical)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('drops an orphaned server_tool_use (paused web_search) with no result block', () => {
    const canonical = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'searching' },
          {
            type: 'provider_raw' as const,
            provider: 'anthropic' as const,
            block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'x' } },
          },
        ],
      },
    ]
    // No corresponding web_search_tool_result → the orphaned call is stripped (else Anthropic 400s).
    expect(toAnthropicMessages(canonical)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'searching' }] },
    ])
  })

  it('keeps a server_tool_use that IS paired with its web_search_tool_result', () => {
    const canonical = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'provider_raw' as const,
            provider: 'anthropic' as const,
            block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} },
          },
          {
            type: 'provider_raw' as const,
            provider: 'anthropic' as const,
            block: { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
          },
        ],
      },
    ]
    expect(toAnthropicMessages(canonical)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
        ],
      },
    ])
  })

  it('maps the canonical-only tool role onto an Anthropic user turn', () => {
    const canonical = [
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 't1', content: 'ok' }] },
    ]
    expect(toAnthropicMessages(canonical)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
  })
})

describe('compat_reasoning blocks (DeepSeek/Qwen/Kimi reasoning replay)', () => {
  for (const provider of ['deepseek', 'qwen', 'kimi'] as const) {
    it(`tags ${provider} compat_reasoning history blocks with its own provider (NOT anthropic)`, () => {
      const history = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'compat_reasoning', provider, reasoning_content: 'thought' },
            { type: 'text', text: 'answer' },
          ],
        },
      ]
      const canonical = toCanonicalMessages(history as never)
      const blocks = canonical[0].content as Array<{ type: string; provider?: string }>
      expect(blocks[0]).toEqual({
        type: 'provider_raw',
        provider,
        block: { type: 'compat_reasoning', provider, reasoning_content: 'thought' },
      })
    })

    it(`toAnthropicMessages skips ${provider} reasoning (mid-chat switch to Claude must not 400)`, () => {
      const history = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'compat_reasoning', provider, reasoning_content: 'thought' },
            { type: 'text', text: 'answer' },
          ],
        },
      ]
      expect(toAnthropicMessages(toCanonicalMessages(history as never))).toEqual([
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      ])
    })
  }

  it('signed Anthropic thinking blocks still round-trip verbatim (default-case regression)', () => {
    const anthropic = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 'claude thought', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]
    expect(toAnthropicMessages(toCanonicalMessages(anthropic as never))).toEqual(anthropic)
  })
})

describe('stripCompatReasoningBlocks (legacy Anthropic-path guard)', () => {
  it('removes compat_reasoning blocks (any provider), keeps text/tool_use', () => {
    const m = {
      role: 'assistant' as const,
      content: [
        { type: 'compat_reasoning', provider: 'kimi', reasoning_content: 'thought' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't1', name: 'foo', input: {} },
      ],
    }
    expect(stripCompatReasoningBlocks(m).content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 't1', name: 'foo', input: {} },
    ])
  })

  it('returns the message unchanged (same ref) when no reasoning block present', () => {
    const m = { role: 'assistant' as const, content: [{ type: 'text', text: 'hi' }] }
    expect(stripCompatReasoningBlocks(m)).toBe(m)
  })

  it('leaves string content untouched', () => {
    const m = { role: 'user' as const, content: 'plain' }
    expect(stripCompatReasoningBlocks(m)).toBe(m)
  })

  it('strips reasoning even when an image block co-exists (prevents toAnthropicContent crash)', () => {
    const m = {
      role: 'assistant' as const,
      content: [
        { type: 'compat_reasoning', provider: 'qwen', reasoning_content: 'thought' },
        { type: 'image', image: { dataUri: 'data:...' } },
      ],
    }
    expect(stripCompatReasoningBlocks(m).content).toEqual([{ type: 'image', image: { dataUri: 'data:...' } }])
  })
})
