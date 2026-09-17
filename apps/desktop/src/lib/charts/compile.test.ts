import { describe, it, expect } from 'vitest'

import { compileD3SceneFromLayers } from './compile'
import type { D3ChartLayer } from '@/lib/types'

// Security review F17: chart data/config is inlined into an inline <script>.
// A `</script>` substring in user data must be escaped, or it closes the tag
// early — breaking the scene and opening an injection vector.
describe('compileD3SceneFromLayers — <script> escaping', () => {
  const makeLayer = (over: Partial<D3ChartLayer>): D3ChartLayer =>
    ({
      id: 'chart-1',
      name: 'Chart',
      chartType: 'bar',
      data: [],
      config: {},
      layout: { x: 0, y: 0, width: 100, height: 100 },
      ...over,
    }) as D3ChartLayer

  it('escapes </script> appearing in chart data', () => {
    const { sceneCode } = compileD3SceneFromLayers([
      makeLayer({ data: [{ label: '</script><img src=x onerror=alert(1)>', value: 1 }] }),
    ])
    expect(sceneCode).not.toContain('</script>')
    expect(sceneCode).toContain('\\u003c/script>')
  })

  it('escapes </script> in plotly traces/config', () => {
    const { sceneCode } = compileD3SceneFromLayers([
      makeLayer({ chartType: 'plotly', data: [{ x: '</script>', y: 2 }] }),
    ])
    expect(sceneCode).not.toContain('</script>')
  })

  it('escapes </script> in recharts spec', () => {
    const { sceneCode } = compileD3SceneFromLayers([
      makeLayer({ chartType: 'recharts', data: [{ label: '</script>', value: 3 }] }),
    ])
    expect(sceneCode).not.toContain('</script>')
  })
})
