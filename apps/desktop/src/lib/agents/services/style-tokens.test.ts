// @vitest-environment node
//
// PR-D (D1) — reference → structured style tokens. Proves a reference's
// understanding brief is reshaped into a STRUCTURED, consumable token set
// (palette/fonts/mood/lighting/composition/subjects) with no model call, that
// a sparse brief yields a sparse-but-honest token set, and that the helpers
// used by D2 (memory rows) and D3 (prompt clause, explicit-override) behave.

import { describe, it, expect } from 'vitest'
import {
  extractStyleTokens,
  hasStyleSignal,
  renderTokensForPrompt,
  tokensToMemoryRows,
  coerceStyleTokens,
  normalizeHex,
  hexPresentIn,
  phraseMatches,
  isHex,
  type StyleTokens,
} from './style-tokens'
import type { UnderstandingBrief } from '../types'

function makeBrief(overrides: Partial<UnderstandingBrief> = {}): UnderstandingBrief {
  return {
    summary: 'A reference image.',
    perMedia: [],
    costUsd: 0,
    modelsUsed: [],
    ...overrides,
  }
}

describe('extractStyleTokens (D1)', () => {
  it('extracts a structured token set from a rich brief', () => {
    const brief = makeBrief({
      summary:
        'A moody product shot with soft light and a centered composition, shot in a minimalist studio.',
      visualStyle: {
        palette: ['#1a1917', '#f0ece0', '#c08457'],
        mood: 'warm, archival',
        typography: 'condensed serif',
      },
      subjects: ['ceramic mug', 'wooden table'],
      perMedia: [
        {
          mediaId: 'm1',
          kind: 'image',
          backend: 'cloud:anthropic',
          caption: 'A ceramic mug under soft light, centered composition.',
          mood: 'warm, archival',
          palette: ['#1a1917', '#f0ece0', '#c08457'],
          subjects: ['ceramic mug'],
        },
      ],
    })
    const tokens = extractStyleTokens(brief)
    expect(tokens.palette).toEqual(['#1a1917', '#f0ece0', '#c08457'])
    expect(tokens.mood).toBe('warm, archival')
    expect(tokens.subjects).toContain('ceramic mug')
    // Lighting + composition are best-effort keyword reads of caption/summary.
    expect(tokens.lighting).toBe('soft light')
    expect(tokens.composition).toBe('centered composition')
    // Typography hint surfaced from visualStyle + caption cues.
    expect(tokens.fonts).toContain('condensed serif')
    expect(hasStyleSignal(tokens)).toBe(true)
  })

  it('yields a sparse-but-honest token set (no invented values)', () => {
    const brief = makeBrief({
      summary: 'An audio clip with narration.',
      perMedia: [{ mediaId: 'a1', kind: 'audio', backend: 'cloud:whisper', transcript: 'hello world' }],
    })
    const tokens = extractStyleTokens(brief)
    // No visual signal → no palette/mood/lighting/composition.
    expect(tokens.palette).toBeUndefined()
    expect(tokens.mood).toBeUndefined()
    expect(tokens.lighting).toBeUndefined()
    expect(tokens.composition).toBeUndefined()
    expect(hasStyleSignal(tokens)).toBe(false)
  })

  it('does not treat audio/doc captions as a visual style signal', () => {
    const brief = makeBrief({
      summary: 'reference',
      // visualStyle has no palette/mood; only a doc caption mentions lighting.
      perMedia: [
        { mediaId: 'd1', kind: 'doc', backend: 'cloud:anthropic', caption: 'soft light document', ocrText: 'x' },
      ],
    })
    const tokens = extractStyleTokens(brief)
    // 'soft light' came only from a doc caption → not folded into a visual token.
    expect(tokens.lighting).toBeUndefined()
  })
})

describe('extractStyleTokens — B2 visual-only merge filter', () => {
  it('does not leak an audio/doc mood or subject into the tokens', () => {
    const brief = makeBrief({
      summary: 'A mixed-media reference.',
      // Cross-kind merged fields (what the old code read) carry the doc/audio signal.
      visualStyle: { palette: ['#1a1917'], mood: 'somber, spoken-word' },
      subjects: ['narrator voice', 'ceramic mug'],
      perMedia: [
        {
          mediaId: 'img1',
          kind: 'image',
          backend: 'cloud:anthropic',
          caption: 'A ceramic mug on a table.',
          palette: ['#1a1917', '#f0ece0'],
          mood: 'warm, archival',
          subjects: ['ceramic mug'],
        },
        {
          // An audio analysis contributes a mood + a "subject" that must NOT surface.
          mediaId: 'aud1',
          kind: 'audio',
          backend: 'cloud:whisper',
          mood: 'somber, spoken-word',
          subjects: ['narrator voice'],
          transcript: 'hello',
        },
        {
          mediaId: 'doc1',
          kind: 'doc',
          backend: 'cloud:anthropic',
          subjects: ['invoice number'],
          ocrText: 'INVOICE',
        },
      ],
    })
    const tokens = extractStyleTokens(brief)
    // Palette + mood + subjects derived ONLY from the visual (image) analysis.
    expect(tokens.palette).toEqual(['#1a1917', '#f0ece0'])
    expect(tokens.mood).toBe('warm, archival')
    expect(tokens.mood).not.toContain('spoken-word')
    expect(tokens.subjects).toEqual(['ceramic mug'])
    expect(tokens.subjects).not.toContain('narrator voice')
    expect(tokens.subjects).not.toContain('invoice number')
  })

  it('aggregates palette/subjects across multiple visual analyses (image+video), de-duped', () => {
    const brief = makeBrief({
      perMedia: [
        { mediaId: 'i1', kind: 'image', backend: 'x', palette: ['#111', '#222'], subjects: ['mug'] },
        { mediaId: 'v1', kind: 'video', backend: 'x', palette: ['#222', '#333'], subjects: ['mug', 'logo'] },
        // doc palette/subjects must be excluded entirely
        { mediaId: 'd1', kind: 'doc', backend: 'x', palette: ['#999'], subjects: ['footnote'] },
      ],
    })
    const tokens = extractStyleTokens(brief)
    expect(tokens.palette).toEqual(['#111', '#222', '#333'])
    expect(tokens.subjects).toEqual(['mug', 'logo'])
  })
})

describe('A2 — normalizeHex / hexPresentIn / phraseMatches', () => {
  it('normalizeHex canonicalizes 3/4/6/8-digit hex to 6-digit lowercase', () => {
    expect(normalizeHex('#fff')).toBe('#ffffff')
    expect(normalizeHex('#FFFFFF')).toBe('#ffffff')
    expect(normalizeHex('#FFF8')).toBe('#ffffff') // 4-digit (alpha dropped)
    expect(normalizeHex('#1A1917')).toBe('#1a1917')
    expect(normalizeHex('#1a1917ff')).toBe('#1a1917') // 8-digit (alpha dropped)
    // Non-hex passes through (lowercased/trimmed).
    expect(normalizeHex('  Soft Light ')).toBe('soft light')
  })

  it('hexPresentIn treats #fff == #ffffff (both directions) and avoids false substring hits', () => {
    // #fff IS present when haystack says #ffffff (canonical equality).
    expect(hexPresentIn('background is #ffffff here', '#fff')).toBe(true)
    // and the reverse: #ffffff present when haystack says #fff.
    expect(hexPresentIn('use #fff please', '#ffffff')).toBe(true)
    // #fff is NOT falsely "found" inside an unrelated longer hex literal.
    expect(hexPresentIn('accent #fff000', '#fff')).toBe(false)
    expect(isHex('#fff')).toBe(true)
    expect(isHex('soft light')).toBe(false)
  })

  it('phraseMatches respects word boundaries (soft light vs soft lightbox)', () => {
    expect(phraseMatches('a soft light scene', 'soft light')).toBe(true)
    expect(phraseMatches('a soft lightbox scene', 'soft light')).toBe(false)
    expect(phraseMatches('minimalist studio', 'minimal')).toBe(false)
    expect(phraseMatches('minimal layout', 'minimal')).toBe(true)
  })
})

describe('tokensToMemoryRows (D2)', () => {
  it('maps salient tokens to style memory rows and omits subjects', () => {
    const tokens: StyleTokens = {
      palette: ['#111', '#222'],
      fonts: ['serif'],
      mood: 'calm',
      lighting: 'golden hour',
      composition: 'rule of thirds',
      subjects: ['mug'], // deliberately not persisted
    }
    const rows = tokensToMemoryRows(tokens)
    const keys = rows.map((r) => r.key)
    expect(keys).toEqual([
      'reference_palette',
      'reference_typography',
      'reference_mood',
      'reference_lighting',
      'reference_composition',
    ])
    expect(rows.every((r) => r.category === 'style')).toBe(true)
    expect(rows.find((r) => r.key === 'reference_palette')?.value).toBe('#111, #222')
  })
})

describe('coerceStyleTokens (untrusted referenceTokens shape)', () => {
  it('coerces a string palette/fonts into arrays (the .join crash path)', () => {
    const t = coerceStyleTokens({ palette: '#fff', fonts: 'Inter', mood: 'calm' })
    expect(t?.palette).toEqual(['#fff'])
    expect(t?.fonts).toEqual(['Inter'])
    expect(t?.mood).toBe('calm')
    // proves it no longer throws downstream
    expect(() => tokensToMemoryRows(t as StyleTokens)).not.toThrow()
  })
  it('keeps well-shaped arrays and drops empty/blank entries', () => {
    const t = coerceStyleTokens({ palette: ['#0f172a', '', '  '], composition: 'rule of thirds' })
    expect(t?.palette).toEqual(['#0f172a'])
    expect(t?.composition).toBe('rule of thirds')
  })
  it('returns null for junk / no usable signal', () => {
    expect(coerceStyleTokens(null)).toBeNull()
    expect(coerceStyleTokens('nope')).toBeNull()
    expect(coerceStyleTokens({ palette: [], mood: '   ' })).toBeNull()
  })
})

describe('renderTokensForPrompt (D3 helper)', () => {
  it('renders a clause and returns empty for no-signal tokens', () => {
    expect(renderTokensForPrompt({})).toBe('')
    const clause = renderTokensForPrompt({ palette: ['#111'], mood: 'calm', lighting: 'soft light' })
    expect(clause).toContain('Match this reference style')
    expect(clause).toContain('#111')
    expect(clause).toContain('calm mood')
  })
})
