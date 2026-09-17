'use client'

import { whiteBalanceGains, gradeTransferTables } from '@/lib/compositor/clip-grade-css'
import type { ClipColorGrade } from '@/lib/edit-engines/clip-grade'

/**
 * Hidden SVG <filter> for a COMMITTED per-clip color grade (ClipColorGrade),
 * referenced by a scene iframe's css `filter` via `url(#clip-grade-<clipId>)`.
 *
 * Structured JSX (no markup strings, nothing to sanitize) — the editor-document twin
 * of the export host's injected filter. It MUST match compileClipGradeCss's
 * `svgFilterContent` node-for-node (feColorMatrix white-balance, then the
 * feComponentTransfer transfer tables, same order) so the preview and the MP4 export
 * resolve the identical filter → preview == export. LUT + hue curves have no SVG
 * form and are applied only to media clips via the WebGL tier.
 */
export function ClipGradeSvgFilter({ grade, id }: { grade: ClipColorGrade; id: string }) {
  const tempK = grade.temperature ?? 6500
  const tint = grade.tint ?? 0
  const gains = Math.abs(tempK - 6500) > 1 || Math.abs(tint) > 1e-4 ? whiteBalanceGains(tempK, tint) : null
  const tables = gradeTransferTables(grade)
  if (!gains && !tables) return null
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter id={id} colorInterpolationFilters="sRGB">
        {gains && (
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
      </filter>
    </svg>
  )
}
