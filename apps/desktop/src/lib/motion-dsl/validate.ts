// MotionRef validation — catches agent typos with close-match suggestions.
//
// `animate_layer({preset: 'fadInUp'})` should not silently no-op. The
// validator returns either {ok: true} or {ok: false, error, suggestions}
// so the tool handler can throw a clear, agent-correctable error.

import type { MotionRef } from './types'
import { MOTION_PRESET_IDS, getMotionPreset } from './presets.generated'
import { isSpringName } from './springs'

export type ValidationResult = { ok: true } | { ok: false; error: string; suggestions?: ReadonlyArray<string> }

/**
 * Returns up to N preset ids whose Levenshtein distance from `query` is
 * smallest. Ties broken by preset alphabetical order. Empty array means
 * no plausible match (likely a category typo, not a spelling typo).
 */
export function suggestPresetId(query: string, max = 3): ReadonlyArray<string> {
  const lowered = query.toLowerCase()
  const scored = MOTION_PRESET_IDS.map((id) => ({ id, d: levenshtein(lowered, id.toLowerCase()) }))
  scored.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.id.localeCompare(b.id)))
  // Cut off when distance exceeds half the query length — prevents
  // returning every preset for an empty/junk query.
  const cutoff = Math.max(2, Math.ceil(query.length / 2))
  return scored
    .filter((s) => s.d <= cutoff)
    .slice(0, max)
    .map((s) => s.id)
}

export function validateMotionRef(ref: unknown): ValidationResult {
  if (typeof ref !== 'object' || ref === null) {
    return { ok: false, error: 'MotionRef must be an object' }
  }
  const r = ref as Record<string, unknown>
  if (typeof r.kind !== 'string') {
    return { ok: false, error: 'MotionRef.kind is required and must be a string' }
  }
  if (r.kind === 'preset') {
    if (typeof r.preset !== 'string' || r.preset.length === 0) {
      return { ok: false, error: 'preset id is required' }
    }
    if (!getMotionPreset(r.preset)) {
      const suggestions = suggestPresetId(r.preset)
      return {
        ok: false,
        error: `Unknown preset "${r.preset}"`,
        suggestions,
      }
    }
    if (r.spring !== undefined && (typeof r.spring !== 'string' || !isSpringName(r.spring))) {
      return { ok: false, error: `Unknown spring "${r.spring}" — use one of: gentle, wobbly, stiff, slow, molasses` }
    }
    return { ok: true }
  }
  if (r.kind === 'spring') {
    if (typeof r.spring !== 'string' || !isSpringName(r.spring)) {
      return { ok: false, error: 'spring is required and must be one of: gentle, wobbly, stiff, slow, molasses' }
    }
    if (typeof r.from !== 'object' || r.from === null)
      return { ok: false, error: 'from is required and must be an object' }
    if (typeof r.to !== 'object' || r.to === null) return { ok: false, error: 'to is required and must be an object' }
    return { ok: true }
  }
  if (r.kind === 'custom') {
    if (!Array.isArray(r.keyframes) || r.keyframes.length < 2) {
      return { ok: false, error: 'custom MotionRef requires at least 2 keyframes' }
    }
    if (typeof r.durationFrames !== 'number' || r.durationFrames <= 0) {
      return { ok: false, error: 'durationFrames is required and must be > 0' }
    }
    return { ok: true }
  }
  return { ok: false, error: `Unknown MotionRef.kind "${String(r.kind)}" — expected preset | spring | custom` }
}

// ── Levenshtein, iterative + O(min(a,b)) memory ───────────────────────────

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // Ensure b is the shorter — keeps memory minimal.
  if (a.length < b.length) {
    const tmp = a
    a = b
    b = tmp
  }
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const t = prev
    prev = curr
    curr = t
  }
  return prev[b.length]
}
