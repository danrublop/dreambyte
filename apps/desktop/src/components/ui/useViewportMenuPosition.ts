'use client'

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Gap kept between a menu and the window edge. */
const MARGIN = 8

/**
 * One axis of the placement: keep `v` (the requested left/top) inside
 * `[MARGIN, limit - size - MARGIN]`, preferring a flip to the other side of the
 * anchor when the menu would overflow the far edge. Exported for the unit test.
 */
export function fitAxis(v: number, size: number, limit: number, margin = MARGIN) {
  const overflows = v + size > limit - margin
  return Math.max(margin, overflows ? Math.min(v - size, limit - size - margin) : v)
}

/**
 * Keeps a `position: fixed` menu inside the window.
 *
 * Cursor (or anchor-rect) coordinates alone push menus off-screen near the
 * right/bottom edge, where they render cut off — the window size was never
 * consulted. This measures the menu once mounted, then flips it to the other
 * side of the anchor (native menu behaviour) and clamps when neither side fits.
 *
 * Attach `ref` to the menu root and spread `style` onto it; pass `maxHeight` to
 * the scrollable surface so a menu taller than the window scrolls instead of
 * overflowing. `externalRef` lets callers that already hold a ref (e.g. for
 * outside-click close) reuse it instead of stacking two refs on one node.
 */
export function useViewportMenuPosition(x: number, y: number, externalRef?: RefObject<HTMLDivElement>) {
  const ownRef = useRef<HTMLDivElement>(null)
  const ref = externalRef ?? ownRef
  const [pos, setPos] = useState({ left: x, top: y })
  const [placed, setPlaced] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: fitAxis(x, width, window.innerWidth), top: fitAxis(y, height, window.innerHeight) })
    setPlaced(true)
    // ref identity is stable; re-measure only when the requested point moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  return {
    ref,
    // Hidden for the single frame before measurement so the un-clamped
    // position never paints.
    style: { left: pos.left, top: pos.top, visibility: placed ? 'visible' : 'hidden' } as const,
    maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
  }
}
