// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createChartToolHandler } from './chart-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Scene, GlobalStyle, SceneGraph, D3ChartLayer } from '@/lib/types'

/**
 * Direct coverage for chart-tools mutations: generate / update / remove /
 * reorder. The D3 compilation pipeline is exercised end-to-end (no mocks);
 * the test asserts the in-memory chartLayers + sceneType + sceneCode shape
 * after each call. The action-emit side-effect is covered separately by
 * `action-emitter.test.ts`.
 */

function makeScene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    name: id,
    sceneType: 'react',
    durationSeconds: 5,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    chartLayers: [],
    sceneCode: '',
    sceneStyles: '',
    d3Data: null,
    duration: 8,
    ...overrides,
  } as Scene
}

function makeWorld(scenes: Scene[]): WorldStateMutable {
  return {
    scenes,
    globalStyle: {} as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scenes[0]?.id ?? null } as SceneGraph,
  } as unknown as WorldStateMutable
}

const handler = createChartToolHandler({
  regenerateHTML: async () => ({ htmlWritten: true }),
})

const barData = [
  { label: 'A', value: 10 },
  { label: 'B', value: 20 },
  { label: 'C', value: 30 },
]

describe('chart-tools — mutation sites', () => {
  it('generate_chart adds a layer, flips sceneType to d3, and writes sceneCode', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler(
      'generate_chart',
      { sceneId: 's1', chartType: 'bar', data: barData, animated: true },
      world,
    )
    expect(result.success).toBe(true)
    const scene = world.scenes[0]
    expect(scene.sceneType).toBe('d3')
    expect(scene.chartLayers!.length).toBe(1)
    expect(scene.chartLayers![0].chartType).toBe('bar')
    expect(scene.sceneCode.length).toBeGreaterThan(0)
  })

  it('generate_chart rejects unknown chartType', async () => {
    const world = makeWorld([makeScene('s1')])
    const result = await handler('generate_chart', { sceneId: 's1', chartType: 'flamingo', data: barData }, world)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid chartType')
  })

  it('update_chart patches a single chart in place', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('generate_chart', { sceneId: 's1', chartType: 'bar', data: barData, name: 'orig' }, world)
    const chartId = world.scenes[0].chartLayers![0].id
    const result = await handler('update_chart', { sceneId: 's1', chartId, name: 'renamed', animated: true }, world)
    expect(result.success).toBe(true)
    const updated = world.scenes[0].chartLayers!.find((c) => c.id === chartId) as D3ChartLayer
    expect(updated.name).toBe('renamed')
    expect(updated.timing.animated).toBe(true)
  })

  it('update_chart errors on unknown chartId', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('generate_chart', { sceneId: 's1', chartType: 'bar', data: barData }, world)
    const result = await handler('update_chart', { sceneId: 's1', chartId: 'nope', name: 'x' }, world)
    expect(result.success).toBe(false)
  })

  it('reorder_charts rearranges the layer order', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('generate_chart', { sceneId: 's1', chartType: 'bar', data: barData, name: 'a' }, world)
    await handler('generate_chart', { sceneId: 's1', chartType: 'pie', data: barData, name: 'b' }, world)
    await handler('generate_chart', { sceneId: 's1', chartType: 'line', data: barData, name: 'c' }, world)
    const [a, b, c] = world.scenes[0].chartLayers!.map((l) => l.id)
    const result = await handler('reorder_charts', { sceneId: 's1', orderedChartIds: [c, a, b] }, world)
    expect(result.success).toBe(true)
    expect(world.scenes[0].chartLayers!.map((l) => l.id)).toEqual([c, a, b])
  })

  it('reorder_charts errors on length mismatch', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('generate_chart', { sceneId: 's1', chartType: 'bar', data: barData }, world)
    await handler('generate_chart', { sceneId: 's1', chartType: 'pie', data: barData }, world)
    const result = await handler(
      'reorder_charts',
      { sceneId: 's1', orderedChartIds: [world.scenes[0].chartLayers![0].id] },
      world,
    )
    expect(result.success).toBe(false)
  })

  it('reorder_charts errors on unknown id in the list', async () => {
    const world = makeWorld([makeScene('s1')])
    await handler('generate_chart', { sceneId: 's1', chartType: 'bar', data: barData }, world)
    await handler('generate_chart', { sceneId: 's1', chartType: 'pie', data: barData }, world)
    const ids = world.scenes[0].chartLayers!.map((l) => l.id)
    const result = await handler('reorder_charts', { sceneId: 's1', orderedChartIds: [ids[0], 'unknown'] }, world)
    expect(result.success).toBe(false)
  })

  it('returns an error when sceneId does not exist', async () => {
    const world = makeWorld([makeScene('s1')])
    for (const tool of ['generate_chart', 'update_chart', 'reorder_charts']) {
      const result = await handler(
        tool,
        { sceneId: 'unknown', chartType: 'bar', data: barData, chartId: 'x', orderedChartIds: ['x'] },
        world,
      )
      expect(result.success).toBe(false)
    }
  })
})
