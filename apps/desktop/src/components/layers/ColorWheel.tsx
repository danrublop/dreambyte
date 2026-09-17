'use client'

/**
 * DaVinci-style color wheel — a hue disc with a draggable puck (color cast
 * direction × magnitude) and a master luminance slider underneath. Pure
 * controlled component: `onPreview` during drags, `onCommit` on release.
 * Double-click the disc resets the puck; double-click the label resets the
 * whole wheel (puck + master).
 *
 * Mapping: puck angle picks an RGB direction (r=cosθ, g=cos(θ−120°),
 * b=cos(θ+120°)), distance from center scales it — the same channel-offset
 * model wheelTransfer() consumes in src/lib/edit-engines/layer-grade.ts.
 */

import { useRef } from 'react'
import { type WheelValue, NEUTRAL_WHEEL } from '@/lib/edit-engines/layer-grade'

const DEG120 = (2 * Math.PI) / 3

function puckFromValue(v: WheelValue): { x: number; y: number } {
  // Inverse of the angle→RGB projection: (x', y') = 1.5·mag·(cosθ, sinθ)
  const x = (v.r - 0.5 * v.g - 0.5 * v.b) / 1.5
  const y = ((Math.sqrt(3) / 2) * (v.g - v.b)) / 1.5
  return { x, y }
}

function valueFromPuck(x: number, y: number, master: number): WheelValue {
  const mag = Math.min(1, Math.hypot(x, y))
  if (mag < 1e-4) return { r: 0, g: 0, b: 0, master }
  const a = Math.atan2(y, x)
  return {
    r: Math.cos(a) * mag,
    g: Math.cos(a - DEG120) * mag,
    b: Math.cos(a + DEG120) * mag,
    master,
  }
}

export function ColorWheel({
  label,
  value,
  onPreview,
  onCommit,
}: {
  label: string
  value: WheelValue
  onPreview: (v: WheelValue) => void
  onCommit: (v: WheelValue) => void
}) {
  const discRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const latestRef = useRef(value)
  latestRef.current = value

  const puck = puckFromValue(value)

  const puckFromEvent = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = discRef.current!.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const x = ((e.clientX - cx) / (rect.width / 2)) * 1
    // Screen y grows downward; wheel y is "toward green" upward.
    const y = -((e.clientY - cy) / (rect.height / 2))
    const mag = Math.hypot(x, y)
    return mag > 1 ? { x: x / mag, y: y / mag } : { x, y }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
      <span
        onDoubleClick={() => onCommit({ ...NEUTRAL_WHEEL })}
        title="Double-click to reset"
        className="text-[10.5px] text-[var(--color-text-muted)] select-none"
      >
        {label}
      </span>
      <div
        ref={discRef}
        data-testid={`color-wheel-${label.toLowerCase()}`}
        className="relative aspect-square w-full max-w-[76px] cursor-crosshair rounded-full border border-[var(--color-border)]"
        style={{
          // Hue ring fading to neutral at the center — conic for direction,
          // radial overlay for magnitude falloff.
          background:
            'radial-gradient(circle, var(--color-bg) 18%, transparent 75%), conic-gradient(from 90deg, #e5484d, #e0a336, #6fae3f, #3fae8c, #3f7fae, #7a5fd0, #c44fae, #e5484d)',
          touchAction: 'none',
        }}
        onPointerDown={(e) => {
          draggingRef.current = true
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          const p = puckFromEvent(e)
          onPreview(valueFromPuck(p.x, p.y, latestRef.current.master))
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return
          const p = puckFromEvent(e)
          onPreview(valueFromPuck(p.x, p.y, latestRef.current.master))
        }}
        onPointerUp={() => {
          if (!draggingRef.current) return
          draggingRef.current = false
          onCommit(latestRef.current)
        }}
        onDoubleClick={() => onCommit({ ...latestRef.current, r: 0, g: 0, b: 0 })}
      >
        <div
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
          style={{
            left: `${50 + puck.x * 44}%`,
            top: `${50 - puck.y * 44}%`,
            borderColor: 'var(--color-text-primary)',
            background: 'var(--color-panel)',
          }}
        />
      </div>
      <input
        type="range"
        min={-100}
        max={100}
        step={1}
        value={Math.round(value.master * 100)}
        title={`${label} master`}
        className="w-full cursor-pointer"
        style={{ accentColor: 'var(--color-text-muted)', height: 12 }}
        onChange={(e) => onPreview({ ...latestRef.current, master: Number(e.target.value) / 100 })}
        onPointerUp={() => onCommit(latestRef.current)}
        onKeyUp={() => onCommit(latestRef.current)}
        onDoubleClick={() => onCommit({ ...latestRef.current, master: 0 })}
      />
    </div>
  )
}
