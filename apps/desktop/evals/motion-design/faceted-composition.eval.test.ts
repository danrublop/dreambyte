// @vitest-environment node
/**
 * COMPOSITION eval — the deterministic gate for faceted style
 * composition. Mirrors the memory-ab eval pattern: $0, no provider key. It does
 * NOT judge whether the produced video is good (that is the human RUBRIC); it
 * proves the COMPOSITION CONTRACT the design locks in:
 *
 *   "Style is compositional — facets come from DIFFERENT blocks, named by source."
 *
 * Each scenario sets up a state where the RIGHT answer is a facet drawn from a
 * different block than another facet, and asserts the rendered ## Style Spec
 * block reflects those distinct sources. A live-quality bar (does the model
 * honor the spec) is an in-app smoke — out of scope here by design.
 */

import { describe, it, expect } from 'vitest'
import { composeFacetedStyleSpec } from '../../src/lib/agents/faceted-style-composer'
import type { SavedStyleFacetSource } from '../../src/lib/skills/distill'
import type { GlobalStyle } from '../../src/lib/types'
import type { BrandKit } from '../../src/lib/types/media'

const EMPTY: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

/** Pull a facet line's source attribution from the rendered block. */
function sourceOf(block: string, facet: string): string | null {
  const m = block.match(new RegExp(`\\*\\*${facet.replace(/[/]/g, '\\$&')}\\*\\* _\\(([^)]+)\\)`))
  return m ? m[1] : null
}

interface Scenario {
  name: string
  style: GlobalStyle
  message?: string
  brandKit?: BrandKit | null
  /** A saved style decomposed into per-facet sources. */
  savedStyle?: SavedStyleFacetSource | null
  /** facet → a regex its source attribution must match */
  expectSources: Record<string, RegExp>
  /** at least these two facets must have DIFFERENT sources (cross-block) */
  distinct: [string, string]
}

/** A distilled saved style projected to per-facet sources. */
const SAVED_EDITORIAL: SavedStyleFacetSource = {
  name: 'Editorial Calm',
  facets: {
    palette: ['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'],
    fonts: ['Söhne', 'Inter'],
    motion: { motionPersonality: 'premium', cameraMoves: ['dollyIn', 'pan'] },
    renderer: 'react',
  },
}

const ACME_BRAND: BrandKit = {
  brandName: 'Acme',
  logoAssetIds: [],
  palette: ['#0055ff', '#ffffff', '#222222', '#ff8800'],
  fontPrimary: 'Brandon Grotesque',
  fontSecondary: null,
  guidelines: null,
}

const SCENARIOS: Scenario[] = [
  {
    // Preset palette + a DIFFERENT block's motion (motionPersonality).
    name: 'preset palette + motionPersonality motion',
    style: { ...EMPTY, presetId: 'kraft', motionPersonality: 'playful' },
    message: 'make a how-to tutorial walking through composting step by step',
    expectSources: {
      Palette: /preset "kraft"/,
      'Motion feel': /motionPersonality/,
    },
    distinct: ['Palette', 'Motion feel'],
  },
  {
    // Brand palette + preset visual character + motionPersonality motion — three
    // blocks contributing three facets.
    name: 'brand palette + preset character + motionPersonality motion',
    style: { ...EMPTY, presetId: 'cinematic', motionPersonality: 'energetic' },
    brandKit: ACME_BRAND,
    expectSources: {
      // brand wins palette attribution when no project override is set
      Palette: /brand kit "Acme"/,
      'Visual character': /preset "cinematic"/,
      'Motion feel': /motionPersonality/,
    },
    distinct: ['Palette', 'Motion feel'],
  },
  {
    // Explicit user signal overrides a preset facet — the precedence contract.
    name: 'explicit user background overrides preset background',
    style: { ...EMPTY, presetId: 'whiteboard' },
    // "black background" trips the background detector but not the palette one,
    // so palette stays attributed to the preset — a clean cross-block contrast.
    message: 'use a black background for this one',
    expectSources: {
      Background: /your request this turn/,
      Palette: /preset "whiteboard"/,
    },
    distinct: ['Background', 'Palette'],
  },
  {
    // A SAVED style supplies the palette facet while the PRESET (a different
    // block) supplies visual character — the saved-style cross-block mix.
    name: 'saved-style palette + preset visual character',
    style: { ...EMPTY, presetId: 'kraft' }, // a preset is set, but saved style outranks it for palette
    message: 'make a how-to tutorial walking through the setup step by step',
    savedStyle: SAVED_EDITORIAL,
    expectSources: {
      Palette: /saved style "Editorial Calm"/,
      'Visual character': /preset "kraft"/,
    },
    distinct: ['Palette', 'Visual character'],
  },
  {
    // A SAVED style supplies palette/motion while a PRESET supplies the
    // visual character — three sources, three facets, no wholesale template.
    name: 'saved-style palette+motion + preset visual character',
    style: { ...EMPTY, presetId: 'cinematic' },
    savedStyle: SAVED_EDITORIAL,
    expectSources: {
      Palette: /saved style "Editorial Calm"/,
      'Motion feel': /saved style "Editorial Calm"/,
      'Visual character': /preset "cinematic"/,
    },
    distinct: ['Palette', 'Visual character'],
  },
]

describe('faceted composition eval — facets come from different blocks, named by source', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}`, () => {
      const block = composeFacetedStyleSpec({
        globalStyle: sc.style,
        latestUserMessage: sc.message,
        brandKit: sc.brandKit ?? null,
        savedStyle: sc.savedStyle ?? null,
      })
      expect(block, 'block should render').toBeTruthy()
      // Every expected facet attributes to its expected source.
      for (const [facet, re] of Object.entries(sc.expectSources)) {
        const src = sourceOf(block!, facet)
        expect(src, `${facet} source in "${sc.name}"`).toMatch(re)
      }
      // The two named facets must come from DIFFERENT blocks (the cross-block core).
      const [a, b] = sc.distinct
      expect(sourceOf(block!, a)).not.toEqual(sourceOf(block!, b))
    })
  }

  it('a styleless project produces no block (no empty injection leaks)', () => {
    expect(composeFacetedStyleSpec({ globalStyle: EMPTY })).toBeNull()
  })
})
