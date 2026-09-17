import { describe, it, expect } from 'vitest'
import {
  adaptAnthropicCitations,
  adaptOpenAICitations,
  adaptGeminiCitations,
  dedupeSources,
} from './research-citations'

describe('adaptAnthropicCitations', () => {
  it('maps web_search_tool_result content entries to ResearchSource[]', () => {
    const got = adaptAnthropicCitations(
      [
        { type: 'web_search_result', title: 'Example', url: 'https://example.com/a' },
        { type: 'web_search_result', title: 'Two', url: 'https://example.org/b' },
      ],
      'tu_123',
    )
    expect(got).toEqual([
      { url: 'https://example.com/a', title: 'Example', provider: 'anthropic', toolUseId: 'tu_123' },
      { url: 'https://example.org/b', title: 'Two', provider: 'anthropic', toolUseId: 'tu_123' },
    ])
  })

  it('skips entries without a url and handles undefined input', () => {
    expect(adaptAnthropicCitations(undefined)).toEqual([])
    expect(adaptAnthropicCitations([{ type: 'x' }])).toEqual([])
  })
})

describe('adaptOpenAICitations', () => {
  it('accepts url_citation with flat or nested shape', () => {
    const got = adaptOpenAICitations([
      { type: 'url_citation', url: 'https://a.test', title: 'A', quote: 'qa' },
      { type: 'url_citation', url_citation: { url: 'https://b.test', title: 'B', quote: 'qb' } },
      { type: 'other' },
      { type: 'url_citation' }, // no url — skipped
    ])
    expect(got).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'qa', provider: 'openai' },
      { url: 'https://b.test', title: 'B', snippet: 'qb', provider: 'openai' },
    ])
  })

  it('returns empty for undefined / non-arrays', () => {
    expect(adaptOpenAICitations(undefined)).toEqual([])
    expect(adaptOpenAICitations([])).toEqual([])
  })
})

describe('adaptGeminiCitations', () => {
  it('pulls web URIs out of groundingChunks', () => {
    const got = adaptGeminiCitations({
      groundingChunks: [
        { web: { uri: 'https://x.test', title: 'X' } },
        { web: { uri: 'https://y.test' } },
        { web: {} },
        {},
      ],
    })
    expect(got).toEqual([
      { url: 'https://x.test', title: 'X', provider: 'google' },
      { url: 'https://y.test', title: undefined, provider: 'google' },
    ])
  })

  it('returns empty when groundingMetadata is missing', () => {
    expect(adaptGeminiCitations(undefined)).toEqual([])
    expect(adaptGeminiCitations({})).toEqual([])
  })
})

describe('dedupeSources', () => {
  it('drops repeated URLs preserving first-seen order', () => {
    const got = dedupeSources([
      { url: 'https://a.test', provider: 'openai' },
      { url: 'https://b.test', provider: 'openai' },
      { url: 'https://a.test', provider: 'openai', title: 'dup' },
    ])
    expect(got.map((s) => s.url)).toEqual(['https://a.test', 'https://b.test'])
  })
})
