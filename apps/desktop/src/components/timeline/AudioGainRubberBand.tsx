'use client'

import { useMemo, useRef } from 'react'
import type { Clip } from '@/lib/types'
import { useVideoStore } from '@/lib/store'
import { snapKeyframeTime } from './keyframe-position'

interface Props {
  clip: Clip
  pixelsPerSecond: number
  /** Height of the clip body in px. */
  height: number
  locked?: boolean
}

const DIAMOND_SIZE = 9
/** Linear gain that maps to the TOP of the clip body. */
const MAX_GAIN = 2 // +6 dB

interface Point {
  time: number
  value: number
  /** True for the synthesized clip-edge endpoints (no keyframe). */
  virtual?: boolean
}

function valueToY(value: number, height: number): number {
  const clamped = Math.max(0, Math.min(MAX_GAIN, value))
  return Math.round((1 - clamped / MAX_GAIN) * height)
}

function yToValue(y: number, height: number): number {
  const clamped = Math.max(0, Math.min(height, y))
  return MAX_GAIN * (1 - clamped / height)
}

export function AudioGainRubberBand({ clip, pixelsPerSecond, height, locked }: Props) {
  const dispatchAction = useVideoStore((s) => s.dispatchAction)
  const dragRef = useRef<{ startX: number; startY: number; startTime: number; startValue: number } | null>(null)

  // Stable srcIdx anchors React keys to the keyframe's position in the
  // underlying clip.keyframes array — not to its time or value. Without
  // this, dragging a diamond changes its time, the time-based key changes,
  // React unmounts and remounts the element, and the in-flight
  // pointermove handler keeps firing on a detached node. Diamond would
  // appear to "stick" until you re-click.
  const gainKfs = useMemo(() => {
    return clip.keyframes
      .map((k, srcIdx) => ({ ...k, srcIdx }))
      .filter((k) => k.property === 'gain' && k.time >= 0 && k.time <= clip.duration)
      .sort((a, b) => a.time - b.time)
  }, [clip.keyframes, clip.duration])

  const baseValue = clip.audioGain ?? 1

  // Build the polyline: synthesize start/end endpoints using the first/last
  // keyframe value (or baseValue when no keyframes) so the line spans the
  // whole clip. Memoized so parent re-renders (selection changes, hover,
  // etc.) don't pay the string-build cost when peaks/keyframes didn't move.
  const { polylinePoints, widthPx } = useMemo(() => {
    const points: Point[] = []
    if (gainKfs.length === 0) {
      points.push({ time: 0, value: baseValue, virtual: true })
      points.push({ time: clip.duration, value: baseValue, virtual: true })
    } else {
      if (gainKfs[0].time > 0) points.push({ time: 0, value: gainKfs[0].value, virtual: true })
      for (const k of gainKfs) points.push({ time: k.time, value: k.value })
      if (gainKfs[gainKfs.length - 1].time < clip.duration) {
        points.push({ time: clip.duration, value: gainKfs[gainKfs.length - 1].value, virtual: true })
      }
    }
    const widthPx = clip.duration * pixelsPerSecond
    const polylinePoints = points.map((p) => `${p.time * pixelsPerSecond},${valueToY(p.value, height)}`).join(' ')
    return { polylinePoints, widthPx }
  }, [gainKfs, baseValue, clip.duration, pixelsPerSecond, height])

  // Only show when there's actually something to rubber-band. (No keyframes
  // and gain==1 means there's nothing meaningful to draw.) This early return
  // MUST stay below every hook above — placing it before a useMemo changes
  // the hook count when a clip toggles between gain==1 and gain!=1, which
  // throws "rendered fewer hooks than expected" and tears down the timeline.
  if (gainKfs.length === 0 && (clip.audioGain ?? 1) === 1) return null

  const onDiamondPointerDown = (kfTime: number, kfValue: number) => (e: React.PointerEvent) => {
    if (locked || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startY: e.clientY, startTime: kfTime, startValue: kfValue }
    let lastTime = kfTime
    let lastValue = kfValue

    // RAF-coalesce: rubber-band drag dispatches a keyframe/update reducer
    // round-trip per pointermove without throttling, which floods the WAL
    // and re-renders the gain polyline twice per frame on 120Hz trackpads.
    let pendingEv: PointerEvent | null = null
    let rafId: number | null = null
    const apply = () => {
      rafId = null
      const ev = pendingEv
      pendingEv = null
      if (!ev || !dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const dy = ev.clientY - dragRef.current.startY
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return

      const newTime = snapKeyframeTime(dragRef.current.startTime + dx / pixelsPerSecond, clip.duration)
      // Vertical drag maps to a value delta. Use the same gain scale as
      // valueToY so dragging the diamond visually matches the gain change.
      const valueDelta = (dy / height) * MAX_GAIN
      const newValue = Math.max(0, Math.min(MAX_GAIN, dragRef.current.startValue - valueDelta))

      const patch: { time?: number; value?: number } = {}
      if (newTime !== lastTime) patch.time = newTime
      if (Math.abs(newValue - lastValue) > 0.001) patch.value = newValue
      if (Object.keys(patch).length === 0) return

      const r = dispatchAction(
        {
          type: 'keyframe/update',
          params: { clipId: clip.id, property: 'gain', time: lastTime, patch },
        },
        { source: 'user' },
      )
      if (r.success) {
        if (patch.time !== undefined) lastTime = patch.time
        if (patch.value !== undefined) lastValue = patch.value
      }
    }
    const onMove = (ev: PointerEvent) => {
      pendingEv = ev
      if (rafId !== null) return
      rafId = requestAnimationFrame(apply)
    }

    const onUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (pendingEv) apply()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onDiamondContextMenu = (kfTime: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (locked) return
    dispatchAction(
      { type: 'keyframe/remove', params: { clipId: clip.id, property: 'gain', time: kfTime } },
      { source: 'user' },
    )
  }

  // Double-click on the line creates a new keyframe at that point with an
  // interpolated value from the surrounding points.
  const onLineDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (locked) return
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const t = snapKeyframeTime(x / pixelsPerSecond, clip.duration)
    const value = yToValue(y, height)
    dispatchAction(
      {
        type: 'keyframe/add',
        params: {
          clipId: clip.id,
          keyframe: { time: t, property: 'gain', value, easing: 'linear' },
        },
      },
      { source: 'user' },
    )
  }

  return (
    <svg
      width={widthPx}
      height={height}
      viewBox={`0 0 ${widthPx} ${height}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
      onDoubleClick={onLineDoubleClick}
      data-testid="audio-gain-rubberband"
    >
      {/* 0 dB reference line (gain = 1) */}
      <line
        x1={0}
        x2={widthPx}
        y1={valueToY(1, height)}
        y2={valueToY(1, height)}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={0.5}
        strokeDasharray="2 3"
      />
      {/* Gain polyline */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ pointerEvents: locked ? 'none' : 'stroke' }}
      />
      {/* Diamonds at each real keyframe */}
      {gainKfs.map((k) => {
        const cx = k.time * pixelsPerSecond
        const cy = valueToY(k.value, height)
        return (
          <rect
            key={k.srcIdx}
            x={cx - DIAMOND_SIZE / 2}
            y={cy - DIAMOND_SIZE / 2}
            width={DIAMOND_SIZE}
            height={DIAMOND_SIZE}
            fill="#22d3ee"
            stroke="rgba(0,0,0,0.45)"
            strokeWidth={1}
            transform={`rotate(45 ${cx} ${cy})`}
            style={{
              pointerEvents: locked ? 'none' : 'auto',
              cursor: locked ? 'default' : 'grab',
              touchAction: 'none',
            }}
            onPointerDown={onDiamondPointerDown(k.time, k.value)}
            onContextMenu={onDiamondContextMenu(k.time)}
          />
        )
      })}
    </svg>
  )
}
