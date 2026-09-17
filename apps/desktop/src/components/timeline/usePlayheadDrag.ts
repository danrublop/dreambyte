import { useCallback, useRef, useState } from 'react'
import { SNAP_THRESHOLD } from './constants'

interface UsePlayheadDragOptions {
  pps: number
  scrollX: number
  containerRef: React.RefObject<HTMLDivElement | null>
  sceneBoundaries: number[]
  onSeek: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
  /** Pixel offset from the container's left edge to where time=0 begins
   * (e.g. the width of any left gutter rendered inside the container). */
  leftOffset?: number
}

export function usePlayheadDrag({
  pps,
  scrollX,
  containerRef,
  sceneBoundaries,
  onSeek,
  onScrubStart,
  onScrubEnd,
  leftOffset = 0,
}: UsePlayheadDragOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const [dragTime, setDragTime] = useState(0)
  const draggingRef = useRef(false)

  const computeTime = useCallback(
    (clientX: number) => {
      const el = containerRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const cursorPx = clientX - rect.left - leftOffset
      const time = (scrollX + cursorPx) / pps
      // Snap to nearest scene boundary
      for (const boundary of sceneBoundaries) {
        const bPx = boundary * pps - scrollX
        if (Math.abs(bPx - cursorPx) <= SNAP_THRESHOLD) {
          return boundary
        }
      }
      return Math.max(0, time)
    },
    [pps, scrollX, containerRef, sceneBoundaries, leftOffset],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      draggingRef.current = true
      setIsDragging(true)
      onScrubStart?.()
      const t = computeTime(e.clientX)
      setDragTime(t)
      onSeek(t)

      // RAF-coalesce scrubbing so onSeek (which causes a full preview/timeline
      // re-render) fires at most once per frame.
      let pendingX: number | null = null
      let rafId: number | null = null
      const applyMove = () => {
        rafId = null
        if (!draggingRef.current || pendingX == null) return
        const t2 = computeTime(pendingX)
        pendingX = null
        setDragTime(t2)
        onSeek(t2)
      }
      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return
        pendingX = ev.clientX
        if (rafId !== null) return
        rafId = requestAnimationFrame(applyMove)
      }
      const onEnd = () => {
        if (!draggingRef.current) return
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        if (pendingX != null) applyMove()
        draggingRef.current = false
        setIsDragging(false)
        onScrubEnd?.()
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    },
    [computeTime, onSeek, onScrubStart, onScrubEnd],
  )

  return { isDragging, dragTime, onPointerDown }
}
