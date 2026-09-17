// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { fitAxis, useViewportMenuPosition } from './useViewportMenuPosition'

// Window 1000 wide, menu 200 wide, 8px margin.
describe('fitAxis', () => {
  it('leaves a menu that already fits where it was asked for', () => {
    expect(fitAxis(100, 200, 1000)).toBe(100)
  })

  it('flips to the other side of the anchor when it would overflow the far edge', () => {
    // 900 + 200 = 1100 > 992 → flip to 900 - 200.
    expect(fitAxis(900, 200, 1000)).toBe(700)
  })

  it('clamps to the far edge when the flipped position also overflows', () => {
    // Flip would be -50; clamp to 1000 - 200 - 8.
    expect(fitAxis(150, 200, 1000)).toBe(150)
    expect(fitAxis(995, 200, 1000)).toBe(792)
  })

  it('never returns less than the margin, even when the menu is wider than the window', () => {
    expect(fitAxis(500, 2000, 1000)).toBe(8)
  })
})

/** Give every rendered node a fixed measured size, the way a real menu measures. */
function stubMenuSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

/** A ref already pointing at a node, as a mounted menu's ref would be. */
function attachedRef() {
  return { current: document.createElement('div') }
}

describe('useViewportMenuPosition', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.innerWidth = 1000
    window.innerHeight = 800
  })

  it('keeps the requested point and reveals the menu once measured', () => {
    stubMenuSize(200, 300)
    const { result } = renderHook(() => useViewportMenuPosition(100, 100, attachedRef()))
    expect(result.current.style.left).toBe(100)
    expect(result.current.style.top).toBe(100)
    expect(result.current.style.visibility).toBe('visible')
  })

  it('flips a menu opened near the right/bottom edge back inside the window', () => {
    stubMenuSize(200, 300)
    const { result } = renderHook(() => useViewportMenuPosition(950, 700, attachedRef()))
    // 950 + 200 overflows 1000 → flip to 750. 700 + 300 overflows 800 → flip to 400.
    expect(result.current.style.left).toBe(750)
    expect(result.current.style.top).toBe(400)
  })

  it('stays hidden at the requested point when there is no node to measure', () => {
    const { result } = renderHook(() => useViewportMenuPosition(950, 700))
    expect(result.current.style.visibility).toBe('hidden')
    expect(result.current.style.left).toBe(950)
  })

  it('measures the caller-supplied ref instead of its own', () => {
    stubMenuSize(200, 300)
    const external = attachedRef()
    const { result } = renderHook(() => useViewportMenuPosition(950, 100, external))
    expect(result.current.ref).toBe(external)
    expect(result.current.style.left).toBe(750)
  })

  it('re-measures when the requested point moves', () => {
    stubMenuSize(200, 300)
    const node = attachedRef()
    const { result, rerender } = renderHook(({ x }) => useViewportMenuPosition(x, 100, node), {
      initialProps: { x: 100 },
    })
    expect(result.current.style.left).toBe(100)
    rerender({ x: 950 })
    expect(result.current.style.left).toBe(750)
  })

  it('caps the menu height to the window so a tall menu scrolls instead of overflowing', () => {
    const { result } = renderHook(() => useViewportMenuPosition(0, 0))
    expect(result.current.maxHeight).toBe('calc(100vh - 16px)')
  })
})
