// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searxngWebSearch, searxngImageSearch, isSearxngReady } from './searxng'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.SEARXNG_URL
})
afterEach(() => {
  if (saved === undefined) delete process.env.SEARXNG_URL
  else process.env.SEARXNG_URL = saved
  vi.restoreAllMocks()
})

describe('isSearxngReady', () => {
  it('reflects SEARXNG_URL presence', () => {
    expect(isSearxngReady({} as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isSearxngReady({ SEARXNG_URL: 'http://localhost:8888' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('searxngWebSearch', () => {
  it('throws a clear error when no URL is set', async () => {
    delete process.env.SEARXNG_URL
    await expect(searxngWebSearch({ query: 'hi' })).rejects.toThrow(/SEARXNG_URL is not set/)
  })

  it('GETs the JSON API, strips trailing slash, and maps results (capped by count, drops url-less)', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888/'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: ['Paris is the capital of France.'],
        results: [
          { title: 'France', url: 'https://en.wikipedia.org/wiki/France', content: 'Capital: Paris', score: 0.9 },
          { title: 'Paris', url: 'https://en.wikipedia.org/wiki/Paris', content: 'the capital' },
          { title: 'no url', content: 'dropped' },
        ],
      }),
    })
    global.fetch = fetchMock as never
    const res = await searxngWebSearch({ query: 'capital of France', count: 1 })
    expect(res.provider).toBe('searxng')
    expect(res.answer).toBe('Paris is the capital of France.')
    expect(res.results).toHaveLength(1) // count=1 caps it; url-less would drop anyway
    expect(res.results[0]).toEqual({
      title: 'France',
      url: 'https://en.wikipedia.org/wiki/France',
      content: 'Capital: Paris',
      score: 0.9,
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('http://localhost:8888/search?') // trailing slash stripped, no double //
    expect(url).toContain('format=json')
    expect(url).toContain('q=capital+of+France')
  })

  it('folds a site filter into the query and maps recency to time_range', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
    global.fetch = fetchMock as never
    await searxngWebSearch({ query: 'asyncio', site: 'docs.python.org', recency: 'week' })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('site%3Adocs.python.org')
    expect(url).toContain('time_range=week')
  })

  it('rejects an empty query even with a site set', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888'
    const fetchMock = vi.fn()
    global.fetch = fetchMock as never
    await expect(searxngWebSearch({ query: '  ', site: 'x.com' })).rejects.toThrow(/query is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hints at the json-format config on a 403', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888'
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '' }) as never
    await expect(searxngWebSearch({ query: 'x' })).rejects.toThrow(/search\.formats/)
  })

  it('handles a payload with no results/answers without throwing', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888'
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never
    const res = await searxngWebSearch({ query: 'x' })
    expect(res.results).toEqual([])
    expect(res.answer).toBeUndefined()
  })
})

describe('searxngImageSearch', () => {
  it('requests categories=images and maps img_src/thumbnail/resolution to StockImage', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8888'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            img_src: 'https://c.com/a.jpg',
            thumbnail_src: 'https://c.com/a_t.jpg',
            url: 'https://page.com/a',
            title: 'A',
            resolution: '960 x 640',
          },
          { img_src: 'https://c.com/b.jpg', url: 'https://page.com/b', title: 'B' }, // no thumb → falls back to img_src
          { title: 'no img', url: 'https://page.com/c' }, // dropped (no http img_src)
        ],
      }),
    })
    global.fetch = fetchMock as never
    const res = await searxngImageSearch({ query: 'morocco' })
    expect(fetchMock.mock.calls[0][0]).toContain('categories=images')
    expect(res.provider).toBe('searxng')
    expect(res.results).toHaveLength(2)
    expect(res.results[0]).toMatchObject({
      source: 'searxng',
      url: 'https://c.com/a.jpg',
      thumbnailUrl: 'https://c.com/a_t.jpg',
      sourceUrl: 'https://page.com/a',
      width: 960,
      height: 640,
      license: 'web — rights unverified',
    })
    expect(res.results[1].thumbnailUrl).toBe('https://c.com/b.jpg') // fallback
  })

  it('throws when SEARXNG_URL is unset', async () => {
    delete process.env.SEARXNG_URL
    await expect(searxngImageSearch({ query: 'x' })).rejects.toThrow(/SEARXNG_URL is not set/)
  })
})
