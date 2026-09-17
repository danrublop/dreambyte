// @vitest-environment node
//
// T1 (OKF PR1) unit + integration tests for composeFacetedStyleSpec.
//
// Proves:
//  - cross-block mixing: a facet can come from a DIFFERENT block than another,
//    and the rendered block names each facet's source distinctly
//  - explicit user signal this turn overrides a block facet (note + honor)
//  - audio/avatar/data are PROSE HINTS, not structured state
//  - the block stays BOUNDED (it replaces 5 injections — summarize, don't concat)
//  - integration: the block REPLACES the 5 scattered injections in
//    buildAgentContext with content parity for unchanged style (no facet dropped)

import { describe, it, expect } from 'vitest'
import { composeFacetedStyleSpec, detectExplicitFacetSignals } from './faceted-style-composer'
import { buildAgentContext } from './context-builder'
import type { GlobalStyle } from '../types'
import type { BrandKit } from '../types/media'

const EMPTY_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

const BRAND: BrandKit = {
  brandName: 'Acme',
  logoAssetIds: [],
  palette: ['#0055ff', '#ffffff', '#222222', '#ff8800'],
  fontPrimary: 'Brandon Grotesque',
  fontSecondary: 'Tiempos',
  guidelines: null,
}

describe('composeFacetedStyleSpec — facet sourcing + cross-block mixing', () => {
  it('emits a single ## Style Spec block', () => {
    const out = composeFacetedStyleSpec({ globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' } })!
    expect(out).toContain('## Style Spec')
    // Only ONE Style Spec header (it consolidates, it doesn't fan out)
    expect(out.match(/## Style Spec/g)!.length).toBe(1)
  })

  it('cross-block mixing: palette source and motion source are named DISTINCTLY', () => {
    // kraft palette (preset block) + motionPersonality (a different block). The pacing
    // facet used to be the second source here; it came from a pipeline playbook, and
    // the pipelines are deleted.
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft', motionPersonality: 'playful' },
    })!
    expect(out).toMatch(/\*\*Palette\*\*.*preset "kraft"/)
    expect(out).toMatch(/\*\*Motion feel\*\*.*motionPersonality/)
    const paletteSrc = out.match(/\*\*Palette\*\* _\(([^)]+)\)/)![1]
    const motionSrc = out.match(/\*\*Motion feel\*\* _\(([^)]+)\)/)![1]
    expect(paletteSrc).not.toEqual(motionSrc)
  })

  it('no facet is ever attributed to a playbook — the pipelines are deleted', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' },
      latestUserMessage: 'make a how-to tutorial walking through the setup steps, punchy fast cuts',
    })!
    expect(out).not.toContain('playbook')
    expect(out).not.toContain('Pacing / structure')
    expect(out).not.toContain('Playbook pattern')
  })

  it('brand kit supplies the palette/typography facet source when no override/preset wins', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, brandKit: BRAND })!
    expect(out).toMatch(/\*\*Palette\*\*.*brand kit "Acme"/)
    expect(out).toMatch(/\*\*Typography\*\*.*brand kit "Acme"/)
    expect(out).toContain('Brandon Grotesque')
  })

  it('a project override outranks the brand for the palette facet attribution', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, paletteOverride: ['#aaa', '#bbb', '#ccc', '#ddd'] },
      brandKit: BRAND,
    })!
    expect(out).toMatch(/\*\*Palette\*\*.*project override/)
  })

  it('motion facet comes from motionPersonality (yet another block)', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'cinematic', motionPersonality: 'premium' },
    })!
    expect(out).toMatch(/\*\*Motion feel\*\*.*motionPersonality/)
    expect(out).toContain('premium')
  })
})

describe('composeFacetedStyleSpec — explicit user signal overrides a block facet', () => {
  it('explicit background signal overrides the preset background attribution', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'whiteboard' },
      latestUserMessage: 'use a dark background instead',
    })!
    expect(out).toMatch(/\*\*Background\*\*.*your request this turn/)
    expect(out).toMatch(/honor it/)
  })

  it('explicit typography signal overrides the preset typography attribution', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'whiteboard' },
      latestUserMessage: 'use a serif font for the titles',
    })!
    expect(out).toMatch(/\*\*Typography\*\*.*your request this turn/)
  })

  it('detectExplicitFacetSignals flags only what the message names', () => {
    expect(detectExplicitFacetSignals('use neon colors')).toMatchObject({ palette: expect.any(String) })
    expect(detectExplicitFacetSignals('make it bouncy and playful')).toMatchObject({ motion: expect.any(String) })
    expect(detectExplicitFacetSignals('a video about cats')).toEqual({})
  })
})

describe('detectExplicitFacetSignals — anchored to directives, not topic words', () => {
  // NEGATIVE: incidental topic vocabulary must NOT flip any facet to explicit.
  const NEGATIVE: Array<[string, string]> = [
    ['a video about dark matter', 'dark matter'],
    ['explain background radiation in the early universe', 'background radiation'],
    ['the monochrome art era of the 1920s', 'monochrome era'],
    ['a documentary about distant stars', 'distant stars'],
    ['some background information about the topic', 'background information'],
    ['a clip set to smooth jazz', 'smooth jazz'],
    ['a video about fast food chains', 'fast food'],
    ['explain how light travels through space', 'light (topic)'],
    ['a video about cats', 'cats'],
  ]
  for (const [msg, label] of NEGATIVE) {
    it(`does NOT flip any facet for "${label}"`, () => {
      expect(detectExplicitFacetSignals(msg)).toEqual({})
    })
  }

  // POSITIVE controls: deliberate style directives still detect.
  it('"use a teal palette" detects palette', () => {
    expect(detectExplicitFacetSignals('use a teal palette')).toMatchObject({ palette: expect.any(String) })
  })
  it('"make the background black" detects background (not palette/typography)', () => {
    const sig = detectExplicitFacetSignals('make the background black')
    expect(sig).toMatchObject({ background: expect.any(String) })
    expect(sig.typography).toBeUndefined()
  })
  it('"with a serif font" detects typography', () => {
    expect(detectExplicitFacetSignals('with a serif font')).toMatchObject({ typography: expect.any(String) })
  })
  it('"use a dark background instead" detects background', () => {
    expect(detectExplicitFacetSignals('use a dark background instead')).toMatchObject({
      background: expect.any(String),
    })
  })
  it('"use a black background for this one" detects background', () => {
    expect(detectExplicitFacetSignals('use a black background for this one')).toMatchObject({
      background: expect.any(String),
    })
  })
  it('"make it snappy and fast" detects motion', () => {
    expect(detectExplicitFacetSignals('make it snappy and fast')).toMatchObject({ motion: expect.any(String) })
  })
})

describe('composeFacetedStyleSpec — false-positive topic words do not regress brand parity', () => {
  it('"a video about dark matter" keeps brand palette/font VISIBLE (no explicit override mislabel)', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' },
      latestUserMessage: 'a video about dark matter and distant stars',
      brandKit: BRAND,
    })!
    // Palette/typography still attribute to brand (not "your request this turn")
    expect(out).toMatch(/\*\*Palette\*\*.*brand kit "Acme"/)
    expect(out).toMatch(/\*\*Typography\*\*.*brand kit "Acme"/)
    expect(out).not.toMatch(/\*\*Palette\*\*.*your request this turn/)
    // Brand values are present (not suppressed)
    expect(out).toContain('Brandon Grotesque')
    expect(out).toContain('#0055ff')
  })
})

describe('composeFacetedStyleSpec — brand stays visible under an explicit signal (FIX 1b)', () => {
  it('explicit palette signal still wins, but the brand palette stays VISIBLE', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' },
      latestUserMessage: 'use a teal palette',
      brandKit: BRAND,
    })!
    // Explicit wins the source attribution
    expect(out).toMatch(/\*\*Palette\*\*.*your request this turn/)
    // ...and the brand palette is NOT hidden (informative, coexists)
    expect(out).toContain('brand palette available')
    expect(out).toContain('#0055ff')
    // honor-the-user note still present
    expect(out).toMatch(/honor it over the inherited palette/)
  })

  it('explicit typography signal still wins, but the brand font stays VISIBLE', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' },
      latestUserMessage: 'use a serif font',
      brandKit: BRAND,
    })!
    expect(out).toMatch(/\*\*Typography\*\*.*your request this turn/)
    expect(out).toContain('brand font available')
    expect(out).toContain('Brandon Grotesque')
  })
})

describe('composeFacetedStyleSpec — brand source/value alignment (FIX 2)', () => {
  it('when source is brand, the VALUE leads with the brand palette (tag and value agree)', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, brandKit: BRAND })!
    const paletteLine = out.split('\n').find((l) => l.includes('**Palette**'))!
    // Tag says brand
    expect(paletteLine).toMatch(/brand kit "Acme"/)
    // Value LEADS with the brand palette, not the resolved preset/neutral palette
    expect(paletteLine).toMatch(/_: \[#0055ff/)
    // It's honest that resolveStyle output is the fallback, not the lead
    expect(paletteLine).toContain('resolveStyle fallback')
  })

  it('when source is brand, the typography VALUE leads with the brand font', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, brandKit: BRAND })!
    const typoLine = out.split('\n').find((l) => l.includes('**Typography**'))!
    expect(typoLine).toMatch(/brand kit "Acme"/)
    expect(typoLine).toMatch(/_: Brandon Grotesque/)
    expect(typoLine).toContain('resolveStyle fallback')
  })
})

describe('composeFacetedStyleSpec — audio/avatar/data are HINTS, not state', () => {
  it('renders audio/avatar/data under a "hints" section, clearly marked', () => {
    const out = composeFacetedStyleSpec({ globalStyle: { ...EMPTY_STYLE, presetId: 'cinematic' } })!
    expect(out).toContain('Non-visual hints')
    expect(out).toMatch(/\*\*Audio \/ avatar tone\*\* _\(hint/)
    expect(out).toMatch(/\*\*Data-viz\*\* _\(hint/)
    // Hints carry NO structured facet keys (no JSON-ish state, no "facet:" tags)
    expect(out).not.toMatch(/audioFacet|avatarFacet|dataFacet|styleSource/)
  })

  it('data-viz hint carries the resolved axis/grid colors (preset-derived, not new state)', () => {
    const out = composeFacetedStyleSpec({ globalStyle: { ...EMPTY_STYLE, presetId: 'data-story' } })!
    expect(out).toMatch(/Data-viz.*axis #/)
  })
})

// ── PR2 / T4: a SAVED style supplies per-facet sources, mixable with preset/brand
describe('composeFacetedStyleSpec — saved style as per-facet source (PR2)', () => {
  const SAVED = {
    name: 'Editorial Calm',
    facets: {
      palette: ['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'],
      fonts: ['Söhne', 'Inter'],
      background: '#101418',
      motion: { motionPersonality: 'premium', cameraMoves: ['dollyIn', 'pan'] },
      renderer: 'react',
      visualCharacter: { roughness: 0, presetId: null },
    },
  }

  it('a saved style contributes the palette facet, attributed to the named saved style', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, savedStyle: SAVED })!
    expect(out).toMatch(/\*\*Palette\*\*.*saved style "Editorial Calm"/)
    expect(out).toContain('#c8553d')
    expect(out).toContain('## Style Spec')
  })

  it('MIXING: saved style supplies the palette while motionPersonality supplies motion', () => {
    // preset 'kraft' is set, but the saved style outranks it for the palette facet;
    // motionPersonality (a DIFFERENT block) supplies motion — true cross-block mixing.
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft', motionPersonality: 'playful' },
      savedStyle: SAVED,
    })!
    // Palette facet → saved style (NOT the kraft preset)
    expect(out).toMatch(/\*\*Palette\*\*.*saved style "Editorial Calm"/)
    expect(out).not.toMatch(/\*\*Palette\*\* _\(preset "kraft"/)
    expect(out).toMatch(/\*\*Motion feel\*\*.*motionPersonality/)
    // The two facet sources are DIFFERENT strings → mixed, not one template
    const paletteSrc = out.match(/\*\*Palette\*\* _\(([^)]+)\)/)![1]
    const motionSrc = out.match(/\*\*Motion feel\*\* _\(([^)]+)\)/)![1]
    expect(paletteSrc).not.toEqual(motionSrc)
  })

  it('PRECEDENCE on the SAME facet: saved style > brand > preset for palette/typography', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'kraft' }, // preset = lowest of the three
      brandKit: BRAND, // brand = middle
      savedStyle: SAVED, // saved = highest (below override/explicit)
    })!
    // Saved style WINS the source attribution for palette + typography
    expect(out).toMatch(/\*\*Palette\*\*.*saved style "Editorial Calm"/)
    expect(out).toMatch(/\*\*Typography\*\*.*saved style "Editorial Calm"/)
    // Saved value leads
    expect(out).toMatch(/\*\*Palette\*\* _\(saved style[^)]*\)_: \[#101418/)
    expect(out).toContain('Söhne')
    // Brand stays VISIBLE (informative), but does NOT own the facet
    expect(out).toContain('brand palette available')
  })

  it('a per-project override OUTRANKS the saved style for the palette facet', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, paletteOverride: ['#aaa', '#bbb', '#ccc', '#ddd'] },
      savedStyle: SAVED,
    })!
    expect(out).toMatch(/\*\*Palette\*\*.*project override/)
    expect(out).not.toMatch(/\*\*Palette\*\*.*saved style/)
  })

  it('an EXPLICIT user signal OUTRANKS the saved style for the palette facet', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: EMPTY_STYLE,
      latestUserMessage: 'use a teal palette',
      savedStyle: SAVED,
    })!
    expect(out).toMatch(/\*\*Palette\*\*.*your request this turn/)
    expect(out).not.toMatch(/\*\*Palette\*\*.*saved style/)
  })

  it('saved style supplies the MOTION facet when the project sets no motionPersonality', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, savedStyle: SAVED })!
    expect(out).toMatch(/\*\*Motion feel\*\*.*saved style "Editorial Calm"/)
    expect(out).toContain('premium feel')
    expect(out).toContain('dollyIn')
  })

  it('the projects own motionPersonality OUTRANKS the saved-style motion facet', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, motionPersonality: 'corporate' },
      savedStyle: SAVED,
    })!
    expect(out).toMatch(/\*\*Motion feel\*\*.*motionPersonality/)
    expect(out).toContain('corporate')
    expect(out).not.toMatch(/\*\*Motion feel\*\*.*saved style/)
  })

  it('a saved style ALONE (no preset/brand/override) still produces a block', () => {
    const out = composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE, savedStyle: SAVED })
    expect(out).not.toBeNull()
    expect(out!).toContain('saved style "Editorial Calm"')
  })
})

describe('composeFacetedStyleSpec — bounded + empty-guard', () => {
  it('returns null when there is genuinely nothing to say', () => {
    expect(composeFacetedStyleSpec({ globalStyle: EMPTY_STYLE })).toBeNull()
  })

  it('the summarized non-visual hint line is bounded (no full agentGuidance dump)', () => {
    const out = composeFacetedStyleSpec({ globalStyle: { ...EMPTY_STYLE, presetId: 'cinematic' } })!
    // cinematic's full agentGuidance is ~100 lines / >2000 chars. The hint line
    // must be a SUMMARY — assert the audio/avatar tone hint line is short.
    const hintLine = out.split('\n').find((l) => l.includes('Audio / avatar tone'))!
    expect(hintLine.length).toBeLessThan(280)
  })

  it('the whole block stays bounded — nothing attaches a verbatim body any more', () => {
    // The playbook body was the one large authored block appended verbatim. Gone.
    const out = composeFacetedStyleSpec({
      globalStyle: { ...EMPTY_STYLE, presetId: 'cinematic' },
      latestUserMessage: 'make a how-to tutorial, punchy fast cuts, podcast style',
    })!
    expect(out.length).toBeLessThan(1500)
  })
})

// ── Integration: the ONE block replaces the 5 scattered injections ───────────
describe('buildAgentContext integration — Style Spec replaces the 5 injections', () => {
  function promptFor(
    style: GlobalStyle,
    extra: {
      latestUserMessage?: string
      brandKit?: BrandKit | null
      memories?: Array<{ category: string; key: string; value: string; confidence: number }>
    } = {},
  ): string {
    return buildAgentContext(
      'scene-maker',
      {
        agentType: 'scene-maker',
        activeTools: [],
        sceneContext: 'all',
        latestUserMessage: extra.latestUserMessage,
        brandKit: extra.brandKit ?? null,
      },
      [],
      style,
      'Integration Test',
      'mp4',
      undefined,
      undefined,
      'off',
      undefined,
      undefined,
      extra.memories,
    ).systemPrompt
  }

  it('the consolidated block is present and the OLD scattered headers are gone', () => {
    const prompt = promptFor({ ...EMPTY_STYLE, presetId: 'kraft' })
    expect(prompt).toContain('## Style Spec')
    // The old standalone injection headers must not reappear (consolidation)
    expect(prompt).not.toContain('## Pipeline Playbook:')
    expect(prompt).not.toContain('## Learned User Preferences')
    // serializeGlobalStyle's verbose "Global Style:" guidance is gone; only the
    // compact world-state snapshot remains.
    expect(prompt).toContain('Global Style (snapshot')
  })

  it('content parity for unchanged style — no facet is silently dropped', () => {
    const prompt = promptFor(
      { ...EMPTY_STYLE, presetId: 'kraft', motionPersonality: 'playful' },
      {
        latestUserMessage: 'make a how-to tutorial about composting',
        brandKit: BRAND,
        memories: [{ category: 'style', key: 'bg', value: 'warm earthy backgrounds', confidence: 0.8 }],
      },
    )
    // Visual facet (was serializeGlobalStyle + preset guidance)
    expect(prompt).toMatch(/\*\*Palette\*\*/)
    // Motion facet
    expect(prompt).toContain('playful')
    // Brand facet source (was Brand Kit palette/font lines)
    expect(prompt).toContain('Brandon Grotesque')
    // Memory facet (was Learned User Preferences) — contract phrases preserved
    expect(prompt).toContain('warm earthy backgrounds')
    expect(prompt).toContain('ACTIVE DEFAULT')
    expect(prompt).toMatch(/explicit request[\s\S]*always wins/i)
  })

  it('brand logos + tools survive in the slimmed Brand Kit section (operational)', () => {
    const prompt = promptFor({ ...EMPTY_STYLE }, { brandKit: { ...BRAND, guidelines: 'No drop shadows.' } })
    expect(prompt).toContain('## Brand Kit (assets & tools)')
    expect(prompt).toContain('No drop shadows.')
    // The operational payload is the logo URLs + the 3D-extrude pointer, both of which
    // the model can act on directly. It must NOT name `brand_kit`: that tool is defined
    // but never offered to scene-maker, so commanding it sent the model after a
    // signature it doesn't have. See no-phantom-tool-names.test.ts.
    expect(prompt).toContain('buildSVG3D')
    expect(prompt).not.toContain('brand_kit')
    // Palette/font live in the Style Spec, not duplicated here
    expect(prompt).not.toContain('**Brand Palette:**')
  })
})

describe('composeFacetedStyleSpec — feedback-category memories are NOT active defaults (P2)', () => {
  it('excludes run-diagnostic feedback memories from the Learned User Preferences block', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: EMPTY_STYLE,
      memories: [
        // Real durable taste — belongs in the active-default block.
        { category: 'style', key: 'prefers_dark_bg', value: 'dark backgrounds', confidence: 0.9 },
        // Run diagnostics minted by extractMemories — must NOT be rendered as a
        // standing "ACTIVE DEFAULT" preference.
        {
          category: 'feedback',
          key: 'scene_type_failure_d3',
          value: 'd3 generation failed 3 times in this run — consider alternative renderer',
          confidence: 0.7,
        },
        {
          category: 'feedback',
          key: 'high_regeneration_rate',
          value: '5 regeneration calls in one run',
          confidence: 0.6,
        },
      ],
    })!
    expect(out).toContain('Learned User Preferences')
    expect(out).toContain('dark backgrounds') // taste memory survives
    expect(out).not.toContain('scene_type_failure_d3')
    expect(out).not.toContain('high_regeneration_rate')
  })

  it('returns null when the ONLY memories are feedback diagnostics (no active-default block)', () => {
    const out = composeFacetedStyleSpec({
      globalStyle: EMPTY_STYLE,
      memories: [
        { category: 'feedback', key: 'high_regeneration_rate', value: '5 regeneration calls', confidence: 0.9 },
      ],
    })
    expect(out).toBeNull()
  })
})
