// @vitest-environment node

// Frontmatter parser robustness — the review flagged that CRLF / BOM inputs
// (real with the Windows-parity work) defeated detection, leaking raw YAML into
// the prompt or dropping playbooks. These lock the normalization.

import { describe, it, expect } from 'vitest'
import { parseFrontmatter, frontmatterType } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses LF frontmatter + strips it from the body', () => {
    const d = parseFrontmatter('---\ntype: rule\ntitle: X\n---\n# Body\ntext')
    expect(d.hasFrontmatter).toBe(true)
    expect(d.meta.type).toBe('rule')
    expect(d.body).toBe('# Body\ntext')
  })

  it('parses CRLF frontmatter (Windows) — no YAML leak', () => {
    const d = parseFrontmatter('---\r\ntype: rule\r\ntitle: X\r\n---\r\n# Body\r\ntext')
    expect(d.hasFrontmatter).toBe(true)
    expect(d.meta.type).toBe('rule')
    expect(d.body).toContain('# Body')
    expect(d.body).not.toContain('type:') // YAML did not leak into the body
  })

  it('parses lone-CR (classic Mac) frontmatter — no YAML leak', () => {
    const d = parseFrontmatter('---\rtype: rule\rtitle: X\r---\r# Body\rtext')
    expect(d.hasFrontmatter).toBe(true)
    expect(d.meta.type).toBe('rule')
    expect(d.body).toContain('# Body')
    expect(d.body).not.toContain('type:')
  })

  it('parses BOM-prefixed frontmatter', () => {
    const d = parseFrontmatter('﻿---\ntype: rule\n---\n# Body')
    expect(d.hasFrontmatter).toBe(true)
    expect(d.meta.type).toBe('rule')
  })

  it('no frontmatter → whole text is the body, empty meta', () => {
    const d = parseFrontmatter('# Just a body\nno yaml here')
    expect(d.hasFrontmatter).toBe(false)
    expect(d.body).toContain('# Just a body')
    expect(d.meta).toEqual({})
  })

  it('malformed YAML → empty meta but body preserved (never unreadable)', () => {
    const d = parseFrontmatter('---\n:\n  : broken\n: :\n---\n# Body')
    expect(d.body).toBe('# Body')
  })

  it('a body containing a --- horizontal rule is not mis-stripped', () => {
    const d = parseFrontmatter('---\ntype: rule\n---\n# A\n\n---\n\n# B')
    expect(d.meta.type).toBe('rule')
    expect(d.body).toContain('# A')
    expect(d.body).toContain('# B')
  })

  it('frontmatterType returns a non-empty type or null', () => {
    expect(frontmatterType('---\ntype: rule\n---\nx')).toBe('rule')
    expect(frontmatterType('---\ntitle: x\n---\nx')).toBe(null)
    expect(frontmatterType('no frontmatter')).toBe(null)
    expect(frontmatterType('---\ntype: "  "\n---\nx')).toBe(null)
  })
})
