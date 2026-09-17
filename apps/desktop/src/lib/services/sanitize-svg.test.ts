import { describe, it, expect } from 'vitest'

import { sanitizeSvg } from './sanitize-svg'

// Security review F85: SVG served same-origin must have active content stripped.
// F159: backed by DOMPurify (tree-based) instead of regex, so encoded/SMIL
// bypasses are also closed. DOMPurify reserializes, so assertions check for the
// absence of active content rather than exact-string equality.
describe('sanitizeSvg', () => {
  it('strips <script> blocks', () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('strips on* event handlers', () => {
    const out = sanitizeSvg('<svg onload="evil()"><rect onclick="x"/></svg>')
    expect(out).not.toMatch(/on\w+\s*=/i)
  })

  it('neutralizes javascript: URIs', () => {
    const out = sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>')
    expect(out).not.toContain('javascript:')
  })

  it('strips <foreignObject>', () => {
    const out = sanitizeSvg('<svg><foreignObject><body>hi</body></foreignObject></svg>')
    expect(out).not.toContain('foreignObject')
  })

  // Regex bypasses the old sanitizer missed — now caught by tree parsing.
  it('strips SMIL handler/href injection (<set>, <animate>)', () => {
    const out = sanitizeSvg(
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a>' +
        '<set attributeName="onload" to="evil()"/></svg>',
    )
    expect(out).not.toContain('javascript:')
    expect(out).not.toMatch(/onload/i)
  })

  it('neutralizes entity-encoded javascript: URIs', () => {
    const out = sanitizeSvg('<svg><a href="&#106;avascript:alert(1)">x</a></svg>')
    expect(out).not.toMatch(/javascript:/i)
  })

  it('keeps internal <use> fragment refs (sprite/symbol reuse)', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="a" width="10" height="10"/></defs><use href="#a"/></svg>',
    )
    expect(out).toContain('<use')
    expect(out).toContain('href="#a"')
  })

  it('drops <use> pointing off-document (external URL / data: SSRF+XSS)', () => {
    const ext = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>')
    expect(ext).not.toContain('<use')
    expect(ext).not.toContain('evil.example')
    const data = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml,<svg onload=alert(1)>#a"/></svg>',
    )
    expect(data).not.toContain('<use')
    expect(data).not.toContain('onload')
  })

  it('preserves the root xmlns so the stored file still renders', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>',
    )
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('leaves benign markup intact', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>')
    expect(out).toContain('<svg')
    expect(out).toContain('viewBox="0 0 10 10"')
    expect(out).toContain('<rect')
    expect(out).toContain('width="10"')
    expect(out).toContain('height="10"')
    expect(out).toContain('fill="#f00"')
  })

  // Security review (both-attrs): <use> href AND xlink:href must each be a
  // same-document #fragment. The keep-fragment / strip-external-href cases are
  // covered above; these add the xlink:href axis the single-attr check missed.
  describe('<use> xlink:href independence', () => {
    it('strips <use> with an external xlink:href', () => {
      expect(sanitizeSvg('<svg><use xlink:href="//evil/x"/></svg>')).not.toContain('<use')
    })

    it('strips <use> when a safe href is paired with an evil xlink:href', () => {
      expect(sanitizeSvg('<svg><use href="#ok" xlink:href="http://evil"/></svg>')).not.toContain('<use')
    })
  })
})
