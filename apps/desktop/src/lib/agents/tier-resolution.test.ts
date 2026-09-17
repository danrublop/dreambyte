// @vitest-environment node
//
// Locks in the Cursor-style tier philosophy (task: tier remap):
//   budget = cheapest, auto = capable non-Anthropic (Kimi), premium = Anthropic.
// resolveModel maps (agentType, tier, override, enabledModelIds) → concrete model.

import { describe, it, expect } from 'vitest'
import { resolveModel, keyedProvidersFromEnv } from './context-builder'
import type { ModelId } from './types'
import type { ModelProvider } from './model-config'

const SM = 'scene-maker' as const
const keyed = (...providers: ModelProvider[]): ReadonlySet<ModelProvider> => new Set(providers)

describe('tier → model resolution (Cursor-style tiers)', () => {
  describe('defaults when no enabled-list constrains the choice', () => {
    it('auto → Kimi (capable, non-Anthropic)', () => {
      expect(resolveModel(SM, 'auto')).toBe('kimi-k2.6')
    })
    it('premium → Anthropic Opus (best)', () => {
      expect(resolveModel(SM, 'premium')).toBe('claude-opus-4-6')
    })
    it('budget → Qwen Flash (cheapest, $0.05/1M)', () => {
      expect(resolveModel(SM, 'budget')).toBe('qwen-flash')
    })
  })

  describe('falls back to what the user actually has enabled', () => {
    it('Anthropic-only user is unaffected — auto still resolves to Sonnet', () => {
      const enabled = ['claude-sonnet-4-6', 'claude-opus-4-6']
      expect(resolveModel(SM, 'auto', null, enabled)).toBe('claude-sonnet-4-6')
    })

    it('Kimi-enabled user gets Kimi on auto (the intended path)', () => {
      const enabled = ['kimi-k2.6', 'claude-sonnet-4-6']
      expect(resolveModel(SM, 'auto', null, enabled)).toBe('kimi-k2.6')
    })

    it('budget prefers the cheaper non-Anthropic option over Haiku', () => {
      // deepseek-v4-flash ($0.14) beats claude-haiku ($1.0) in the budget chain.
      const enabled = ['deepseek-v4-flash', 'claude-haiku-4-5-20251001']
      expect(resolveModel(SM, 'budget', null, enabled)).toBe('deepseek-v4-flash')
    })

    it('premium stays quality-first — Anthropic Opus wins when enabled', () => {
      const enabled = ['claude-opus-4-6', 'deepseek-v4-pro', 'kimi-k2.6']
      expect(resolveModel(SM, 'premium', null, enabled)).toBe('claude-opus-4-6')
    })
  })

  describe('explicit override still wins over the tier default', () => {
    it('an enabled override is used verbatim', () => {
      const enabled = ['deepseek-v4-pro', 'kimi-k2.6']
      expect(resolveModel(SM, 'auto', 'deepseek-v4-pro' as ModelId, enabled)).toBe('deepseek-v4-pro')
    })
  })

  describe('key-gating: an enabled-but-unkeyed model never wins the tier fallback (T1)', () => {
    it('Kimi enabled WITHOUT a Moonshot key falls back to a keyed provider, not a 401-bound kimi', () => {
      // The trap: auto defaults to Kimi, user toggled it on, but no MOONSHOT_API_KEY.
      const enabled = ['kimi-k2.6', 'claude-sonnet-4-6']
      const onlyAnthropicKeyed = keyed('anthropic')
      expect(resolveModel(SM, 'auto', null, enabled, undefined, onlyAnthropicKeyed)).toBe('claude-sonnet-4-6')
    })

    it('Kimi enabled WITH a Moonshot key still resolves to Kimi on auto', () => {
      const enabled = ['kimi-k2.6', 'claude-sonnet-4-6']
      expect(resolveModel(SM, 'auto', null, enabled, undefined, keyed('kimi', 'anthropic'))).toBe('kimi-k2.6')
    })

    it('an EXPLICIT override is honored even if its provider is unkeyed (user owns the 401)', () => {
      const enabled = ['kimi-k2.6', 'claude-sonnet-4-6']
      expect(resolveModel(SM, 'auto', 'kimi-k2.6' as ModelId, enabled, undefined, keyed('anthropic'))).toBe('kimi-k2.6')
    })

    it('no keys at all → still returns a tool-capable model (surfaces a clear 401, not a no-op)', () => {
      const enabled = ['kimi-k2.6']
      expect(resolveModel(SM, 'auto', null, enabled, undefined, keyed())).toBe('kimi-k2.6')
    })

    it('codex-cli (keyless CLI runtime) survives key-gating even with no OPENAI_API_KEY', () => {
      // getModelProvider maps codex-cli → openai; key-gating must NOT gate it
      // behind OPENAI_API_KEY since it is a keyless runtime. Order codex-cli
      // SECOND so the regression is visible: the buggy path skips it and returns
      // the unkeyed kimi-k2.6 (toolCapableIds[0]); the fix returns codex-cli.
      const enabled = ['kimi-k2.6', 'codex-cli']
      // keyed set has neither openai nor kimi — only the keyless runtimes.
      expect(resolveModel(SM, 'auto', null, enabled, undefined, keyed('local', 'codex-cli'))).toBe('codex-cli')
    })

    it('omitting keyedProviders preserves the old behavior (no gating)', () => {
      const enabled = ['kimi-k2.6', 'claude-sonnet-4-6']
      expect(resolveModel(SM, 'auto', null, enabled)).toBe('kimi-k2.6')
    })
  })

  describe('keyedProvidersFromEnv', () => {
    it('always includes keyless providers and adds cloud providers whose env key is set', () => {
      const set = keyedProvidersFromEnv({ MOONSHOT_API_KEY: 'x', ANTHROPIC_API_KEY: '' } as unknown as NodeJS.ProcessEnv)
      expect(set.has('local')).toBe(true)
      expect(set.has('claude-code')).toBe(true)
      expect(set.has('kimi')).toBe(true)
      expect(set.has('anthropic')).toBe(false) // empty string is not a key
      expect(set.has('deepseek')).toBe(false)
    })
  })
})
