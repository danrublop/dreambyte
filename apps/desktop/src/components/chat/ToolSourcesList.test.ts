import { describe, it, expect } from 'vitest'
import { webSources } from './ToolSourcesList'
import type { ToolCallRecord } from '@/lib/agents/types'

const call = (toolName: string, data: unknown): ToolCallRecord => ({
  id: '1',
  toolName,
  input: {},
  output: { success: true, data },
})

describe('webSources', () => {
  it('maps web_search results, dedupes by url, caps at 5', () => {
    const results = [
      { url: 'http://a', title: 'A' },
      { url: 'http://a', title: 'dup' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `http://b${i}`, title: `B${i}` })),
    ]
    const out = webSources(call('web_search', { results }))
    expect(out).toHaveLength(5)
    expect(out[0]).toEqual({ url: 'http://a', title: 'A' })
  })

  it('falls back title→hostname when title missing', () => {
    const out = webSources(call('web_search', { results: [{ url: 'https://www.example.com/x' }] }))
    expect(out).toEqual([{ url: 'https://www.example.com/x', title: 'example.com' }])
  })

  it('handles mcp-prefixed fetch_url_content as a single source', () => {
    const out = webSources(call('mcp__dreambyte__fetch_url_content', { url: 'http://p', title: 'Page' }))
    expect(out).toEqual([{ url: 'http://p', title: 'Page' }])
  })

  it('returns [] for other tools / no data', () => {
    expect(webSources(call('find_stock_images', { results: [{ url: 'x' }] }))).toEqual([])
    expect(webSources({ id: '1', toolName: 'web_search', input: {} })).toEqual([])
  })
})
