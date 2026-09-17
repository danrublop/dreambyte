/**
 * Faceted style composer.
 *
 * THE FRAME:
 *   Style is NOT a monolithic thing you retrieve ("pick 1 of N saved styles" =
 *   templating, the anti-pattern). Style is COMPOSITIONAL — facet-blocks the
 *   agent assembles fluidly. A "medical explainer, professional" prompt pieces
 *   together pacing + palette + typography + motion + audio + avatar + data-viz,
 *   each facet drawn from a curated block, a brand kit, a learned preference, or
 *   fresh derivation.
 *
 * This module is ADDITIVE. It does NOT rewrite or generalize the resolver. It
 * READS the output of the existing, UNTOUCHED `resolveStyle` cascade
 * (src/lib/styles/presets.ts) for the visual facets, the brand kit for
 * palette/typography, `globalStyle.motionPersonality` for the motion facet, and the
 * preset `agentGuidance` + axis/grid colors + design-brief tone for the
 * audio/avatar/data-viz HINTS — and renders ONE source-attributed "## Style
 * Spec" markdown block.
 *
 * CROSS-BLOCK MIXING happens at the PROMPT level: every facet line names its
 * SOURCE, so the agent can see (and the human can audit) that facets come from
 * DIFFERENT blocks (e.g. kraft palette + cinematic pacing + a brand font). That
 * source-attribution is the "fluid, not templating" core — no new persisted
 * state, no provenance bit, no schema.
 *
 * A SAVED (distilled) style is also a facet source, and there is a whole-style
 * escape hatch (skill-tools `apply`). The saved style is decomposed into per-facet sources
 * (palette here, fonts there) the composer mixes with preset/brand —
 * NOT a wholesale prose template. Audio/avatar/data facets are
 * PROSE HINTS here, not structured.
 */

import type { GlobalStyle } from '../types'
import type { BrandKit } from '../types/media'
import { resolveStyle, getPreset, type StylePresetId } from '../styles/presets'
import type { SavedStyleFacetSource } from '../skills/distill'

/** A facet's chosen SOURCE, surfaced in the rendered block so the human can see
 *  that facets came from different blocks (the cross-block-mixing audit trail). */
export type FacetSource =
  | { kind: 'preset'; id: StylePresetId }
  | { kind: 'neutral-baseline' }
  | { kind: 'override' } // per-project override on GlobalStyle (Style Picker)
  | { kind: 'saved-style'; name: string } // a distilled saved style, per-facet
  | { kind: 'brand'; brandName: string | null }
  | { kind: 'motion-personality' }
  | { kind: 'memory' }
  | { kind: 'design-brief' }
  | { kind: 'explicit-user-signal' } // the user named this facet in THIS turn
  | { kind: 'fresh' } // no block contributes — agent's own derivation

export interface ComposeFacetedStyleInput {
  globalStyle: GlobalStyle
  /** Most-recent user message — used to detect explicit facet signals that
   *  override a block facet. */
  latestUserMessage?: string
  /** Project brand kit (a facet SOURCE for palette/typography). */
  brandKit?: BrandKit | null
  /**
   * A SAVED (distilled) style selected for this build's intent, decomposed
   * into per-facet sources. A facet SOURCE that sits ABOVE brand/preset but BELOW
   * a per-project override and an explicit user signal:
   *   explicit user > pinned/whole-style (override) > SAVED-STYLE facet > brand > preset > memory > neutral
   * So a saved style can supply ONE facet (e.g. palette) while a preset
   * supplies another — the cross-block mixing the design calls for. The caller
   * (context-builder) selects it via selectProjectStyleFacets(intent). null = none.
   */
  savedStyle?: SavedStyleFacetSource | null
  /** Learned cross-session preferences (a facet SOURCE — lowest precedence,
   *  applies only where the request is silent). Already confidence-filtered &
   *  sorted by the caller is fine; we re-filter defensively. */
  memories?: Array<{ category: string; key: string; value: string; confidence: number }>
}

const MEMORY_CONFIDENCE_FLOOR = 0.3

/** Render a FacetSource as a short, human-auditable attribution tag. */
function renderSource(src: FacetSource): string {
  switch (src.kind) {
    case 'preset':
      return `preset "${src.id}"`
    case 'neutral-baseline':
      return 'neutral baseline (no preset)'
    case 'override':
      return 'project override (Style Picker)'
    case 'saved-style':
      return `saved style "${src.name}"`
    case 'brand':
      return src.brandName ? `brand kit "${src.brandName}"` : 'brand kit'
    case 'motion-personality':
      return 'motionPersonality'
    case 'memory':
      return 'learned preference'
    case 'design-brief':
      return 'design brief'
    case 'explicit-user-signal':
      return 'your request this turn'
    case 'fresh':
      return 'your call (no block specifies it)'
  }
}

/** One rendered facet line: `- **Palette** (source): value`. */
function facetLine(name: string, source: FacetSource, value: string): string {
  return `- **${name}** _(${renderSource(source)})_: ${value}`
}

/**
 * Detect an explicit facet signal in THIS turn's message. When the user NAMES a
 * facet ("use a dark background", "make it serif", "punchy fast cuts"), that
 * overrides whatever a block would contribute for that facet (explicit
 * precedence). We return a coarse signal per facet; the block then notes the
 * override so the agent honors the user over the inherited block value.
 *
 * ANCHORED DETECTION (over-trigger fix): a facet only fires when a style-INTENT frame co-occurs with
 * the facet noun — NOT on substring-anywhere keyword hits. Topic vocabulary like
 * "dark matter", "distant stars", "monochrome era", "background radiation",
 * "background information", "smooth jazz" sits in NO style directive, so it no
 * longer falsely flips a facet to "explicit user signal" (which would otherwise
 * mislabel an inherited brand/preset facet as "the user demanded this" and
 * suppress the brand-available note — a silent brand/preset parity regression).
 *
 * A false negative just means the block value stands (the user's prose is still
 * in the conversation); a false positive mislabels an inherited facet, so we err
 * toward NOT firing. No silent value changes either way.
 */
export interface ExplicitFacetSignals {
  palette?: string
  typography?: string
  background?: string
  motion?: string
}

/** Style-intent verbs that frame a deliberate facet directive. */
const STYLE_DIRECTIVE =
  '(?:use|make|set|give|want|wants|wanted|need|needs|with|using|prefer|go|keep|apply|do|render|in)'

/**
 * Does `m` (already lowercased) name a facet inside a deliberate style directive
 * — a verb-framed ask ("use … <noun>", "make it <noun>") leading into the facet
 * noun? `nounPattern` is a regex alternation source authored by THIS module (a
 * static group like `(?:background|bg)`), interpolated as-is — never user input,
 * so no escaping is applied to it (escaping would defeat the alternation).
 *
 * Because the directive verb must co-occur AHEAD of the noun, a bare topic word
 * ("dark matter", "background radiation") in NO directive never qualifies.
 */
function namedAsFacet(m: string, nounPattern: string): boolean {
  // Verb-framed directive somewhere ahead of the noun:
  //   "use a teal palette", "make the background black", "set a serif font",
  //   "give it a dark bg", "with a serif font", "make it snappy".
  return new RegExp(`\\b${STYLE_DIRECTIVE}\\b[\\w\\s,'"-]*?\\b${nounPattern}\\b`).test(m)
}

export function detectExplicitFacetSignals(message?: string): ExplicitFacetSignals {
  if (!message) return {}
  const m = message.toLowerCase()
  const sig: ExplicitFacetSignals = {}

  // Color descriptors that, when DIRECTLY attached to a facet noun, frame intent
  // ("dark background", "teal palette"). On their own they're topic words.
  const colorDesc =
    '(?:dark|light|bright|muted|pastel|neon|monochrome|colou?red|warm|cool|black|white|teal|red|blue|green|orange|purple|pink|yellow)'

  // ── Palette / color ────────────────────────────────────────────────────────
  // Fires on: a style-directive framing a color/palette noun ("use a teal
  // palette", "use neon colors", "change the colors"), OR a descriptor directly
  // qualifying a palette/color noun ("<X> palette", "<X> color scheme").
  // Does NOT fire on bare topic words ("monochrome era", "dark matter").
  if (
    namedAsFacet(m, '(?:colou?rs?|palette|hue|hues|colou?r\\s+scheme|colou?r\\s+palette)') ||
    new RegExp(`\\b${colorDesc}\\s+(?:colou?rs?|palette|hues?|colou?r\\s+scheme|tones?)\\b`).test(m)
  ) {
    sig.palette = 'the user named colors/palette this turn'
  }

  // ── Background specifically ──────────────────────────────────────────────────
  // Fires on: a style-directive framing background/bg ("use a dark background",
  // "make the background black", "set the bg to navy"), OR a color descriptor
  // directly qualifying background/bg ("dark background", "black bg"). Does NOT
  // fire on "background radiation" / "background information" (no directive, no
  // color descriptor immediately before "background").
  if (namedAsFacet(m, '(?:background|bg)') || new RegExp(`\\b${colorDesc}\\s+(?:background|bg)\\b`).test(m)) {
    sig.background = 'the user named the background this turn'
  }

  // ── Typography ───────────────────────────────────────────────────────────────
  // Fires on: a style-directive framing a typography noun ("use a serif font",
  // "make the titles serif", "with a mono typeface"), OR a typeface descriptor
  // directly qualifying font/typeface ("serif font", "handwritten typeface").
  // "font"/"typeface"/"typography" are themselves strong style nouns, so a plain
  // mention of them ("change the font") counts via the directive frame.
  if (
    namedAsFacet(m, '(?:font|fonts|typeface|typefaces|typography)') ||
    /\b(?:serif|sans[-\s]?serif|sans|monospace|mono|handwritten|script|cursive|display)\s+(?:font|fonts|typeface|typefaces|type)\b/.test(
      m,
    )
  ) {
    sig.typography = 'the user named typography this turn'
  }

  // ── Motion / animation feel ──────────────────────────────────────────────────
  // Fires on: a style-directive framing an explicit motion NOUN ("use snappy
  // animation", "change the easing", "smoother transitions"), OR a feel ADJECTIVE
  // that is the DIRECT OBJECT of a make/keep/feel directive ("make it bouncy",
  // "keep it snappy", "make the motion smooth"). The adjective branch is tighter
  // than namedAsFacet (which allows the noun anywhere downstream) so loose topic
  // phrases like "set to smooth jazz" / "playful kids show" don't trip it.
  const feelAdj = '(?:bouncy|snappy|smooth|kinetic|playful|premium|corporate|energetic|punchy)'
  if (
    namedAsFacet(m, '(?:animation|animations|motion|easing|spring|transitions?)') ||
    new RegExp(`\\b(?:make|makes|keep|feel|feels|want|wants|need|needs)\\b[\\w\\s,'"-]{0,24}?\\b${feelAdj}\\b`).test(m)
  ) {
    sig.motion = 'the user named the motion feel this turn'
  }

  return sig
}

/**
 * Summarize a preset's verbose `agentGuidance` into a single bounded HINT line
 * for a non-visual facet. The full guidance is large (the cinematic preset alone
 * is ~100 lines); this block REPLACES five separate injections, so we MUST
 * summarize, not concatenate. We take the first substantive sentence/clause and
 * cap it — the agent still has the resolved visual facets above; this is a
 * tonal nudge for audio/avatar pacing, not a spec.
 */
function summarizeGuidance(guidance: string, maxChars = 160): string {
  const oneLine = guidance.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  // Prefer a clean sentence boundary within the budget.
  const slice = oneLine.slice(0, maxChars)
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '))
  return (lastStop > 40 ? slice.slice(0, lastStop) : slice).trim() + '…'
}

/** Memory entries that survive the confidence floor, highest first, capped.
 *  Excludes the `feedback` category: those are RUN DIAGNOSTICS minted by
 *  extractMemories (e.g. "d3 generation failed 3 times", "high regeneration
 *  rate") — transient signals about a past run, NOT durable user taste. Rendering
 *  them in the "Learned User Preferences … ACTIVE DEFAULT" block would tell the
 *  agent to treat a one-off failure as a standing preference. Only taste-bearing
 *  categories (style/content/…) belong in the active-default facet. */
function relevantMemories(
  memories: ComposeFacetedStyleInput['memories'],
): NonNullable<ComposeFacetedStyleInput['memories']> {
  if (!memories || memories.length === 0) return []
  return [...memories]
    .filter((mem) => mem.category !== 'feedback')
    .filter((mem) => mem.confidence >= MEMORY_CONFIDENCE_FLOOR)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8)
}

/**
 * Compose the single source-attributed `## Style Spec` block.
 *
 * Returns `null` when there is genuinely nothing to say (no preset, no
 * overrides, no brand, no motion personality, no design
 * brief, no memory) — so an empty block never leaks into the prompt, matching
 * the existing per-injection "omit when empty" behavior.
 */
export function composeFacetedStyleSpec(input: ComposeFacetedStyleInput): string | null {
  const { globalStyle, latestUserMessage, brandKit } = input
  const presetId = globalStyle.presetId ?? null
  const resolved = resolveStyle(presetId, globalStyle) // REUSED, untouched
  const preset = getPreset(presetId)
  const explicit = detectExplicitFacetSignals(latestUserMessage)
  const mems = relevantMemories(input.memories)

  // ── SAVED-STYLE facets (distilled, decomposed per-facet) ───────────
  // A facet SOURCE that ranks BELOW a project override + explicit user signal but
  // ABOVE brand + preset. Each facet is independent — the saved style may supply a
  // palette while a preset supplies pacing (cross-block mixing). Only present
  // facets contribute; absent ones fall through to brand/preset/baseline.
  const saved = input.savedStyle ?? null
  const savedFacets = saved?.facets ?? {}
  const savedName = saved?.name ?? null
  const savedSource = (): FacetSource => ({ kind: 'saved-style', name: savedName ?? 'saved style' })
  const savedPalette = savedFacets.palette && savedFacets.palette.length > 0 ? savedFacets.palette : null
  const savedBackground = savedFacets.background || null
  const savedFonts = savedFacets.fonts && savedFacets.fonts.length > 0 ? savedFacets.fonts : null
  const savedMotionPersonality = savedFacets.motion?.motionPersonality || null
  const savedCameraMoves =
    savedFacets.motion?.cameraMoves && savedFacets.motion.cameraMoves.length > 0 ? savedFacets.motion.cameraMoves : null
  const savedRenderer = savedFacets.renderer || null
  const hasAnySavedFacet =
    !!savedPalette ||
    !!savedBackground ||
    !!savedFonts ||
    !!savedMotionPersonality ||
    !!savedCameraMoves ||
    !!savedRenderer ||
    savedFacets.visualCharacter?.roughness != null

  // ── VISUAL facets (from the REUSED resolveStyle output) ───────────────────
  // Per-facet source: an override on GlobalStyle wins attribution; else brand
  // (when it supplies that field); else the preset / neutral baseline. Explicit
  // user signal this turn overrides any of them (we keep the resolved value but
  // flag the override so the agent honors the user).
  const baseVisualSource: FacetSource = presetId ? { kind: 'preset', id: presetId } : { kind: 'neutral-baseline' }

  const paletteOverridden = globalStyle.paletteOverride != null
  const brandPalette = brandKit?.palette && brandKit.palette.length > 0
  // Source attribution: explicit > override > SAVED-STYLE > brand > preset/baseline.
  const paletteSource: FacetSource = explicit.palette
    ? { kind: 'explicit-user-signal' }
    : paletteOverridden
      ? { kind: 'override' }
      : savedPalette
        ? savedSource()
        : brandPalette
          ? { kind: 'brand', brandName: brandKit?.brandName ?? null }
          : baseVisualSource
  // VALUE must agree with the TAG (FIX 2): resolveStyle does NOT fold the brand or
  // saved-style palette in, so when the source IS one of those (no override, no
  // explicit) we LEAD the value with that source's palette — the rendered tag and
  // value both point at the same source — and show the resolved preset/neutral
  // palette as the fallback. When the source is preset/override, resolved leads.
  const paletteIsSavedSourced = !!savedPalette && !paletteOverridden && !explicit.palette
  const paletteIsBrandSourced = !paletteIsSavedSourced && !!brandPalette && !paletteOverridden && !explicit.palette
  const paletteValue =
    (paletteIsSavedSourced
      ? `[${savedPalette!.join(', ')}] (from saved style "${savedName}"; resolveStyle fallback if unusable: [${resolved.palette.join(', ')}])`
      : paletteIsBrandSourced
        ? `[${brandKit!.palette.join(', ')}] (brand palette — use it; resolveStyle fallback if unusable: [${resolved.palette.join(', ')}])`
        : `[${resolved.palette.join(', ')}]`) +
    // Defense-in-depth (FIX 1b): brand availability stays VISIBLE even under an
    // explicit signal, override, or a saved-style source, so brand guidance never
    // silently vanishes — it's informative; the higher-precedence source WINS.
    (brandPalette && !paletteIsBrandSourced
      ? ` · brand palette available: [${brandKit!.palette.join(', ')}]${
          explicit.palette || paletteOverridden || paletteIsSavedSourced ? '' : ' (prefer it)'
        }`
      : '') +
    (explicit.palette ? ` — ${explicit.palette}; honor it over the inherited palette` : '')

  const bgOverridden = globalStyle.bgColorOverride != null
  const bgIsSavedSourced = !!savedBackground && !bgOverridden && !explicit.background
  const bgSource: FacetSource = explicit.background
    ? { kind: 'explicit-user-signal' }
    : bgOverridden
      ? { kind: 'override' }
      : bgIsSavedSourced
        ? savedSource()
        : baseVisualSource
  const bgValue =
    (bgIsSavedSourced
      ? `${savedBackground} (from saved style "${savedName}"; resolveStyle fallback: ${resolved.bgColor} (${resolved.bgStyle}))`
      : `${resolved.bgColor} (${resolved.bgStyle})`) +
    (explicit.background ? ` — ${explicit.background}; honor it` : '')

  const fontOverridden = globalStyle.fontOverride != null || globalStyle.bodyFontOverride != null
  const brandFont = brandKit?.fontPrimary
  // Source: explicit > override > SAVED-STYLE > brand > preset/baseline.
  const typoSource: FacetSource = explicit.typography
    ? { kind: 'explicit-user-signal' }
    : fontOverridden
      ? { kind: 'override' }
      : savedFonts
        ? savedSource()
        : brandFont
          ? { kind: 'brand', brandName: brandKit?.brandName ?? null }
          : baseVisualSource
  const bodyFontStr = resolved.bodyFont && resolved.bodyFont !== resolved.font ? ` / body ${resolved.bodyFont}` : ''
  const brandFontStr = brandFont ? `${brandFont}${brandKit?.fontSecondary ? ` / ${brandKit.fontSecondary}` : ''}` : ''
  const savedFontStr = savedFonts ? savedFonts.join(' / ') : ''
  // VALUE agrees with the TAG (FIX 2): resolveStyle ignores brand + saved style,
  // so when the source IS one of those we LEAD with that font and show the
  // resolved preset/neutral font as the fallback.
  const typoIsSavedSourced = !!savedFonts && !fontOverridden && !explicit.typography
  const typoIsBrandSourced = !typoIsSavedSourced && !!brandFont && !fontOverridden && !explicit.typography
  const typoValue =
    (typoIsSavedSourced
      ? `${savedFontStr} (from saved style "${savedName}"; resolveStyle fallback if unusable: ${resolved.font}${bodyFontStr})`
      : typoIsBrandSourced
        ? `${brandFontStr} (brand font — use it; resolveStyle fallback if unusable: ${resolved.font}${bodyFontStr})`
        : `${resolved.font}${bodyFontStr}`) +
    // Defense-in-depth (FIX 1b): brand font stays VISIBLE under a higher-precedence
    // source (explicit / override / saved style); that source still wins.
    (brandFont && !typoIsBrandSourced
      ? ` · brand font available: ${brandFontStr}${explicit.typography || fontOverridden || typoIsSavedSourced ? '' : ' (prefer it)'}`
      : '') +
    (explicit.typography ? ` — ${explicit.typography}; honor it` : '')

  // Texture / roughness / tool / renderer — visual character, from preset/baseline.
  // A saved style with no preset of its own contributes its roughness as a hint;
  // its dominant renderer is surfaced as a renderer HINT (the saved style steers,
  // resolveStyle's preferredRenderer still leads).
  const savedRoughness = savedFacets.visualCharacter?.roughness
  const characterIsSavedSourced = !presetId && (savedRoughness != null || !!savedRenderer)
  const characterValue =
    `roughness ${resolved.roughnessLevel}, tool ${resolved.defaultTool}, renderer ${resolved.preferredRenderer}, texture ${resolved.textureStyle}${resolved.textureStyle !== 'none' ? ` @ ${resolved.textureIntensity} ${resolved.textureBlendMode}` : ''} (applied by the template — do not re-add)` +
    (characterIsSavedSourced
      ? ` · saved style "${savedName}" used${savedRoughness != null ? ` roughness ${savedRoughness}` : ''}${savedRenderer ? `${savedRoughness != null ? ', ' : ' '}renderer ${savedRenderer}` : ''} — match its feel`
      : savedRenderer && presetId
        ? ` · saved style "${savedName}" renderer hint: ${savedRenderer}`
        : '')

  const visualLines = [
    facetLine('Palette', paletteSource, paletteValue),
    facetLine('Background', bgSource, bgValue),
    facetLine('Typography', typoSource, typoValue),
    facetLine('Visual character', characterIsSavedSourced ? savedSource() : baseVisualSource, characterValue),
  ]

  // No PACING facet: pacing is the model's call, informed by the brief's
  // pacingProfile from routeOKF — a fixed per-video-type pattern over-constrains.

  // ── MOTION facet (globalStyle.motionPersonality, else SAVED-STYLE motion) ──
  // Precedence: explicit > project motionPersonality > saved-style motion. The
  // saved style contributes a motion source (its personality + observed camera
  // moves) only when the project itself sets no motionPersonality — so a saved
  // style can supply the motion facet while a preset supplies the palette.
  let motionLine: string | null = null
  if (globalStyle.motionPersonality) {
    const motionSrc: FacetSource = explicit.motion ? { kind: 'explicit-user-signal' } : { kind: 'motion-personality' }
    motionLine = facetLine(
      'Motion feel',
      motionSrc,
      `${globalStyle.motionPersonality}` + (explicit.motion ? ` — ${explicit.motion}; honor it` : ''),
    )
  } else if (savedMotionPersonality || savedCameraMoves) {
    const motionSrc: FacetSource = explicit.motion ? { kind: 'explicit-user-signal' } : savedSource()
    const savedMotionStr = [
      savedMotionPersonality ? `${savedMotionPersonality} feel` : null,
      savedCameraMoves ? `camera moves: ${savedCameraMoves.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    motionLine = facetLine(
      'Motion feel',
      motionSrc,
      savedMotionStr + (explicit.motion ? ` — ${explicit.motion}; honor it over the saved-style motion` : ''),
    )
  } else if (explicit.motion) {
    motionLine = facetLine('Motion feel', { kind: 'explicit-user-signal' }, explicit.motion)
  }

  // ── AUDIO / AVATAR / DATA-VIZ — PROSE HINTS only (no structured facets) ────
  // These steer the per-scene audio/avatar/chart layers via their own tools;
  // here they're a tonal nudge derived from the preset's agentGuidance, the
  // data-viz axis/grid colors, and the design-brief presence. Clearly marked as
  // hints, NOT state.
  const guidanceHint = presetId ? summarizeGuidance(preset.agentGuidance) : null
  const hintLines: string[] = []
  if (guidanceHint) {
    hintLines.push(`- **Audio / avatar tone** _(hint, from ${renderSource(baseVisualSource)})_: ${guidanceHint}`)
  }
  hintLines.push(
    `- **Data-viz** _(hint, from ${renderSource(baseVisualSource)})_: axis ${resolved.axisColor}, grid ${resolved.gridColor}; charts inherit the palette above.`,
  )
  if (globalStyle.designBrief) {
    hintLines.push(
      `- **Design brief** _(hint, from ${renderSource({ kind: 'design-brief' })})_: a project design brief is set — follow its exact token values (see the Project Design Brief section); these style facets are a summary, the brief is authoritative where it conflicts.`,
    )
  }

  // ── MEMORY (learned preferences — lowest-precedence facet source) ──────────
  // Preserves the memory contract verbatim (this is the SINGLE memory consumption
  // path): ACTIVE DEFAULT framing + the user-wins HARD RULE, ordered by
  // confidence. Phrasing kept stable so the contract is unmissable.
  let memoryBlock: string | null = null
  if (mems.length > 0) {
    const lines = mems.map((mem) => `- [${mem.category}] ${mem.key}: ${mem.value}`)
    memoryBlock = `### Learned User Preferences _(${renderSource({ kind: 'memory' })} — lowest-precedence facet source)_
These are durable preferences learned from this user's past sessions and confirmed by their behavior. Treat each as an ACTIVE DEFAULT for this run: when the current request does not specify a choice this preference covers (palette, fonts, background, audience, pacing, do/don't rules), follow the preference rather than your own generic default.

HARD RULE — the user's explicit request in THIS session always wins. If anything above conflicts with what the user just asked for, obey the user and ignore the conflicting preference (do not mention the override).

${lines.join('\n')}`
  }

  // ── Nothing-to-say guard ───────────────────────────────────────────────────
  const hasSignal =
    presetId != null ||
    paletteOverridden ||
    bgOverridden ||
    fontOverridden ||
    brandPalette ||
    !!brandFont ||
    motionLine != null ||
    !!globalStyle.motionPersonality ||
    !!globalStyle.designBrief ||
    mems.length > 0 ||
    (!!saved && hasAnySavedFacet) ||
    Object.keys(explicit).length > 0
  if (!hasSignal) return null

  // ── Assemble the ONE block ─────────────────────────────────────────────────
  const sections: string[] = []
  sections.push(`## Style Spec
Assemble this video's style from the facets below. Each facet names its SOURCE — facets may come from DIFFERENT blocks (e.g. a preset palette + a brand font + a saved-style motion feel). That is intentional: compose fluidly, don't treat any one source as a whole-style template. Your explicit request this turn overrides any inherited facet.`)

  sections.push(['### Visual', ...visualLines].join('\n'))

  if (motionLine) sections.push(['### Pacing & motion', motionLine].join('\n'))

  if (hintLines.length > 0) {
    sections.push(['### Non-visual hints (steer the per-scene layers — not fixed state)', ...hintLines].join('\n'))
  }

  if (memoryBlock) sections.push(memoryBlock)

  return sections.join('\n\n')
}
