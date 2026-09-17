/**
 * Timeline marker reducers (agent-addressable markers).
 *
 * The marker UI (TimeRuler render/rename/remove, snap-engine snap targets)
 * and the store ops shipped earlier; these reducers make markers part of
 * the typed action layer so agent tool calls get the same undo/WAL/save
 * semantics as every other timeline mutation. Mirrors track-flag-reducer:
 * read prior, write new, emit an explicit inverse.
 */

import type { ActionResult, ProjectState, MarkerAddAction, MarkerRemoveAction } from '../types'
import type { Timeline, TimelineMarker } from '@/lib/types'
import { validateId } from '../validators/_shared'

function withMarkers(state: ProjectState, markers: TimelineMarker[]): ProjectState {
  const timeline: Timeline = state.project.timeline ?? { tracks: [] }
  return {
    ...state,
    project: {
      ...state.project,
      timeline: { ...timeline, markers },
      updatedAt: new Date().toISOString(),
    },
  }
}

export function reduceMarkerAdd(state: ProjectState, action: MarkerAddAction): ActionResult {
  const { markerId, time, label, color } = action.params
  const idErr = validateId(markerId, 'markerId')
  if (idErr) return { success: false, error: idErr }
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    return {
      success: false,
      error: { code: 'INVALID_TIME_RANGE', message: 'Marker time must be a non-negative number' },
    }
  }
  const markers = state.project.timeline?.markers ?? []
  if (markers.some((m) => m.id === markerId)) {
    return { success: false, error: { code: 'DUPLICATE_ID', message: `Marker ${markerId} already exists` } }
  }

  const marker: TimelineMarker = { id: markerId, time, ...(label ? { label } : {}), ...(color ? { color } : {}) }
  return {
    success: true,
    state: withMarkers(state, [...markers, marker]),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'marker/remove',
      params: { markerId },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceMarkerRemove(state: ProjectState, action: MarkerRemoveAction): ActionResult {
  const { markerId } = action.params
  const idErr = validateId(markerId, 'markerId')
  if (idErr) return { success: false, error: idErr }
  const markers = state.project.timeline?.markers ?? []
  const marker = markers.find((m) => m.id === markerId)
  if (!marker) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: `Marker ${markerId} not found` } }
  }

  return {
    success: true,
    state: withMarkers(
      state,
      markers.filter((m) => m.id !== markerId),
    ),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'marker/add',
      params: { markerId, time: marker.time, label: marker.label, color: marker.color },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}
