import { describe, it, expect, vi } from 'vitest'
import { analyzeFramesVision, sendFramesToVision, parseFramesJson, supportsFrameVision } from './frames-vision'
import type { KeyframeImage } from '../../../services/video-understander'
import * as compat from './openai-compat-vision'

// Mock only the compat transport (avoid a real network call); keep the real
// providerForEngine registry so the dispatch wiring is exercised end-to-end.
vi.mock('./openai-compat-vision', async (orig) => ({
  ...(await orig<typeof import('./openai-compat-vision')>()),
  callOpenAICompatVision: vi.fn(),
}))

// Mock the Anthropic client so the cloud:anthropic dispatch branch is testable
// without a live key (the runner never mocks getAnthropicClient).
const anthropicMessages = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../providers', () => ({ getAnthropicClient: () => ({ messages: anthropicMessages }) }))

function frame(timeSec: number): KeyframeImage {
  return { timeSec, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }
}

/** A fetch double shaped like the Ollama /api/chat response. */
function ollamaFetch(content: string, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ message: { content } }),
  })) as unknown as typeof fetch
}

describe('parseFramesJson', () => {
  it('parses fenced JSON into {scene, events}', () => {
    const raw = '```json\n{"scene":"a chart grows","events":[{"start":0,"end":1,"description":"bar rises"}]}\n```'
    const r = parseFramesJson(raw)
    expect(r.scene).toBe('a chart grows')
    expect(r.events).toEqual([{ start: 0, end: 1, description: 'bar rises' }])
  })

  it('drops events without a description and defaults missing times', () => {
    const r = parseFramesJson('{"events":[{"description":"x"},{"start":2}]}')
    expect(r.events).toEqual([{ start: 0, end: 0, description: 'x' }])
  })

  it('returns {events:[]} on unparseable text', () => {
    expect(parseFramesJson('not json')).toEqual({ events: [] })
  })
})

describe('analyzeFramesVision — intake contract preserved (regression)', () => {
  it('returns {scene, events} via the local Ollama path', async () => {
    const content = JSON.stringify({ scene: 'overview', events: [{ start: 0, end: 2, description: 'intro' }] })
    const r = await analyzeFramesVision([frame(0), frame(1)], 'local:ollama', { fetchImpl: ollamaFetch(content) })
    expect(r.scene).toBe('overview')
    expect(r.events).toHaveLength(1)
    expect(r.events[0].description).toBe('intro')
  })

  it('degrades to {events:[]} when the provider errors (never throws)', async () => {
    const r = await analyzeFramesVision([frame(0)], 'local:ollama', { fetchImpl: ollamaFetch('', false) })
    expect(r).toEqual({ events: [] })
  })

  it('returns {events:[]} for empty frames without calling the provider', async () => {
    const fetchImpl = ollamaFetch('{}')
    const r = await analyzeFramesVision([], 'local:ollama', { fetchImpl })
    expect(r).toEqual({ events: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns {events:[]} for an engine with no transport (e.g. gemini native)', async () => {
    expect(await analyzeFramesVision([frame(0)], 'cloud:gemini')).toEqual({ events: [] })
  })
})

describe('sendFramesToVision — prompt-generic raw-text transport (T1 seam)', () => {
  it('passes the caller-supplied prompt through and returns raw model text', async () => {
    let sentBody: any
    const fetchImpl = vi.fn(async (_url: string, opts: { body: string }) => {
      sentBody = JSON.parse(opts.body)
      return { ok: true, status: 200, json: async () => ({ message: { content: 'RAW-CUT-REVIEW-TEXT' } }) }
    }) as unknown as typeof fetch

    const raw = await sendFramesToVision([frame(0), frame(3)], 'CUSTOM CUT-REVIEW PROMPT', 'local:ollama', {
      fetchImpl,
    })

    expect(raw).toBe('RAW-CUT-REVIEW-TEXT') // returned verbatim, not parsed
    expect(sentBody.messages[0].content).toBe('CUSTOM CUT-REVIEW PROMPT') // not framesPrompt
    expect(sentBody.messages[0].images).toHaveLength(2) // both frames sent as base64
  })

  it('returns "" for empty frames', async () => {
    expect(await sendFramesToVision([], 'p', 'local:ollama')).toBe('')
  })

  it('propagates transport failure (caller decides how to degrade)', async () => {
    await expect(
      sendFramesToVision([frame(0)], 'p', 'local:ollama', { fetchImpl: ollamaFetch('', false) }),
    ).rejects.toThrow(/HTTP 500/)
  })

  it('dispatches cloud:compat and returns its raw text unparsed (contract flip vs the old parsed wrapper)', async () => {
    const mocked = vi.mocked(compat.callOpenAICompatVision)
    mocked.mockResolvedValueOnce('{"scene":"x","events":[]}')

    const raw = await sendFramesToVision([frame(0)], 'COMPAT PROMPT', 'cloud:qwen')

    expect(raw).toBe('{"scene":"x","events":[]}') // returned verbatim, NOT parsed to an object
    const [, payload, prompt] = mocked.mock.calls[0]
    expect(prompt).toBe('COMPAT PROMPT')
    expect(payload).toHaveLength(1)
    expect(payload[0]).toHaveProperty('base64')
  })

  it('throws on an unsupported engine (so callers surface it, not silent "")', async () => {
    await expect(sendFramesToVision([frame(0)], 'p', 'cloud:bogus')).rejects.toThrow(/No multi-frame vision transport/)
  })

  it('uses a local model tag verbatim (only "ollama" remaps to qwen2.5vl)', async () => {
    let body: any
    const fetchImpl = vi.fn(async (_url: string, opts: { body: string }) => {
      body = JSON.parse(opts.body)
      return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }
    }) as unknown as typeof fetch
    await sendFramesToVision([frame(0)], 'p', 'local:llava', { fetchImpl })
    expect(body.model).toBe('llava')
  })

  it('dispatches cloud:anthropic, returns the text block verbatim, and passes a timeout', async () => {
    anthropicMessages.create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'RAW-ANTHRO' }] })
    const raw = await sendFramesToVision([frame(0)], 'ANTHRO PROMPT', 'cloud:anthropic')
    expect(raw).toBe('RAW-ANTHRO')
    const [params, opts] = anthropicMessages.create.mock.calls[0]
    expect(params.messages[0].content.at(-1)).toEqual({ type: 'text', text: 'ANTHRO PROMPT' })
    expect(opts).toMatchObject({ timeout: expect.any(Number) }) // hung-call guard
  })

  it('returns "" from cloud:anthropic when there is no text block', async () => {
    anthropicMessages.create.mockResolvedValueOnce({ content: [] })
    expect(await sendFramesToVision([frame(0)], 'p', 'cloud:anthropic')).toBe('')
  })
})

describe('supportsFrameVision', () => {
  it('accepts local, anthropic, and openai-compat engines', () => {
    expect(supportsFrameVision('local:ollama')).toBe(true)
    expect(supportsFrameVision('local:llava')).toBe(true)
    expect(supportsFrameVision('cloud:anthropic')).toBe(true)
    expect(supportsFrameVision('cloud:qwen')).toBe(true)
  })

  it('rejects cloud:gemini (valid image engine, but no multi-frame transport here)', () => {
    expect(supportsFrameVision('cloud:gemini')).toBe(false)
    expect(supportsFrameVision('cloud:unknown')).toBe(false)
  })

  it('requests Ollama JSON mode by default, omits it when jsonMode:false', async () => {
    let body: any
    const fetchImpl = vi.fn(async (_url: string, opts: { body: string }) => {
      body = JSON.parse(opts.body)
      return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }
    }) as unknown as typeof fetch

    await sendFramesToVision([frame(0)], 'p', 'local:ollama', { fetchImpl })
    expect(body.format).toBe('json') // default on

    await sendFramesToVision([frame(0)], 'p', 'local:ollama', { fetchImpl, jsonMode: false })
    expect(body.format).toBeUndefined() // omitted, not 'json'
  })
})
