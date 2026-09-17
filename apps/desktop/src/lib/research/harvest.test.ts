import { describe, it, expect } from 'vitest'
import { harvestFromToolCalls, selectCitedMedia, dedupeSources } from './harvest'
import type { ToolCallRecord } from '@/lib/agents/types'

function tc(toolName: string, data: unknown, input: Record<string, unknown> = {}): ToolCallRecord {
  return { id: toolName, toolName, input, output: { success: true, data } as ToolCallRecord['output'] }
}

describe('harvestFromToolCalls', () => {
  it('collects web_search results as sources', () => {
    const calls = [
      tc('web_search', { results: [{ title: 'Eiffel', url: 'https://a.com/1' }, { url: 'https://a.com/2' }] }),
    ]
    const { sources } = harvestFromToolCalls(calls)
    expect(sources).toEqual([
      { title: 'Eiffel', url: 'https://a.com/1' },
      { title: 'https://a.com/2', url: 'https://a.com/2' },
    ])
  })

  it('collects fetch_url_content by its input url', () => {
    const { sources } = harvestFromToolCalls([tc('fetch_url_content', { title: 'Page' }, { url: 'https://p.com/x' })])
    expect(sources).toEqual([{ title: 'Page', url: 'https://p.com/x' }])
  })

  it('harvests the page hero image (og:image first) from fetch_url_content as media', () => {
    const { sources, media } = harvestFromToolCalls([
      tc(
        'fetch_url_content',
        { title: 'Morocco Win', images: [{ url: 'https://cdn/hero.jpg' }, { url: 'https://cdn/inline.jpg' }] },
        { url: 'https://bbc.com/a' },
      ),
    ])
    expect(sources).toEqual([{ title: 'Morocco Win', url: 'https://bbc.com/a' }])
    // Only the hero (images[0]) is staged, sourced back to the page it came from.
    expect(media).toEqual([
      { directUrl: 'https://cdn/hero.jpg', sourceUrl: 'https://bbc.com/a', title: 'Morocco Win', type: 'image' },
    ])
  })

  it('picks the DIRECT url for stock images (url), not the page (sourceUrl)', () => {
    const { media } = harvestFromToolCalls([
      tc('find_stock_images', {
        results: [{ url: 'https://cdn/img.jpg', sourceUrl: 'https://unsplash.com/p/x', title: 'T' }],
      }),
    ])
    expect(media).toEqual([
      {
        directUrl: 'https://cdn/img.jpg',
        sourceUrl: 'https://unsplash.com/p/x',
        thumbnailUrl: undefined,
        title: 'T',
        type: 'image',
      },
    ])
  })

  it('picks mediaUrl (not url) + mediaType for archival footage', () => {
    const { media } = harvestFromToolCalls([
      tc('find_archival_footage', {
        results: [
          {
            mediaUrl: 'https://commons/img.jpg',
            sourceUrl: 'https://commons/page',
            thumbnailUrl: 'https://t/1',
            title: 'Photo',
            mediaType: 'image',
          },
          { mediaUrl: 'https://commons/clip.webm', title: 'Clip', mediaType: 'video' },
          { url: 'https://commons/wrong.jpg', title: 'No mediaUrl' }, // has no mediaUrl → dropped (directUrl '')
        ],
      }),
    ])
    expect(media).toEqual([
      {
        directUrl: 'https://commons/img.jpg',
        sourceUrl: 'https://commons/page',
        thumbnailUrl: 'https://t/1',
        title: 'Photo',
        type: 'image',
      },
      {
        directUrl: 'https://commons/clip.webm',
        sourceUrl: undefined,
        thumbnailUrl: undefined,
        title: 'Clip',
        type: 'video',
      },
    ])
  })

  it('picks files[0].url as the direct url for stock videos', () => {
    const { media } = harvestFromToolCalls([
      tc('find_stock_videos', {
        results: [
          {
            files: [{ url: 'https://cdn/v.mp4' }],
            sourceUrl: 'https://pexels/v',
            previewUrl: 'https://prev',
            title: 'V',
          },
        ],
      }),
    ])
    expect(media[0]).toMatchObject({
      directUrl: 'https://cdn/v.mp4',
      sourceUrl: 'https://pexels/v',
      previewUrl: 'https://prev',
      type: 'video',
    })
  })

  it('dedups media by direct url across calls', () => {
    const call = tc('find_stock_images', { results: [{ url: 'https://cdn/img.jpg', title: 'T' }] })
    const { media } = harvestFromToolCalls([call, call])
    expect(media).toHaveLength(1)
  })
})

describe('selectCitedMedia', () => {
  const media = [
    { directUrl: 'https://cdn/a.jpg', sourceUrl: 'https://unsplash.com/a', title: 'A', type: 'image' as const },
    { directUrl: 'https://cdn/b.jpg', sourceUrl: 'https://unsplash.com/b', title: 'B', type: 'image' as const },
  ]

  it('matches when the brief cites the PAGE url, returns the DIRECT url (outside-voice #4)', () => {
    const brief = 'Great shot: https://unsplash.com/a is perfect.'
    expect(selectCitedMedia(media, brief).map((m) => m.directUrl)).toEqual(['https://cdn/a.jpg'])
  })

  it('matches when the brief cites the direct url', () => {
    expect(selectCitedMedia(media, 'use https://cdn/b.jpg').map((m) => m.directUrl)).toEqual(['https://cdn/b.jpg'])
  })

  it('returns nothing when the brief cites neither', () => {
    expect(selectCitedMedia(media, 'no urls here')).toEqual([])
  })

  it('caps the count', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      directUrl: `https://cdn/${i}.jpg`,
      title: `${i}`,
      type: 'image' as const,
    }))
    const brief = many.map((m) => m.directUrl).join(' ')
    expect(selectCitedMedia(many, brief, 6)).toHaveLength(6)
  })
})

describe('dedupeSources', () => {
  it('drops duplicate urls, keeps first', () => {
    expect(
      dedupeSources([
        { title: 'a', url: 'u1' },
        { title: 'b', url: 'u1' },
        { title: 'c', url: 'u2' },
      ]),
    ).toEqual([
      { title: 'a', url: 'u1' },
      { title: 'c', url: 'u2' },
    ])
  })
})
