/**
 * Reference-design style tokens (design matching).
 *
 * The multimodal intake pipeline (`buildUnderstandingBrief`) digests attached
 * reference media into prose + a few loosely-structured fields. To actually
 * "match a reference design" we need those signals in a STRUCTURED, consumable
 * shape that three consumers share:
 *   - create_design_brief (seed/augment the DESIGN.md)
 *   - project-scoped memory (personalize future generations via the single
 *     prompt-injection path)
 *   - generate_image_from_reference (enrich the i2i generation prompt)
 *
 * `extractStyleTokens` is a PURE function over an UnderstandingBrief (or a raw
 * MediaAnalysis[]). It never calls a model — it reshapes what intake already
 * produced. Lighting/composition aren't first-class engine fields, so they are
 * best-effort keyword reads of the captions/mood and are simply omitted when
 * nothing matches (no hallucinated tokens).
 */

import type { UnderstandingBrief } from '../types'

/** Structured style tokens extracted from a reference's analysis. All optional —
 *  only populated fields are emitted, so a sparse reference yields a sparse (but
 *  honest) token set. */
export interface StyleTokens {
  /** Dominant hex colors, de-duped, capped. */
  palette?: string[]
  /** Typography hint (font names / descriptors), when the engine surfaced any. */
  fonts?: string[]
  /** Short mood/tone phrase(s). */
  mood?: string
  /** Lighting descriptor (best-effort keyword read of captions/mood). */
  lighting?: string
  /** Composition descriptor (best-effort keyword read of captions/mood). */
  composition?: string
  /** Key subjects/entities, for content grounding. */
  subjects?: string[]
}

const LIGHTING_KEYWORDS = [
  'soft light',
  'hard light',
  'backlit',
  'backlight',
  'rim light',
  'golden hour',
  'high-key',
  'high key',
  'low-key',
  'low key',
  'dramatic lighting',
  'natural light',
  'studio lighting',
  'neon glow',
  'moody lighting',
  'overcast',
  'silhouette',
  'chiaroscuro',
]

const COMPOSITION_KEYWORDS = [
  'rule of thirds',
  'centered composition',
  'symmetrical',
  'symmetry',
  'asymmetric',
  'minimalist',
  'minimal layout',
  'grid layout',
  'close-up',
  'wide shot',
  'negative space',
  'leading lines',
  'flat lay',
  'overhead',
  "bird's-eye",
  'isometric',
  'diagonal composition',
]

/** Scan a haystack for the first matching descriptor phrase (word-boundary,
 *  case-insensitive) so e.g. "soft lightbox" doesn't match "soft light". */
function findDescriptor(haystack: string, keywords: string[]): string | undefined {
  const lower = haystack.toLowerCase()
  for (const kw of keywords) {
    if (phraseMatches(lower, kw)) return kw
  }
  return undefined
}

/**
 * Normalize a CSS hex color to 6-digit lowercase (`#fff` → `#ffffff`,
 * `#FFFFFF` → `#ffffff`, `#abcd` (4-digit incl. alpha) → `#aabbcc`). Returns
 * the input lowercased+trimmed when it isn't a recognizable 3/4/6/8-digit hex,
 * so non-hex descriptors pass through unchanged. This makes `#fff` and
 * `#ffffff` compare EQUAL while preventing `#fff` from being falsely "found"
 * as a substring of an unrelated `#ffffff`.
 */
export function normalizeHex(value: string): string {
  const v = value.trim().toLowerCase()
  const m = v.match(/^#([0-9a-f]{3,8})$/)
  if (!m) return v
  const h = m[1]
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
  if (h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` // drop alpha, expand RGB
  if (h.length === 6) return `#${h}`
  if (h.length === 8) return `#${h.slice(0, 6)}` // drop alpha
  return v
}

/** True when `value` looks like a CSS hex color (3/4/6/8 digit). */
export function isHex(value: string): boolean {
  return /^#([0-9a-f]{3,8})$/i.test(value.trim())
}

/**
 * True when a hex color is already named in some text. Both sides are
 * normalized to 6-digit lowercase, then matched on a word boundary so
 * `#fff` (→ `#ffffff`) is found in a haystack that says `#FFFFFF` but a bare
 * `#fff` literal in the haystack is ALSO recognized (it normalizes to the
 * same canonical form). Non-hex haystacks scan their own hex tokens.
 */
export function hexPresentIn(haystack: string, hex: string): boolean {
  const target = normalizeHex(hex)
  // Pull every hex token out of the haystack and canonicalize each.
  const tokens = haystack.toLowerCase().match(/#[0-9a-f]{3,8}\b/g) ?? []
  return tokens.some((t) => normalizeHex(t) === target)
}

/**
 * Word-boundary, case-insensitive phrase match. Prevents a descriptor like
 * `soft light` from matching inside `soft lightbox`, or `minimal` inside
 * `minimalist`. The haystack is expected lowercased; the needle is lowercased
 * here. Boundaries are non-`[a-z0-9]` (so hyphens/spaces around the phrase are
 * fine, but an alphanumeric directly adjacent fails the match).
 */
export function phraseMatches(lowerHaystack: string, phrase: string): boolean {
  const p = phrase.toLowerCase().trim()
  if (!p) return false
  // Escape regex specials in the phrase; allow the phrase's own internal
  // whitespace to match one-or-more whitespace.
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
  return re.test(lowerHaystack)
}

/** Pull typography descriptors out of captions/mood prose (best-effort). The
 *  intake engines don't emit a font field, so look for explicit serif/sans/etc.
 *  cues. Returns undefined when nothing typographic is mentioned. */
function extractFontHints(brief: UnderstandingBrief, captions: string): string[] | undefined {
  const explicit = brief.visualStyle?.typography?.trim()
  const hints = new Set<string>()
  if (explicit) hints.add(explicit)
  const FONT_CUES = [
    'serif',
    'sans-serif',
    'sans serif',
    'monospace',
    'handwritten',
    'script',
    'display font',
    'condensed',
    'bold typography',
    'all caps',
    'uppercase',
  ]
  const lower = captions.toLowerCase()
  for (const cue of FONT_CUES) {
    if (lower.includes(cue)) hints.add(cue)
  }
  return hints.size ? [...hints].slice(0, 4) : undefined
}

/**
 * Extract structured style tokens from an understanding brief. Pure: reshapes
 * intake output, never calls a model. Designed so a sparse brief yields a
 * sparse-but-honest token set (no invented values).
 */
export function extractStyleTokens(brief: UnderstandingBrief): StyleTokens {
  const analyses = brief.perMedia ?? []
  // All style reasoning is restricted to VISUAL media (image/video) so an audio/doc
  // signal can't masquerade as a visual style cue. palette/mood/subjects are derived
  // from the visual-filtered per-media analyses (each MediaAnalysis carries its own
  // palette/mood/subjects) rather than the cross-kind merged brief.visualStyle/
  // brief.subjects — which aggregate over ALL kinds, so a doc's OCR subjects or an
  // audio mood would otherwise leak into the tokens. For the single-media
  // analyze_reference_media path the result is identical to the brief; for a
  // multi-media brief it is now strictly kind-filtered.
  const visual = analyses.filter((a) => a.kind === 'image' || a.kind === 'video')
  const captions = [brief.summary, ...visual.map((a) => a.caption).filter(Boolean), brief.visualStyle?.notes]
    .filter(Boolean)
    .join(' ')

  // Aggregate palette/subjects over visual analyses only (de-duped, capped).
  const visualPalette = [...new Set(visual.flatMap((a) => a.palette ?? []))].slice(0, 8)
  const palette = visualPalette.length ? visualPalette : undefined

  const visualSubjects = [...new Set(visual.flatMap((a) => a.subjects ?? []))].slice(0, 12)
  const subjects = visualSubjects.length ? visualSubjects : undefined

  // Mood: join the distinct non-empty per-visual-media moods (mirrors mergeStructured's
  // moods.join(', ') but scoped to visual kinds).
  const visualMoods = [...new Set(visual.map((a) => a.mood?.trim()).filter(Boolean) as string[])]
  const mood = visualMoods.length ? visualMoods.join(', ') : undefined

  // Lighting/composition can appear in either the captions or the mood phrase.
  const descriptorSource = `${captions} ${mood ?? ''}`
  const lighting = findDescriptor(descriptorSource, LIGHTING_KEYWORDS)
  const composition = findDescriptor(descriptorSource, COMPOSITION_KEYWORDS)
  const fonts = extractFontHints(brief, captions)

  const tokens: StyleTokens = {}
  if (palette) tokens.palette = palette
  if (fonts) tokens.fonts = fonts
  if (mood) tokens.mood = mood
  if (lighting) tokens.lighting = lighting
  if (composition) tokens.composition = composition
  if (subjects) tokens.subjects = subjects
  return tokens
}

/** True when the extracted tokens carry at least one usable signal. */
export function hasStyleSignal(tokens: StyleTokens | null | undefined): boolean {
  if (!tokens) return false
  return Boolean(
    tokens.palette?.length ||
    tokens.fonts?.length ||
    tokens.mood ||
    tokens.lighting ||
    tokens.composition ||
    tokens.subjects?.length,
  )
}

/**
 * Coerce an untrusted value (e.g. model-supplied `referenceTokens` tool arg) into a
 * well-shaped StyleTokens. Array fields are normalized to string[] (a model passing
 * `palette: "#fff"` would otherwise make tokensToMemoryRows' `.join` throw); scalar
 * fields kept only when strings. Returns null when nothing usable survives.
 */
export function coerceStyleTokens(raw: unknown): StyleTokens | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const toStrArray = (v: unknown): string[] | undefined => {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
    const out = arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    return out.length ? out : undefined
  }
  const toStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const t: StyleTokens = {}
  const palette = toStrArray(r.palette)
  const fonts = toStrArray(r.fonts)
  const subjects = toStrArray(r.subjects)
  if (palette) t.palette = palette
  if (fonts) t.fonts = fonts
  if (subjects) t.subjects = subjects
  const mood = toStr(r.mood)
  const lighting = toStr(r.lighting)
  const composition = toStr(r.composition)
  if (mood) t.mood = mood
  if (lighting) t.lighting = lighting
  if (composition) t.composition = composition
  return hasStyleSignal(t) ? t : null
}

/**
 * Render style tokens as a compact descriptive clause for appending to a
 * generation prompt (D3). Returns '' when there's no signal so callers can
 * concatenate unconditionally.
 */
export function renderTokensForPrompt(tokens: StyleTokens | null | undefined): string {
  if (!hasStyleSignal(tokens)) return ''
  const t = tokens as StyleTokens
  const parts: string[] = []
  if (t.palette?.length) parts.push(`color palette ${t.palette.join(', ')}`)
  if (t.mood) parts.push(`${t.mood} mood`)
  if (t.lighting) parts.push(`${t.lighting}`)
  if (t.composition) parts.push(`${t.composition}`)
  if (t.fonts?.length) parts.push(`typography: ${t.fonts.join(', ')}`)
  return parts.length ? `Match this reference style: ${parts.join('; ')}.` : ''
}

/**
 * Project salient tokens into (category, key, value) memory rows. category is
 * always 'style' so they merge with the existing brand/style precedence layers
 * Returns the rows; the caller persists them with the right scope +
 * confidence. Subjects are deliberately NOT persisted — they're content of one
 * reference, not a durable taste signal.
 */
export function tokensToMemoryRows(tokens: StyleTokens): { category: string; key: string; value: string }[] {
  const rows: { category: string; key: string; value: string }[] = []
  if (tokens.palette?.length)
    rows.push({ category: 'style', key: 'reference_palette', value: tokens.palette.join(', ') })
  if (tokens.fonts?.length)
    rows.push({ category: 'style', key: 'reference_typography', value: tokens.fonts.join(', ') })
  if (tokens.mood) rows.push({ category: 'style', key: 'reference_mood', value: tokens.mood })
  if (tokens.lighting) rows.push({ category: 'style', key: 'reference_lighting', value: tokens.lighting })
  if (tokens.composition) rows.push({ category: 'style', key: 'reference_composition', value: tokens.composition })
  return rows
}
