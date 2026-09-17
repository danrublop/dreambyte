import type { Scene } from '@/lib/types'
import { compileD3SceneFromLayers } from '@/lib/charts/compile'

function autoGridLayouts(layers: any[]): any[] {
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
  return layers.map((l, i) => ({ ...l, layout: presets[i] ?? l.layout }))
}

export function normalizeScenesForPersistence(scenes: Scene[]): Scene[] {
  return (scenes || []).map((scene) => {
    if (scene.sceneType !== 'd3') {
      return { ...scene, chartLayers: [], d3Data: null }
    }
    const layers = Array.isArray(scene.chartLayers) ? scene.chartLayers : []
    if (layers.length === 0) return scene
    const normalizedLayers = layers.length <= 4 ? autoGridLayouts(layers as any) : layers
    const compiled = compileD3SceneFromLayers(normalizedLayers as any)
    return {
      ...scene,
      chartLayers: normalizedLayers as any,
      sceneCode: compiled.sceneCode,
      d3Data: compiled.d3Data as any,
    }
  })
}
