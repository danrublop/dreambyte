// @vitest-environment node
//
// T4 test debt: the five text services (generateSvg/enhancePrompt/summarizeScene/
// editSvg/generateLottie) were rewritten to route through resolveTextModel +
// completeText (provider-agnostic), and had their old Anthropic-only dispatch
// deleted. This locks in the routing seam: correct tier per service, modelId +
// modelConfigs threaded through, and the CompletionResult → UsageShape mapping
// (cost_usd = completion.costUsd). A regression in that seam silently breaks all
// of /api/generate's text modes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CompletionResult } from '@/lib/generation/generate'

// Partial-mock generate.ts: keep everything real except the two routing seams.
vi.mock('@/lib/generation/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation/generate')>()
  return { ...actual, completeText: vi.fn(), resolveTextModel: vi.fn() }
})

import { completeText, resolveTextModel } from '@/lib/generation/generate'
import {
  generateSvg,
  enhancePrompt,
  summarizeScene,
  editSvg,
  generateLottie,
  LottieParseError,
} from './generation'

const completion = (over: Partial<CompletionResult> = {}): CompletionResult => ({
  raw: 'RESULT',
  inputTokens: 11,
  outputTokens: 7,
  truncated: false,
  costUsd: 0.0021,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks() // call history accumulates across tests otherwise
  vi.mocked(resolveTextModel).mockReturnValue('claude-sonnet-4-6' as never)
  vi.mocked(completeText).mockResolvedValue(completion())
})

describe('text services route through resolveTextModel + completeText', () => {
  it('generateSvg uses the auto tier and maps CompletionResult → UsageShape', async () => {
    const r = await generateSvg({ prompt: 'a circle', modelId: 'mymodel', modelConfigs: [] as never })
    expect(resolveTextModel).toHaveBeenCalledWith('mymodel', 'auto', [])
    // model + maxTokens (8192) + configs threaded into completeText
    expect(completeText).toHaveBeenCalledWith('claude-sonnet-4-6', expect.any(String), 'a circle', 8192, [])
    expect(r.result).toBe('RESULT')
    expect(r.usage).toEqual({ input_tokens: 11, output_tokens: 7, cost_usd: 0.0021 })
  })

  it('enhancePrompt uses the auto tier with a 512 cap', async () => {
    await enhancePrompt({ prompt: 'p' })
    expect(resolveTextModel).toHaveBeenCalledWith(undefined, 'auto', undefined)
    expect(completeText).toHaveBeenCalledWith('claude-sonnet-4-6', expect.any(String), expect.stringContaining('p'), 512, undefined)
  })

  it('editSvg uses the auto tier with an 8192 cap and maps usage', async () => {
    const r = await editSvg({ svgContent: '<svg/>', editInstruction: 'make it red' })
    expect(resolveTextModel).toHaveBeenCalledWith(undefined, 'auto', undefined)
    expect(completeText).toHaveBeenCalledWith('claude-sonnet-4-6', expect.any(String), expect.stringContaining('make it red'), 8192, undefined)
    expect(r.usage.cost_usd).toBe(0.0021)
  })

  it('summarizeScene uses the BUDGET tier (was Haiku) with a 200 cap', async () => {
    const r = await summarizeScene({ prompt: 'p', svgContent: '<svg/>' })
    expect(resolveTextModel).toHaveBeenCalledWith(undefined, 'budget', undefined)
    expect(completeText).toHaveBeenCalledWith('claude-sonnet-4-6', expect.any(String), expect.any(String), 200, undefined)
    expect(r.result).toBe('RESULT')
  })

  it('generateLottie routes via auto tier; invalid JSON throws LottieParseError carrying mapped usage', async () => {
    vi.mocked(completeText).mockResolvedValue(completion({ raw: 'not json' }))
    await expect(generateLottie({ prompt: 'bounce' })).rejects.toMatchObject({
      // LottieParseError exposes the usage it was constructed with
      usage: { input_tokens: 11, output_tokens: 7, cost_usd: 0.0021 },
    })
    expect(resolveTextModel).toHaveBeenCalledWith(undefined, 'auto', undefined)
    expect(completeText).toHaveBeenCalledWith('claude-sonnet-4-6', expect.any(String), 'bounce', 8192, undefined)
  })

  it('generateLottie surfaces a LottieParseError instance on bad JSON', async () => {
    vi.mocked(completeText).mockResolvedValue(completion({ raw: '{ broken' }))
    await expect(generateLottie({ prompt: 'x' })).rejects.toBeInstanceOf(LottieParseError)
  })

  it('input validation fires before any model call', async () => {
    await expect(generateSvg({ prompt: '' })).rejects.toThrow(/prompt is required/)
    await expect(editSvg({ svgContent: '', editInstruction: '' })).rejects.toThrow(/required/)
    expect(completeText).not.toHaveBeenCalled()
  })
})
