/**
 * Color-grade presets — agent-addressable looks composed from
 * the EXISTING ClipFilter primitives, so they render in the Pixi preview and
 * export identically with zero new filter plumbing.
 *
 * Conventions (must match src/lib/compositor/filters.ts + ClipInspector):
 *   brightness / contrast / saturate — 1 = neutral
 *   grayscale / sepia               — 0..1, 0 = none
 *   hue-rotate                      — degrees, 0 = none
 *
 * `intensity` (0..1, default 1) lerps every value toward its neutral, so
 * "warm at 0.4" is a subtle warm rather than a different recipe. Switching
 * grades REPLACES the grade-managed filter types (else noir's grayscale
 * would bleed into a later warm); `blur` is deliberately not grade-managed —
 * it's a spatial effect users set independently.
 */

import type { ClipFilter } from '@/lib/types'

export interface ColorGrade {
  id: string
  name: string
  description: string
  filters: ClipFilter[]
}

/** Filter types a grade may own — applying/clearing a grade only touches these. */
export const GRADE_FILTER_TYPES: ReadonlyArray<ClipFilter['type']> = [
  'brightness',
  'contrast',
  'saturate',
  'grayscale',
  'sepia',
  'hue-rotate',
]

export const COLOR_GRADES: ColorGrade[] = [
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Deeper contrast, slightly lifted saturation, a hint of warmth',
    filters: [
      { type: 'contrast', value: 1.12 },
      { type: 'saturate', value: 1.12 },
      { type: 'brightness', value: 0.97 },
      { type: 'sepia', value: 0.06 },
    ],
  },
  {
    id: 'warm',
    name: 'Warm',
    description: 'Golden-hour warmth — gentle sepia and saturation lift',
    filters: [
      { type: 'sepia', value: 0.18 },
      { type: 'saturate', value: 1.1 },
      { type: 'brightness', value: 1.03 },
    ],
  },
  {
    id: 'cool',
    name: 'Cool',
    description: 'Cooler cast with a touch more contrast',
    filters: [
      { type: 'hue-rotate', value: 12 },
      { type: 'saturate', value: 1.05 },
      { type: 'contrast', value: 1.06 },
    ],
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Black & white with punchy contrast',
    filters: [
      { type: 'grayscale', value: 1 },
      { type: 'contrast', value: 1.22 },
      { type: 'brightness', value: 0.96 },
    ],
  },
  {
    id: 'faded',
    name: 'Faded',
    description: 'Washed film look — lowered contrast and saturation, lifted blacks',
    filters: [
      { type: 'contrast', value: 0.88 },
      { type: 'saturate', value: 0.82 },
      { type: 'brightness', value: 1.06 },
    ],
  },
  {
    id: 'vivid',
    name: 'Vivid',
    description: 'Punchy social-media saturation and contrast',
    filters: [
      { type: 'saturate', value: 1.32 },
      { type: 'contrast', value: 1.08 },
    ],
  },
]

/** Neutral value per grade-managed type (lerp target for intensity). */
function neutralFor(type: ClipFilter['type']): number {
  switch (type) {
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return 1
    default:
      return 0 // grayscale, sepia, hue-rotate
  }
}

export function getColorGrade(id: string): ColorGrade | null {
  return COLOR_GRADES.find((g) => g.id === id) ?? null
}

/**
 * Resolve a grade's filters at the given intensity (0..1, clamped; 1 = the
 * recipe as written, 0 = fully neutral → empty list). Values that land on
 * their neutral are dropped rather than emitted as no-op filters.
 */
export function resolveGradeFilters(gradeId: string, intensity = 1): ClipFilter[] | null {
  const grade = getColorGrade(gradeId)
  if (!grade) return null
  const t = Math.max(0, Math.min(1, intensity))
  const out: ClipFilter[] = []
  for (const f of grade.filters) {
    const neutral = neutralFor(f.type)
    const value = neutral + (f.value - neutral) * t
    if (Math.abs(value - neutral) < 1e-9) continue
    out.push({ type: f.type, value: Number(value.toFixed(4)) })
  }
  return out
}
