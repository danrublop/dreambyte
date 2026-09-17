// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tavilyWebSearch, isTavilyReady } from './tavily'

let savedKey: string | undefined
beforeEach(() => {
  savedKey = process.env.TAVILY_API_KEY
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = savedKey
  vi.restoreAllMocks()
})

describe('isTavilyReady', () => {
  it('reflects TAVILY_API_KEY presence', () => {
    expect(isTavilyReady({} as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isTavilyReady({ TAVILY_API_KEY: 'x' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('tavilyWebSearch', () => {
  it('throws a clear error when no key is set', async () => {
    delete process.env.TAVILY_API_KEY
    await expect(tavilyWebSearch({ query: 'hi' })).rejects.toThrow(/TAVILY_API_KEY is not set/)
  })

  it('posts the query + parses results into the normalized shape', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: 'Paris is the capital of France.',
        results: [
          { title: 'France', url: 'https://en.wikipedia.org/wiki/France', content: 'Capital: Paris', score: 0.98 },
          { title: 'Paris', url: 'https://en.wikipedia.org/wiki/Paris', content: 'Paris is the capital' },
          { content: 'no url — dropped' },
        ],
      }),
    })
    global.fetch = fetchMock as never
    const res = await tavilyWebSearch({ query: 'capital of France', count: 3 })
    expect(res.provider).toBe('tavily')
    expect(res.answer).toBe('Paris is the capital of France.')
    expect(res.results).toHaveLength(2) // the no-url result is dropped
    expect(res.results[0]).toEqual({
      title: 'France',
      url: 'https://en.wikipedia.org/wiki/France',
      content: 'Capital: Paris',
      score: 0.98,
    })
    // request shape
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toBe('capital of France')
    expect(body.max_results).toBe(3)
    expect(body.include_answer).toBe(true)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tvly-test')
  })

  it('folds a site filter into the query', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
    global.fetch = fetchMock as never
    await tavilyWebSearch({ query: 'asyncio', site: 'docs.python.org' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toBe('asyncio site:docs.python.org')
  })

  it('rejects an empty query even when a site is set (no bare site: search)', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    const fetchMock = vi.fn()
    global.fetch = fetchMock as never
    await expect(tavilyWebSearch({ query: '  ', site: 'docs.python.org' })).rejects.toThrow(/query is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps recency to time_range (and omits it for "any")', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
    global.fetch = fetchMock as never
    await tavilyWebSearch({ query: 'news', recency: 'week' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).time_range).toBe('week')
    await tavilyWebSearch({ query: 'news', recency: 'any' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('time_range')
  })

  it('throws on a non-ok HTTP response', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' }) as never
    await expect(tavilyWebSearch({ query: 'x' })).rejects.toThrow(/Tavily search failed \(401\)/)
  })
})

describe('tavilyWebSearch — defensive branches', () => {
  it('returns [] results when the payload has no results array (answer-only)', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: 'only an answer' }) }) as never
    const res = await tavilyWebSearch({ query: 'x' })
    expect(res.results).toEqual([])
    expect(res.answer).toBe('only an answer')
  })

  it('handles results: null without throwing', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: null }) }) as never
    const res = await tavilyWebSearch({ query: 'x' })
    expect(res.results).toEqual([])
    expect(res.answer).toBeUndefined()
  })

  it('rejects when the request is aborted (15s timeout path)', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test'
    global.fetch = vi.fn().mockImplementation((_u: unknown, opts: { signal: AbortSignal }) =>
      new Promise((_res, rej) => {
        opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    ) as never
    vi.useFakeTimers()
    const p = tavilyWebSearch({ query: 'x' })
    p.catch(() => {}) // avoid unhandled rejection before timers advance
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(p).rejects.toThrow(/aborted/)
    vi.useRealTimers()
  })
})
