import type { GlobalStyle } from './types'
import { FONT_CATALOG } from './fonts/catalog'

/** CSS `font-family` value for app chrome (settings, header, panels). */
export function resolveUIFontStack(gs: Pick<GlobalStyle, 'uiTypography' | 'uiFontFamily'>): string {
  const mode = gs.uiTypography ?? 'app'
  if (mode === 'system') {
    return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  }
  if (mode === 'app') {
    // Inter is the facelift face (docs/EDITOR-DESIGN.md). Geist/system are fallback only.
    return '"Inter Variable", "Inter", var(--font-geist-sans), Geist, ui-sans-serif, system-ui, -apple-system, sans-serif'
  }
  const name = (gs.uiFontFamily ?? 'Inter').trim() || 'Inter'
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const entry = FONT_CATALOG.find((f) => f.family === name)
  return `"${escaped}", ${entry?.fallback ?? 'system-ui, sans-serif'}`
}
