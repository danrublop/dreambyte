import { v4 as uuidv4 } from 'uuid'
import type { Scene } from '@/lib/types'
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { clearStaleCodeFields } from '@/lib/agents/tool-executor'
import { compileD3SceneFromLayers } from '@/lib/charts/compile'
import { deriveChartLayersFromScene } from '@/lib/charts/extract'
import { autoGridChartLayoutsForLayers, isDreambyteChartType } from '@/lib/charts/structured-d3'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'

/**
 * P1b-fanout-remaining (charts): emit `scene/update` for the
 * recompile-and-replace patches that chart tools apply (sceneType,
 * sceneCode, sceneStyles, d3Data, chartLayers swept together).
 */
function emitChartSceneUpdate(world: WorldStateMutable, sceneId: string, patch: Partial<Scene>, prior: Partial<Scene>) {
  emitAgentAction({ type: 'scene/update', params: { sceneId, patch, prior } }, emitterDeps(world))
}

// remove_chart was deleted from ALL_TOOLS (remove_layer carries the same D3
// chart-layer branch keyed on the same ids). Its handler had no schema and no
// internal caller, so it is gone too.
// chart(op) is the MODEL-facing name; the switch below still dispatches on the three
// original internal op names, which the router at the top of the handler maps to.
export const CHART_TOOL_NAMES = ['chart'] as const

// ── Factory ──────────────────────────────────────────────────────────────────

export function createChartToolHandler(deps: {
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  return async function handleChartTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    // chart(op) → the internal op names the switch below already dispatches on.
    // Same shape as find_media(kind) / scene_props(op): the merged tool runs the
    // ORIGINAL handler body, so nothing about chart authoring changed.
    const CHART_OPS: Record<string, string> = {
      create: 'generate_chart',
      update: 'update_chart',
      reorder: 'reorder_charts',
    }
    let op = toolName
    if (toolName === 'chart') {
      const requested = ((args as { op?: string }).op ?? 'create') as string
      const mapped = CHART_OPS[requested]
      if (!mapped) {
        return { success: false, error: `chart: unknown op "${requested}" — expected create, update or reorder.` }
      }
      op = mapped
    }

    switch (op) {
      // ── generate_chart ───────────────────────────────────────────────────

      case 'generate_chart': {
        const {
          sceneId,
          chartType,
          data: chartData,
          config: chartConfig,
          animated,
          name: chartName,
          layout: chartLayout,
        } = args as {
          sceneId: string
          chartType: string
          data: unknown
          config?: Record<string, unknown>
          animated?: boolean
          name?: string
          layout?: { x?: number; y?: number; width?: number; height?: number }
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        if (!isDreambyteChartType(chartType)) {
          return err(
            `Invalid chartType "${chartType}". Use a structured preset (including plotly/funnel) or add_layer(d3) for custom code.`,
          )
        }

        const lay = chartLayout || {}
        const chartLayer = {
          id: uuidv4(),
          name:
            typeof chartName === 'string' && chartName.trim() ? chartName.trim().slice(0, 120) : `${chartType} chart`,
          chartType,
          data: chartData,
          config: (chartConfig || {}) as Record<string, unknown>,
          layout: {
            x: typeof lay.x === 'number' && Number.isFinite(lay.x) ? lay.x : 5,
            y: typeof lay.y === 'number' && Number.isFinite(lay.y) ? lay.y : 10,
            width: typeof lay.width === 'number' && Number.isFinite(lay.width) ? lay.width : 90,
            height: typeof lay.height === 'number' && Number.isFinite(lay.height) ? lay.height : 80,
          },
          timing: { startAt: 0, duration: Math.max(0.5, scene.duration || 8), animated: !!animated },
        }
        const existingLayers = deriveChartLayersFromScene(scene as Scene)
        let nextLayers = [...existingLayers, chartLayer] as any
        if (nextLayers.length >= 2 && nextLayers.length <= 4) {
          nextLayers = autoGridChartLayoutsForLayers(nextLayers as any) as any
        }
        const compiled = compileD3SceneFromLayers(nextLayers)

        const staleClears = clearStaleCodeFields('d3')
        const generatePatch = {
          ...staleClears,
          sceneType: 'd3' as const,
          sceneCode: compiled.sceneCode,
          sceneStyles: '',
          d3Data: compiled.d3Data,
          chartLayers: nextLayers,
        }
        const generatePrior: Partial<Scene> = {
          sceneType: scene.sceneType,
          sceneCode: scene.sceneCode,
          sceneStyles: scene.sceneStyles,
          d3Data: scene.d3Data,
          chartLayers: scene.chartLayers,
        }
        updateScene(world, sceneId, generatePatch)
        emitChartSceneUpdate(world, sceneId, generatePatch, generatePrior)

        await deps.regenerateHTML(world, sceneId, logger)
        return {
          success: true,
          affectedSceneId: sceneId,
          changes: [
            { type: 'scene_updated', sceneId, description: `Added ${chartType} chart${animated ? ' (animated)' : ''}` },
          ],
          data: { chartType, animated: !!animated, chartCount: nextLayers.length },
        }
      }

      // ── update_chart ─────────────────────────────────────────────────────

      case 'update_chart': {
        const {
          sceneId,
          chartId,
          chartType,
          data: patchData,
          config: patchConfig,
          layout: patchLayout,
          timing: patchTiming,
          name: patchName,
          animated,
        } = args as {
          sceneId: string
          chartId: string
          chartType?: string
          data?: unknown
          config?: Record<string, unknown>
          layout?: { x?: number; y?: number; width?: number; height?: number }
          timing?: { startAt?: number; duration?: number }
          name?: string
          animated?: boolean
        }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        const layers = deriveChartLayersFromScene(scene as Scene)
        const idx = layers.findIndex((c) => c.id === chartId)
        if (idx < 0) return err(`Chart ${chartId} not found in scene`)

        const cur = layers[idx]
        let nextLayer = { ...cur }
        if (typeof patchName === 'string' && patchName.trim()) {
          nextLayer = { ...nextLayer, name: patchName.trim().slice(0, 120) }
        }
        if (chartType !== undefined && chartType !== null && String(chartType).length > 0) {
          const ct = String(chartType)
          if (!isDreambyteChartType(ct)) return err(`Invalid chartType "${ct}"`)
          nextLayer = { ...nextLayer, chartType: ct as any }
        }
        if (patchData !== undefined) nextLayer = { ...nextLayer, data: patchData }
        if (patchConfig && typeof patchConfig === 'object' && !Array.isArray(patchConfig)) {
          nextLayer = { ...nextLayer, config: { ...cur.config, ...patchConfig } }
        }
        if (patchLayout && typeof patchLayout === 'object') {
          const pl = patchLayout
          nextLayer = {
            ...nextLayer,
            layout: {
              x: typeof pl.x === 'number' && Number.isFinite(pl.x) ? pl.x : cur.layout.x,
              y: typeof pl.y === 'number' && Number.isFinite(pl.y) ? pl.y : cur.layout.y,
              width: typeof pl.width === 'number' && Number.isFinite(pl.width) ? pl.width : cur.layout.width,
              height: typeof pl.height === 'number' && Number.isFinite(pl.height) ? pl.height : cur.layout.height,
            },
          }
        }
        if (patchTiming && typeof patchTiming === 'object') {
          const pt = patchTiming
          nextLayer = {
            ...nextLayer,
            timing: {
              startAt: typeof pt.startAt === 'number' && Number.isFinite(pt.startAt) ? pt.startAt : cur.timing.startAt,
              duration:
                typeof pt.duration === 'number' && Number.isFinite(pt.duration) && pt.duration > 0
                  ? pt.duration
                  : cur.timing.duration,
              animated: cur.timing.animated,
            },
          }
        }
        if (typeof animated === 'boolean') {
          nextLayer = { ...nextLayer, timing: { ...nextLayer.timing, animated } }
        }

        const nextLayers = [...layers]
        nextLayers[idx] = nextLayer
        const compiled = compileD3SceneFromLayers(nextLayers)
        const staleClears = clearStaleCodeFields('d3')
        const updatePatch = {
          ...staleClears,
          sceneType: 'd3' as const,
          sceneCode: compiled.sceneCode,
          sceneStyles: '',
          d3Data: compiled.d3Data,
          chartLayers: nextLayers,
        }
        const updatePrior: Partial<Scene> = {
          sceneType: scene.sceneType,
          sceneCode: scene.sceneCode,
          sceneStyles: scene.sceneStyles,
          d3Data: scene.d3Data,
          chartLayers: scene.chartLayers,
        }
        updateScene(world, sceneId, updatePatch)
        emitChartSceneUpdate(world, sceneId, updatePatch, updatePrior)
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, `Updated chart ${chartId}`, { chartId })
      }

      // ── reorder_charts ───────────────────────────────────────────────────

      case 'reorder_charts': {
        const { sceneId, orderedChartIds } = args as { sceneId: string; orderedChartIds: string[] }
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)
        if (!Array.isArray(orderedChartIds) || orderedChartIds.length === 0) {
          return err('orderedChartIds must be a non-empty array of chart layer ids')
        }
        const layers = deriveChartLayersFromScene(scene as Scene)
        if (layers.length === 0) return err('No charts in this scene to reorder')
        const map = new Map(layers.map((l) => [l.id, l]))
        if (orderedChartIds.length !== layers.length) {
          return err(`orderedChartIds length (${orderedChartIds.length}) must match chart count (${layers.length})`)
        }
        const nextLayers: typeof layers = []
        const seen = new Set<string>()
        for (const id of orderedChartIds) {
          if (seen.has(id)) return err(`Duplicate chart id in orderedChartIds: ${id}`)
          const L = map.get(id)
          if (!L) return err(`Unknown chart id "${id}" — use ids from context chartLayers`)
          nextLayers.push(L)
          seen.add(id)
        }
        const compiled = compileD3SceneFromLayers(nextLayers)
        const staleClears = clearStaleCodeFields('d3')
        const reorderPatch = {
          ...staleClears,
          sceneType: 'd3' as const,
          sceneCode: compiled.sceneCode,
          sceneStyles: '',
          d3Data: compiled.d3Data,
          chartLayers: nextLayers,
        }
        const reorderPrior: Partial<Scene> = {
          sceneType: scene.sceneType,
          sceneCode: scene.sceneCode,
          sceneStyles: scene.sceneStyles,
          d3Data: scene.d3Data,
          chartLayers: scene.chartLayers,
        }
        updateScene(world, sceneId, reorderPatch)
        emitChartSceneUpdate(world, sceneId, reorderPatch, reorderPrior)
        await deps.regenerateHTML(world, sceneId, logger)
        return ok(sceneId, 'Reordered charts', { order: nextLayers.map((c) => c.id) })
      }

      default:
        return err(`Unknown chart tool: ${toolName}`)
    }
  }
}
