import { describe, it, expect } from 'vitest'
import { generateSceneHTML } from './sceneTemplate'
import type { Scene } from './types'

/**
 * Inspector overrides vs the render loop.
 *
 * DreambyteComposition re-renders every frame from useCurrentFrame(), so React
 * rewrites any inline style it owns. Overrides used to be written straight onto
 * `el.style` once, 50ms after mount — which meant an override on an ANIMATED
 * property was wiped on the very next frame and the user's edit silently
 * reverted. Styles now ship as a stylesheet with !important, which outranks
 * React's inline writes.
 *
 * These assert on the emitted HTML rather than driving jsdom, because the bug
 * was in what we emit; jsdom's cascade is not the thing under test.
 */
function html(elementOverrides: Record<string, Record<string, unknown>>) {
  return generateSceneHTML({
    id: 's1',
    name: 'S',
    sceneType: 'react',
    duration: 5,
    bgColor: '#000',
    layers: [{ id: 'l1', generatedCode: 'function SceneComponent(){return null}', prompt: 'x' }],
    elementOverrides,
  } as unknown as Scene)
}

describe('inspector element overrides survive the render loop', () => {
  it('emits style overrides as !important CSS, not a one-shot inline write', () => {
    const out = html({ 'el-1': { opacity: 0.5 } })
    expect(out).toContain("decls += __kebab(prop) + ':'")
    expect(out).toContain("' !important;'")
    expect(out).toContain('document.head.appendChild(__styleEl)')
    // The old failure mode: assigning through el.style, which React overwrites
    // on the next frame. Nothing should write styles that way again.
    expect(out).not.toContain('el.style[prop] =')
    // ...and it must no longer be a single deferred shot.
    expect(out).not.toContain('setTimeout(function() {')
  })

  it('kebab-cases camelCase props and adds px to bare numbers', () => {
    const out = html({ 'el-1': { fontSize: 24 } })
    // The conversion is emitted as runtime JS, so assert the mechanism is present.
    expect(out).toContain("replace(/[A-Z]/g")
    expect(out).toContain("(val + 'px')")
  })

  it('escapes ids into the attribute selector — ids are generated, not authored', () => {
    const out = html({ 'we"ird': { color: 'red' } })
    expect(out).toContain('String(id).replace(/["\\\\]/g, \'\\\\$&\')')
    expect(out).toContain('[id="')
  })

  it('re-asserts text every frame, since CSS cannot set textContent', () => {
    const out = html({ 'el-1': { text: 'Hi' } })
    expect(out).toContain('requestAnimationFrame(__applyText)')
    // Guarded so it is a no-op on frames React did not clobber.
    expect(out).toContain('el.textContent !== __texts[i].text')
  })

  it('stays out of the way at runtime when there are no overrides', () => {
    const out = html({})
    // The block is always emitted; the guard is a runtime one, so nothing
    // touches the document or starts an rAF loop on a scene with no overrides.
    expect(out).toContain('var __overrides = {}')
    expect(out).toContain('if (Object.keys(__overrides).length > 0) {')
  })
})
