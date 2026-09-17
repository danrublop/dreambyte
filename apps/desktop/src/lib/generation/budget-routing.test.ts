// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { __testResolveGenModel } from './generate'

/**
 * Scene-codegen model routing (eng-review 3B): codegen FOLLOWS the agent's
 * provider. When the agent model is DeepSeek, the quality tier maps within
 * DeepSeek (budget/auto → v4-flash, premium → v4-pro) — explicitly, NOT via
 * the registry `tier` field. Non-DeepSeek agents are untouched: their model
 * passes through, and absent a requested model the Claude tier defaults apply.
 *
 * The former DREAMBYTE_DEEPSEEK_BUDGET env flag (DeepSeek budget codegen
 * under a Claude agent) was retired with 3B — one routing rule, no hidden
 * env-var override. These tests are the matrix the eng review mandated.
 */

describe('scene-codegen model routing (3B provider-follow)', () => {
  describe('DeepSeek agent → DeepSeek codegen, tier-mapped', () => {
    it('budget tier on a deepseek agent uses v4-flash', () => {
      expect(__testResolveGenModel('deepseek-v4-flash', 'budget')).toBe('deepseek-v4-flash')
    })

    it('auto tier on a deepseek agent uses v4-flash', () => {
      expect(__testResolveGenModel('deepseek-v4-flash', 'auto')).toBe('deepseek-v4-flash')
    })

    it('premium tier on a deepseek agent upgrades codegen to v4-pro', () => {
      expect(__testResolveGenModel('deepseek-v4-flash', 'premium')).toBe('deepseek-v4-pro')
    })

    it('tier map is decoupled from which deepseek model drives the agent (pro agent, budget tier → flash)', () => {
      expect(__testResolveGenModel('deepseek-v4-pro', 'budget')).toBe('deepseek-v4-flash')
      expect(__testResolveGenModel('deepseek-v4-pro', 'auto')).toBe('deepseek-v4-flash')
      expect(__testResolveGenModel('deepseek-v4-pro', 'premium')).toBe('deepseek-v4-pro')
    })

    it('routes via modelConfigs lookup for custom deepseek-provider models', () => {
      const configs = [
        { id: 'my-ds', modelId: 'my-ds', provider: 'deepseek' },
      ] as unknown as Parameters<typeof __testResolveGenModel>[2]
      expect(__testResolveGenModel('my-ds', 'premium', configs)).toBe('deepseek-v4-pro')
    })
  })

  describe('non-DeepSeek agents unchanged (regression guard)', () => {
    it('a requested Claude model passes through on every tier', () => {
      expect(__testResolveGenModel('claude-sonnet-4-6', 'budget')).toBe('claude-sonnet-4-6')
      expect(__testResolveGenModel('claude-sonnet-4-6', 'auto')).toBe('claude-sonnet-4-6')
      expect(__testResolveGenModel('claude-sonnet-4-6', 'premium')).toBe('claude-sonnet-4-6')
    })

    it('a requested OpenAI model passes through', () => {
      expect(__testResolveGenModel('gpt-4o', 'budget')).toBe('gpt-4o')
    })

    it('no requested model → Claude tier defaults', () => {
      expect(__testResolveGenModel(undefined, 'budget')).toBe('claude-haiku-4-5-20251001')
      expect(__testResolveGenModel(undefined, 'auto')).toBe('claude-sonnet-4-6')
      expect(__testResolveGenModel(undefined, 'premium')).toBe('claude-opus-4-6')
    })
  })

  describe('retired env flag has no effect (5A regression guard)', () => {
    it('DREAMBYTE_DEEPSEEK_BUDGET no longer routes Claude-agent budget codegen to DeepSeek', () => {
      const prev = process.env.DREAMBYTE_DEEPSEEK_BUDGET
      const prevKey = process.env.DEEPSEEK_API_KEY
      process.env.DREAMBYTE_DEEPSEEK_BUDGET = '1'
      process.env.DEEPSEEK_API_KEY = 'sk-test'
      try {
        expect(__testResolveGenModel(undefined, 'budget')).toBe('claude-haiku-4-5-20251001')
        expect(__testResolveGenModel('claude-haiku-4-5-20251001', 'budget')).toBe('claude-haiku-4-5-20251001')
      } finally {
        if (prev === undefined) delete process.env.DREAMBYTE_DEEPSEEK_BUDGET
        else process.env.DREAMBYTE_DEEPSEEK_BUDGET = prev
        if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = prevKey
      }
    })
  })
})

import { __testCallOpenAICompat } from './generate'

function fakeCompatClient(opts: { content?: string; reasoning?: string; finish?: string; usage?: any }) {
  const bodies: any[] = []
  const create = async (b: any) => {
    bodies.push(b)
    return {
      choices: [{ message: { content: opts.content ?? '', ...(opts.reasoning ? { reasoning_content: opts.reasoning } : {}) }, finish_reason: opts.finish ?? 'stop' }],
      usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
    }
  }
  return { client: { chat: { completions: { create } } } as any, bodies }
}

function throwingClient(status: number) {
  let calls = 0
  const create = async () => {
    calls++
    const e: any = new Error('boom'); e.status = status; throw e
  }
  return { client: { chat: { completions: { create } } } as any, calls: () => calls }
}

describe('callOpenAICompat — thinking param by model (6A)', () => {
  it('v4-flash sends thinking:disabled', async () => {
    const { client, bodies } = fakeCompatClient({ content: 'code' })
    await __testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-flash', 'sys', 'user', 1000)
    expect(bodies[0].thinking).toEqual({ type: 'disabled' })
    expect(bodies[0].max_tokens).toBe(1000) // no headroom when thinking off
  })

  it('v4-pro sends thinking:enabled and adds reasoning headroom to max_tokens', async () => {
    const { client, bodies } = fakeCompatClient({ content: 'code' })
    await __testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-pro', 'sys', 'user', 1000)
    expect(bodies[0].thinking).toEqual({ type: 'enabled' })
    expect(bodies[0].max_tokens).toBeGreaterThan(1000)
  })

  it('qwen/kimi models get NO thinking param', async () => {
    const { client, bodies } = fakeCompatClient({ content: 'code' })
    await __testCallOpenAICompat(client, 'Qwen', 'qwen-plus', 'sys', 'user', 1000)
    expect(bodies[0]).not.toHaveProperty('thinking')
  })
})

describe('callOpenAICompat — retry policy (6A)', () => {
  it('does NOT retry a 400 (fail fast, rethrow)', async () => {
    const { client, calls } = throwingClient(400)
    await expect(__testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-flash', 's', 'u', 100)).rejects.toThrow('boom')
    expect(calls()).toBe(1)
  })

  it('does NOT retry a 401 (bad key)', async () => {
    const { client, calls } = throwingClient(401)
    await expect(__testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-flash', 's', 'u', 100)).rejects.toThrow('boom')
    expect(calls()).toBe(1)
  })

  it('retries once on 429', async () => {
    const { client, calls } = throwingClient(429)
    await expect(__testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-flash', 's', 'u', 100)).rejects.toBeTruthy()
    expect(calls()).toBe(2)
  })
})

describe('callOpenAICompat — reasoning-ate-budget (CRITICAL: no silent empty scene)', () => {
  it('empty content + reasoning present → truncated:true even when finish_reason is stop', async () => {
    const { client } = fakeCompatClient({ content: '', reasoning: 'lots of thinking', finish: 'stop' })
    const r = await __testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-pro', 's', 'u', 100)
    expect(r.raw).toBe('')
    expect(r.truncated).toBe(true) // caller surfaces a failure, not a blank scene
  })

  it('content present → truncated:false (happy path)', async () => {
    const { client } = fakeCompatClient({ content: 'real code', reasoning: 'thinking', finish: 'stop' })
    const r = await __testCallOpenAICompat(client, 'DeepSeek', 'deepseek-v4-pro', 's', 'u', 100)
    expect(r.raw).toBe('real code')
    expect(r.truncated).toBe(false)
  })
})

import { resolveTextModel, hasAnyTextProviderKey, completeText } from './generate'

describe('resolveTextModel — provider-key priority (review CRITICAL)', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_KEY']
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!)
  })

  it('Anthropic wins when present (both tiers)', () => {
    process.env.ANTHROPIC_API_KEY = 'x'
    expect(resolveTextModel(undefined, 'budget')).toBe('claude-haiku-4-5-20251001')
    expect(resolveTextModel(undefined, 'auto')).toBe('claude-sonnet-4-6')
  })
  it('DeepSeek next (flash for both tiers)', () => {
    process.env.DEEPSEEK_API_KEY = 'x'
    expect(resolveTextModel(undefined, 'budget')).toBe('deepseek-v4-flash')
    expect(resolveTextModel(undefined, 'auto')).toBe('deepseek-v4-flash')
  })
  it('Qwen tier-mapped', () => {
    process.env.DASHSCOPE_API_KEY = 'x'
    expect(resolveTextModel(undefined, 'budget')).toBe('qwen-flash')
    expect(resolveTextModel(undefined, 'auto')).toBe('qwen-plus')
  })
  it('Kimi', () => {
    process.env.MOONSHOT_API_KEY = 'x'
    expect(resolveTextModel(undefined, 'budget')).toBe('kimi-k2.6')
  })
  it('priority order: Anthropic beats DeepSeek when both present', () => {
    process.env.ANTHROPIC_API_KEY = 'x'
    process.env.DEEPSEEK_API_KEY = 'y'
    expect(resolveTextModel(undefined, 'auto')).toBe('claude-sonnet-4-6')
  })
  it('no key → Anthropic default (completeText then surfaces the clear key error)', () => {
    expect(resolveTextModel(undefined, 'budget')).toBe('claude-haiku-4-5-20251001')
  })
  it('explicit model wins over keys; deepseek explicit maps by tier', () => {
    process.env.ANTHROPIC_API_KEY = 'x'
    expect(resolveTextModel('gpt-4o', 'auto')).toBe('gpt-4o')
    expect(resolveTextModel('deepseek-v4-flash', 'premium' as 'auto')).toBe('deepseek-v4-pro')
  })

  it('hasAnyTextProviderKey reflects the same key set', () => {
    expect(hasAnyTextProviderKey()).toBe(false)
    process.env.MOONSHOT_API_KEY = 'x'
    expect(hasAnyTextProviderKey()).toBe(true)
  })
})

describe('completeText — no-key guard (review)', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_KEY']
  let saved: Record<string, string | undefined>
  beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => { for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!) })

  it('throws an actionable error (not a raw 401) when the provider has no key', async () => {
    await expect(completeText('deepseek-v4-flash', 'sys', 'user', 100)).rejects.toThrow(/add one in Settings/)
  })
  it('mentions the missing env var name', async () => {
    await expect(completeText('claude-sonnet-4-6', 'sys', 'user', 100)).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})
