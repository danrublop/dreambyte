/**
 * Interaction reducer.
 *
 * Operates on `Scene.interactions: InteractionElement[]`. Hotspots /
 * tooltips / choices / quizzes / gates / forms. The reducer is shape-
 * agnostic — it treats the union as opaque and lets the discriminated
 * union's `type` survive untouched.
 */

import type {
  ActionResult,
  ProjectState,
  InteractionAddAction,
  InteractionUpdateAction,
  InteractionRemoveAction,
} from '../types'
import type { InteractionElement, Scene } from '@/lib/types'
import { validateId, validateExists, validateNoIdPatch, validateRange } from '../validators/_shared'

function applyToScene(state: ProjectState, sceneId: string, fn: (scene: Scene) => Scene): ProjectState {
  return {
    ...state,
    scenes: state.scenes.map((s) => (s.id === sceneId ? { ...fn(s), updatedAt: Date.now() } : s)),
    project: { ...state.project, updatedAt: new Date().toISOString() },
  }
}

export function reduceInteractionAdd(state: ProjectState, action: InteractionAddAction): ActionResult {
  const { sceneId, interactionId, interaction, position } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const idErr = validateId(interactionId, 'interactionId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }
  if (interaction.id !== interactionId) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'interaction.id must match params.interactionId' },
    }
  }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  if (scene.interactions.some((i) => i.id === interactionId)) {
    return {
      success: false,
      error: { code: 'DUPLICATE_ID', message: `Interaction ${interactionId} already on scene ${sceneId}` },
    }
  }
  if (typeof position === 'number') {
    const r = validateRange(position, 0, scene.interactions.length, 'position')
    if (r) return { success: false, error: r }
  }

  const idx = typeof position === 'number' ? position : scene.interactions.length
  const next = [...scene.interactions.slice(0, idx), interaction, ...scene.interactions.slice(idx)]

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, interactions: next })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'interaction/remove',
      params: { sceneId, interactionId, prior: { interaction, index: idx } },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

export function reduceInteractionUpdate(state: ProjectState, action: InteractionUpdateAction): ActionResult {
  const { sceneId, interactionId, patch } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const idErr = validateId(interactionId, 'interactionId')
  if (idErr) return { success: false, error: idErr }
  const noIdErr = validateNoIdPatch(patch as Record<string, unknown>)
  if (noIdErr) return { success: false, error: noIdErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const target = scene.interactions.find((i) => i.id === interactionId)
  if (!target) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: `Interaction ${interactionId} not on scene ${sceneId}` },
    }
  }

  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = (target as unknown as Record<string, unknown>)[k]
  }

  const next = scene.interactions.map((i) => (i.id === interactionId ? ({ ...i, ...patch } as InteractionElement) : i))

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, interactions: next })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'interaction/update',
      params: { sceneId, interactionId, patch: prior as Partial<InteractionElement>, prior: patch },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}

export function reduceInteractionRemove(state: ProjectState, action: InteractionRemoveAction): ActionResult {
  const { sceneId, interactionId } = action.params

  const sceneIdErr = validateId(sceneId, 'sceneId')
  if (sceneIdErr) return { success: false, error: sceneIdErr }
  const idErr = validateId(interactionId, 'interactionId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }

  const scene = state.scenes.find((s) => s.id === sceneId)!
  const idx = scene.interactions.findIndex((i) => i.id === interactionId)
  if (idx === -1) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: `Interaction ${interactionId} not on scene ${sceneId}` },
    }
  }
  const removed = scene.interactions[idx]
  const next = scene.interactions.filter((i) => i.id !== interactionId)

  return {
    success: true,
    state: applyToScene(state, sceneId, (s) => ({ ...s, interactions: next })),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'interaction/add',
      params: { sceneId, interactionId, interaction: removed, position: idx },
    },
    effects: [{ kind: 'regenerate-scene-html', sceneId }, { kind: 'schedule-project-save' }],
  }
}
