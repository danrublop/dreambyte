// ── Curated Font Catalog ─────────────────────────────────────────────────────
// Single source of truth for all available fonts in Dreambyte.
// Used by: scene templates (Google Fonts CDN), app UI (@fontsource), agent tools (enum).

export type FontCategory = 'sans-serif' | 'serif' | 'handwritten' | 'monospace' | 'display' | 'system'

export interface CatalogFont {
  id: string
  family: string
  category: FontCategory
  weights: number[]
  googleFontsId: string | null // for CDN URL building; null for system fonts
  fallback: string // CSS fallback stack
}

export const FONT_CATALOG: CatalogFont[] = [
  // ── Sans-serif ──────────────────────────────────────────────
  {
    id: 'satoshi',
    family: 'Satoshi',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: null,
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'figtree',
    family: 'Figtree',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    googleFontsId: 'Figtree',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'sora',
    family: 'Sora',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    googleFontsId: 'Sora',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'manrope',
    family: 'Manrope',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Manrope',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'bricolage-grotesque',
    family: 'Bricolage Grotesque',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Bricolage+Grotesque',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'nunito',
    family: 'Nunito',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Nunito',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'poppins',
    family: 'Poppins',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    googleFontsId: 'Poppins',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'work-sans',
    family: 'Work Sans',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Work+Sans',
    fallback: 'system-ui, sans-serif',
  },

  // ── Serif ───────────────────────────────────────────────────
  {
    id: 'bitter',
    family: 'Bitter',
    category: 'serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Bitter',
    fallback: 'Georgia, serif',
  },
  {
    id: 'vollkorn',
    family: 'Vollkorn',
    category: 'serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Vollkorn',
    fallback: 'Georgia, serif',
  },
  {
    id: 'merriweather',
    family: 'Merriweather',
    category: 'serif',
    weights: [400, 700],
    googleFontsId: 'Merriweather',
    fallback: 'Georgia, serif',
  },
  {
    id: 'source-serif-4',
    family: 'Source Serif 4',
    category: 'serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Source+Serif+4',
    fallback: 'Georgia, serif',
  },

  // ── Handwritten ─────────────────────────────────────────────
  {
    id: 'caveat',
    family: 'Caveat',
    category: 'handwritten',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Caveat',
    fallback: 'cursive',
  },
  {
    id: 'patrick-hand',
    family: 'Patrick Hand',
    category: 'handwritten',
    weights: [400],
    googleFontsId: 'Patrick+Hand',
    fallback: 'cursive',
  },
  {
    id: 'kalam',
    family: 'Kalam',
    category: 'handwritten',
    weights: [400, 700],
    googleFontsId: 'Kalam',
    fallback: 'cursive',
  },
  {
    id: 'architects-daughter',
    family: 'Architects Daughter',
    category: 'handwritten',
    weights: [400],
    googleFontsId: 'Architects+Daughter',
    fallback: 'cursive',
  },

  // ── Monospace ───────────────────────────────────────────────
  {
    id: 'dm-mono',
    family: 'DM Mono',
    category: 'monospace',
    weights: [400, 500],
    googleFontsId: 'DM+Mono',
    fallback: 'monospace',
  },
  {
    id: 'jetbrains-mono',
    family: 'JetBrains Mono',
    category: 'monospace',
    weights: [400, 500, 600, 700],
    googleFontsId: 'JetBrains+Mono',
    fallback: 'monospace',
  },
  {
    id: 'space-mono',
    family: 'Space Mono',
    category: 'monospace',
    weights: [400, 700],
    googleFontsId: 'Space+Mono',
    fallback: 'monospace',
  },
  {
    id: 'fira-code',
    family: 'Fira Code',
    category: 'monospace',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Fira+Code',
    fallback: 'monospace',
  },

  // ── Display ─────────────────────────────────────────────────
  {
    id: 'bebas-neue',
    family: 'Bebas Neue',
    category: 'display',
    weights: [400],
    googleFontsId: 'Bebas+Neue',
    fallback: 'Impact, sans-serif',
  },
  {
    id: 'righteous',
    family: 'Righteous',
    category: 'display',
    weights: [400],
    googleFontsId: 'Righteous',
    fallback: 'Impact, sans-serif',
  },
  {
    id: 'fredoka',
    family: 'Fredoka',
    category: 'display',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Fredoka',
    fallback: 'sans-serif',
  },
  {
    id: 'permanent-marker',
    family: 'Permanent Marker',
    category: 'display',
    weights: [400],
    googleFontsId: 'Permanent+Marker',
    fallback: 'cursive',
  },

  // ── System ──────────────────────────────────────────────────
  {
    id: 'georgia',
    family: 'Georgia',
    category: 'system',
    weights: [400, 700],
    googleFontsId: null,
    fallback: 'serif',
  },
  {
    id: 'system-mono',
    family: 'monospace',
    category: 'system',
    weights: [400],
    googleFontsId: null,
    fallback: '',
  },
]

// ── Legacy fonts (removed from agent selection but still renderable for existing scenes) ──

export const LEGACY_FONTS: CatalogFont[] = [
  {
    id: 'inter',
    family: 'Inter',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    googleFontsId: 'Inter',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'outfit',
    family: 'Outfit',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    googleFontsId: 'Outfit',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'plus-jakarta-sans',
    family: 'Plus Jakarta Sans',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Plus+Jakarta+Sans',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'space-grotesk',
    family: 'Space Grotesk',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Space+Grotesk',
    fallback: 'system-ui, sans-serif',
  },
  {
    id: 'playfair-display',
    family: 'Playfair Display',
    category: 'serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Playfair+Display',
    fallback: 'Georgia, serif',
  },
  {
    id: 'lora',
    family: 'Lora',
    category: 'serif',
    weights: [400, 500, 600, 700],
    googleFontsId: 'Lora',
    fallback: 'Georgia, serif',
  },
]

// ── Font Pairings ───────────────────────────────────────────────────────────

export interface FontPairing {
  id: string
  name: string
  heading: string // family name for headings/display
  body: string // family name for body text
  mood: string[] // for agent selection guidance
}

export const FONT_PAIRINGS: FontPairing[] = [
  {
    id: 'impact-friendly',
    name: 'Impact + Friendly',
    heading: 'Bebas Neue',
    body: 'Nunito',
    mood: ['bold', 'approachable', 'educational'],
  },
  {
    id: 'editorial-clean',
    name: 'Editorial + Clean',
    heading: 'Merriweather',
    body: 'Work Sans',
    mood: ['editorial', 'professional', 'documentary'],
  },
  {
    id: 'geometric-warmth',
    name: 'Geometric + Warmth',
    heading: 'Sora',
    body: 'Bitter',
    mood: ['modern', 'warm', 'trustworthy'],
  },
  {
    id: 'handmade-modern',
    name: 'Handmade + Modern',
    heading: 'Caveat',
    body: 'Figtree',
    mood: ['casual', 'creative', 'whiteboard'],
  },
  {
    id: 'bold-precise',
    name: 'Bold + Precise',
    heading: 'Righteous',
    body: 'Manrope',
    mood: ['energetic', 'technical', 'startup'],
  },
  {
    id: 'display-grotesk',
    name: 'Display + Grotesk',
    heading: 'Fredoka',
    body: 'Bricolage Grotesque',
    mood: ['playful', 'distinctive', 'kids'],
  },
  {
    id: 'classic-sans',
    name: 'Classic + Sans',
    heading: 'Vollkorn',
    body: 'Sora',
    mood: ['scholarly', 'elegant', 'data'],
  },
  {
    id: 'marker-clean',
    name: 'Marker + Clean',
    heading: 'Permanent Marker',
    body: 'Work Sans',
    mood: ['raw', 'informal', 'sketch'],
  },
  {
    id: 'mono-serif',
    name: 'Mono + Serif',
    heading: 'JetBrains Mono',
    body: 'Source Serif 4',
    mood: ['technical', 'code', 'developer'],
  },
  {
    id: 'grotesk-text',
    name: 'Grotesk + Text',
    heading: 'Bricolage Grotesque',
    body: 'Nunito',
    mood: ['quirky', 'friendly', 'explainer'],
  },
]

export const FONT_PAIRING_IDS: string[] = FONT_PAIRINGS.map((p) => p.id)

export function getFontPairing(id: string): FontPairing | undefined {
  return FONT_PAIRINGS.find((p) => p.id === id)
}

// ── Derived lookups ──────────────────────────────────────────────────────────

// Include legacy fonts in rendering lookups so existing scenes still work
const _allFonts = [...FONT_CATALOG, ...LEGACY_FONTS]
const _byId = new Map(_allFonts.map((f) => [f.id, f]))
const _byFamily = new Map(_allFonts.map((f) => [f.family, f]))

/** All font family names (for agent tool enums) */
export const FONT_FAMILIES: string[] = FONT_CATALOG.map((f) => f.family)

/** Is this font family in our curated catalog? */
export function isValidFont(family: string): boolean {
  return _byFamily.has(family)
}

// ── Google Fonts URL builders (for scene HTML) ───────────────────────────────

function buildWeightSpec(font: CatalogFont): string {
  const weights = font.weights.sort((a, b) => a - b).join(';')
  return `family=${font.googleFontsId}:wght@${weights}`
}

/** Resolve catalog **family** name from a UI value that may be either `family` or `id` (e.g. `Inter` vs `inter`). */
export function resolveSceneFontFamily(familyOrId: string | null | undefined): string {
  if (!familyOrId?.trim()) return 'Nunito'
  const font = _byFamily.get(familyOrId) ?? _byId.get(familyOrId)
  return font?.family ?? familyOrId
}

/** CSS font stack: quoted primary + catalog fallback or system UI. */
export function sceneFontCssStack(familyOrId: string | null | undefined): string {
  const font = _byFamily.get(familyOrId ?? '') ?? _byId.get(familyOrId ?? '')
  const primary = font?.family ?? (familyOrId?.trim() || 'Nunito')
  const tail = font?.fallback ? `, ${font.fallback}` : ', system-ui, sans-serif'
  return `'${primary.replace(/'/g, "\\'")}'${tail}`
}

/** Build a Google Fonts <link> tag for a single font family. `familyOrId` may be catalog **id** or **family**. Returns '' for system-only fonts. */
export function buildFontLink(familyOrId: string | null | undefined): string {
  if (!familyOrId?.trim()) return ''
  const font = _byFamily.get(familyOrId) ?? _byId.get(familyOrId)
  if (!font || !font.googleFontsId) return ''
  const url = `https://fonts.googleapis.com/css2?${buildWeightSpec(font)}&display=swap`
  return `<link href="${url}" rel="stylesheet">`
}

/** Build a single Google Fonts <link> tag loading multiple fonts at once. */
export function buildMultiFontLink(families: string[]): string {
  const specs = families
    .map((f) => _byFamily.get(f))
    .filter((f): f is CatalogFont => !!f && !!f.googleFontsId)
    .map(buildWeightSpec)
  if (specs.length === 0) return ''
  const url = `https://fonts.googleapis.com/css2?${specs.join('&')}&display=swap`
  return `<link href="${url}" rel="stylesheet">`
}

/** Category display labels */
export const CATEGORY_LABELS: Record<FontCategory, string> = {
  'sans-serif': 'Sans Serif',
  serif: 'Serif',
  handwritten: 'Handwritten',
  monospace: 'Monospace',
  display: 'Display',
  system: 'System',
}
