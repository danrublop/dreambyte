/**
 * CSS-filter bridge for grades on SCENE layers (grading UI, layer-panel pass).
 *
 * Timeline footage clips store grades as ClipFilter[] (rendered by Pixi);
 * scene-wrapped media (a video/image dropped onto the timeline becomes its
 * own scene) renders through scene HTML, where the same grade primitives map
 * 1:1 onto CSS filter functions. These helpers convert between the two so
 * detectGrade/resolveGradeFilters stay the single source of truth for looks.
 */

import type { ClipFilter } from '@/lib/types'

const UNIT: Record<string, (v: number) => string> = {
  brightness: (v) => `brightness(${round(v)})`,
  contrast: (v) => `contrast(${round(v)})`,
  saturate: (v) => `saturate(${round(v)})`,
  grayscale: (v) => `grayscale(${round(v)})`,
  sepia: (v) => `sepia(${round(v)})`,
  'hue-rotate': (v) => `hue-rotate(${round(v)}deg)`,
  blur: (v) => `blur(${round(v)}px)`,
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** ClipFilter[] → CSS filter string (stable order = input order). */
export function filtersToCss(filters: ClipFilter[]): string {
  return filters
    .map((f) => UNIT[f.type]?.(f.value))
    .filter(Boolean)
    .join(' ')
}

export interface ParsedCssFilters {
  filters: ClipFilter[]
  /** True when the string contained functions we don't model (url(), drop-shadow…). */
  hasUnknown: boolean
}

const FN_RE = /([a-z-]+)\(([^)]*)\)/gi

/** CSS filter string → ClipFilter[] (unknown functions flagged, not parsed). */
export function parseCssFilters(css: string | undefined | null): ParsedCssFilters {
  const filters: ClipFilter[] = []
  let hasUnknown = false
  if (!css?.trim()) return { filters, hasUnknown }
  for (const m of css.matchAll(FN_RE)) {
    const fn = m[1].toLowerCase()
    const raw = m[2].trim()
    if (!(fn in UNIT)) {
      hasUnknown = true
      continue
    }
    const value = parseFloat(raw)
    if (!Number.isFinite(value)) {
      hasUnknown = true
      continue
    }
    // % forms normalize to the unitless convention (brightness(112%) → 1.12),
    // except hue-rotate/blur which are deg/px.
    const isPercent = raw.endsWith('%')
    const normalized = fn === 'hue-rotate' || fn === 'blur' ? value : isPercent ? value / 100 : value
    filters.push({ type: fn as ClipFilter['type'], value: normalized })
  }
  return { filters, hasUnknown }
}
