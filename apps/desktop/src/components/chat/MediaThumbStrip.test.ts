import { describe, it, expect } from 'vitest'
import { mediaThumbs } from './MediaThumbStrip'
import type { ToolCallRecord } from '@/lib/agents/types'

const call = (toolName: string, results: unknown): ToolCallRecord => ({
  id: '1',
  toolName,
  input: {},
  output: { success: true, data: { results } },
})

describe('mediaThumbs', () => {
  it('extracts thumb + source link from stock-image results', () => {
    const out = mediaThumbs(
      call('find_media', [{ thumbnailUrl: 'http://t/1.jpg', sourceUrl: 'http://src/1', alt: 'eiffel' }]),
    )
    expect(out).toEqual([{ thumb: 'http://t/1.jpg', href: 'http://src/1', title: 'eiffel' }])
  })

  it('handles mcp-prefixed archival tool + optional title, falls back href→thumb', () => {
    const out = mediaThumbs(
      call('mcp__dreambyte__find_media', [{ thumbnailUrl: 'http://t/2.jpg', title: 'moon' }]),
    )
    expect(out).toEqual([{ thumb: 'http://t/2.jpg', href: 'http://t/2.jpg', title: 'moon' }])
  })

  it('drops results without a thumbnail and caps at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ thumbnailUrl: `http://t/${i}.jpg`, sourceUrl: 'http://s' }))
    const out = mediaThumbs(call('find_media', [{ sourceUrl: 'http://s' }, ...many]))
    expect(out).toHaveLength(8)
  })

  it('returns [] for non-media tools and missing data', () => {
    expect(mediaThumbs(call('web_search', [{ thumbnailUrl: 'x' }]))).toEqual([])
    expect(mediaThumbs({ id: '1', toolName: 'find_media', input: {} })).toEqual([])
  })
})
