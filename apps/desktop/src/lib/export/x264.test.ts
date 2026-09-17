// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { X264_QUALITY_PARAMS } from './x264'

/**
 * Drift guard: packages/render-server/stitcher.js is plain JS in a separate package, so
 * it can't import the constant — it carries inline copies. If the tuning ever
 * changes in one place but not the other, the caption burn-in re-encode (or
 * the stitch itself) silently diverges in quality. This test pins them.
 */
describe('X264_QUALITY_PARAMS — single source of truth', () => {
  it('matches every inline copy in packages/render-server/stitcher.js', () => {
    const stitcher = readFileSync(path.join(__dirname, '../../../../../packages/render-server/stitcher.js'), 'utf-8')
    const inlineCopies = stitcher.match(/-x264-params ([^']+)'/g) ?? []
    expect(inlineCopies.length).toBeGreaterThanOrEqual(3) // cuts-reencode + 2 xfade passes
    for (const copy of inlineCopies) {
      expect(copy).toBe(`-x264-params ${X264_QUALITY_PARAMS}'`)
    }
  })
})
