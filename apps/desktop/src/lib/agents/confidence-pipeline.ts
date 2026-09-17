/**
 * Memory confidence pipeline — turns no-UI taste signals into
 * PER-KEY confidence adjustments.
 *
 * The dead code this replaces moved EVERY memory sharing a runId on a single
 * thumbs/regenerate — the mis-attribution bug. Here, every signal names the
 * specific (category, key) it moves, so a regenerate of a visual layer never
 * touches an unrelated `content`/`workflow` memory.
 *
 * Three no-UI signals (decision 3 of the plan):
 *   - regenerate           −0.10  the agent's guess was rejected and re-rolled
 *   - keep + export        +0.08  the output was confirmed good (shipped)
 *   - inferred(next-msg)   ±0.05  the user's next message confirms/contradicts
 *                                 an existing memory (clamped low; LLM may misread)
 *
 * Producers return explicit { category, key, delta } adjustments; the runner
 * applies each via adjustMemoryKeyConfidence (clamped [0,1] in SQL).
 *
 * Attribution principle: a visual REGENERATE / EXPORT is a signal about the
 * STYLE memories that shaped the look. It is scoped to category 'style' so a
 * domain memory ("content: audience=students") is never moved by the user
 * re-rolling a gradient. Content/workflow/feedback keys stay put unless a
 * signal can NAME them (only the inferred-next-message path can).
 */

import type { ToolCallRecord } from './types'

export const REGENERATE_DELTA = -0.1
export const KEEP_EXPORT_DELTA = 0.08
/** Inferred deltas are clamped to this magnitude (an LLM read of prose). */
export const INFERRED_DELTA_CAP = 0.05

export interface ActiveMemory {
  category: string
  key: string
}

export interface ConfidenceAdjustment {
  category: string
  key: string
  delta: number
  reason: 'regenerate' | 'keep_export' | 'inferred'
}

const REGENERATE_TOOLS = new Set(['regenerate_layer'])
const EXPORT_TOOLS = new Set(['export'])

function succeeded(tc: ToolCallRecord): boolean {
  // success defaults true unless the tool explicitly reported failure (matches
  // the run-analytics convention `output?.success !== false`).
  return tc.output?.success !== false
}

/**
 * Compute per-key confidence adjustments for a completed run.
 *
 * @param toolCalls       the run's tool log
 * @param activeMemories  the memories that were INJECTED into this run's prompt
 *                        (the only keys a generation could have been shaped by)
 * @param inferred        explicit per-key deltas from the semantic next-message
 *                        pass (already clamped to ±INFERRED_DELTA_CAP)
 */
export function computeConfidenceAdjustments(opts: {
  toolCalls: ToolCallRecord[]
  activeMemories: ActiveMemory[]
  inferred?: Array<{ category: string; key: string; delta: number }>
}): ConfidenceAdjustment[] {
  const { toolCalls, activeMemories } = opts
  const out: ConfidenceAdjustment[] = []

  const regenerated = toolCalls.some((tc) => REGENERATE_TOOLS.has(tc.toolName) && succeeded(tc))
  const exported = toolCalls.some((tc) => EXPORT_TOOLS.has(tc.toolName) && succeeded(tc))

  // Only STYLE memories are implicated by a visual regenerate/export — scoping
  // here is the attribution fix (unrelated categories are never moved).
  const activeStyleKeys = activeMemories.filter((m) => m.category === 'style')

  // regenerate − : the look the style memory steered was rejected. If the run
  // ALSO exported afterward, the net was a keep — skip the negative (the export
  // signal below confirms it) so a single re-roll mid-session isn't punished.
  if (regenerated && !exported) {
    for (const m of activeStyleKeys) {
      out.push({ category: m.category, key: m.key, delta: REGENERATE_DELTA, reason: 'regenerate' })
    }
  }

  // keep + export + : the output shipped, confirming the style memories used.
  if (exported) {
    for (const m of activeStyleKeys) {
      out.push({ category: m.category, key: m.key, delta: KEEP_EXPORT_DELTA, reason: 'keep_export' })
    }
  }

  // inferred(next message): explicit per-key, clamped. These can name ANY
  // category because the model read the user's words about that exact pref.
  for (const inf of opts.inferred ?? []) {
    const delta = Math.max(-INFERRED_DELTA_CAP, Math.min(INFERRED_DELTA_CAP, inf.delta))
    if (delta === 0) continue
    out.push({ category: inf.category, key: inf.key, delta, reason: 'inferred' })
  }

  return out
}
