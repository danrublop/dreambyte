/**
 * Grade detection + hover-preview substitution.
 *
 * The Grade pill must REFLECT state it didn't necessarily create — the agent
 * writes the same ClipFilter primitives via apply_color_grade, and the user
 * can hand-edit filter values in the Effects tab. Detection inverts
 * resolveGradeFilters: find the (grade, intensity) whose resolved set matches
 * the clip's grade-managed filters exactly; anything else is 'custom' (some
 * grade-managed filters exist but match no preset) or null (none exist).
 */

import type { Clip, ClipFilter, Timeline } from '@/lib/types'
import { COLOR_GRADES, GRADE_FILTER_TYPES, resolveGradeFilters } from './color-grades'

export interface DetectedGrade {
  gradeId: string
  /** 0..1 — recovered from the filter values. */
  intensity: number
}

const EPS = 0.005

function neutralFor(type: ClipFilter['type']): number {
  switch (type) {
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return 1
    default:
      return 0
  }
}

/** The clip's grade-managed filters (blur/blend are never grade-owned). */
export function gradeManagedFilters(filters: ClipFilter[]): ClipFilter[] {
  const managed = new Set<string>(GRADE_FILTER_TYPES)
  return filters.filter((f) => managed.has(f.type))
}

/**
 * Detect which preset (at which intensity) produced the clip's grade-managed
 * filters. Returns null when none exist, 'custom' when they match no preset.
 */
export function detectGrade(filters: ClipFilter[]): DetectedGrade | 'custom' | null {
  const managed = gradeManagedFilters(filters)
  if (managed.length === 0) return null

  for (const grade of COLOR_GRADES) {
    // Recover intensity from the first recipe filter present on the clip:
    // value = neutral + (recipe - neutral) × t  →  t = (value - neutral) / (recipe - neutral)
    const probe = grade.filters[0]
    const onClip = managed.find((f) => f.type === probe.type)
    if (!onClip) continue
    const denom = probe.value - neutralFor(probe.type)
    if (Math.abs(denom) < 1e-9) continue
    const t = (onClip.value - neutralFor(probe.type)) / denom
    if (t < EPS || t > 1 + EPS) continue
    const resolved = resolveGradeFilters(grade.id, Math.min(1, t))
    if (!resolved) continue
    // Exact-set match: same types, same values (within EPS), nothing extra.
    if (resolved.length !== managed.length) continue
    const ok = resolved.every((r) => {
      const m = managed.find((f) => f.type === r.type)
      return m && Math.abs(m.value - r.value) < EPS
    })
    if (ok) return { gradeId: grade.id, intensity: Math.min(1, Math.round(t * 100) / 100) }
  }
  return 'custom'
}

/** The clip's filters with the grade-managed subset swapped for `gradeFilters`
 *  (blur/tone-curve/blend preserved). Used to compose hover previews and
 *  commits alike. */
export function composeGradeFilters(clipFilters: ClipFilter[], gradeFilters: ClipFilter[]): ClipFilter[] {
  const managed = new Set<string>(GRADE_FILTER_TYPES)
  return [...clipFilters.filter((f) => !managed.has(f.type)), ...gradeFilters]
}

/**
 * Hover-preview substitution: a timeline whose target clip renders with the
 * override's complete filter list (the caller composes it — grade hovers via
 * composeGradeFilters, curve drags by swapping the tone-curve entry).
 * Pure — the caller memoizes; nothing is persisted and no undo entry exists,
 * which is the entire point of previewing on hover.
 */
export function applyGradePreview(
  timeline: Timeline | null | undefined,
  override: { clipId: string; filters: ClipFilter[] } | null,
): Timeline | null | undefined {
  if (!timeline || !override) return timeline
  let touched = false
  const tracks = timeline.tracks.map((t) => {
    if (!t.clips.some((c) => c.id === override.clipId)) return t
    touched = true
    return {
      ...t,
      clips: t.clips.map((c): Clip => (c.id === override.clipId ? { ...c, filters: override.filters } : c)),
    }
  })
  return touched ? { ...timeline, tracks } : timeline
}
