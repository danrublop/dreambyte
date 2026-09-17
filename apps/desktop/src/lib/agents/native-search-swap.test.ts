import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { swapNativeSearchTool, isNativeSearchMarker } from './context-builder'
import type { ClaudeToolDefinition } from './types'

// The strip-vs-keep behavior for non-native models depends on a search backend being
// configured (TAVILY_API_KEY or SEARXNG_URL). Run the "strip" assertions with BOTH unset.
let _savedTavily: string | undefined
let _savedSearx: string | undefined
beforeEach(() => {
  _savedTavily = process.env.TAVILY_API_KEY
  _savedSearx = process.env.SEARXNG_URL
  delete process.env.TAVILY_API_KEY
  delete process.env.SEARXNG_URL
})
afterEach(() => {
  if (_savedTavily === undefined) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = _savedTavily
  if (_savedSearx === undefined) delete process.env.SEARXNG_URL
  else process.env.SEARXNG_URL = _savedSearx
})

function tools(...names: string[]): ClaudeToolDefinition[] {
  return names.map((n) => ({
    name: n,
    description: `${n} description`,
    input_schema: { type: 'object', properties: {} },
  }))
}

describe('swapNativeSearchTool', () => {
  it('leaves tools untouched when research is disabled', () => {
    const input = tools('web_search', 'other')
    const out = swapNativeSearchTool(input, 'anthropic', 'claude-sonnet-4-6' as any, false)
    expect(out).toEqual(input)
  })

  it('leaves tools untouched when no web_search tool is present', () => {
    const input = tools('other')
    const out = swapNativeSearchTool(input, 'anthropic', 'claude-sonnet-4-6' as any, true)
    expect(out).toEqual(input)
  })

  it('swaps to Anthropic server tool for Anthropic models', () => {
    const out = swapNativeSearchTool(tools('web_search', 'other'), 'anthropic', 'claude-sonnet-4-6' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws?.type).toBe('web_search_20250305')
    expect(ws?.max_uses).toBe(5)
    expect(isNativeSearchMarker(ws!)).toBe(true)
  })

  it('swaps to openai_web_search marker for OpenAI native-search models', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'openai', 'gpt-4.1' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws?.type).toBe('openai_web_search')
    expect(isNativeSearchMarker(ws!)).toBe(true)
  })

  it('KEEPS web_search for OpenAI models without native search (e.g. o1) — served by the keyless floor', () => {
    // runWebSearch always has a backend now (SearXNG/Tavily when set, else the
    // keyless in-process floor), so the custom tool is never stripped for lack of one.
    const out = swapNativeSearchTool(tools('web_search', 'other'), 'openai', 'o1' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws).toBeDefined()
    expect(ws?.type).toBeUndefined() // stays the CUSTOM tool, not swapped to a native marker
    expect(out.find((t) => t.name === 'other')).toBeDefined()
  })

  it('swaps to google_search marker for Gemini models with native search', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'google', 'gemini-2.5-flash-preview-05-20' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws?.type).toBe('google_search')
    expect(isNativeSearchMarker(ws!)).toBe(true)
  })

  it('swaps to qwen_web_search marker for Qwen models (DashScope enable_search)', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'qwen', 'qwen-flash' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws?.type).toBe('qwen_web_search')
    expect(isNativeSearchMarker(ws!)).toBe(true)
  })

  it('KEEPS web_search for local models — the keyless floor always gives them a search path', () => {
    const out = swapNativeSearchTool(tools('web_search', 'other'), 'local', 'ollama/llama3.1:8b' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws).toBeDefined()
    expect(ws?.type).toBeUndefined() // custom tool kept, not a native marker
    expect(out.find((t) => t.name === 'other')).toBeDefined()
  })

  it('leaves tools untouched (no strip) when webSearchEnabled is false', () => {
    // The tool is already removed upstream by filterToolsForAgent; swap is a no-op here.
    const input = tools('web_search', 'other')
    expect(swapNativeSearchTool(input, 'local', 'ollama/llama3.1:8b' as any, false)).toEqual(input)
  })
})

describe('swapNativeSearchTool — universal Tavily web search for non-native models', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'tvly-test'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = saved
  })

  it('KEEPS the custom web_search tool for DeepSeek when Tavily is configured', () => {
    const out = swapNativeSearchTool(tools('web_search', 'other'), 'deepseek', 'deepseek-v4-flash' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws).toBeDefined()
    expect(ws?.type).toBeUndefined() // custom tool, NOT a native marker — served via Tavily
    expect(isNativeSearchMarker(ws!)).toBe(false)
  })

  it('KEEPS web_search for Kimi (auto model) when Tavily is configured', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'kimi', 'kimi-k2.6' as any, true)
    expect(out.find((t) => t.name === 'web_search')).toBeDefined()
  })

  it('KEEPS web_search for local models when Tavily is configured', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'local', 'ollama/llama3.1:8b' as any, true)
    expect(out.find((t) => t.name === 'web_search')).toBeDefined()
  })

  it('native-search providers STILL swap to their server marker (Tavily not used for them)', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'anthropic', 'claude-sonnet-4-6' as any, true)
    expect(out.find((t) => t.name === 'web_search')?.type).toBe('web_search_20250305')
  })
})

describe('swapNativeSearchTool — free SearXNG search for non-native models', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.SEARXNG_URL
    process.env.SEARXNG_URL = 'http://localhost:8888'
    delete process.env.TAVILY_API_KEY // prove SearXNG alone is enough
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.SEARXNG_URL
    else process.env.SEARXNG_URL = saved
  })

  it('KEEPS web_search for a local model when only SEARXNG_URL is set (no Tavily key)', () => {
    const out = swapNativeSearchTool(tools('web_search', 'other'), 'local', 'ollama/llama3.1:8b' as any, true)
    const ws = out.find((t) => t.name === 'web_search')
    expect(ws).toBeDefined()
    expect(isNativeSearchMarker(ws!)).toBe(false) // custom tool routed through runWebSearch → SearXNG
  })

  it('KEEPS web_search for DeepSeek when only SEARXNG_URL is set', () => {
    const out = swapNativeSearchTool(tools('web_search'), 'deepseek', 'deepseek-v4-flash' as any, true)
    expect(out.find((t) => t.name === 'web_search')).toBeDefined()
  })
})
