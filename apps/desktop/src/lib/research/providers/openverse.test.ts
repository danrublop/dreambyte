// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openverseImageSearch, isOpenverseReady } from './openverse'

const FIXTURE = {
  results: [
    {
      id: 'abc',
      title: 'Mountains at sunrise',
      url: 'https://live.staticflickr.com/1540/pic_b.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/',
      foreign_landing_url: 'https://www.flickr.com/photos/x/1',
      creator: 'leguico',
      creator_url: 'https://www.flickr.com/photos/x',
      license: 'by-nc-nd',
      license_version: '2.0',
      width: 1024,
      height: 683,
    },
    { title: 'no url — dropped', width: 800, height: 600 },
    { url: 'https://ex.com/small.jpg', width: 200, height: 150 }, // filtered by minWidth
  ],
}

afterEach(() => vi.restoreAllMocks())

describe('openverseImageSearch', () => {
  it('is keyless (always ready)', () => {
    expect(isOpenverseReady()).toBe(true)
  })

  it('maps results, formats license, drops url-less rows, applies minWidth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(FIXTURE), { status: 200 })),
    )
    const r = await openverseImageSearch({ query: 'mountain sunrise', count: 10, minWidth: 800 })
    expect(r.provider).toBe('openverse')
    expect(r.results).toHaveLength(1) // url-less dropped, small filtered out
    const img = r.results[0]
    expect(img).toMatchObject({
      source: 'openverse',
      url: 'https://live.staticflickr.com/1540/pic_b.jpg',
      sourceUrl: 'https://www.flickr.com/photos/x/1',
      license: 'BY-NC-ND 2.0 (Openverse)',
      author: 'leguico',
    })
    expect(img.id).toBe('openverse-abc')
  })

  it('rejects an empty query', async () => {
    await expect(openverseImageSearch({ query: '  ' })).rejects.toThrow(/query is required/)
  })

  it('throws a clear error on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 429 })),
    )
    await expect(openverseImageSearch({ query: 'x' })).rejects.toThrow(/429/)
  })
})
