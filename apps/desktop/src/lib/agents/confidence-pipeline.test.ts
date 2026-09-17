// T2 — confidence pipeline (per-signal, PER KEY). Proves attribution:
//   - regenerate → negative delta on the touched (style) key ONLY
//   - keep+export → positive on the style key
//   - inferred → clamped to ±INFERRED_DELTA_CAP
//   - unrelated categories (content/workflow) are NEVER moved by a visual signal

import { describe, expect, it } from 'vitest'
import {
  computeConfidenceAdjustments,
  REGENERATE_DELTA,
  KEEP_EXPORT_DELTA,
  INFERRED_DELTA_CAP,
  type ActiveMemory,
} from './confidence-pipeline'
import type { ToolCallRecord } from './types'

function tc(toolName: string, success = true): ToolCallRecord {
  return { toolName, input: {}, output: { success } } as unknown as ToolCallRecord
}

const active: ActiveMemory[] = [
  { category: 'style', key: 'bg' },
  { category: 'style', key: 'palette' },
  { category: 'content', key: 'audience' }, // must NOT be moved by a visual signal
  { category: 'workflow', key: 'tempo' },
]

describe('computeConfidenceAdjustments (T2 attribution)', () => {
  it('regenerate (no export) lowers ONLY style keys', () => {
    const adj = computeConfidenceAdjustments({
      toolCalls: [tc('regenerate_layer')],
      activeMemories: active,
    })
    expect(adj.every((a) => a.category === 'style')).toBe(true)
    expect(adj.every((a) => a.delta === REGENERATE_DELTA && a.reason === 'regenerate')).toBe(true)
    expect(adj.map((a) => a.key).sort()).toEqual(['bg', 'palette'])
    // content/workflow keys untouched — the attribution fix.
    expect(adj.some((a) => a.key === 'audience' || a.key === 'tempo')).toBe(false)
  })

  it('export raises ONLY style keys', () => {
    const adj = computeConfidenceAdjustments({
      toolCalls: [tc('export')],
      activeMemories: active,
    })
    expect(adj.every((a) => a.category === 'style' && a.delta === KEEP_EXPORT_DELTA)).toBe(true)
    expect(adj.some((a) => a.key === 'audience')).toBe(false)
  })

  it('regenerate followed by export nets to keep (no negative)', () => {
    const adj = computeConfidenceAdjustments({
      toolCalls: [tc('regenerate_layer'), tc('export')],
      activeMemories: active,
    })
    expect(adj.every((a) => a.delta === KEEP_EXPORT_DELTA)).toBe(true)
  })

  it('a failed regenerate is not a signal', () => {
    const adj = computeConfidenceAdjustments({
      toolCalls: [tc('regenerate_layer', false)],
      activeMemories: active,
    })
    expect(adj).toHaveLength(0)
  })

  it('inferred deltas are clamped to ±INFERRED_DELTA_CAP and can name any category', () => {
    const adj = computeConfidenceAdjustments({
      toolCalls: [],
      activeMemories: active,
      inferred: [
        { category: 'content', key: 'audience', delta: 0.9 }, // over cap → clamped
        { category: 'workflow', key: 'tempo', delta: -5 }, // under cap → clamped
        { category: 'style', key: 'bg', delta: 0 }, // zero → dropped
      ],
    })
    const audience = adj.find((a) => a.key === 'audience')
    const tempo = adj.find((a) => a.key === 'tempo')
    expect(audience?.delta).toBe(INFERRED_DELTA_CAP)
    expect(tempo?.delta).toBe(-INFERRED_DELTA_CAP)
    expect(adj.some((a) => a.key === 'bg')).toBe(false)
    expect(adj.every((a) => a.reason === 'inferred')).toBe(true)
  })

  it('no signals and no inferred → no adjustments', () => {
    expect(computeConfidenceAdjustments({ toolCalls: [tc('create_scene')], activeMemories: active })).toHaveLength(0)
  })
})
