'use client'

/**
 * Advanced grading for SCENE media layers (video layer / image layers) —
 * Lumetri-style stack rendered as three standard property-panel sections
 * (same Section/FieldLabel/SliderCell primitives as Transform and Blending):
 *
 *   Look        preset chips (hover previews, click commits) + intensity
 *   Correction  exposure · contrast · saturation · temperature · tint · hue
 *   Curves      per-channel tone curves (RGB·R·G·B)
 *
 * Storage: the Look is a CSS filter string (`layer.filter`); the correction
 * stack is a structured `layer.colorGrade` compiled by
 * src/lib/edit-engines/layer-grade.ts into CSS functions + an SVG filter
 * (feColorMatrix/feComponentTransfer) baked into the scene HTML — editor
 * preview and export render the identical math. Hover/drag previews filter
 * the scene's preview iframe through the same engine (transient store field,
 * no scene writes, no undo noise); every release commits ONE scene update.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, ClipboardPaste, Save, X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { COLOR_GRADES, resolveGradeFilters } from '@/lib/edit-engines/color-grades'
import { detectGrade, composeGradeFilters } from '@/lib/edit-engines/grade-detect'
import { filtersToCss, parseCssFilters } from '@/lib/edit-engines/grade-css'
import {
  type LayerColorGrade,
  type WheelValue,
  NEUTRAL_WHEEL,
  isNeutralGrade,
  gradeToCssChain,
  gradeNeedsSvgFilter,
} from '@/lib/edit-engines/layer-grade'
import { listCustomLooks, saveCustomLook, deleteCustomLook, type CustomLook } from '@/lib/edit-engines/custom-looks'
import type { ToneCurveData } from '@/lib/edit-engines/tone-curve'
import { Section, FieldLabel, SliderCell } from './property-panel-primitives'
import { CurveEditor } from './CurveEditor'
import { ColorWheel } from './ColorWheel'

const HOVER_BG = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'

interface SliderSpec {
  key: keyof Omit<LayerColorGrade, 'curves'>
  label: string
  min: number
  max: number
  toGrade: (v: number) => number
  fromGrade: (v: number) => number
}

const SLIDERS: SliderSpec[] = [
  { key: 'exposure', label: 'Exposure', min: -100, max: 100, toGrade: (v) => v / 100, fromGrade: (v) => v * 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, toGrade: (v) => v / 100, fromGrade: (v) => v * 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, toGrade: (v) => v / 100, fromGrade: (v) => v * 100 },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, toGrade: (v) => v / 100, fromGrade: (v) => v * 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100, toGrade: (v) => v / 100, fromGrade: (v) => v * 100 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, toGrade: (v) => v, fromGrade: (v) => v },
]

export interface LayerGradeValue {
  /** Look preset CSS (layer.filter). */
  lookCss: string | undefined
  /** Correction stack (layer.colorGrade). */
  grade: LayerColorGrade | undefined
}

/**
 * Renders the Look / Correction / Curves sections — drop in alongside the
 * other panel sections (no extra wrapper Section needed).
 */
export function LayerGradeControl({
  sceneId,
  value,
  onApply,
}: {
  sceneId: string
  value: LayerGradeValue
  /** Commit both fields in one scene update (undefined fields = cleared). */
  onApply: (next: LayerGradeValue) => void
}) {
  const setSceneGradePreview = useVideoStore((s) => s.setSceneGradePreview)

  // ── Look (preset) state ──
  const parsedLook = parseCssFilters(value.lookCss)
  const detected = parsedLook.hasUnknown ? ('custom' as const) : detectGrade(parsedLook.filters)
  const activeLook = typeof detected === 'object' && detected !== null ? detected : null

  const [intensity, setIntensity] = useState(activeLook?.intensity ?? 1)
  const lookKey = activeLook ? `${activeLook.gradeId}:${activeLook.intensity}` : 'none'
  useEffect(() => {
    setIntensity(activeLook?.intensity ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookKey])

  // ── Correction state (local while dragging; commits on release) ──
  const [draft, setDraft] = useState<LayerColorGrade>(value.grade ?? {})
  const draftRef = useRef(draft)
  draftRef.current = draft
  const committedKey = JSON.stringify(value.grade ?? {})
  useEffect(() => {
    setDraft(value.grade ?? {})
    // Re-sync when the committed grade changes (undo, agent edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey])

  const clearPreview = () => setSceneGradePreview(null)
  useEffect(() => () => setSceneGradePreview(null), [setSceneGradePreview])

  /** Push a live preview of (lookCss × grade) onto the scene iframe. */
  const preview = (lookCss: string | undefined, grade: LayerColorGrade) => {
    const css = gradeToCssChain(grade, {
      lookCss: lookCss ?? '',
      svgFilterId: gradeNeedsSvgFilter(grade) ? 'dreambyte-grade-preview' : null,
    })
    setSceneGradePreview({ sceneId, css: css || 'none', grade })
  }

  const commit = (lookCss: string | undefined, grade: LayerColorGrade) => {
    clearPreview()
    onApply({ lookCss, grade: isNeutralGrade(grade) ? undefined : grade })
  }

  const lookCssWith = (gradeId: string | null, t: number): string | undefined => {
    const css = filtersToCss(
      composeGradeFilters(parsedLook.filters, gradeId ? (resolveGradeFilters(gradeId, t) ?? []) : []),
    )
    return css || undefined
  }

  const [lookMenuOpen, setLookMenuOpen] = useState(false)
  const [customLooks, setCustomLooks] = useState<CustomLook[]>(() => listCustomLooks())
  const [savingName, setSavingName] = useState<string | null>(null)
  const copiedGrade = useVideoStore((st) => st.copiedGrade)
  const setCopiedGrade = useVideoStore((st) => st.setCopiedGrade)
  const lookOptions: Array<{ id: string | null; name: string; desc?: string }> = [
    { id: null, name: 'None' },
    ...COLOR_GRADES.map((g) => ({ id: g.id as string | null, name: g.name, desc: g.description })),
  ]
  const currentLookName = activeLook
    ? (COLOR_GRADES.find((g) => g.id === activeLook.gradeId)?.name ?? activeLook.gradeId)
    : detected === 'custom'
      ? 'Custom'
      : 'None'

  const setParam = (key: SliderSpec['key'], v: number, commitNow: boolean) => {
    const next = { ...draftRef.current, [key]: v }
    setDraft(next)
    if (commitNow) commit(value.lookCss, next)
    else preview(value.lookCss, next)
  }

  const setCurves = (curves: ToneCurveData, commitNow: boolean) => {
    const next = { ...draftRef.current, curves }
    setDraft(next)
    if (commitNow) commit(value.lookCss, next)
    else preview(value.lookCss, next)
  }

  const setWheel = (key: 'lift' | 'gamma' | 'gain', v: WheelValue, commitNow: boolean) => {
    const next = { ...draftRef.current, [key]: v }
    setDraft(next)
    if (commitNow) commit(value.lookCss, next)
    else preview(value.lookCss, next)
  }

  return (
    <div onMouseLeave={clearPreview}>
      <Section title="Look">
        <div>
          <FieldLabel>Preset</FieldLabel>
          <div className="relative">
            {/* Trigger styled like SelectCell; custom menu so rows can hover-preview */}
            <button
              type="button"
              data-testid="layer-grade-preset-trigger"
              onClick={() => setLookMenuOpen((o) => !o)}
              className="no-style flex h-9 w-full cursor-pointer items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-left"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-primary)]">
                {currentLookName}
              </span>
              <ChevronDown size={12} className="text-[var(--color-text-muted)]" />
            </button>
            {lookMenuOpen && (
              <>
                <div className="fixed inset-0 z-[90]" onClick={() => setLookMenuOpen(false)} />
                <div
                  data-testid="layer-grade-preset-menu"
                  className="absolute left-0 right-0 top-[calc(100%+6px)] z-[100] overflow-hidden rounded-lg shadow-2xl animate-in slide-in-from-top-1 duration-150"
                  style={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
                  onMouseLeave={clearPreview}
                >
                  <div style={{ padding: 4 }}>
                    {customLooks.length > 0 && (
                      <>
                        {customLooks.map((cl) => {
                          const isActive =
                            value.lookCss === cl.lookCss &&
                            JSON.stringify(value.grade ?? {}) === JSON.stringify(cl.grade ?? {})
                          return (
                            <div key={cl.id} className="group/look relative">
                              <button
                                type="button"
                                data-testid={`layer-grade-custom-look-${cl.id}`}
                                onClick={() => {
                                  commit(cl.lookCss, cl.grade ?? {})
                                  setLookMenuOpen(false)
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = HOVER_BG
                                  preview(cl.lookCss, cl.grade ?? {})
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = 'transparent'
                                }}
                                className="no-style !flex w-full !flex-row items-center cursor-pointer text-left"
                                style={{
                                  gap: 8,
                                  padding: '5px 8px',
                                  borderRadius: 6,
                                  transition: 'background 0.12s ease',
                                  background: 'transparent',
                                }}
                              >
                                <span
                                  className="truncate"
                                  style={{
                                    fontSize: 12.5,
                                    fontWeight: 450,
                                    lineHeight: 1,
                                    color: 'var(--color-text-primary)',
                                  }}
                                >
                                  {cl.name}
                                </span>
                                <span style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}>
                                  saved
                                </span>
                                <span style={{ flex: 1 }} />
                                {isActive && (
                                  <Check
                                    size={13}
                                    strokeWidth={2.5}
                                    style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
                                  />
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete look ${cl.name}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCustomLooks(deleteCustomLook(cl.id))
                                }}
                                className="no-style absolute right-1.5 top-1/2 hidden -translate-y-1/2 cursor-pointer rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] group-hover/look:block"
                              >
                                <X size={11} strokeWidth={2.5} />
                              </button>
                            </div>
                          )
                        })}
                        <div style={{ height: 1, margin: '4px 4px', background: 'var(--color-border)' }} />
                      </>
                    )}
                    {lookOptions.map((c) => {
                      const isActive = c.id === null ? detected === null : activeLook?.gradeId === c.id
                      return (
                        <button
                          key={c.id ?? 'none'}
                          type="button"
                          data-testid={`layer-grade-look-${c.id ?? 'none'}`}
                          onClick={() => {
                            commit(lookCssWith(c.id, intensity), draft)
                            setLookMenuOpen(false)
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = HOVER_BG
                            preview(lookCssWith(c.id, intensity), draft)
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                          }}
                          className="no-style !flex w-full !flex-row items-center cursor-pointer text-left"
                          style={{
                            gap: 8,
                            padding: '5px 8px',
                            borderRadius: 6,
                            transition: 'background 0.12s ease',
                            background: 'transparent',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 12.5,
                              fontWeight: 450,
                              lineHeight: 1,
                              color: c.id === null ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {c.name}
                          </span>
                          {c.desc && (
                            <span
                              className="truncate"
                              style={{ fontSize: 12.5, lineHeight: 1, color: 'var(--color-text-muted)' }}
                            >
                              {c.desc}
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          {isActive && (
                            <Check
                              size={13}
                              strokeWidth={2.5}
                              style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        <div>
          <FieldLabel>Intensity</FieldLabel>
          <SliderCell
            value={Math.round(intensity * 100)}
            min={5}
            max={100}
            step={5}
            format={(v) => String(Math.round(v))}
            onChange={(v) => {
              const t = v / 100
              setIntensity(t)
              if (activeLook) preview(lookCssWith(activeLook.gradeId, t), draft)
            }}
            onCommit={() => {
              if (activeLook) commit(lookCssWith(activeLook.gradeId, intensity), draft)
            }}
          />
        </div>
        <div className="flex gap-1.5">
          <GradeActionButton
            label="Copy"
            icon={<Copy size={11} strokeWidth={2} />}
            onClick={() => setCopiedGrade({ lookCss: value.lookCss, grade: value.grade })}
          />
          <GradeActionButton
            label="Paste"
            icon={<ClipboardPaste size={11} strokeWidth={2} />}
            disabled={!copiedGrade}
            onClick={() => {
              if (copiedGrade) commit(copiedGrade.lookCss, copiedGrade.grade ?? {})
            }}
          />
          <GradeActionButton
            label="Save look"
            icon={<Save size={11} strokeWidth={2} />}
            onClick={() => setSavingName('')}
          />
        </div>
        {savingName !== null && (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={savingName}
              placeholder="Look name"
              onChange={(e) => setSavingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && savingName.trim()) {
                  setCustomLooks(saveCustomLook(savingName, { lookCss: value.lookCss, grade: value.grade }))
                  setSavingName(null)
                } else if (e.key === 'Escape') {
                  setSavingName(null)
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              data-testid="layer-grade-save-name"
            />
            <GradeActionButton
              label="Save"
              disabled={!savingName.trim()}
              onClick={() => {
                setCustomLooks(saveCustomLook(savingName, { lookCss: value.lookCss, grade: value.grade }))
                setSavingName(null)
              }}
            />
            <GradeActionButton label="Cancel" onClick={() => setSavingName(null)} />
          </div>
        )}
      </Section>

      <Section title="Correction">
        {SLIDERS.map((sp) => {
          const raw = sp.fromGrade((draft[sp.key] as number | undefined) ?? 0)
          return (
            <div key={sp.key}>
              <FieldLabel>{sp.label}</FieldLabel>
              <SliderCell
                value={Math.round(raw)}
                min={sp.min}
                max={sp.max}
                step={1}
                suffix=""
                format={(v) => String(Math.round(v))}
                onChange={(v) => setParam(sp.key, sp.toGrade(v), false)}
                onCommit={() => setParam(sp.key, sp.toGrade(Math.round(raw)), true)}
              />
            </div>
          )
        })}
      </Section>

      <Section title="Wheels">
        <div className="flex gap-2">
          {(['lift', 'gamma', 'gain'] as const).map((key) => (
            <ColorWheel
              key={key}
              label={key === 'lift' ? 'Lift' : key === 'gamma' ? 'Gamma' : 'Gain'}
              value={draft[key] ?? { ...NEUTRAL_WHEEL }}
              onPreview={(v) => setWheel(key, v, false)}
              onCommit={(v) => setWheel(key, v, true)}
            />
          ))}
        </div>
      </Section>

      <Section title="Curves">
        <CurveEditor
          curves={draft.curves ?? {}}
          onPreview={(next) => setCurves(next, false)}
          onCommit={(next) => setCurves(next, true)}
        />
      </Section>

      <Section title="Effects">
        <div>
          <FieldLabel>Vignette</FieldLabel>
          <SliderCell
            value={Math.round((draft.vignette ?? 0) * 100)}
            min={0}
            max={100}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => setParam('vignette', v / 100, false)}
            onCommit={() => setParam('vignette', draftRef.current.vignette ?? 0, true)}
          />
        </div>
        <div>
          <FieldLabel>Sharpen</FieldLabel>
          <SliderCell
            value={Math.round((draft.sharpen ?? 0) * 100)}
            min={0}
            max={100}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => setParam('sharpen', v / 100, false)}
            onCommit={() => setParam('sharpen', draftRef.current.sharpen ?? 0, true)}
          />
        </div>
      </Section>
    </div>
  )
}

function GradeActionButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="no-style flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[11px] text-[var(--color-text-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-text-primary)_5%,transparent)] disabled:cursor-default disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  )
}
