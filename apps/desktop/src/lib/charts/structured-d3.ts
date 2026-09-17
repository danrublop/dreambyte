/**
 * Normalize LLM / tool output into D3ChartLayer[] and compile via DreambyteCharts.
 */

import { v4 as uuidv4 } from 'uuid'
import type { D3ChartLayer, D3ChartType } from '@/lib/types'

export const DREAMBYTE_CHART_TYPES: readonly D3ChartType[] = [
  'bar',
  'horizontalBar',
  'stackedBar',
  'groupedBar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'number',
  'gauge',
  'funnel',
  'plotly',
  'recharts',
] as const

const TYPE_SET = new Set<string>(DREAMBYTE_CHART_TYPES)

export function isDreambyteChartType(t: string): t is D3ChartType {
  return TYPE_SET.has(t)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function defaultDataForType(chartType: D3ChartType): unknown {
  switch (chartType) {
    case 'plotly':
      return {
        traces: [
          { type: 'scatter', mode: 'lines+markers', x: [1, 2, 3, 4], y: [12, 9, 15, 11], line: { shape: 'spline' } },
        ],
      }
    case 'number':
      return { value: 0, label: 'Value' }
    case 'gauge':
      return { value: 72, max: 100 }
    default:
      return [
        { label: 'A', value: 12 },
        { label: 'B', value: 28 },
        { label: 'C', value: 18 },
      ]
  }
}

/** Build a valid D3ChartLayer from loose AI/tool JSON. */
export function normalizeChartLayerFromAi(raw: unknown, sceneDuration: number, _index: number): D3ChartLayer {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ctRaw = typeof o.chartType === 'string' ? o.chartType : 'bar'
  const chartType: D3ChartType = isDreambyteChartType(ctRaw) ? ctRaw : 'bar'

  let data: unknown = o.data
  if (data === undefined || data === null) {
    data = defaultDataForType(chartType)
  }

  const cfg = o.config && typeof o.config === 'object' && !Array.isArray(o.config) ? { ...(o.config as object) } : {}

  const layoutRaw = o.layout && typeof o.layout === 'object' ? (o.layout as Record<string, unknown>) : {}
  const layout = {
    x: clamp(Number(layoutRaw.x ?? (_index === 0 ? 5 : 52)), 0, 95),
    y: clamp(Number(layoutRaw.y ?? 10), 0, 95),
    width: clamp(Number(layoutRaw.width ?? 90), 5, 100),
    height: clamp(Number(layoutRaw.height ?? 80), 5, 100),
  }

  const timingRaw = o.timing && typeof o.timing === 'object' ? (o.timing as Record<string, unknown>) : {}
  const dur = sceneDuration > 0 ? sceneDuration : 8
  const timing = {
    startAt: typeof timingRaw.startAt === 'number' && Number.isFinite(timingRaw.startAt) ? timingRaw.startAt : 0,
    duration:
      typeof timingRaw.duration === 'number' && Number.isFinite(timingRaw.duration) && timingRaw.duration > 0
        ? timingRaw.duration
        : Math.max(0.5, dur),
    animated: timingRaw.animated === true,
  }

  const id = typeof o.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(o.id) ? o.id : `chart-${uuidv4().slice(0, 8)}`

  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : `${chartType} chart`

  return {
    id,
    name,
    chartType,
    data,
    config: cfg as Record<string, unknown>,
    layout,
    timing,
  }
}

/** Parse top-level LLM JSON into normalized chart layers (multi-chart aware). */
export function normalizeChartLayersFromStructuredResponse(parsed: unknown, sceneDuration: number): D3ChartLayer[] {
  if (!parsed || typeof parsed !== 'object') return []
  const p = parsed as Record<string, unknown>
  const rawLayers = p.chartLayers
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) return []
  return rawLayers.map((row, i) => normalizeChartLayerFromAi(row, sceneDuration, i))
}

export function autoGridChartLayoutsForLayers<T extends D3ChartLayer>(layers: T[]): T[] {
  const n = layers.length
  if (n <= 1) return layers
  const presets =
    n === 2
      ? [
          { x: 4, y: 12, width: 44, height: 76 },
          { x: 52, y: 12, width: 44, height: 76 },
        ]
      : n === 3
        ? [
            { x: 4, y: 10, width: 44, height: 36 },
            { x: 52, y: 10, width: 44, height: 36 },
            { x: 28, y: 54, width: 44, height: 36 },
          ]
        : [
            { x: 4, y: 10, width: 44, height: 36 },
            { x: 52, y: 10, width: 44, height: 36 },
            { x: 4, y: 54, width: 44, height: 36 },
            { x: 52, y: 54, width: 44, height: 36 },
          ]
  return layers.map((l, i) => ({
    ...l,
    layout: presets[i] ?? l.layout,
  })) as T[]
}
