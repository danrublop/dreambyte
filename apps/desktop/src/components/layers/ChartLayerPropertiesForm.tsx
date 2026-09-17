'use client'

import { useCallback, useMemo, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import type { D3ChartLayer, D3ChartType, Scene } from '@/lib/types'
import { compileD3SceneFromLayers } from '@/lib/charts/compile'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import { DREAMBYTE_CHART_TYPES } from '@/lib/charts/structured-d3'
import { chartLayerTitleLine } from '@/lib/text-slots'

function num(v: string, fallback: number): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function cfg(layer: D3ChartLayer): Record<string, unknown> {
  return { ...(layer.config || {}) }
}

function patchLayer(
  layers: D3ChartLayer[],
  chartId: string,
  map: (l: D3ChartLayer) => D3ChartLayer,
): D3ChartLayer[] | null {
  const i = layers.findIndex((c) => c.id === chartId)
  if (i < 0) return null
  const next = [...layers]
  next[i] = map(next[i])
  return next
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-0.5 block text-[10px] font-medium text-[var(--color-text-muted)]">{children}</label>
}

const inp =
  'kbd w-full rounded border px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]'
const inpStyle = {
  backgroundColor: 'var(--color-input-bg)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text-primary)',
} as const

export default function ChartLayerPropertiesForm({ scene, chartId }: { scene: Scene; chartId: string }) {
  const { updateScene, saveSceneHTML, openTextTabForSlot } = useVideoStore()
  const layer = useMemo(() => deriveChartLayersFromScene(scene).find((c) => c.id === chartId), [scene, chartId])

  const [dataDraft, setDataDraft] = useState<string | null>(null)
  const [colorsDraft, setColorsDraft] = useState<string | null>(null)
  const [plotlyLayoutDraft, setPlotlyLayoutDraft] = useState<string | null>(null)
  const [plotlyConfigDraft, setPlotlyConfigDraft] = useState<string | null>(null)
  // Surface JSON parse failures instead of silently discarding the draft on
  // blur. On a parse error the handlers return early (keeping
  // the user's text in the field) and set this message.
  const [jsonError, setJsonError] = useState<string | null>(null)

  const applyLayers = useCallback(
    (next: D3ChartLayer[]) => {
      const compiled = compileD3SceneFromLayers(next)
      updateScene(scene.id, {
        sceneType: 'd3',
        chartLayers: next,
        sceneCode: compiled.sceneCode,
        d3Data: compiled.d3Data as any,
      })
      void saveSceneHTML(scene.id)
    },
    [scene.id, updateScene, saveSceneHTML],
  )

  const update = useCallback(
    (map: (l: D3ChartLayer) => D3ChartLayer) => {
      const layers = deriveChartLayersFromScene(scene)
      const next = patchLayer(layers, chartId, map)
      if (next) applyLayers(next)
    },
    [scene, chartId, applyLayers],
  )

  const plotlyLayoutRecord = useMemo(() => {
    if (!layer) return {}
    const pl = cfg(layer).plotlyLayout
    if (pl && typeof pl === 'object' && !Array.isArray(pl)) return pl as Record<string, unknown>
    return {}
  }, [layer])

  const plotlyMargin = useMemo(() => {
    const m = plotlyLayoutRecord.margin
    if (m && typeof m === 'object' && !Array.isArray(m)) return m as Record<string, unknown>
    return {}
  }, [plotlyLayoutRecord])

  const patchPlotlyLayoutSurface = useCallback(
    (surface: Record<string, unknown>) => {
      update((l) => {
        const baseCfg = cfg(l)
        const cur =
          baseCfg.plotlyLayout && typeof baseCfg.plotlyLayout === 'object' && !Array.isArray(baseCfg.plotlyLayout)
            ? { ...(baseCfg.plotlyLayout as Record<string, unknown>) }
            : {}
        const nextLayout = { ...cur }
        for (const [k, v] of Object.entries(surface)) {
          if (v === undefined) delete nextLayout[k]
          else nextLayout[k] = v
        }
        return { ...l, config: { ...baseCfg, plotlyLayout: Object.keys(nextLayout).length ? nextLayout : undefined } }
      })
    },
    [update],
  )

  const patchPlotlyMarginSide = useCallback(
    (side: 'l' | 'r' | 't' | 'b', value: number | undefined) => {
      update((l) => {
        const baseCfg = cfg(l)
        const cur =
          baseCfg.plotlyLayout && typeof baseCfg.plotlyLayout === 'object' && !Array.isArray(baseCfg.plotlyLayout)
            ? { ...(baseCfg.plotlyLayout as Record<string, unknown>) }
            : {}
        const prevM =
          cur.margin && typeof cur.margin === 'object' && !Array.isArray(cur.margin)
            ? { ...(cur.margin as Record<string, unknown>) }
            : {}
        const margin = { ...prevM }
        if (value === undefined || !Number.isFinite(value)) delete margin[side]
        else margin[side] = value
        const nextLayout = { ...cur }
        if (Object.keys(margin).length) nextLayout.margin = margin
        else delete nextLayout.margin
        return { ...l, config: { ...baseCfg, plotlyLayout: Object.keys(nextLayout).length ? nextLayout : undefined } }
      })
    },
    [update],
  )

  if (!layer) {
    return <p className="text-[11px] text-[var(--color-text-muted)]">Chart not found.</p>
  }

  const c = cfg(layer)
  const isPlotly = layer.chartType === 'plotly'
  const isRecharts = layer.chartType === 'recharts'
  const isPlotlyOrRecharts = isPlotly || isRecharts
  const dataStr =
    dataDraft ??
    (() => {
      try {
        return JSON.stringify(layer.data ?? [], null, 2)
      } catch {
        return '[]'
      }
    })()
  const colorsStr =
    colorsDraft ?? (Array.isArray(c.colors) ? JSON.stringify(c.colors, null, 2) : c.colors ? String(c.colors) : '')

  const patchConfig = (patch: Record<string, unknown>) => {
    update((l) => {
      const base = cfg(l)
      const next = { ...base, ...patch }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete next[k]
      }
      return { ...l, config: next }
    })
  }

  return (
    <div className="space-y-3">
      {jsonError && (
        <div
          role="alert"
          className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--danger)]"
        >
          {jsonError}
        </div>
      )}
      <p className="text-[10px] leading-snug text-[var(--color-text-muted)]">
        Scene <strong className="text-[var(--color-text-primary)]">background</strong> (color, texture, canvas motion)
        is separate: double-click <strong className="text-[var(--color-text-primary)]">Background</strong> in the stack.
        Use panel &amp; plot fills below so charts can sit transparently on top or read as cards.
      </p>

      <details open className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
          Identity &amp; data
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <FieldLabel>Name</FieldLabel>
            <input
              type="text"
              value={layer.name}
              onChange={(e) => update((l) => ({ ...l, name: e.target.value }))}
              className={inp}
              style={inpStyle}
            />
          </div>
          <div>
            <FieldLabel>Chart type</FieldLabel>
            <select
              value={layer.chartType}
              onChange={(e) => update((l) => ({ ...l, chartType: e.target.value as D3ChartType }))}
              className={inp}
              style={inpStyle}
            >
              {DREAMBYTE_CHART_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>Data (JSON)</FieldLabel>
            {isRecharts ? (
              <p className="mb-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
                Recharts (shadcn-style): array of rows with your <span className="font-mono">categoryKey</span> and{' '}
                <span className="font-mono">valueKey</span> (defaults <span className="font-mono">label</span> /{' '}
                <span className="font-mono">value</span>). Set series colors via the palette JSON in Typography.
              </p>
            ) : null}
            {isPlotly ? (
              <p className="mb-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
                Plotly: <span className="font-mono">traces</span> array — style each trace with fields like{' '}
                <span className="font-mono">marker.color</span>, <span className="font-mono">line.color</span>,{' '}
                <span className="font-mono">marker.size</span> (
                <a
                  href="https://plotly.com/javascript/reference/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--color-accent)] underline"
                >
                  trace reference
                </a>
                ). Overall figure look uses <span className="font-mono">plotlyLayout</span> below (
                <a
                  href="https://plotly.com/javascript/reference/layout/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--color-accent)] underline"
                >
                  layout reference
                </a>
                ).
              </p>
            ) : null}
            <textarea
              rows={6}
              value={dataStr}
              onChange={(e) => setDataDraft(e.target.value)}
              onBlur={() => {
                if (dataDraft == null) return
                try {
                  const parsed = JSON.parse(dataDraft)
                  update((l) => ({ ...l, data: parsed }))
                } catch {
                  setJsonError('Chart data: invalid JSON — not saved. Fix it or revert.')
                  return // keep the draft so the user doesn't lose their edit
                }
                setJsonError(null)
                setDataDraft(null)
              }}
              className={`${inp} font-mono text-[11px]`}
              style={inpStyle}
            />
          </div>
        </div>
      </details>

      <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
          Layout &amp; timing (% of chart area)
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(['x', 'y', 'width', 'height'] as const).map((k) => (
            <div key={k}>
              <FieldLabel>{k}</FieldLabel>
              <input
                type="number"
                value={layer.layout[k]}
                onChange={(e) =>
                  update((l) => ({
                    ...l,
                    layout: { ...l.layout, [k]: num(e.target.value, l.layout[k]) },
                  }))
                }
                className={inp}
                style={inpStyle}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Start at (s)</FieldLabel>
            <input
              type="number"
              step={0.1}
              min={0}
              value={layer.timing.startAt}
              onChange={(e) => update((l) => ({ ...l, timing: { ...l.timing, startAt: num(e.target.value, 0) } }))}
              className={inp}
              style={inpStyle}
            />
          </div>
          <div>
            <FieldLabel>Duration (s)</FieldLabel>
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={layer.timing.duration}
              onChange={(e) =>
                update((l) => ({ ...l, timing: { ...l.timing, duration: Math.max(0.1, num(e.target.value, 1)) } }))
              }
              className={inp}
              style={inpStyle}
            />
          </div>
        </div>
        <label className="mt-2 flex cursor-pointer flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-primary)]">
          <input
            type="checkbox"
            disabled={isPlotlyOrRecharts}
            checked={isPlotlyOrRecharts ? false : layer.timing.animated}
            onChange={(e) => {
              if (isPlotlyOrRecharts) return
              update((l) => ({ ...l, timing: { ...l.timing, animated: e.target.checked } }))
            }}
          />
          Animated reveal (scene timeline)
          {isPlotly ? (
            <span className="text-[var(--color-text-muted)]">(Plotly layers render as static plots)</span>
          ) : null}
          {isRecharts ? (
            <span className="text-[var(--color-text-muted)]">
              (Recharts layers animate with React, not the scene timeline)
            </span>
          ) : null}
        </label>
      </details>

      <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
          Panel vs scene (HTML container)
        </summary>
        <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          Styles the chart&apos;s positioned div — not the scene. Leave transparent to float over video, images, or
          canvas background.
        </p>
        <div className="mt-2 space-y-2">
          <div>
            <FieldLabel>Panel background</FieldLabel>
            <div className="flex gap-2">
              <input
                type="color"
                value={
                  /^#[0-9a-fA-F]{6}$/.test(String(c.chartPanelBackground || ''))
                    ? String(c.chartPanelBackground)
                    : '#ffffff'
                }
                onChange={(e) => patchConfig({ chartPanelBackground: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border bg-transparent"
                style={{ borderColor: 'var(--color-border)' }}
              />
              <input
                type="text"
                placeholder="transparent | rgba(...) | #hex"
                value={typeof c.chartPanelBackground === 'string' ? c.chartPanelBackground : ''}
                onChange={(e) => patchConfig({ chartPanelBackground: e.target.value || 'transparent' })}
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Panel opacity</FieldLabel>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={typeof c.chartPanelOpacity === 'number' ? c.chartPanelOpacity : 1}
                onChange={(e) => patchConfig({ chartPanelOpacity: Math.max(0, Math.min(1, num(e.target.value, 1))) })}
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <FieldLabel>Panel radius (px)</FieldLabel>
              <input
                type="number"
                min={0}
                max={48}
                step={1}
                value={typeof c.chartPanelBorderRadius === 'number' ? c.chartPanelBorderRadius : 0}
                onChange={(e) => patchConfig({ chartPanelBorderRadius: Math.max(0, num(e.target.value, 0)) })}
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>
          <div>
            <FieldLabel>Panel box-shadow (CSS)</FieldLabel>
            <input
              type="text"
              placeholder="none | 0 8px 24px rgba(0,0,0,0.15)"
              value={typeof c.chartPanelBoxShadow === 'string' ? c.chartPanelBoxShadow : ''}
              onChange={(e) => patchConfig({ chartPanelBoxShadow: e.target.value || 'none' })}
              className={inp}
              style={inpStyle}
            />
          </div>
        </div>
      </details>

      {!isPlotlyOrRecharts ? (
        <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Plot area (inside SVG)
          </summary>
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            Fills the SVG viewport behind marks. Leave empty for a see-through plot (scene shows through).
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(String(c.plotBackground || '')) ? String(c.plotBackground) : '#ffffff'}
              onChange={(e) => patchConfig({ plotBackground: e.target.value })}
              className="h-8 w-10 cursor-pointer rounded border bg-transparent"
              style={{ borderColor: 'var(--color-border)' }}
            />
            <input
              type="text"
              placeholder="empty = transparent"
              value={c.plotBackground === undefined || c.plotBackground === null ? '' : String(c.plotBackground)}
              onChange={(e) => {
                const v = e.target.value.trim()
                if (!v) patchConfig({ plotBackground: undefined })
                else patchConfig({ plotBackground: v })
              }}
              className={inp}
              style={inpStyle}
            />
          </div>
        </details>
      ) : null}

      {isRecharts ? (
        <details open className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Recharts (shadcn-style scene chart)
          </summary>
          <p className="mt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
            The scene iframe loads React + Recharts from{' '}
            <a href="https://esm.sh" target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline">
              esm.sh
            </a>{' '}
            (same stack as{' '}
            <a
              href="https://ui.shadcn.com/docs/components/chart"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline"
            >
              shadcn charts
            </a>
            ). Preview and MP4 export need network access to that CDN.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Variant</FieldLabel>
              <select
                value={c.rechartsVariant === 'line' || c.rechartsVariant === 'area' ? String(c.rechartsVariant) : 'bar'}
                onChange={(e) =>
                  patchConfig({
                    rechartsVariant: e.target.value as 'bar' | 'line' | 'area',
                  })
                }
                className={inp}
                style={inpStyle}
              >
                <option value="bar">bar</option>
                <option value="line">line</option>
                <option value="area">area</option>
              </select>
            </div>
            <div className="flex flex-col justify-end">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={c.showGrid !== false}
                  onChange={(e) => patchConfig({ showGrid: e.target.checked })}
                />
                Show grid
              </label>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Category key (X)</FieldLabel>
              <input
                type="text"
                placeholder="label"
                value={typeof c.categoryKey === 'string' ? c.categoryKey : ''}
                onChange={(e) => {
                  const t = e.target.value.trim()
                  patchConfig({ categoryKey: t ? t : undefined })
                }}
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <FieldLabel>Value key (Y)</FieldLabel>
              <input
                type="text"
                placeholder="value"
                value={typeof c.valueKey === 'string' ? c.valueKey : ''}
                onChange={(e) => {
                  const t = e.target.value.trim()
                  patchConfig({ valueKey: t ? t : undefined })
                }}
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>
        </details>
      ) : null}

      {isPlotly ? (
        <details open className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Plotly.js layout &amp; config
          </summary>
          <p className="mt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
            Defaults: transparent <span className="font-mono">paper_bgcolor</span> /{' '}
            <span className="font-mono">plot_bgcolor</span>, <span className="font-mono">autosize</span>, merged margins
            (partial <span className="font-mono">margin</span> keys keep the rest), static export-friendly{' '}
            <span className="font-mono">staticPlot</span>. Docs:{' '}
            <a
              href="https://plotly.com/javascript/reference/layout/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline"
            >
              layout
            </a>
            {' · '}
            <a
              href="https://plotly.com/javascript/reference/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline"
            >
              traces
            </a>
            {' · '}
            <a
              href="https://github.com/plotly/plotly.js"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline"
            >
              plotly.js
            </a>
            .
          </p>
          <div
            className="mt-2 space-y-3 rounded-md border border-dashed p-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <p className="text-[10px] font-semibold text-[var(--color-text-primary)]">Quick layout (plotlyLayout)</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>paper_bgcolor (full figure)</FieldLabel>
                <div className="flex gap-1">
                  <input
                    type="color"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(String(plotlyLayoutRecord.paper_bgcolor ?? ''))
                        ? String(plotlyLayoutRecord.paper_bgcolor)
                        : '#1a1a2e'
                    }
                    onChange={(e) => patchPlotlyLayoutSurface({ paper_bgcolor: e.target.value })}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent"
                    style={{ borderColor: 'var(--color-border)' }}
                  />
                  <input
                    type="text"
                    placeholder="empty = transparent (default)"
                    value={
                      plotlyLayoutRecord.paper_bgcolor !== undefined && plotlyLayoutRecord.paper_bgcolor !== null
                        ? String(plotlyLayoutRecord.paper_bgcolor)
                        : ''
                    }
                    onChange={(e) => {
                      const t = e.target.value.trim()
                      patchPlotlyLayoutSurface({ paper_bgcolor: t ? t : undefined })
                    }}
                    className={inp}
                    style={inpStyle}
                  />
                </div>
              </div>
              <div>
                <FieldLabel>plot_bgcolor (plot region)</FieldLabel>
                <div className="flex gap-1">
                  <input
                    type="color"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(String(plotlyLayoutRecord.plot_bgcolor ?? ''))
                        ? String(plotlyLayoutRecord.plot_bgcolor)
                        : '#2d2d3a'
                    }
                    onChange={(e) => patchPlotlyLayoutSurface({ plot_bgcolor: e.target.value })}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent"
                    style={{ borderColor: 'var(--color-border)' }}
                  />
                  <input
                    type="text"
                    placeholder="empty = transparent (default)"
                    value={
                      plotlyLayoutRecord.plot_bgcolor !== undefined && plotlyLayoutRecord.plot_bgcolor !== null
                        ? String(plotlyLayoutRecord.plot_bgcolor)
                        : ''
                    }
                    onChange={(e) => {
                      const t = e.target.value.trim()
                      patchPlotlyLayoutSurface({ plot_bgcolor: t ? t : undefined })
                    }}
                    className={inp}
                    style={inpStyle}
                  />
                </div>
              </div>
            </div>
            <div>
              <FieldLabel>margin (px) — empty uses compile defaults (48/24/48/48)</FieldLabel>
              <div className="mt-1 grid grid-cols-4 gap-2">
                {(['l', 'r', 't', 'b'] as const).map((side) => (
                  <div key={side}>
                    <span className="mb-0.5 block text-[8px] uppercase text-[var(--color-text-muted)]">{side}</span>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      step={4}
                      placeholder="auto"
                      value={typeof plotlyMargin[side] === 'number' ? plotlyMargin[side] : ''}
                      onChange={(e) => {
                        const t = e.target.value.trim()
                        if (!t) patchPlotlyMarginSide(side, undefined)
                        else {
                          const n = Number(t)
                          patchPlotlyMarginSide(side, Number.isFinite(n) ? n : undefined)
                        }
                      }}
                      className={inp}
                      style={inpStyle}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            <div>
              <FieldLabel>plotlyLayout (JSON object)</FieldLabel>
              <textarea
                rows={5}
                className={`${inp} font-mono text-[11px]`}
                style={inpStyle}
                value={
                  plotlyLayoutDraft ??
                  JSON.stringify(
                    typeof c.plotlyLayout === 'object' && c.plotlyLayout !== null && !Array.isArray(c.plotlyLayout)
                      ? c.plotlyLayout
                      : {},
                    null,
                    2,
                  )
                }
                onChange={(e) => setPlotlyLayoutDraft(e.target.value)}
                onBlur={() => {
                  if (plotlyLayoutDraft == null) return
                  const t = plotlyLayoutDraft.trim()
                  if (!t) {
                    patchConfig({ plotlyLayout: undefined })
                    setJsonError(null)
                    setPlotlyLayoutDraft(null)
                    return
                  }
                  try {
                    const parsed = JSON.parse(t)
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                      patchConfig({ plotlyLayout: parsed })
                  } catch {
                    setJsonError('plotlyLayout: invalid JSON — not saved. Fix it or clear the field.')
                    return
                  }
                  setJsonError(null)
                  setPlotlyLayoutDraft(null)
                }}
              />
            </div>
            <div>
              <FieldLabel>plotlyConfig (JSON object)</FieldLabel>
              <textarea
                rows={4}
                className={`${inp} font-mono text-[11px]`}
                style={inpStyle}
                value={
                  plotlyConfigDraft ??
                  JSON.stringify(
                    typeof c.plotlyConfig === 'object' && c.plotlyConfig !== null && !Array.isArray(c.plotlyConfig)
                      ? c.plotlyConfig
                      : {},
                    null,
                    2,
                  )
                }
                onChange={(e) => setPlotlyConfigDraft(e.target.value)}
                onBlur={() => {
                  if (plotlyConfigDraft == null) return
                  const t = plotlyConfigDraft.trim()
                  if (!t) {
                    patchConfig({ plotlyConfig: undefined })
                    setJsonError(null)
                    setPlotlyConfigDraft(null)
                    return
                  }
                  try {
                    const parsed = JSON.parse(t)
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                      patchConfig({ plotlyConfig: parsed })
                  } catch {
                    setJsonError('plotlyConfig: invalid JSON — not saved. Fix it or clear the field.')
                    return
                  }
                  setJsonError(null)
                  setPlotlyConfigDraft(null)
                }}
              />
            </div>
          </div>
        </details>
      ) : null}

      {!isPlotlyOrRecharts ? (
        <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Ink, axes &amp; labels (DreambyteCharts)
          </summary>
          <p className="mt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
            Override typography colors and bar outlines. Empty fields fall back to the dark/light theme and (unless
            disabled) scene <span className="font-mono">AXIS_COLOR</span> /{' '}
            <span className="font-mono">GRID_COLOR</span>.
          </p>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-primary)]">
            <input
              type="checkbox"
              checked={c.useSceneAxisColors !== false}
              onChange={(e) => patchConfig({ useSceneAxisColors: e.target.checked ? undefined : false })}
            />
            Use scene axis/grid colors when axis/grid not set
          </label>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ['textColor', 'Primary text (titles default)'],
                ['tickLabelColor', 'Tick & default muted text'],
                ['axisColor', 'Axis lines'],
                ['gridColor', 'Grid lines'],
                ['titleColor', 'Title override'],
                ['subtitleColor', 'Subtitle override'],
                ['axisLabelColor', 'X/Y axis titles'],
                ['legendTextColor', 'Legend labels'],
                ['valueLabelColor', 'Value labels on bars'],
              ] as const
            ).map(([key, lab]) => (
              <div key={key}>
                <FieldLabel>{lab}</FieldLabel>
                <div className="flex gap-1">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(String(c[key] || '')) ? String(c[key]) : '#888888'}
                    onChange={(e) => patchConfig({ [key]: e.target.value })}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent"
                    style={{ borderColor: 'var(--color-border)' }}
                  />
                  <input
                    type="text"
                    placeholder="empty = auto"
                    value={typeof c[key] === 'string' ? (c[key] as string) : ''}
                    onChange={(e) => {
                      const t = e.target.value.trim()
                      patchConfig({ [key]: t ? t : undefined })
                    }}
                    className={inp}
                    style={inpStyle}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Bar stroke (hex / rgba)</FieldLabel>
              <input
                type="text"
                placeholder="empty = none"
                value={typeof c.barStroke === 'string' ? c.barStroke : ''}
                onChange={(e) => {
                  const t = e.target.value.trim()
                  patchConfig({ barStroke: t ? t : undefined })
                }}
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <FieldLabel>Bar stroke width</FieldLabel>
              <input
                type="number"
                min={0}
                max={12}
                step={0.5}
                value={typeof c.barStrokeWidth === 'number' ? c.barStrokeWidth : ''}
                onChange={(e) => {
                  const n = num(e.target.value, NaN)
                  if (!Number.isFinite(n) || n <= 0) patchConfig({ barStrokeWidth: undefined })
                  else patchConfig({ barStrokeWidth: n })
                }}
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>
        </details>
      ) : null}

      {!isPlotly ? (
        <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Labels &amp; format
          </summary>
          <div className="mt-2 space-y-2">
            {(
              [
                ['title', 'Title'],
                ['subtitle', 'Subtitle'],
                ['xLabel', 'X label'],
                ['yLabel', 'Y label'],
              ] as const
            ).map(([key, lab]) => (
              <div key={key}>
                <FieldLabel>{lab}</FieldLabel>
                <input
                  type="text"
                  value={typeof c[key] === 'string' ? (c[key] as string) : ''}
                  onChange={(e) => patchConfig({ [key]: e.target.value })}
                  className={inp}
                  style={inpStyle}
                />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <FieldLabel>Value format (d3)</FieldLabel>
                <input
                  type="text"
                  placeholder=",.0f"
                  value={typeof c.valueFormat === 'string' ? c.valueFormat : ''}
                  onChange={(e) => patchConfig({ valueFormat: e.target.value })}
                  className={inp}
                  style={inpStyle}
                />
              </div>
              <div>
                <FieldLabel>Theme</FieldLabel>
                <select
                  value={c.theme === 'light' ? 'light' : 'dark'}
                  onChange={(e) => patchConfig({ theme: e.target.value })}
                  className={inp}
                  style={inpStyle}
                >
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <FieldLabel>Value prefix</FieldLabel>
                <input
                  type="text"
                  value={typeof c.valuePrefix === 'string' ? c.valuePrefix : ''}
                  onChange={(e) => patchConfig({ valuePrefix: e.target.value })}
                  className={inp}
                  style={inpStyle}
                />
              </div>
              <div>
                <FieldLabel>Value suffix</FieldLabel>
                <input
                  type="text"
                  value={typeof c.valueSuffix === 'string' ? c.valueSuffix : ''}
                  onChange={(e) => patchConfig({ valueSuffix: e.target.value })}
                  className={inp}
                  style={inpStyle}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-[var(--color-text-primary)]">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={c.showGrid !== false}
                  onChange={(e) => patchConfig({ showGrid: e.target.checked })}
                />
                Grid
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={c.showValues !== false}
                  onChange={(e) => patchConfig({ showValues: e.target.checked })}
                />
                Value labels
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(c.showLegend)}
                  onChange={(e) => patchConfig({ showLegend: e.target.checked })}
                />
                Legend
              </label>
            </div>
          </div>
        </details>
      ) : null}

      <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
          Typography &amp; colors
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <FieldLabel>Font family</FieldLabel>
            <input
              type="text"
              placeholder="e.g. Inter, system-ui"
              value={typeof c.fontFamily === 'string' ? c.fontFamily : typeof c.font === 'string' ? c.font : ''}
              onChange={(e) => patchConfig({ fontFamily: e.target.value })}
              className={inp}
              style={inpStyle}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['fontSize', 'Body / base'],
                ['titleSize', 'Title'],
                ['subtitleSize', 'Subtitle'],
                ['axisLabelSize', 'Axis labels'],
                ['axisTickSize', 'Axis ticks'],
                ['dataLabelSize', 'Data labels'],
              ] as const
            ).map(([key, lab]) => (
              <div key={key}>
                <FieldLabel>{lab}</FieldLabel>
                <input
                  type="number"
                  min={8}
                  max={120}
                  step={1}
                  value={typeof c[key] === 'number' ? c[key] : ''}
                  onChange={(e) => {
                    const n = num(e.target.value, NaN)
                    if (!Number.isFinite(n)) patchConfig({ [key]: undefined })
                    else patchConfig({ [key]: n })
                  }}
                  className={inp}
                  style={inpStyle}
                />
              </div>
            ))}
          </div>
          {!isPlotly ? (
            <div>
              <FieldLabel>Colors (JSON array of hex)</FieldLabel>
              <textarea
                rows={3}
                value={colorsStr}
                onChange={(e) => setColorsDraft(e.target.value)}
                onBlur={() => {
                  if (colorsDraft == null) return
                  const t = colorsDraft.trim()
                  if (!t) {
                    patchConfig({ colors: undefined })
                    setJsonError(null)
                    setColorsDraft(null)
                    return
                  }
                  try {
                    const parsed = JSON.parse(t)
                    if (Array.isArray(parsed)) patchConfig({ colors: parsed })
                  } catch {
                    setJsonError('colors: invalid JSON array — not saved. Fix it or clear the field.')
                    return
                  }
                  setJsonError(null)
                  setColorsDraft(null)
                }}
                placeholder='["#e84545", "#2563eb", ...]'
                className={`${inp} font-mono text-[11px]`}
                style={inpStyle}
              />
            </div>
          ) : (
            <p className="text-[10px] text-[var(--color-text-muted)]">
              Palette for Plotly is set per trace (<span className="font-mono">marker.color</span>,{' '}
              <span className="font-mono">line.color</span>, etc.).
            </p>
          )}
        </div>
      </details>

      {!isPlotlyOrRecharts ? (
        <details className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-primary)]">
            Animation &amp; margin
          </summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(
              [
                ['animationDuration', 'Duration (s)'],
                ['staggerDelay', 'Stagger (s)'],
                ['countDuration', 'Count (s)'],
              ] as const
            ).map(([key, lab]) => (
              <div key={key}>
                <FieldLabel>{lab}</FieldLabel>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.05}
                  value={typeof c[key] === 'number' ? c[key] : ''}
                  onChange={(e) => {
                    const n = num(e.target.value, NaN)
                    if (!Number.isFinite(n)) patchConfig({ [key]: undefined })
                    else patchConfig({ [key]: n })
                  }}
                  className={inp}
                  style={inpStyle}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">Margin (px) inside the chart SVG</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => {
              const m = (c.margin as Record<string, unknown> | undefined) || {}
              return (
                <div key={side}>
                  <FieldLabel>Margin {side}</FieldLabel>
                  <input
                    type="number"
                    min={0}
                    max={400}
                    step={4}
                    value={typeof m[side] === 'number' ? m[side] : ''}
                    onChange={(e) => {
                      const n = num(e.target.value, NaN)
                      const base = { ...(typeof c.margin === 'object' && c.margin ? (c.margin as object) : {}) }
                      if (!Number.isFinite(n)) {
                        const nextM = { ...base }
                        delete (nextM as any)[side]
                        patchConfig(Object.keys(nextM).length ? { margin: nextM } : { margin: undefined })
                      } else patchConfig({ margin: { ...base, [side]: n } })
                    }}
                    className={inp}
                    style={inpStyle}
                  />
                </div>
              )
            })}
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-primary)]">
            <input
              type="checkbox"
              checked={c.readableDefaults === false}
              onChange={(e) => patchConfig({ readableDefaults: e.target.checked ? false : undefined })}
            />
            Disable readable defaults merge (expert)
          </label>
        </details>
      ) : null}

      <button
        type="button"
        className="no-style w-full rounded-lg border px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
        onClick={() => openTextTabForSlot(`chart:${chartId}:title`)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Title slot
        </span>
        <p className="mt-0.5 font-mono text-[11px] text-[var(--color-text-muted)]">
          {chartLayerTitleLine(layer).slice(0, 56)}
          {chartLayerTitleLine(layer).length > 56 ? '…' : ''}
        </p>
        <span className="mt-1 block text-[11px] text-[var(--color-accent)]">Open in Text tab →</span>
      </button>
    </div>
  )
}
