import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Throttle a high-frequency streamed string into bounded React re-renders.
 *
 * The agent emits a `token` (or `thinking_token`) event for every few
 * characters. Calling setState on each one re-renders the consuming component
 * dozens of times per second — the same pathology that pins Cursor's renderer
 * at ~100% CPU. This hook buffers the latest value in a ref and flushes it to
 * state at most once per `intervalMs` (default ~30fps), so render count scales
 * with wall-clock time, not token count.
 *
 *   push(full) ──▶ pendingRef = full
 *                  │
 *                  ├─ timer pending?  ── yes ─▶ (coalesce, do nothing)
 *                  │
 *                  └─ no ─▶ elapsed >= interval? ─ yes ─▶ flush() now
 *                                                ─ no  ─▶ setTimeout(flush, remaining)
 *
 * Semantics:
 * - `push` takes the FULL accumulated string each call (not a delta), so a
 *   dropped/coalesced push never loses text — the next push carries everything.
 * - `flush` forces the pending value to state immediately and cancels the
 *   timer. Call it at boundaries where the displayed value must be current
 *   (tool-call commit, stream end) so buffered text never lands after a
 *   snapshot or gets dropped on completion.
 * - `reset` clears value + pending + timer. Call it at run start and in the
 *   run's finally block; this is the stream-identity guard — a stale timer
 *   from a finished run cannot flush into the next message because reset
 *   cancels it.
 * - Unmount cancels the timer and blocks any late flush (no setState-after-
 *   unmount), which also covers React 18 StrictMode mount/unmount/remount.
 */
export interface ThrottledStream {
  /** Latest flushed value — read this in render. */
  value: string
  /** Set the latest full value; schedules a flush within `intervalMs`. */
  push: (next: string) => void
  /** Force the pending value to state now and cancel the timer. */
  flush: () => void
  /** Clear value, pending, and timer (stream-identity guard). */
  reset: () => void
}

export function useThrottledStream(intervalMs = 33): ThrottledStream {
  const [value, setValue] = useState('')
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushRef = useRef(0)
  const mountedRef = useRef(true)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const flush = useCallback(() => {
    clearTimer()
    if (pendingRef.current !== null && mountedRef.current) {
      setValue(pendingRef.current)
      pendingRef.current = null
      lastFlushRef.current = Date.now()
    }
  }, [])

  const push = useCallback(
    (next: string) => {
      pendingRef.current = next
      if (timerRef.current !== null) return // a flush is already scheduled
      const elapsed = Date.now() - lastFlushRef.current
      if (elapsed >= intervalMs) {
        flush()
      } else {
        timerRef.current = setTimeout(flush, intervalMs - elapsed)
      }
    },
    [flush, intervalMs],
  )

  const reset = useCallback(() => {
    clearTimer()
    pendingRef.current = null
    lastFlushRef.current = 0
    if (mountedRef.current) setValue('')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimer()
    }
  }, [])

  return { value, push, flush, reset }
}
