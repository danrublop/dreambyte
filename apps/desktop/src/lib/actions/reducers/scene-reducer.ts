/**
 * Scene reducer.
 *
 * Pure functions: `(state, action) → ActionResult` with explicit inverse.
 * No mutation. State input must already be frozen by the executor.
 *
 * Inverses:
 *   create  ↔ delete (with index)
 *   update  ↔ update (with prior patch)
 *   delete  → agent/applyRun snapshot (restores scene + dependent timeline
 *             clips + scene-graph edges atomically — a coherent world)
 *   reorder ↔ reorder (swapped)
 */

import type {
  Action,
  ActionResult,
  ProjectState,
  SceneCreateAction,
  SceneUpdateAction,
  SceneDeleteAction,
  SceneReorderAction,
  AgentApplyRunAction,
} from '../types'
import { validateId, validateExists, validateNoIdPatch, validateRange } from '../validators/_shared'
import { makeSceneClipCascadeFilter } from './scene-clip-cascade'

function pickPrior(scene: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const prior: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    prior[key] = scene[key]
  }
  return prior
}

function nextProjectTimestamp(state: ProjectState): ProjectState['project'] {
  return { ...state.project, updatedAt: new Date(action_now()).toISOString() }
}

// Action timestamps come from the dispatcher; reducers consult Date.now()
// only for the project's `updatedAt` projection. Centralised so tests can
// stub if needed.
function action_now(): number {
  return Date.now()
}

export function reduceSceneCreate(state: ProjectState, action: SceneCreateAction): ActionResult {
  const { sceneId, position, scene } = action.params

  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }
  if (state.scenes.some((s) => s.id === sceneId)) {
    return { success: false, error: { code: 'DUPLICATE_ID', message: `Scene ${sceneId} already exists` } }
  }
  if (typeof position === 'number') {
    const r = validateRange(position, 0, state.scenes.length, 'position')
    if (r) return { success: false, error: r }
  }
  if (!scene || scene.id !== sceneId) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'scene.id must match params.sceneId' },
    }
  }

  const idx = typeof position === 'number' ? position : state.scenes.length
  const insert = scene as ProjectState['scenes'][number]
  const newScenes = [...state.scenes.slice(0, idx), insert, ...state.scenes.slice(idx)]

  const inverse: SceneDeleteAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'scene/delete',
    params: { sceneId, prior: { scene: insert, index: idx } },
  }

  return {
    success: true,
    state: {
      ...state,
      scenes: newScenes,
      project: nextProjectTimestamp(state),
    },
    inverseAction: inverse,
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceSceneUpdate(state: ProjectState, action: SceneUpdateAction): ActionResult {
  const { sceneId, patch } = action.params

  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }
  const existsErr = validateExists(state, sceneId, 'scene')
  if (existsErr) return { success: false, error: existsErr }
  const noIdErr = validateNoIdPatch(patch as Record<string, unknown>)
  if (noIdErr) return { success: false, error: noIdErr }

  const target = state.scenes.find((s) => s.id === sceneId)!
  const prior = pickPrior(target as unknown as Record<string, unknown>, patch as Record<string, unknown>)

  const newScenes = state.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch, updatedAt: action_now() } : s))

  const inverse: SceneUpdateAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'scene/update',
    params: { sceneId, patch: prior as Partial<ProjectState['scenes'][number]> },
  }

  // Patches that touch generated code or worldConfig need the HTML
  // regenerated downstream. The reducer itself stays pure; the runtime's
  // effect-runner picks this up.
  const codeKeys = ['sceneCode', 'svgContent', 'canvasCode', 'reactCode', 'sceneHTML', 'worldConfig', 'aiLayers']
  const touchesCode = Object.keys(patch).some((k) => codeKeys.includes(k))

  return {
    success: true,
    state: {
      ...state,
      scenes: newScenes,
      project: nextProjectTimestamp(state),
    },
    inverseAction: inverse,
    effects: [
      ...(touchesCode ? [{ kind: 'regenerate-scene-html' as const, sceneId }] : []),
      { kind: 'schedule-project-save' as const },
    ],
  }
}

/**
 * scene/delete — cascade-safe delete.
 *
 * Removing a scene must leave a COHERENT world: the scene itself, the timeline
 * clips that reference it (the scene clip + the audio clips derived from the
 * scene's audioLayer), and its scene-graph nodes/edges all go together.
 * Splicing `state.scenes` alone (the old behavior) left dangling timeline clips
 * and graph edges, and the old `scene/create` inverse could only restore the
 * scene — never the clips/edges — so undo produced an incoherent world.
 *
 * The dependent-clip rule is SHARED with `clip/remove`'s scene path via
 * `makeSceneClipCascadeFilter`, so deleting a scene directly and deleting its
 * scene clip leave the timeline in an identical state (scene clip + derived
 * audio + avatar clips all go). The inverse is an `agent/applyRun` full-state
 * snapshot (same idiom clip/remove uses) so a single Cmd+Z restores scene +
 * clips + graph atomically.
 */
export function reduceSceneDelete(state: ProjectState, action: SceneDeleteAction): ActionResult {
  const { sceneId } = action.params

  const idErr = validateId(sceneId, 'sceneId')
  if (idErr) return { success: false, error: idErr }

  const idx = state.scenes.findIndex((s) => s.id === sceneId)
  if (idx === -1) {
    return { success: false, error: { code: 'SCENE_NOT_FOUND', message: `Scene ${sceneId} not found` } }
  }

  // Snapshot the full prior state for the inverse, BEFORE any mutation.
  const priorScenes = state.scenes
  const priorGlobalStyle = state.globalStyle
  const priorSceneGraph = state.project.sceneGraph
  const priorTimeline = state.project.timeline ?? null

  const removed = state.scenes[idx]
  const newScenes = state.scenes.filter((s) => s.id !== sceneId)
  const newSelected = state.selectedSceneId === sceneId ? (newScenes[0]?.id ?? null) : state.selectedSceneId

  // Scene-graph: drop the node + any edge touching it, and re-home the start
  // node if it was the deleted scene.
  const graph = state.project.sceneGraph
  const newGraph = {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== sceneId),
    edges: graph.edges.filter((e) => e.fromSceneId !== sceneId && e.toSceneId !== sceneId),
    startSceneId: graph.startSceneId === sceneId ? (newScenes[0]?.id ?? '') : graph.startSceneId,
  }

  // Timeline: drop every clip that depends on the scene (scene clip + derived
  // audio + avatar clips). Shared filter keeps this identical to clip/remove.
  const isDependentClip = makeSceneClipCascadeFilter(sceneId, removed)
  const timeline = state.project.timeline
  const newTimeline = timeline
    ? {
        ...timeline,
        tracks: timeline.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => !isDependentClip(c)),
        })),
      }
    : timeline

  // Inverse: full prior-state snapshot. agent/applyRun restores scenes +
  // globalStyle + sceneGraph + timeline together, so undo is coherent.
  const inverse: AgentApplyRunAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'agent/applyRun',
    params: {
      scenes: priorScenes,
      globalStyle: priorGlobalStyle,
      sceneGraph: priorSceneGraph,
      timeline: priorTimeline,
    },
  }

  return {
    success: true,
    state: {
      ...state,
      scenes: newScenes,
      selectedSceneId: newSelected,
      project: {
        ...state.project,
        sceneGraph: newGraph,
        ...(timeline ? { timeline: newTimeline } : {}),
        updatedAt: new Date(action_now()).toISOString(),
      },
    },
    inverseAction: inverse,
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceSceneReorder(state: ProjectState, action: SceneReorderAction): ActionResult {
  const { fromIndex, toIndex } = action.params

  const fromErr = validateRange(fromIndex, 0, Math.max(0, state.scenes.length - 1), 'fromIndex')
  if (fromErr) return { success: false, error: fromErr }
  const toErr = validateRange(toIndex, 0, Math.max(0, state.scenes.length - 1), 'toIndex')
  if (toErr) return { success: false, error: toErr }

  if (fromIndex === toIndex) {
    // No-op; still emit success so the caller / WAL records the intent
    return {
      success: true,
      state,
      inverseAction: { ...action, id: `inv-${action.id}`, source: 'replay' } as Action,
      effects: [],
    }
  }

  const scenes = [...state.scenes]
  const [removed] = scenes.splice(fromIndex, 1)
  scenes.splice(toIndex, 0, removed)

  // Inverse swaps endpoints. After moving from→to, the reverse goes to→from.
  const inverse: SceneReorderAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'scene/reorder',
    params: { fromIndex: toIndex, toIndex: fromIndex },
  }

  return {
    success: true,
    state: {
      ...state,
      scenes,
      project: nextProjectTimestamp(state),
    },
    inverseAction: inverse,
    effects: [{ kind: 'schedule-project-save' }],
  }
}
