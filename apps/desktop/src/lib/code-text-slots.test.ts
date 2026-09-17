import { describe, expect, it } from 'vitest'
import {
  extractCodeTextSlots,
  resolveSlot,
  updateMixedContentText,
  updateSlotStyleProp,
  updateSlotText,
} from './code-text-slots'

describe('extractCodeTextSlots', () => {
  it('finds heading, paragraph, div text', () => {
    const code = '<h1 style={{ fontSize: 168, fontWeight: 800 }}>INTRO</h1><p>Body text here.</p><div>Plain</div>'
    const slots = extractCodeTextSlots(code)
    const kinds = slots.map((s) => s.kind)
    expect(kinds).toContain('jsx-heading')
    expect(kinds).toContain('jsx-paragraph')
    expect(kinds).toContain('jsx-div')
    const heading = slots.find((s) => s.kind === 'jsx-heading')!
    expect(heading.text).toBe('INTRO')
    expect(heading.style.fontSize).toBe(168)
    expect(heading.style.fontWeight).toBe(800)
  })

  it('parses SVG <text> attributes', () => {
    const code = '<svg><text x="10" font-size="48" font-weight="700" fill="#fff">Hello</text></svg>'
    const slots = extractCodeTextSlots(code)
    const slot = slots.find((s) => s.kind === 'svg-text')!
    expect(slot.text).toBe('Hello')
    expect(slot.style.fontSize).toBe(48)
    expect(slot.style.fontWeight).toBe(700)
    expect(slot.style.color).toBe('#fff')
  })

  it('finds canvas2d and three.js text literals', () => {
    const code = `ctx.fillText('Hi there', 10, 20); new TextGeometry('3D!', { size: 12 })`
    const slots = extractCodeTextSlots(code)
    const canvas = slots.find((s) => s.kind === 'canvas-text')!
    expect(canvas.text).toBe('Hi there')
    const three = slots.find((s) => s.kind === 'three-text')!
    expect(three.text).toBe('3D!')
  })
})

describe('updateSlotText', () => {
  it('rewrites heading inner text', () => {
    const code = '<h1 style={{ fontSize: 96 }}>OLD</h1>'
    const slot = resolveSlot(code, 'jsx-heading', 0)!
    const next = updateSlotText(code, slot, 'NEW')!
    expect(next).toBe('<h1 style={{ fontSize: 96 }}>NEW</h1>')
  })

  it('rewrites canvas fillText literal preserving quotes', () => {
    const code = `ctx.fillText('Old', 0, 0)`
    const slot = resolveSlot(code, 'canvas-text', 0)!
    const next = updateSlotText(code, slot, 'New')!
    expect(next).toBe(`ctx.fillText('New', 0, 0)`)
  })

  it('rewrites the right occurrence when text repeats', () => {
    const code = '<h1>Hi</h1><h1>Hi</h1>'
    const second = extractCodeTextSlots(code).filter((s) => s.kind === 'jsx-heading')[1]
    const next = updateSlotText(code, second, 'Bye')!
    expect(next).toBe('<h1>Hi</h1><h1>Bye</h1>')
  })
})

describe('updateSlotStyleProp', () => {
  it('updates existing fontSize in style={{...}}', () => {
    const code = '<h1 style={{ fontSize: 96, color: "#fff" }}>HI</h1>'
    const slot = resolveSlot(code, 'jsx-heading', 0)!
    const next = updateSlotStyleProp(code, slot, 'fontSize', 200)!
    expect(next).toContain('fontSize: 200')
    // Color prop is preserved exactly as it was in the source (double-quoted).
    expect(next).toContain('color: "#fff"')
  })

  it('injects style={{}} when missing', () => {
    const code = '<h1>HI</h1>'
    const slot = resolveSlot(code, 'jsx-heading', 0)!
    const next = updateSlotStyleProp(code, slot, 'fontSize', 200)!
    expect(next).toBe('<h1 style={{ fontSize: 200 }}>HI</h1>')
  })

  it('removes a prop when value is empty', () => {
    const code = '<h1 style={{ fontSize: 96, color: "#fff" }}>HI</h1>'
    const slot = resolveSlot(code, 'jsx-heading', 0)!
    const next = updateSlotStyleProp(code, slot, 'color', '')!
    expect(next).not.toContain('color')
    expect(next).toContain('fontSize: 96')
  })

  it('updates an SVG text font-size attribute', () => {
    const code = '<text font-size="48">Hi</text>'
    const slot = resolveSlot(code, 'svg-text', 0)!
    const next = updateSlotStyleProp(code, slot, 'fontSize', 96)!
    expect(next).toContain('font-size="96"')
  })

  it('refuses style edits on canvas/three text', () => {
    const code = `ctx.fillText('A', 0, 0)`
    const slot = resolveSlot(code, 'canvas-text', 0)!
    expect(updateSlotStyleProp(code, slot, 'fontSize', 24)).toBeNull()
  })
})

describe('updateMixedContentText', () => {
  it('rewrites a text run between siblings without touching them', () => {
    const code = '<h1>Hello <em>world</em>, friend</h1>'
    const next = updateMixedContentText(code, 'Hello', 'Hi')
    expect(next).toBe('<h1>Hi <em>world</em>, friend</h1>')
  })

  it('rewrites the trailing run after a child element', () => {
    const code = '<p>One <span>two</span> three</p>'
    const next = updateMixedContentText(code, 'three', 'THREE')
    expect(next).toBe('<p>One <span>two</span> THREE</p>')
  })

  it('escapes JSX-special characters in new text', () => {
    const code = '<h1>Old <em>x</em> rest</h1>'
    const next = updateMixedContentText(code, 'Old', 'A & B {expr}')!
    expect(next).toContain('A &amp; B &#123;expr&#125;')
    // Sibling untouched.
    expect(next).toContain('<em>x</em>')
  })

  it('returns null when the run is ambiguous (multiple matches)', () => {
    const code = '<h1>Hi <em>x</em> Hi</h1><h2>Hi</h2>'
    expect(updateMixedContentText(code, 'Hi', 'Bye')).toBeNull()
  })

  it('returns null when the run is not found', () => {
    const code = '<h1>Hello <em>world</em></h1>'
    expect(updateMixedContentText(code, 'missing', 'x')).toBeNull()
  })

  it('refuses runs that contain JSX braces', () => {
    const code = '<h1>Hi {name}</h1>'
    expect(updateMixedContentText(code, 'Hi {name}', 'Yo')).toBeNull()
  })

  it('refuses empty / whitespace-only originals', () => {
    expect(updateMixedContentText('<h1>x</h1>', '', 'y')).toBeNull()
    expect(updateMixedContentText('<h1>x</h1>', '   ', 'y')).toBeNull()
  })

  it('handles whitespace around the run in source', () => {
    const code = '<h1>\n  Hi\n  <em>x</em>\n</h1>'
    const next = updateMixedContentText(code, 'Hi', 'Bye')!
    // Preserves the surrounding whitespace exactly.
    expect(next).toBe('<h1>\n  Bye\n  <em>x</em>\n</h1>')
  })
})
