'use client'

/**
 * EasingCurvePicker.
 *
 * 4-option selector used by the keyframe edit popover. Each option
 * renders a small SVG curve preview so the user can pick visually.
 *
 * Pure — no Zustand. Caller wires onChange to dispatch.
 */

import type { Keyframe } from '@/lib/types'

export const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const
export type EasingName = (typeof EASINGS)[number]

/**
 * y(x) curves (0..1 in, 0..1 out) for the preview SVG paths. Cubic-Bezier
 * P1/P2 control points; the SVG path uses those directly.
 */
const CURVE_PATHS: Record<EasingName, string> = {
  linear: 'M 0 32 L 32 0',
  // CSS cubic-bezier(0.42, 0, 1, 1) — ease-in
  'ease-in': 'M 0 32 C 13.4 32 32 32 32 0',
  // CSS cubic-bezier(0, 0, 0.58, 1) — ease-out
  'ease-out': 'M 0 32 C 0 32 18.6 0 32 0',
  // CSS cubic-bezier(0.42, 0, 0.58, 1) — ease-in-out
  'ease-in-out': 'M 0 32 C 13.4 32 18.6 0 32 0',
}

export interface EasingCurvePickerProps {
  value: Keyframe['easing']
  onChange: (next: EasingName) => void
  disabled?: boolean
}

export function EasingCurvePicker({ value, onChange, disabled }: EasingCurvePickerProps) {
  const current: EasingName = (EASINGS as readonly string[]).includes(value) ? (value as EasingName) : 'linear'
  return (
    <div data-testid="easing-curve-picker" className="flex gap-1">
      {EASINGS.map((e) => {
        const active = e === current
        return (
          <button
            key={e}
            type="button"
            disabled={disabled}
            data-easing={e}
            data-active={active}
            onClick={() => onChange(e)}
            onMouseEnter={(ev) => {
              if (!active) ev.currentTarget.style.borderColor = 'var(--graphite)'
            }}
            onMouseLeave={(ev) => {
              if (!active) ev.currentTarget.style.borderColor = 'var(--border-input)'
            }}
            title={e}
            className="flex flex-col items-center gap-0.5 p-1 disabled:opacity-50"
            style={{
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-input)'}`,
            }}
          >
            <svg width={32} height={32} viewBox="0 0 32 32" aria-hidden>
              <path
                d={CURVE_PATHS[e]}
                fill="none"
                stroke={active ? 'var(--accent)' : 'var(--mute)'}
                strokeWidth={1.5}
              />
            </svg>
            <span className="text-[9px]" style={{ color: 'var(--mute)' }}>
              {e}
            </span>
          </button>
        )
      })}
    </div>
  )
}
