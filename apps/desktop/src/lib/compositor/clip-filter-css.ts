/**
 * Clip visual effects → CSS, the SHARED mapping for the DOM composite (preview
 * via PreviewPlayer + export via composite-host). This is the unify's filter
 * parity layer: a clip's `filters`/`blendMode` render identically wherever a DOM
 * `<video>`/`<img>` is styled, so preview and export agree.
 *
 * Pure + dependency-free (no Pixi) — usable in the React preview AND in the
 * export host's serialized controller string.
 *
 *   ClipFilter[]            → `filter: blur(2px) brightness(1.2) ...`
 *   clip.blendMode          → `mix-blend-mode: multiply`
 *
 * Parity note: CSS `filter` ≈ Pixi `ColorMatrixFilter`, not pixel-identical
 * (gamma sRGB vs premultiplied GPU); the all-DOM preview and export share it. `tone-curve`
 * is a LUT remap with NO CSS equivalent → skipped (documented degrade).
 */

import type { ClipFilter } from '../types'

/** One ClipFilter → a single CSS `filter` function, or null when it has no CSS form. */
function filterToCss(f: ClipFilter): string | null {
  switch (f.type) {
    case 'blur':
      return `blur(${Math.max(0, f.value)}px)`
    case 'brightness':
      // CSS brightness(1)=identity, Pixi ColorMatrix.brightness(1)=identity — same convention.
      return `brightness(${Math.max(0, f.value)})`
    case 'contrast':
      return `contrast(${Math.max(0, f.value)})`
    case 'saturate':
      return `saturate(${Math.max(0, f.value)})`
    case 'grayscale':
      return `grayscale(${clamp01(f.value)})`
    case 'sepia':
      return `sepia(${clamp01(f.value)})`
    case 'hue-rotate':
      return `hue-rotate(${f.value}deg)`
    case 'tone-curve':
      // LUT remap — no CSS equivalent. Skip (matches the Pixi path returning null
      // for identity curves; a future canvas/WebGL-LUT pass per element could cover it).
      return null
    default:
      return null
  }
}

/**
 * Build the CSS `filter` VALUE (space-joined functions) for a clip's filters.
 * Returns '' when there are no CSS-mappable filters (caller omits the property).
 */
export function clipFiltersToCss(filters: ClipFilter[] | undefined | null): string {
  if (!filters || filters.length === 0) return ''
  const parts: string[] = []
  for (const f of filters) {
    const css = filterToCss(f)
    if (css) parts.push(css)
  }
  return parts.join(' ')
}

/**
 * Map a clip blend-mode string to a CSS `mix-blend-mode` value. Most modes map
 * 1:1; `add` → `plus-lighter` (the additive CSS mode); `subtract` has no CSS
 * equivalent → `normal` (degrade). Unknown / undefined → '' (caller omits).
 */
export function clipBlendModeToCss(mode: string | undefined | null): string {
  switch (mode) {
    case undefined:
    case null:
    case '':
    case 'normal':
      return ''
    case 'multiply':
    case 'screen':
    case 'overlay':
    case 'darken':
    case 'lighten':
    case 'color-dodge':
    case 'color-burn':
    case 'hard-light':
    case 'soft-light':
    case 'difference':
    case 'exclusion':
    case 'hue':
    case 'saturation':
    case 'color':
    case 'luminosity':
      return mode
    case 'add':
      return 'plus-lighter' // additive — the closest CSS mix-blend-mode
    case 'subtract':
      return '' // no CSS equivalent → treat as normal (degrade)
    default:
      return ''
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
