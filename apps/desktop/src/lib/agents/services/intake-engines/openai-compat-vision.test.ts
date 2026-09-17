// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { providerForEngine, OPENAI_COMPAT_VISION_PROVIDERS } from './openai-compat-vision'
import { listEngines, resolveEngine, type CapabilityProbe } from '../media-understanding-registry'

const NO_CAPS: CapabilityProbe = {
  ollamaModels: [],
  hasAnthropicKey: false,
  hasOpenAIKey: false,
  hasGoogleKey: false,
  compatKeys: {},
  hasCuda: false,
}

describe('OpenAI-compat provider registry', () => {
  it('defines the vision-capable cheap providers (qwen/kimi) with baseUrl + keyEnv + model override', () => {
    for (const key of ['qwen', 'kimi']) {
      const p = OPENAI_COMPAT_VISION_PROVIDERS[key]
      expect(p).toBeDefined()
      expect(p.baseUrl).toMatch(/^https:\/\//)
      expect(p.keyEnv).toMatch(/API_KEY|KEY/)
      expect(p.defaultModel.length).toBeGreaterThan(0)
      expect(p.modelEnv).toMatch(/MODEL/)
    }
    // DeepSeek is NOT a vision provider (its API has no vision) — agent model only.
    expect(OPENAI_COMPAT_VISION_PROVIDERS.deepseek).toBeUndefined()
  })

  it('providerForEngine maps cloud:<key> and ignores native/local/deepseek', () => {
    expect(providerForEngine('cloud:qwen')?.key).toBe('qwen')
    expect(providerForEngine('cloud:kimi')?.key).toBe('kimi')
    expect(providerForEngine('cloud:deepseek')).toBeNull() // text-only, not a vision provider
    expect(providerForEngine('cloud:gemini')).toBeNull()
    expect(providerForEngine('cloud:anthropic')).toBeNull()
    expect(providerForEngine('local:qwen2.5vl')).toBeNull()
  })
})

describe('registry — cheap providers as engines', () => {
  it('lists cloud:qwen for image, available only when its key is set', () => {
    const off = listEngines('image', NO_CAPS).find((e) => e.id === 'cloud:qwen')!
    expect(off.available).toBe(false)
    expect(off.reason).toMatch(/DASHSCOPE_API_KEY/)
    const on = listEngines('image', { ...NO_CAPS, compatKeys: { qwen: true } }).find((e) => e.id === 'cloud:qwen')!
    expect(on.available).toBe(true)
  })

  it('lists the vision cheap providers for video too (qwen/kimi, not deepseek)', () => {
    const ids = listEngines('video', NO_CAPS).map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['cloud:qwen', 'cloud:kimi']))
    expect(ids).not.toContain('cloud:deepseek')
  })

  it('does NOT offer the vision providers for audio/doc', () => {
    expect(listEngines('audio', NO_CAPS).some((e) => e.id === 'cloud:qwen')).toBe(false)
    expect(listEngines('doc', NO_CAPS).some((e) => e.id === 'cloud:qwen')).toBe(false)
  })
})

describe('auto selection prefers cheap cloud (Qwen) over Gemini/Anthropic', () => {
  it('image auto → cloud:qwen when no local model but all cloud keys present', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, hasGoogleKey: true, hasAnthropicKey: true, compatKeys: { qwen: true } }
    expect(resolveEngine('image', 'auto', caps)?.id).toBe('cloud:qwen')
  })

  it('video auto → cloud:qwen over gemini when qwen key present', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, hasGoogleKey: true, compatKeys: { qwen: true } }
    expect(resolveEngine('video', 'auto', caps)?.id).toBe('cloud:qwen')
  })

  it('still local-first: a pulled vision model beats cheap cloud', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, ollamaModels: ['qwen2.5vl:7b'], compatKeys: { qwen: true } }
    expect(resolveEngine('image', 'auto', caps)?.tier).toBe('local')
  })

  it('explicit Settings pick of kimi is honored when its key is set', () => {
    const caps: CapabilityProbe = { ...NO_CAPS, hasGoogleKey: true, compatKeys: { kimi: true } }
    expect(resolveEngine('image', 'cloud:kimi', caps)?.id).toBe('cloud:kimi')
  })
})
