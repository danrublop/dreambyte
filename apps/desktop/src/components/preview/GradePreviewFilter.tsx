'use client'

import {
  gradeNeedsSvgFilter,
  temperatureTintGains,
  gradeTransferTables,
  sharpenMatrix,
  type LayerColorGrade,
} from '@/lib/edit-engines/layer-grade'

/**
 * Hidden SVG filter for the grade hover-preview — the editor-document twin of
 * the filter the scene template bakes on commit (same engine, same math).
 * The scene iframe's css `filter` references it via
 * `url(#dreambyte-grade-preview)`. Rendered as structured JSX from the grade
 * object — no markup strings, nothing to sanitize.
 */
export function GradePreviewFilter({ grade }: { grade: LayerColorGrade }) {
  if (!gradeNeedsSvgFilter(grade)) return null
  const needsWb = Math.abs(grade.temperature ?? 0) > 1e-4 || Math.abs(grade.tint ?? 0) > 1e-4
  const gains = temperatureTintGains(grade.temperature ?? 0, grade.tint ?? 0)
  const tables = gradeTransferTables(grade)
  const sharpen = sharpenMatrix(grade.sharpen ?? 0)
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter id="dreambyte-grade-preview" colorInterpolationFilters="sRGB">
        {needsWb && (
          <feColorMatrix
            type="matrix"
            values={`${gains.r} 0 0 0 0  0 ${gains.g} 0 0 0  0 0 ${gains.b} 0 0  0 0 0 1 0`}
          />
        )}
        {tables && (
          <feComponentTransfer>
            <feFuncR type="table" tableValues={tables.r} />
            <feFuncG type="table" tableValues={tables.g} />
            <feFuncB type="table" tableValues={tables.b} />
          </feComponentTransfer>
        )}
        {sharpen && <feConvolveMatrix order="3" kernelMatrix={sharpen} preserveAlpha="true" />}
      </filter>
    </svg>
  )
}
