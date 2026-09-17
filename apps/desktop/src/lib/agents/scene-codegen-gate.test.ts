// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { hasTemplateInterpInQuotedString } from './tool-executor'

/**
 * Regression gate: the AI codegen path can commit `${...}` interpolation inside a
 * plain quoted string — syntactically valid, but it renders the literal text
 * "${expr}" (broken SVG paths, dead CSS transforms). The runtime syntax gate
 * can't catch it because it isn't a syntax error.
 */

describe('hasTemplateInterpInQuotedString (#6)', () => {
  it('flags ${...} inside a double-quoted SVG path attribute', () => {
    expect(hasTemplateInterpInQuotedString('<path d="M110 140 V60 C110 ${20 + x} 190 60 V140" />')).toBe(true)
  })

  it('flags ${...} inside a single-quoted attribute', () => {
    expect(hasTemplateInterpInQuotedString("<g transform='rotate(${deg})' />")).toBe(true)
  })

  it('flags ${...} inside a quoted style string', () => {
    expect(hasTemplateInterpInQuotedString('style={{ transform: "translateY(${headerY}px)" }}')).toBe(true)
  })

  it('does NOT flag a legitimate backtick template literal', () => {
    expect(hasTemplateInterpInQuotedString('const t = `translateY(${y}px)`')).toBe(false)
    expect(hasTemplateInterpInQuotedString('style={{ transform: `scale(${camS})` }}')).toBe(false)
  })

  it('does NOT flag a clean quoted string', () => {
    expect(hasTemplateInterpInQuotedString('<path d="M110 140 V60 C110 20 190 60 V140" />')).toBe(false)
    expect(hasTemplateInterpInQuotedString('const label = "price: $5 each"')).toBe(false)
  })
})
