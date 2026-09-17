/**
 * Layer reducer.
 *
 * Operates on `Scene.aiLayers`. Only the deterministic `add` / `update` /
 * `remove` actions exist; LLM-driven regeneration doesn't go through here.
 */

import type { Action, ActionResult, ProjectState, LayerAddAction, LayerUpdateAction, LayerRemoveAction } from '../types'
import { validateId, validateExists, validateNoIdPatch, validateRange } from '../validators/_shared'

function applyToScene(
  state: ProjectState,
  sceneId: string,
  fn: (scene: ProjectState['scenes'][number]) => ProjectState['scenes'][number],
): ProjectState {
  return {
    ...state,
    scenes: state.scenes.map((s) => (s.id === sceneId ? { ...fn(s), updatedAt: Date.now() } : s)),
    project: { ...state.project, updatedAt: new Date().toISOString() },
  }
}

function checkLayerLock(state: ProjectState, layerId: string, action: Action): ActionResult | null {
  if (action.source === 'agent' && state.uiEditingLayerId === layerId) {
    return {
      success: false,
      error: {
        code: 'LAYER_EDITING',
        message: `Layer ${layerId} is currently being edited by the user`,
        suggestion: 'Wait for the user to finish editing, or pick a different layer.',
      },
    }
  }
  return null
}

export function reduceLayerAdd(state: ProjectState, action: LayerAddAction): ActionResult {
  const { sceneId, layerId, layer, position } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const layerIdErr = validateId(layerId, 'layerId')
  if (layerIdErr) return { success: false, error: layerIdErr }
  const sceneErr = validateExists(state, sceneId, 'scene')
  if (sceneErr) return { success: false, error: sceneErr }
  if (layer.id !== layerId) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'layer.id must match params.layerId' },
    }
  }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const aiLayers = scene.aiLayers ?? []
  if (aiLayers.some((l) => l.id === layerId)) {
    return {
      success: false,
      error: { code: 'DUPLICATE_ID', message: `Layer ${layerId} already exists in scene ${sceneId}` },
    }
  }
  if (typeof position === 'number') {
    const r = validateRange(position, 0, aiLayers.length, 'position')
    if (r) return { success: false, error: r }
  }

  const idx = typeof position === 'number' ? position : aiLayers.length
  const newLayers = [...aiLayers.slice(0, idx), layer, ...aiLayers.slice(idx)]

  const inverse: LayerRemoveAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'layer/remove',
    params: { sceneId, layerId, prior: { layer, index: idx } },
  }

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, aiLayers: newLayers })),
    inverseAction: inverse,
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

export function reduceLayerUpdate(state: ProjectState, action: LayerUpdateAction): ActionResult {
  const { sceneId, layerId, patch } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const layerIdErr = validateId(layerId, 'layerId')
  if (layerIdErr) return { success: false, error: layerIdErr }
  const noIdErr = validateNoIdPatch(patch as Record<string, unknown>)
  if (noIdErr) return { success: false, error: noIdErr }
  const sceneErr = validateExists(state, sceneId, 'scene')
  if (sceneErr) return { success: false, error: sceneErr }
  const layerErr = validateExists(state, layerId, 'layer', sceneId)
  if (layerErr) return { success: false, error: layerErr }

  const lockErr = checkLayerLock(state, layerId, action)
  if (lockErr) return lockErr

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const target = scene.aiLayers!.find((l) => l.id === layerId)!
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = (target as unknown as Record<string, unknown>)[k]
  }

  const newLayers = scene.aiLayers!.map((l) => (l.id === layerId ? ({ ...l, ...patch } as typeof l) : l))

  const inverse: LayerUpdateAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'layer/update',
    params: { sceneId, layerId, patch: prior as Partial<typeof target> },
  }

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, aiLayers: newLayers })),
    inverseAction: inverse,
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

export function reduceLayerRemove(state: ProjectState, action: LayerRemoveAction): ActionResult {
  const { sceneId, layerId } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const layerIdErr = validateId(layerId, 'layerId')
  if (layerIdErr) return { success: false, error: layerIdErr }
  const sceneErr = validateExists(state, sceneId, 'scene')
  if (sceneErr) return { success: false, error: sceneErr }

  const lockErr = checkLayerLock(state, layerId, action)
  if (lockErr) return lockErr

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const idx = (scene.aiLayers ?? []).findIndex((l) => l.id === layerId)
  if (idx === -1) {
    return {
      success: false,
      error: { code: 'LAYER_NOT_FOUND', message: `Layer ${layerId} not found in scene ${sceneId}` },
    }
  }
  const removed = scene.aiLayers![idx]
  const newLayers = scene.aiLayers!.filter((l) => l.id !== layerId)

  const inverse: LayerAddAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'layer/add',
    params: { sceneId, layerId, layer: removed, position: idx },
  }

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, aiLayers: newLayers })),
    inverseAction: inverse,
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}
