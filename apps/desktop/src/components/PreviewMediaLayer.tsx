'use client'

/**
 * Preview DOM media layer. Renders bare video/image timeline clips
 * as real `<video>`/`<img>` DOM elements composited over the scene iframes, driven
 * by `planCompositeFrame` — the SAME contract the MP4 export uses, so preview and
 * export agree. This is the ONLY preview media renderer.
 *
 * Fed `timeline` + `globalTime` + `isPlaying`, it runs its own rAF and drives a
 * {@link PreviewMediaPool} (play()+debounced drift sync). Refs keep the
 * rAF reading the LIVE playhead without re-subscribing every frame.
 *
 * The rAF PARKS itself when idle (paused + nothing changed) and a second effect
 * re-arms it on the next play/scrub/edit, so a static paused editor doesn't burn a
 * wake-locked full-rate loop.
 *
 * z-placement: the overlay sits ABOVE the scene iframes, so media-over-scene
 * composites correctly (the common case: footage over a scene). Media on a LOWER
 * track than a scene above it is a documented limitation; the EXPORT composites
 * the true per-track z either way.
 */

import { useEffect, useRef } from 'react'
import type { Timeline } from '@/lib/types'
import { planCompositeFrame } from '@/lib/timeline/composite-frame'
import { PreviewMediaPool } from '@/lib/compositor/preview-media-pool'

export default function PreviewMediaLayer({
  timeline,
  globalTime,
  isPlaying,
}: {
  timeline: Timeline | null | undefined
  globalTime: number
  isPlaying: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef(globalTime)
  const playingRef = useRef(isPlaying)
  const timelineRef = useRef(timeline)
  // Live values for the rAF (updated every render, read every frame).
  timeRef.current = globalTime
  playingRef.current = isPlaying
  timelineRef.current = timeline

  // The rAF handle (for cancel), an explicit PARKED flag, and a wake() that re-arms a
  // parked loop. `parked` is a dedicated boolean — NOT an overloaded rafRef===0 — so the
  // re-arm guard never depends on the spec-legal-but-fragile "rAF id is never 0".
  const rafRef = useRef(0)
  const parkedRef = useRef(true)
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const pool = new PreviewMediaPool(container)
    // `-1` forces the first tick to run.
    let lastTime = -1
    let lastPlaying = false
    let lastTimeline: unknown = null
    const tick = () => {
      const playing = playingRef.current
      const time = timeRef.current
      const tl = timelineRef.current
      // Re-sync when playing, on scrub (time moved), on play/pause flip, OR when the
      // timeline object changed (store updates it immutably — catches edit-while-paused
      // and live grade-preview, which swaps in a new timeline object).
      const dirty = playing || time !== lastTime || playing !== lastPlaying || tl !== lastTimeline
      if (dirty) {
        lastTime = time
        lastPlaying = playing
        lastTimeline = tl
        const plan = planCompositeFrame(tl, time)
        const media = plan.isGap ? [] : plan.layers.filter((l) => l.kind !== 'scene')
        pool.sync(media, playing)
      }
      // PARK when idle: paused AND nothing changed this tick → stop the loop entirely
      // rather than burn a full-rate rAF on a static paused editor. The wake effect
      // re-arms us the instant globalTime / isPlaying / timeline next changes.
      if (!playing && !dirty) {
        parkedRef.current = true
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    wakeRef.current = () => {
      if (parkedRef.current) {
        parkedRef.current = false
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    parkedRef.current = false
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      parkedRef.current = true
      wakeRef.current = () => {}
      pool.dispose()
    }
  }, [])

  // Re-arm a parked rAF when the transport, playhead, or timeline changes. (When the
  // loop is already running this is a no-op — wake() only schedules if rafRef===0.)
  useEffect(() => {
    wakeRef.current()
  }, [globalTime, isPlaying, timeline])

  return <div ref={containerRef} className="absolute inset-0" style={{ pointerEvents: 'none' }} />
}
