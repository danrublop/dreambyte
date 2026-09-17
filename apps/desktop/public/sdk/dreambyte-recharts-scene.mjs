/**
 * Mounts shadcn-style Recharts layers in D3 scene HTML (React + Recharts via esm.sh).
 * Each host: [data-dreambyte-recharts] + child script.dreambyte-recharts-json (application/json).
 */
const REACT_SRC = 'https://esm.sh/react@18.3.1'
const REACT_DOM_SRC = 'https://esm.sh/react-dom@18.3.1/client'
const RECHARTS_SRC =
  'https://esm.sh/recharts@2.15.3?external=react,react-dom&deps=react@18.3.1,react-dom@18.3.1'

function buildTree(React, R, spec) {
  const {
    BarChart,
    Bar,
    LineChart,
    Line,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
  } = R

  const data = Array.isArray(spec.data) ? spec.data : []
  const cat = typeof spec.categoryKey === 'string' ? spec.categoryKey : 'label'
  const val = typeof spec.valueKey === 'string' ? spec.valueKey : 'value'
  const colors = Array.isArray(spec.colors) ? spec.colors : []
  const fill = colors[0] || 'var(--chart-1)'
  const stroke = colors[1] || colors[0] || 'var(--chart-1)'
  const showGrid = spec.showGrid !== false

  const grid = showGrid
    ? React.createElement(CartesianGrid, {
        key: 'grid',
        vertical: false,
        strokeDasharray: '3 3',
        stroke: 'var(--dreambyte-recharts-grid, rgba(255,255,255,0.08))',
      })
    : null

  const xAxis = React.createElement(XAxis, {
    key: 'x',
    dataKey: cat,
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    tick: { fill: 'var(--dreambyte-recharts-tick, rgba(232,228,220,0.65))', fontSize: 12 },
  })

  const yAxis = React.createElement(YAxis, {
    key: 'y',
    tickLine: false,
    axisLine: false,
    width: 44,
    tick: { fill: 'var(--dreambyte-recharts-tick, rgba(232,228,220,0.65))', fontSize: 12 },
  })

  const tooltip = React.createElement(Tooltip, {
    key: 'tip',
    contentStyle: {
      background: 'rgba(18,18,22,0.96)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8,
      fontSize: 12,
    },
    labelStyle: { color: 'rgba(232,228,220,0.9)' },
    itemStyle: { color: 'rgba(232,228,220,0.95)' },
  })

  const variant = spec.variant === 'line' || spec.variant === 'area' ? spec.variant : 'bar'

  const margin = { top: 8, right: 12, left: 4, bottom: 4 }
  const baseKids = [grid, xAxis, yAxis, tooltip].filter(Boolean)

  let chartInner
  if (variant === 'line') {
    chartInner = React.createElement(
      LineChart,
      { data, margin },
      ...baseKids,
      React.createElement(Line, {
        key: 'series',
        type: 'monotone',
        dataKey: val,
        stroke,
        strokeWidth: 2,
        dot: { r: 3, fill: stroke },
      }),
    )
  } else if (variant === 'area') {
    chartInner = React.createElement(
      AreaChart,
      { data, margin },
      ...baseKids,
      React.createElement(Area, {
        key: 'series',
        type: 'monotone',
        dataKey: val,
        fill: stroke,
        fillOpacity: 0.22,
        stroke,
        strokeWidth: 2,
      }),
    )
  } else {
    chartInner = React.createElement(
      BarChart,
      { data, margin },
      ...baseKids,
      React.createElement(Bar, {
        key: 'series',
        dataKey: val,
        fill,
        radius: [4, 4, 0, 0],
      }),
    )
  }

  const chartWrap = React.createElement(
    ResponsiveContainer,
    { width: '100%', height: '100%' },
    chartInner,
  )

  const title =
    spec.title &&
    React.createElement(
      'div',
      {
        style: {
          flexShrink: 0,
          padding: '6px 10px 4px',
          fontSize: Math.min(28, Math.max(14, (spec.titleSize && Number(spec.titleSize)) || 22)),
          fontWeight: 700,
          color: 'var(--dreambyte-recharts-title, rgba(240,236,224,0.95))',
          lineHeight: 1.2,
        },
      },
      String(spec.title),
    )

  return React.createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        minHeight: 80,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--dreambyte-font, system-ui, sans-serif)',
      },
    },
    title,
    React.createElement('div', { style: { flex: 1, minHeight: 0 } }, chartWrap),
  )
}

export async function mountDreambyteRechartsLayers() {
  const [React, dom, Recharts] = await Promise.all([
    import(REACT_SRC),
    import(REACT_DOM_SRC),
    import(RECHARTS_SRC),
  ])
  const { createRoot } = dom
  const roots = []
  document.querySelectorAll('[data-dreambyte-recharts]').forEach((host) => {
    const specEl = host.querySelector('script[type="application/json"].dreambyte-recharts-json')
    if (!specEl || !specEl.textContent) return
    let spec
    try {
      spec = JSON.parse(specEl.textContent)
    } catch (e) {
      console.warn('[dreambyte-recharts] bad spec', e)
      return
    }
    try {
      const root = createRoot(host)
      root.render(buildTree(React, Recharts, spec))
      roots.push(root)
    } catch (e) {
      console.warn('[dreambyte-recharts] mount failed', e)
    }
  })
  return roots
}
