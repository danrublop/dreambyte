// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildAgentContext } from './context-builder'
import type { GlobalStyle } from '../types'
import type { ModelId } from './types'

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

function thinkingFor(modelOverride: ModelId, requested: 'off' | 'adaptive' | 'deep' = 'adaptive') {
  const ctx = buildAgentContext(
    'scene-maker',
    { agentType: 'scene-maker', activeTools: [], sceneContext: 'all' },
    [],
    GLOBAL_STYLE,
    'Thinking Passthrough Test',
    'mp4',
    modelOverride,
    undefined, // modelTier — irrelevant, override wins
    requested,
  )
  return { modelId: ctx.modelId, thinkingMode: ctx.thinkingMode, maxTokens: ctx.maxTokens }
}

describe('buildAgentContext — thinking passthrough by provider', () => {
  it('passes thinkingMode through for the OpenAI-compat reasoning providers (Kimi/DeepSeek/Qwen)', () => {
    // The reasoning-replay path is live only if these providers actually receive
    // a non-off thinkingMode — the old clamp forced 'off' and made it dead code.
    // Only DeepSeek/Kimi: the runner reads ctx.thinkingMode to drive their thinking
    // param. (Qwen is excluded — the adapter sends no qwen thinking param.)
    expect(thinkingFor('kimi-k2.6' as ModelId).thinkingMode).toBe('adaptive')
    expect(thinkingFor('deepseek-v4-flash' as ModelId).thinkingMode).toBe('adaptive')
  })

  it('passes thinkingMode through for Anthropic', () => {
    expect(thinkingFor('claude-opus-4-6' as ModelId, 'deep').thinkingMode).toBe('deep')
  })

  it('forces thinking off for providers with no driven thinking param (Qwen/Google/OpenAI)', () => {
    // Qwen is NOT in THINKING_CAPABLE_PROVIDERS — nothing drives its thinking, so
    // thinkingMode is forced off (reasoning replay is handled independently).
    expect(thinkingFor('qwen-plus' as ModelId).thinkingMode).toBe('off')
    expect(thinkingFor('gemini-2.5-flash' as ModelId).thinkingMode).toBe('off')
    expect(thinkingFor('gpt-4o' as ModelId).thinkingMode).toBe('off')
  })

  it('honors an explicit off regardless of provider', () => {
    expect(thinkingFor('kimi-k2.6' as ModelId, 'off').thinkingMode).toBe('off')
  })

  it('gives compat reasoning providers a MODEST maxTokens headroom so a tool call fits after thinking (P1-6)', () => {
    // Anthropic inflates via a SEPARATE budget_tokens (max_tokens must exceed it);
    // the compat reasoning providers draw reasoning from the SAME output budget, so
    // they get a modest fixed +4096 headroom — enough to emit a full tool_use after
    // reasoning, NOT the large budget_tokens-driven inflation.
    const BASE = 12288
    const anthropic = thinkingFor('claude-opus-4-6' as ModelId, 'deep')
    const kimi = thinkingFor('kimi-k2.6' as ModelId, 'deep')

    // Compat headroom is present and modest (not a blind large bump).
    expect(kimi.maxTokens).toBe(BASE + 4096)
    expect(kimi.maxTokens).toBeGreaterThan(BASE)
    // Enough headroom to emit a full write_scene_code tool call (a few K tokens)
    // after the reasoning_content, which shares this same budget.
    expect(kimi.maxTokens - BASE).toBeGreaterThanOrEqual(4000)
    // Anthropic's separate-budget inflation is still LARGER than the compat headroom.
    expect(anthropic.maxTokens).toBeGreaterThan(kimi.maxTokens)
  })

  it('withholds compat headroom when the compat reasoning provider will not reason this turn', () => {
    const BASE = 12288
    // kimi with thinking OFF → no reasoning_content → base cap, no headroom.
    expect(thinkingFor('kimi-k2.6' as ModelId, 'off').maxTokens).toBe(BASE)
    // A non-reasoning provider (OpenAI router) never gets the headroom.
    expect(thinkingFor('gpt-4o' as ModelId, 'deep').maxTokens).toBe(BASE)
  })

  it('gives qwen the headroom unconditionally — its reasoning replay is thinkingMode-independent', () => {
    const BASE = 12288
    // Qwen replays reasoning via compat_reasoning regardless of thinkingMode (which
    // is forced off for it), so it still needs room for a tool call after reasoning.
    expect(thinkingFor('qwen-plus' as ModelId, 'off').maxTokens).toBe(BASE + 4096)
  })
})
