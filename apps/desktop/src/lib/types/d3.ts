export type D3ChartType =
  | 'bar'
  | 'horizontalBar'
  | 'stackedBar'
  | 'groupedBar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'number'
  | 'gauge'
  | 'funnel'
  /** Plotly.js figure: `data` is `{ traces: [...] }` (or traces-only array); use `config.plotlyLayout` / `config.plotlyConfig`. */
  | 'plotly'
  /** shadcn-style Recharts in scene HTML (bar | line | area via `config.rechartsVariant`). */
  | 'recharts'

export interface D3ChartLayer {
  id: string
  name: string
  chartType: D3ChartType
  data: unknown
  config: Record<string, unknown>
  layout: {
    x: number
    y: number
    width: number
    height: number
  }
  timing: {
    startAt: number
    duration: number
    animated: boolean
  }
}
