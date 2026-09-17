'use client'

/**
 * Inline tone-curve editor (generic) — channel chips RGB·R·G·B, click to add
 * a control point, drag to shape, double-click to remove, reset row. Pure
 * controlled component: `onPreview` fires during drags, `onCommit` on
 * release/reset. Used by the layer properties Grade section.
 */

import { useMemo, useRef, useState } from 'react'
import {
  TONE_CURVE_CHANNELS,
  type ToneCurveChannel,
  type ToneCurveData,
  type ToneCurvePoint,
  IDENTITY_CURVE,
  evaluateCurve,
  normalizePoints,
} from '@/lib/edit-engines/tone-curve'

const W = 216
const H = 140
const PAD = 8

const CHANNEL_LABELS: Record<ToneCurveChannel, string> = { rgb: 'RGB', r: 'R', g: 'G', b: 'B' }
const CHANNEL_STROKE: Record<ToneCurveChannel, string> = {
  rgb: 'var(--color-text-primary)',
  r: '#c97070',
  g: '#6fae6f',
  b: '#7088c9',
}
const HOVER_BG = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'

function pointsOf(curves: ToneCurveData, ch: ToneCurveChannel): ToneCurvePoint[] {
  const pts = curves[ch]
  return pts && pts.length >= 2 ? pts : IDENTITY_CURVE
}

export function CurveEditor({
  curves,
  onPreview,
  onCommit,
}: {
  curves: ToneCurveData
  onPreview: (next: ToneCurveData) => void
  onCommit: (next: ToneCurveData) => void
}) {
  const [channel, setChannel] = useState<ToneCurveChannel>('rgb')
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const dragRef = useRef<{ idx: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const points = pointsOf(curves, channel)

  const toUnit = (e: React.PointerEvent): ToneCurvePoint => {
    // The svg renders at 100% container width via viewBox — map client px →
    // viewBox coords proportionally before converting to unit space.
    const rect = svgRef.current!.getBoundingClientRect()
    const vx = ((e.clientX - rect.left) / rect.width) * (W + PAD * 2)
    const vy = ((e.clientY - rect.top) / rect.height) * (H + PAD * 2)
    const x = (vx - PAD) / W
    const y = 1 - (vy - PAD) / H
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }

  const withChannel = (pts: ToneCurvePoint[]): ToneCurveData => ({ ...curves, [channel]: normalizePoints(pts) })

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toUnit(e)
    const R = 0.05
    let idx = -1
    let best = R
    points.forEach((pt, i) => {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y)
      if (d < best) {
        best = d
        idx = i
      }
    })
    let pts = [...points]
    if (idx === -1) {
      pts.push(p)
      pts = normalizePoints(pts)
      idx = pts.findIndex((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < 0.011)
      if (idx === -1) idx = pts.length - 1
    }
    setActiveIdx(idx)
    dragRef.current = { idx }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    onPreview(withChannel(pts.map((pt, i) => (i === idx ? p : pt))))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const p = toUnit(e)
    const pts = points.map((pt, i) => (i === drag.idx ? p : pt))
    // Keep the dragged index stable: clamp x between neighbors, no re-sort.
    const prev = points[drag.idx - 1]?.x ?? 0
    const next = points[drag.idx + 1]?.x ?? 1
    pts[drag.idx] = {
      x: Math.min(drag.idx + 1 < points.length ? next - 0.02 : 1, Math.max(drag.idx > 0 ? prev + 0.02 : 0, p.x)),
      y: p.y,
    }
    onPreview({ ...curves, [channel]: pts })
  }

  const onPointerUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    onCommit(withChannel([...points]))
  }

  const removePoint = (idx: number) => {
    if (points.length <= 2) return
    setActiveIdx(null)
    onCommit(withChannel(points.filter((_, i) => i !== idx)))
  }

  const resetChannel = () => {
    const next = { ...curves }
    delete next[channel]
    setActiveIdx(null)
    onCommit(next)
  }

  const path = useMemo(() => {
    const steps = 64
    let d = ''
    for (let i = 0; i <= steps; i++) {
      const x = i / steps
      const y = evaluateCurve(points, x)
      d += `${i === 0 ? 'M' : 'L'}${(PAD + x * W).toFixed(1)},${(PAD + (1 - y) * H).toFixed(1)}`
    }
    return d
  }, [points])

  return (
    <div className="flex flex-col gap-1.5" data-testid="curve-editor">
      <div className="!flex !flex-row items-center" style={{ gap: 4 }}>
        {TONE_CURVE_CHANNELS.map((ch) => {
          const active = channel === ch
          const dirty = curves[ch] && curves[ch]!.length >= 2 && curves[ch]!.some((p) => Math.abs(p.y - p.x) > 1e-4)
          return (
            <button
              key={ch}
              type="button"
              data-testid={`curve-channel-${ch}`}
              onClick={() => {
                setChannel(ch)
                setActiveIdx(null)
              }}
              className="no-style cursor-pointer rounded-full"
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                lineHeight: 1,
                padding: '4px 7px',
                border: '1px solid',
                borderColor: active ? 'var(--color-border)' : 'transparent',
                background: active ? HOVER_BG : 'transparent',
                color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                transition: 'all 0.12s ease',
              }}
            >
              {CHANNEL_LABELS[ch]}
              {dirty ? ' •' : ''}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="curve-reset"
          onClick={resetChannel}
          className="no-style cursor-pointer"
          style={{
            fontSize: 10.5,
            fontWeight: 450,
            lineHeight: 1,
            padding: '4px 6px',
            color: 'var(--color-text-muted)',
          }}
        >
          Reset
        </button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W + PAD * 2} ${H + PAD * 2}`}
        data-testid="curve-canvas"
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          borderRadius: 6,
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg)',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} stroke="var(--color-border)" strokeWidth={0.5} opacity={0.6}>
            <line x1={PAD + t * W} y1={PAD} x2={PAD + t * W} y2={PAD + H} />
            <line x1={PAD} y1={PAD + t * H} x2={PAD + W} y2={PAD + t * H} />
          </g>
        ))}
        <line
          x1={PAD}
          y1={PAD + H}
          x2={PAD + W}
          y2={PAD}
          stroke="var(--color-border)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <path d={path} fill="none" stroke={CHANNEL_STROKE[channel]} strokeWidth={1.5} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={PAD + p.x * W}
            cy={PAD + (1 - p.y) * H}
            r={activeIdx === i ? 4.5 : 3.5}
            fill={activeIdx === i ? 'var(--color-accent)' : 'var(--color-panel)'}
            stroke={activeIdx === i ? 'var(--color-accent)' : 'var(--color-text-muted)'}
            strokeWidth={1.5}
            style={{ cursor: 'grab' }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              removePoint(i)
            }}
          />
        ))}
      </svg>
    </div>
  )
}
