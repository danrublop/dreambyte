'use client'

/**
 * Colorist panel for the per-clip color grade (ClipColorGrade on `clip.grade`).
 * This is the UNIFIED grade UI: it drives the more-powerful clip-grade engine (compositor CSS+SVG plus
 * the WebGL2 LUT/hue tier), reusing the proven DaVinci-style ColorWheel + CurveEditor
 * leaf components via thin model adapters.
 *
 *   Primaries  exposure · contrast · saturation · vibrance · temp · tint · hi/sh/bk/wh
 *   Wheels     lift/gamma/gain (Shadows/Midtones/Highlights) — hue+amount + a luma bar
 *   Curves     master + R/G/B tone curves
 *   Vignette
 *
 * Pure-ish: reads `grade` and emits the FULL next grade via `onChange` (merge by
 * spread); commits on release via `onCommit`.
 */

import { RotateCcw } from 'lucide-react'
import { Section, FieldLabel, SliderCell } from '@/components/layers/property-panel-primitives'
import { ColorWheel } from '@/components/layers/ColorWheel'
import { CurveEditor } from '@/components/layers/CurveEditor'
import { isNeutralClipGrade, type ClipColorGrade, type WheelZone } from '@/lib/edit-engines/clip-grade'
import type { WheelValue } from '@/lib/edit-engines/layer-grade'
import type { ToneCurveData } from '@/lib/edit-engines/tone-curve'

// ── model adapters (clip-grade ⇄ the reused leaf components) ─────────────────
const DEG120 = (2 * Math.PI) / 3
type ZoneKind = 'lum' | 'gamma' | 'gain'

/** ClipColorGrade wheel zone (hue+amount + per-zone luma scalar) → ColorWheel's
 *  WheelValue (RGB puck + master). The puck angle carries hue, its radius the amount;
 *  the master bar carries lift-luma / gamma / gain depending on the zone. */
export function zoneToWheelValue(z: WheelZone | undefined, kind: ZoneKind): WheelValue {
  const a = ((z?.hue ?? 0) * Math.PI) / 180
  const amt = z?.amount ?? 0
  const r = Math.cos(a) * amt
  const g = Math.cos(a - DEG120) * amt
  const b = Math.cos(a + DEG120) * amt
  const master =
    kind === 'lum'
      ? (z?.lum ?? 0) * 2 // -0.5..0.5 → -1..1
      : kind === 'gamma'
        ? Math.log2(Math.max(0.25, z?.gamma ?? 1)) // 0.5..2 → -1..1
        : ((z?.gain ?? 1) - 1) * 2 // 0.5..1.5 → -1..1
  return { r, g, b, master }
}

/** Inverse of zoneToWheelValue. */
export function wheelValueToZone(v: WheelValue, kind: ZoneKind): WheelZone {
  const x = (v.r - 0.5 * v.g - 0.5 * v.b) / 1.5
  const y = ((Math.sqrt(3) / 2) * (v.g - v.b)) / 1.5
  const amount = Math.min(1, Math.hypot(x, y))
  const hue = amount < 1e-4 ? 0 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  const m = Math.max(-1, Math.min(1, v.master))
  const z: WheelZone = { hue, amount }
  if (kind === 'lum') z.lum = m * 0.5
  else if (kind === 'gamma') z.gamma = Math.pow(2, m)
  else z.gain = 1 + m * 0.5
  return z
}

export function clipCurvesToTone(c: ClipColorGrade['curves'] | undefined): ToneCurveData {
  return { rgb: c?.master, r: c?.red, g: c?.green, b: c?.blue }
}
export function toneToClipCurves(t: ToneCurveData): NonNullable<ClipColorGrade['curves']> {
  const out: NonNullable<ClipColorGrade['curves']> = {}
  if (t.rgb) out.master = t.rgb
  if (t.r) out.red = t.r
  if (t.g) out.green = t.g
  if (t.b) out.blue = t.b
  return out
}

type PrimaryKey =
  | 'exposure'
  | 'contrast'
  | 'saturation'
  | 'vibrance'
  | 'temperature'
  | 'tint'
  | 'highlights'
  | 'shadows'
  | 'blacks'
  | 'whites'

interface PrimarySpec {
  key: PrimaryKey
  label: string
  min: number
  max: number
  step: number
  neutral: number
  format: (v: number) => string
  suffix: string
}

export const GRADE_PRIMARIES: PrimarySpec[] = [
  {
    key: 'exposure',
    label: 'Exposure',
    min: -3,
    max: 3,
    step: 0.05,
    neutral: 0,
    format: (v) => v.toFixed(2),
    suffix: 'EV',
  },
  {
    key: 'contrast',
    label: 'Contrast',
    min: 0.5,
    max: 1.5,
    step: 0.01,
    neutral: 1,
    format: (v) => v.toFixed(2),
    suffix: '',
  },
  {
    key: 'saturation',
    label: 'Saturation',
    min: 0,
    max: 2,
    step: 0.01,
    neutral: 1,
    format: (v) => v.toFixed(2),
    suffix: '',
  },
  {
    key: 'vibrance',
    label: 'Vibrance',
    min: -1,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) => v.toFixed(2),
    suffix: '',
  },
  {
    key: 'temperature',
    label: 'Temperature',
    min: 2000,
    max: 11000,
    step: 50,
    neutral: 6500,
    format: (v) => String(Math.round(v)),
    suffix: 'K',
  },
  {
    key: 'tint',
    label: 'Tint',
    min: -100,
    max: 100,
    step: 1,
    neutral: 0,
    format: (v) => String(Math.round(v)),
    suffix: '',
  },
  {
    key: 'highlights',
    label: 'Highlights',
    min: -1,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) => v.toFixed(2),
    suffix: '',
  },
  {
    key: 'shadows',
    label: 'Shadows',
    min: -1,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) => v.toFixed(2),
    suffix: '',
  },
  { key: 'blacks', label: 'Blacks', min: -1, max: 1, step: 0.01, neutral: 0, format: (v) => v.toFixed(2), suffix: '' },
  { key: 'whites', label: 'Whites', min: -1, max: 1, step: 0.01, neutral: 0, format: (v) => v.toFixed(2), suffix: '' },
]

export function ColorGradePanel({
  grade,
  onChange,
  onCommit,
  lutTierAvailable = false,
  defaultOpen = false,
}: {
  grade: ClipColorGrade | undefined
  /** Receives the FULL next grade (already merged). */
  onChange: (next: ClipColorGrade) => void
  /** Checkpoint for undo (slider/wheel release). */
  onCommit: () => void
  /** True only for bare video/image clips, where the LUT/hue WebGL tier renders. */
  lutTierAvailable?: boolean
  defaultOpen?: boolean
}) {
  const g = grade ?? {}
  const set = (key: PrimaryKey, v: number) => onChange({ ...g, [key]: v })
  const setWheel = (zone: 'shadows' | 'mids' | 'highlights', next: WheelZone) =>
    onChange({ ...g, wheels: { ...g.wheels, [zone]: next } })
  const setCurves = (t: ToneCurveData) => onChange({ ...g, curves: toneToClipCurves(t) })
  const isNeutral = isNeutralClipGrade(grade)

  return (
    <>
      <Section title="Color Grade · Primaries" defaultOpen={defaultOpen}>
        {GRADE_PRIMARIES.map((p) => (
          <div key={p.key}>
            <FieldLabel keyframable={false}>{p.label}</FieldLabel>
            <SliderCell
              value={typeof g[p.key] === 'number' ? (g[p.key] as number) : p.neutral}
              min={p.min}
              max={p.max}
              step={p.step}
              onChange={(v) => set(p.key, v)}
              onCommit={onCommit}
              format={p.format}
              suffix={p.suffix}
            />
          </div>
        ))}
        <button
          type="button"
          disabled={isNeutral}
          onClick={() => {
            onChange({})
            onCommit()
          }}
          className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40"
        >
          <RotateCcw size={12} strokeWidth={2.5} />
          Reset grade
        </button>
      </Section>

      <Section title="Wheels" defaultOpen={false}>
        <div className="flex items-start gap-2">
          <ColorWheel
            label="Shadows"
            value={zoneToWheelValue(g.wheels?.shadows, 'lum')}
            onPreview={(v) => setWheel('shadows', wheelValueToZone(v, 'lum'))}
            onCommit={(v) => {
              setWheel('shadows', wheelValueToZone(v, 'lum'))
              onCommit()
            }}
          />
          <ColorWheel
            label="Midtones"
            value={zoneToWheelValue(g.wheels?.mids, 'gamma')}
            onPreview={(v) => setWheel('mids', wheelValueToZone(v, 'gamma'))}
            onCommit={(v) => {
              setWheel('mids', wheelValueToZone(v, 'gamma'))
              onCommit()
            }}
          />
          <ColorWheel
            label="Highlights"
            value={zoneToWheelValue(g.wheels?.highlights, 'gain')}
            onPreview={(v) => setWheel('highlights', wheelValueToZone(v, 'gain'))}
            onCommit={(v) => {
              setWheel('highlights', wheelValueToZone(v, 'gain'))
              onCommit()
            }}
          />
        </div>
      </Section>

      <Section title="Curves" defaultOpen={false}>
        <CurveEditor
          curves={clipCurvesToTone(g.curves)}
          onPreview={setCurves}
          onCommit={(t) => {
            setCurves(t)
            onCommit()
          }}
        />
      </Section>

      <Section title="Vignette" defaultOpen={false}>
        <div>
          <FieldLabel keyframable={false}>Amount</FieldLabel>
          <SliderCell
            value={g.vignette ?? 0}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onChange({ ...g, vignette: v })}
            onCommit={onCommit}
            format={(v) => v.toFixed(2)}
            suffix=""
          />
        </div>
        {!lutTierAvailable && (
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
            LUT &amp; hue curves render on video/image clips only — a scene is filtered as a whole.
          </p>
        )}
      </Section>
    </>
  )
}
