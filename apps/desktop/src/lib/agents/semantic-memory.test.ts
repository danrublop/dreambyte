// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  extractSemanticMemories,
  parseSemanticMemories,
  summarizeToolUsage,
  __setSemanticMemoryTransportForTesting,
} from './semantic-memory'
import type { ToolCallRecord } from './types'

afterEach(() => __setSemanticMemoryTransportForTesting(null))

const CALLS: ToolCallRecord[] = [
  { id: '1', toolName: 'write_scene_code', input: {}, output: { success: true } },
  { id: '2', toolName: 'write_scene_code', input: {}, output: { success: true } },
  { id: '3', toolName: 'add_narration', input: {}, output: { success: true } },
  { id: '4', toolName: 'broken_tool', input: {}, output: { success: false } },
]

describe('summarizeToolUsage', () => {
  it('histograms successful calls only, most-used first', () => {
    expect(summarizeToolUsage(CALLS)).toBe('write_scene_code×2, add_narration')
  })
})

describe('parseSemanticMemories', () => {
  it('parses valid entries and clamps confidence to 0.8', () => {
    const out = parseSemanticMemories(
      '[{"category":"style","key":"brand_color","value":"#00A86B green","confidence":0.95}]',
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ category: 'style', key: 'brand_color' })
    expect(out[0].confidence).toBe(0.8) // never out-confidences direct observation
  })

  it('drops malformed entries but keeps valid siblings', () => {
    const out = parseSemanticMemories(
      JSON.stringify([
        { category: 'bogus', key: 'x', value: 'y', confidence: 0.5 },
        { category: 'content', key: 'BadKey', value: 'y', confidence: 0.5 },
        { category: 'content', key: 'audience', value: 'chemistry students', confidence: 0.6 },
        { category: 'workflow', key: 'k', value: '', confidence: 0.6 },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('audience')
  })

  it('caps at 5 memories, highest confidence first', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      category: 'content',
      key: `pref_${i}`,
      value: `v${i}`,
      confidence: 0.1 + i * 0.05,
    }))
    const out = parseSemanticMemories(JSON.stringify(many))
    expect(out).toHaveLength(5)
    expect(out[0].key).toBe('pref_7') // highest confidence kept
  })

  it('garbage / non-array → empty, never throws', () => {
    expect(parseSemanticMemories('not json')).toEqual([])
    expect(parseSemanticMemories('{"a":1}')).toEqual([])
  })
})

describe('extractSemanticMemories', () => {
  it('skips trivial messages without calling the model', async () => {
    let called = 0
    __setSemanticMemoryTransportForTesting(async () => {
      called++
      return '[]'
    })
    const out = await extractSemanticMemories({ userMessage: 'make it pop', toolCalls: CALLS })
    expect(out).toEqual([])
    expect(called).toBe(0)
  })

  it('threads message, tool summary, and existing keys into the prompt', async () => {
    let captured = ''
    __setSemanticMemoryTransportForTesting(async (_sys, user) => {
      captured = user
      return '[{"category":"style","key":"brand_color","value":"#00A86B","confidence":0.7}]'
    })
    const out = await extractSemanticMemories({
      userMessage: 'use our brand green #00A86B for everything going forward',
      toolCalls: CALLS,
      existingMemories: [{ key: 'preferred_font', value: 'Inter' }],
    })
    expect(out[0].key).toBe('brand_color')
    expect(captured).toContain('#00A86B')
    expect(captured).toContain('write_scene_code×2')
    expect(captured).toContain('preferred_font: Inter')
  })

  it('transport failure → empty (extraction is additive, never blocking)', async () => {
    __setSemanticMemoryTransportForTesting(async () => null)
    const out = await extractSemanticMemories({
      userMessage: 'a perfectly reasonable long request about brand styling',
      toolCalls: CALLS,
    })
    expect(out).toEqual([])
  })
})

describe('extractSemanticMemories — no-key gate (real path, review)', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_KEY']
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    __setSemanticMemoryTransportForTesting(null) // exercise the REAL callModel path
    saved = {}
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!)
  })

  it('returns [] when no text provider key is configured (no network call)', async () => {
    const res = await extractSemanticMemories({
      userMessage: 'use our brand green #00A86B everywhere',
      toolCalls: [],
      existingMemories: [],
    })
    expect(res).toEqual([])
  })
})

// ── Inferred confidence adjustments from the next message (T2) ───────────────
import {
  inferMemoryAdjustments,
  parseInferredAdjustments,
} from './semantic-memory'
import { INFERRED_DELTA_CAP } from './confidence-pipeline'

describe('parseInferredAdjustments', () => {
  const known = new Set(['style:bg', 'content:audience'])

  it('scales the model judgement into the clamped band and drops unknown keys', () => {
    const out = parseInferredAdjustments(
      '[{"category":"style","key":"bg","delta":1},{"category":"content","key":"audience","delta":-0.5},{"category":"style","key":"ghost","delta":1}]',
      known,
    )
    // delta * INFERRED_DELTA_CAP, clamped
    expect(out.find((a) => a.key === 'bg')?.delta).toBeCloseTo(INFERRED_DELTA_CAP, 5)
    expect(out.find((a) => a.key === 'audience')?.delta).toBeCloseTo(-0.5 * INFERRED_DELTA_CAP, 5)
    // hallucinated key not in the known set is dropped
    expect(out.some((a) => a.key === 'ghost')).toBe(false)
  })

  it('drops zero/invalid deltas and non-array input', () => {
    expect(parseInferredAdjustments('[{"category":"style","key":"bg","delta":0}]', known)).toEqual([])
    expect(parseInferredAdjustments('not json', known)).toEqual([])
    expect(parseInferredAdjustments('{}', known)).toEqual([])
  })
})

describe('inferMemoryAdjustments', () => {
  afterEach(() => __setSemanticMemoryTransportForTesting(null))

  it('returns [] with no existing memories (nothing to infer about)', async () => {
    __setSemanticMemoryTransportForTesting(async () => '[{"category":"style","key":"bg","delta":1}]')
    const res = await inferMemoryAdjustments({ userMessage: 'make the background lighter please now', existingMemories: [] })
    expect(res).toEqual([])
  })

  it('infers a contradiction against an existing key via the transport seam', async () => {
    __setSemanticMemoryTransportForTesting(async () => '[{"category":"style","key":"bg","delta":-1}]')
    const res = await inferMemoryAdjustments({
      userMessage: 'actually I want a light background this time, not dark',
      existingMemories: [{ category: 'style', key: 'bg', value: 'dark backgrounds' }],
    })
    expect(res).toHaveLength(1)
    expect(res[0].delta).toBeCloseTo(-INFERRED_DELTA_CAP, 5)
  })
})
