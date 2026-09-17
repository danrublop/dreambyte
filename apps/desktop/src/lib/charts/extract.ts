import type { D3ChartLayer, D3ChartType, Scene } from '@/lib/types'

const KNOWN_TYPES = new Set<D3ChartType>([
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
])

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function splitTopLevelArgs(argList: string): string[] {
  const parts: string[] = []
  let start = 0
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false

  for (let i = 0; i < argList.length; i++) {
    const ch = argList[i]
    if (inString) {
      if (!escaped && ch === inString) inString = null
      escaped = !escaped && ch === '\\'
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch as '"' | "'" | '`'
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')') depthParen--
    else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket--
    else if (ch === '{') depthBrace++
    else if (ch === '}') depthBrace--
    else if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(argList.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(argList.slice(start).trim())
  return parts.filter(Boolean)
}

function findCallClose(source: string, openParenIdx: number): number {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false
  for (let i = openParenIdx; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (!escaped && ch === inString) inString = null
      escaped = !escaped && ch === '\\'
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch as '"' | "'" | '`'
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseDataArg(dataArg: string): unknown | null {
  if (!dataArg) return null
  const trimmed = dataArg.trim()
  if (trimmed === 'DATA' || trimmed === 'window.DATA') return null
  if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const normalized = trimmed.startsWith("'") ? `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"` : trimmed
    return safeJsonParse<unknown>(normalized, null)
  }
  return null
}

/** DreambyteCharts calls use JS object literals (often single-quoted); JSON.parse fails on those. */
function parseChartConfigArg(configArg: string): Record<string, unknown> {
  const trimmed = configArg.trim()
  if (trimmed.startsWith('{')) {
    const parsed = safeJsonParse<Record<string, unknown>>(trimmed, {})
    if (Object.keys(parsed).length > 0) return parsed
  }
  const cfg: Record<string, unknown> = {}
  const pickStr = (key: string) => {
    const m = configArg.match(new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]*)['"]`))
    if (m) cfg[key] = m[1]
  }
  pickStr('title')
  pickStr('subtitle')
  pickStr('yLabel')
  pickStr('xLabel')
  return cfg
}

function extractChartCalls(
  sceneCode: string,
): Array<{ type: D3ChartType; config: Record<string, unknown>; data: unknown | null; animated: boolean }> {
  if (!sceneCode) return []
  const out: Array<{ type: D3ChartType; config: Record<string, unknown>; data: unknown | null; animated: boolean }> = []
  const token = 'DreambyteCharts.'
  let cursor = 0
  while (cursor < sceneCode.length) {
    const start = sceneCode.indexOf(token, cursor)
    if (start === -1) break
    const after = start + token.length
    const openParen = sceneCode.indexOf('(', after)
    if (openParen === -1) break
    const rawType = sceneCode.slice(after, openParen).trim() as D3ChartType
    const closeParen = findCallClose(sceneCode, openParen)
    if (closeParen === -1) break
    const suffix = sceneCode.slice(closeParen, Math.min(sceneCode.length, closeParen + 40))
    const animated = suffix.includes('.animate(window.__tl)')

    if (KNOWN_TYPES.has(rawType)) {
      const argsRaw = sceneCode.slice(openParen + 1, closeParen)
      const args = splitTopLevelArgs(argsRaw)
      const dataArg = args[1] ?? ''
      const configArg = args[2] ?? '{}'
      out.push({
        type: rawType,
        data: parseDataArg(dataArg),
        config: parseChartConfigArg(configArg),
        animated,
      })
    }
    cursor = closeParen + 1
  }
  return out
}

function resolvePerChartData(scene: Scene, callData: unknown | null, idx: number): unknown {
  if (callData != null) return callData

  const d3Data = scene.d3Data as any
  if (d3Data && Array.isArray(d3Data.chartLayers) && d3Data.chartLayers[idx]?.data != null) {
    return d3Data.chartLayers[idx].data
  }
  if (d3Data && Array.isArray(d3Data.datasets) && d3Data.datasets[idx] != null) {
    return d3Data.datasets[idx]
  }
  if (Array.isArray(d3Data) && d3Data[idx] != null && (Array.isArray(d3Data[idx]) || typeof d3Data[idx] === 'object')) {
    return d3Data[idx]
  }
  if (d3Data != null) return d3Data
  return [
    { label: 'A', value: 10 },
    { label: 'B', value: 20 },
  ]
}

function layerHasSeriesData(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0
}

/** Fills missing `data` on persisted chart layers from d3Data meta or by re-parsing DreambyteCharts calls in sceneCode. */
function enrichStoredChartLayers(scene: Scene, layers: D3ChartLayer[]): D3ChartLayer[] {
  const d3Data = scene.d3Data as { chartLayers?: Array<{ id?: string; data?: unknown }> } | null | undefined
  const meta =
    d3Data && typeof d3Data === 'object' && !Array.isArray(d3Data) && Array.isArray(d3Data.chartLayers)
      ? d3Data.chartLayers
      : null

  const calls = extractChartCalls(scene.sceneCode || '')

  return layers.map((layer, i) => {
    if (layerHasSeriesData(layer.data)) return layer
    if (meta?.length) {
      const byId = meta.find((m) => m && m.id === layer.id)
      const row = byId ?? meta[i]
      if (row && layerHasSeriesData(row.data)) {
        return { ...layer, data: row.data }
      }
    }
    const call = calls[i]
    if (call) {
      const recovered = resolvePerChartData(scene, call.data, i)
      if (layerHasSeriesData(recovered)) {
        return { ...layer, data: recovered }
      }
    }
    return layer
  })
}

export function deriveChartLayersFromScene(scene: Scene): D3ChartLayer[] {
  if (scene.sceneType !== 'd3') return scene.chartLayers ?? []
  if ((scene.chartLayers?.length ?? 0) > 0) {
    return enrichStoredChartLayers(scene, scene.chartLayers ?? [])
  }

  const calls = extractChartCalls(scene.sceneCode || '')
  if (calls.length === 0) return []

  const total = calls.length
  const cols = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / cols)
  const gap = 2
  const cellW = Math.max(20, Math.floor((100 - gap * (cols + 1)) / cols))
  const cellH = Math.max(20, Math.floor((100 - gap * (rows + 1)) / rows))

  return calls.map((c, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const sourceData = resolvePerChartData(scene, c.data, i)
    return {
      id: `legacy-chart-${i + 1}`,
      name: c.config?.title ? String(c.config.title) : `${c.type} chart ${i + 1}`,
      chartType: c.type,
      data: sourceData,
      config: c.config ?? {},
      layout: {
        x: gap + col * (cellW + gap),
        y: gap + row * (cellH + gap),
        width: cellW,
        height: cellH,
      },
      timing: {
        startAt: 0,
        duration: Math.max(0.5, scene.duration || 8),
        animated: c.animated,
      },
    }
  })
}
