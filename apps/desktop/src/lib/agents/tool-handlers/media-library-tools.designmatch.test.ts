// @vitest-environment node
//
// PR-D (D3) — generate_image_from_reference enriches its generation prompt with
// the most-recently-analyzed reference's style tokens (silent-user fallback),
// WITHOUT overriding a signal the user's prompt already states.

import { describe, it, expect } from 'vitest'
import { buildReferenceStyleClause } from './media-library-tools'
import type { StyleTokens } from '@/lib/agents/services/style-tokens'

const TOKENS: StyleTokens = {
  palette: ['#1a1917', '#c08457'],
  mood: 'warm archival',
  lighting: 'soft light',
  composition: 'centered composition',
  fonts: ['condensed serif'],
}

describe('buildReferenceStyleClause (D3)', () => {
  it('appends reference style tokens to a neutral prompt', () => {
    const clause = buildReferenceStyleClause('a coffee mug on a desk', TOKENS)
    expect(clause).toContain('Match this reference style')
    expect(clause).toContain('#1a1917')
    expect(clause).toContain('warm archival mood')
    expect(clause).toContain('soft light')
    expect(clause).toContain('centered composition')
    expect(clause).toContain('condensed serif')
  })

  it('does NOT override a signal the prompt already states (explicit user wins)', () => {
    // Prompt explicitly names a bright/high-key mood and a palette color — the
    // reference's conflicting "warm archival" / "#1a1917" must not be appended.
    const prompt = 'a coffee mug, bright cheerful warm archival vibe, using #1a1917'
    const clause = buildReferenceStyleClause(prompt, TOKENS)
    // mood phrase already present → not re-asserted
    expect(clause).not.toContain('warm archival mood')
    // palette hex already present → dropped from the palette clause
    expect(clause).not.toContain('#1a1917')
    // a non-conflicting token (the other palette color / lighting) still flows
    expect(clause).toContain('#c08457')
    expect(clause).toContain('soft light')
  })

  it('returns empty string when no reference tokens are available', () => {
    expect(buildReferenceStyleClause('a coffee mug', undefined)).toBe('')
    expect(buildReferenceStyleClause('a coffee mug', {})).toBe('')
  })

  // A2 — hex + descriptor match precision.
  it('treats #fff and #ffffff as the same color (canonical hex compare)', () => {
    const tokens: StyleTokens = { palette: ['#ffffff', '#c08457'] }
    // Prompt names the color in 3-digit form → the 6-digit token must be suppressed.
    const clause = buildReferenceStyleClause('a white mug on #fff backdrop', tokens)
    expect(clause).not.toContain('#ffffff')
    expect(clause).toContain('#c08457')
  })

  it('does NOT suppress a hex token that only appears as a substring of an unrelated hex', () => {
    const tokens: StyleTokens = { palette: ['#fff'] }
    // #fff must NOT be considered "present" inside the unrelated #fff000.
    const clause = buildReferenceStyleClause('accent color #fff000', tokens)
    expect(clause).toContain('#fff')
  })

  it('does NOT suppress "soft light" when the prompt only says "soft lightbox"', () => {
    const tokens: StyleTokens = { lighting: 'soft light' }
    const clause = buildReferenceStyleClause('a mug in a soft lightbox', tokens)
    // word-boundary match → "soft light" is still appended
    expect(clause).toContain('soft light')
  })
})
