import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enhance, isRichPrompt, modelForEnhance, __clearEnhanceCache, type EnhanceDeps } from './enhance'

const mockDeps = (over: Partial<EnhanceDeps> = {}): EnhanceDeps => ({
  rewrite: vi.fn(async (_system, prompt, _model) => `ENHANCED(${prompt})`),
  ...over,
})

describe('enhance', () => {
  beforeEach(() => __clearEnhanceCache())

  it('rewrites a short video/image prompt via the LLM', async () => {
    const deps = mockDeps()
    expect(await enhance({ modality: 'video', rawPrompt: 'a fox' }, deps)).toBe('ENHANCED(a fox)')
    expect(await enhance({ modality: 'image', rawPrompt: 'a hill' }, deps)).toBe('ENHANCED(a hill)')
    expect(deps.rewrite).toHaveBeenCalledTimes(2)
  })

  it('skips the LLM when enabled is false', async () => {
    const deps = mockDeps()
    expect(await enhance({ modality: 'video', rawPrompt: 'a fox', enabled: false }, deps)).toBe('a fox')
    expect(deps.rewrite).not.toHaveBeenCalled()
  })

  it('skips the LLM when the prompt is already cinematic (T19 vocab gate)', async () => {
    const deps = mockDeps()
    const rich = 'cinematic wide shot, golden hour rim lighting, shallow depth of field'
    expect(await enhance({ modality: 'video', rawPrompt: rich }, deps)).toBe(rich)
    expect(deps.rewrite).not.toHaveBeenCalled()
  })

  it('ENHANCES a long-but-flat prompt that lacks cinematic vocab (T19 — old word gate missed this)', async () => {
    const deps = mockDeps()
    const flat = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ')
    await enhance({ modality: 'video', rawPrompt: flat }, deps)
    expect(deps.rewrite).toHaveBeenCalledTimes(1) // not skipped — it's long but not cinematic
  })

  it('passes audio through (no strategy, no LLM)', async () => {
    const deps = mockDeps()
    expect(await enhance({ modality: 'audio', rawPrompt: 'door slam' }, deps)).toBe('door slam')
    expect(deps.rewrite).not.toHaveBeenCalled()
  })

  it('caches by (modality, prompt) — same input rewrites once', async () => {
    const deps = mockDeps()
    await enhance({ modality: 'video', rawPrompt: 'a fox' }, deps)
    await enhance({ modality: 'video', rawPrompt: 'a fox' }, deps)
    expect(deps.rewrite).toHaveBeenCalledTimes(1)
  })

  it('falls back to the raw prompt when the LLM errors (never blocks generation)', async () => {
    const deps = mockDeps({
      rewrite: vi.fn(async () => {
        throw new Error('rate limited')
      }),
    })
    expect(await enhance({ modality: 'video', rawPrompt: 'a fox' }, deps)).toBe('a fox')
  })
})

describe('modelForEnhance', () => {
  it('auto → Sonnet for video (premium output), Haiku for image', () => {
    expect(modelForEnhance('video', 'auto')).toContain('sonnet')
    expect(modelForEnhance('image', 'auto')).toContain('haiku')
  })
  it('explicit quality overrides modality', () => {
    expect(modelForEnhance('image', 'premium')).toContain('sonnet')
    expect(modelForEnhance('video', 'cheap')).toContain('haiku')
  })
})

describe('enhance model selection', () => {
  beforeEach(() => __clearEnhanceCache())
  it('passes the resolved model to rewrite (auto video → Sonnet)', async () => {
    const deps = mockDeps()
    await enhance({ modality: 'video', rawPrompt: 'a fox' }, deps)
    expect(deps.rewrite).toHaveBeenCalledWith(expect.any(String), 'a fox', expect.stringContaining('sonnet'))
  })
})

describe('isRichPrompt (T19 — cinematic-vocab gate)', () => {
  it('a short cinematic prompt IS rich (3+ vocab hits)', () => {
    expect(isRichPrompt('cinematic dolly shot with neon lighting')).toBe(true) // shot, dolly, lighting, neon, cinematic
  })
  it('a short plain prompt is NOT rich', () => {
    expect(isRichPrompt('a fox on a hill')).toBe(false)
  })
  it('a long-but-flat prompt is NOT rich (vocab, not length, decides)', () => {
    expect(isRichPrompt(Array.from({ length: 45 }, () => 'walk').join(' '))).toBe(false)
  })
  it('one repeated cinematic word does not clear the bar (distinct terms)', () => {
    expect(isRichPrompt('shot shot shot shot')).toBe(false) // only 1 distinct term
  })
  it('word-boundary match: vocab as a substring of common words does NOT count', () => {
    // 'pan'->company, 'shot'->gunshot, 'wide'->worldwide would all false-fire under substrings.
    expect(isRichPrompt('the company expand worldwide despite a gunshot')).toBe(false)
  })
  it('a very long prompt is left alone via the word backstop', () => {
    expect(isRichPrompt(Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '))).toBe(true)
  })
})
