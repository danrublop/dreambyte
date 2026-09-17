import type { D3ChartLayer } from '@/lib/types'

/**
 * JSON for embedding inside an inline `<script>` body. Escaping `<` as the
 * < escape (valid JSON/JS) prevents a `</script>` substring inside chart
 * data/config from prematurely closing the script tag — which would break the
 * scene and is an injection vector.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Not passed to DreambyteCharts — applied to the chart layer HTML container in generated sceneCode. */
const CHART_PANEL_CONFIG_KEYS = new Set([
  'chartPanelBackground',
  'chartPanelOpacity',
  'chartPanelBorderRadius',
  'chartPanelBoxShadow',
])

function withReadableDefaults(layer: D3ChartLayer): Record<string, unknown> {
  const raw = (layer.config || {}) as Record<string, unknown>
  if (layer.chartType === 'plotly' || layer.chartType === 'recharts') return { ...raw }
  const readableOptOut = raw.readableDefaults === false
  if (readableOptOut) return raw

  const merged: Record<string, unknown> = {
    ...raw,
    // Keep typography and labels readable by default unless user explicitly overrides.
    fontFamily: raw.fontFamily,
    fontSize: raw.fontSize ?? 18,
    title: raw.title ?? layer.name,
    showGrid: raw.showGrid ?? true,
    showValues: raw.showValues ?? true,
    // Match dreambyte-charts resolveConfig default (avoid huge legends / layout surprises).
    showLegend: raw.showLegend ?? false,
    axisLabelSize: raw.axisLabelSize ?? 24,
    dataLabelSize: raw.dataLabelSize ?? 20,
    contrastMode: raw.contrastMode ?? 'auto',
  }

  const axisLike = ['bar', 'horizontalBar', 'stackedBar', 'groupedBar', 'line', 'area', 'scatter'].includes(
    layer.chartType,
  )
  if (axisLike) {
    merged.xLabel = raw.xLabel ?? 'Category'
    merged.yLabel = raw.yLabel ?? 'Value'
  }
  return merged
}

function chartSdkConfig(layer: D3ChartLayer): Record<string, unknown> {
  const merged = withReadableDefaults(layer)
  const out: Record<string, unknown> = { ...merged }
  for (const k of CHART_PANEL_CONFIG_KEYS) delete out[k]
  delete out.plotlyLayout
  delete out.plotlyConfig
  delete out.rechartsVariant
  return out
}

function panelDivOpen(layer: D3ChartLayer): string {
  const lid = layer.id.replace(/[^a-zA-Z0-9_-]/g, '')
  const rawPanel = (layer.config || {}) as Record<string, unknown>
  const panelBg =
    typeof rawPanel.chartPanelBackground === 'string' && rawPanel.chartPanelBackground.trim()
      ? rawPanel.chartPanelBackground.trim()
      : 'transparent'
  const panelOp =
    typeof rawPanel.chartPanelOpacity === 'number' &&
    Number.isFinite(rawPanel.chartPanelOpacity) &&
    rawPanel.chartPanelOpacity >= 0 &&
    rawPanel.chartPanelOpacity <= 1
      ? rawPanel.chartPanelOpacity
      : 1
  const panelRad =
    typeof rawPanel.chartPanelBorderRadius === 'number' && Number.isFinite(rawPanel.chartPanelBorderRadius)
      ? Math.max(0, rawPanel.chartPanelBorderRadius)
      : 0
  const panelSh =
    typeof rawPanel.chartPanelBoxShadow === 'string' && rawPanel.chartPanelBoxShadow.trim()
      ? rawPanel.chartPanelBoxShadow.trim()
      : 'none'
  return `
{
  const el = document.createElement('div');
  el.id = 'chart-layer-${lid}';
  el.style.position = 'absolute';
  el.style.left = '${layer.layout.x}%';
  el.style.top = '${layer.layout.y}%';
  el.style.width = '${layer.layout.width}%';
  el.style.height = '${layer.layout.height}%';
  el.style.overflow = 'hidden';
  el.style.background = ${JSON.stringify(panelBg)};
  el.style.opacity = ${JSON.stringify(String(panelOp))};
  el.style.borderRadius = ${JSON.stringify(`${panelRad}px`)};
  el.style.boxShadow = ${JSON.stringify(panelSh)};
  chartRoot.appendChild(el);
`.trim()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const PLOTLY_DEFAULT_MARGIN = { l: 48, r: 24, t: 48, b: 48 }

/**
 * Merge user plotlyLayout over defaults without wiping nested `margin` or `font`
 * when the user only sets partial keys (per Plotly layout docs).
 */
export function mergePlotlyLayoutForCompile(
  userLayout: Record<string, unknown> | undefined,
  fontFamilyFromConfig: string | undefined,
): Record<string, unknown> {
  const user = userLayout && isPlainObject(userLayout) ? userLayout : {}
  const userMargin = isPlainObject(user.margin) ? user.margin : {}
  const userFont = isPlainObject(user.font) ? user.font : {}
  const { margin: _dropM, font: _dropF, ...userTop } = user

  const baseFont: Record<string, unknown> = {
    ...(fontFamilyFromConfig ? { family: fontFamilyFromConfig } : {}),
    ...userFont,
  }

  const mergedMargin = { ...PLOTLY_DEFAULT_MARGIN, ...userMargin }

  const out: Record<string, unknown> = {
    autosize: true,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    ...userTop,
    margin: mergedMargin,
  }

  if (Object.keys(baseFont).length > 0) {
    out.font = baseFont
  }

  return out
}

function compilePlotlyLayerBlock(layer: D3ChartLayer): string {
  const open = panelDivOpen(layer)
  const raw = layer.data
  let traces: unknown[] = []
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.traces)) traces = o.traces
  } else if (Array.isArray(raw)) {
    traces = raw
  }
  const conf = (layer.config || {}) as Record<string, unknown>
  const fontFamily = typeof conf.fontFamily === 'string' && conf.fontFamily.trim() ? conf.fontFamily.trim() : undefined
  const userLayout = isPlainObject(conf.plotlyLayout) ? (conf.plotlyLayout as Record<string, unknown>) : {}
  const plotlyLayout = mergePlotlyLayoutForCompile(userLayout, fontFamily)
  const userPlotCfg =
    typeof conf.plotlyConfig === 'object' && conf.plotlyConfig !== null && !Array.isArray(conf.plotlyConfig)
      ? (conf.plotlyConfig as Record<string, unknown>)
      : {}
  const plotlyConfig = {
    staticPlot: true,
    responsive: true,
    displayModeBar: false,
    ...userPlotCfg,
  }
  const tracesLit = jsonForScript(traces)
  const layoutLit = jsonForScript(plotlyLayout)
  const configLit = jsonForScript(plotlyConfig)
  return `
${open}
  if (typeof Plotly === 'undefined') {
    console.warn('Plotly.js not loaded; chart layer skipped');
  } else {
    Plotly.newPlot(el.id, ${tracesLit}, ${layoutLit}, ${configLit});
  }
}
`.trim()
}

export function chartLayersUsePlotly(layers: D3ChartLayer[] | undefined | null): boolean {
  return !!(layers && layers.some((l) => l.chartType === 'plotly'))
}

export function chartLayersUseRecharts(layers: D3ChartLayer[] | undefined | null): boolean {
  return !!(layers && layers.some((l) => l.chartType === 'recharts'))
}

function buildRechartsSpec(layer: D3ChartLayer): Record<string, unknown> {
  const raw = (layer.config || {}) as Record<string, unknown>
  const v = raw.rechartsVariant
  const variant = v === 'line' || v === 'area' ? v : 'bar'
  const data = Array.isArray(layer.data) ? layer.data : []
  const colors = Array.isArray(raw.colors) ? raw.colors : undefined
  return {
    variant,
    categoryKey: typeof raw.categoryKey === 'string' ? raw.categoryKey : 'label',
    valueKey: typeof raw.valueKey === 'string' ? raw.valueKey : 'value',
    data,
    colors,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : layer.name,
    titleSize: typeof raw.titleSize === 'number' && Number.isFinite(raw.titleSize) ? raw.titleSize : undefined,
    showGrid: raw.showGrid !== false,
  }
}

function compileRechartsLayerBlock(layer: D3ChartLayer): string {
  const open = panelDivOpen(layer)
  const spec = buildRechartsSpec(layer)
  const specStr = jsonForScript(spec)
  const specJsLiteral = JSON.stringify(specStr)
  return `
${open}
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.setAttribute('data-dreambyte-recharts', '1');
  var _spec = document.createElement('script');
  _spec.type = 'application/json';
  _spec.className = 'dreambyte-recharts-json';
  _spec.textContent = ${specJsLiteral};
  el.appendChild(_spec);
}
`.trim()
}

export function compileD3SceneFromLayers(layers: D3ChartLayer[]): { sceneCode: string; d3Data: unknown } {
  const safeLayers = (layers || []).filter(Boolean)

  const blocks = safeLayers.map((layer) => {
    if (layer.chartType === 'plotly') {
      return compilePlotlyLayerBlock(layer)
    }
    if (layer.chartType === 'recharts') {
      return compileRechartsLayerBlock(layer)
    }
    const cfg = jsonForScript(chartSdkConfig(layer))
    const open = panelDivOpen(layer)
    const data = layer.data === undefined || layer.data === null ? '[]' : jsonForScript(layer.data)
    const animateCall = layer.timing?.animated ? '.animate(window.__tl)' : ''
    return `
${open}
  DreambyteCharts.${layer.chartType}('#' + el.id, ${data}, ${cfg})${animateCall};
}
`.trim()
  })

  const indented = blocks
    .map((b) =>
      b
        .split('\n')
        .map((line) => (line ? `  ${line}` : line))
        .join('\n'),
    )
    .join('\n')

  const sceneCode = `
const chartRoot = document.getElementById('chart');
if (chartRoot) {
  while (chartRoot.firstChild) chartRoot.removeChild(chartRoot.firstChild);
  chartRoot.style.position = 'relative';
  chartRoot.style.width = '100%';
  chartRoot.style.height = '100%';
${indented}
}
`.trim()

  return {
    sceneCode,
    d3Data: { chartLayers: safeLayers.map((l) => ({ id: l.id, chartType: l.chartType, data: l.data })) },
  }
}
