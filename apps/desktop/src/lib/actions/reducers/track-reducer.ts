/**
 * Track reducer.
 *
 * Operates on `state.project.timeline.tracks`. The Timeline shape is
 * optional on Project — if it's null, `track/add` initialises it with a
 * fresh `{ tracks: [] }`. This lets new projects start with no timeline
 * and have one appear on the first agent / UI tool call.
 */

import type { ActionResult, ProjectState, TrackAddAction, TrackRemoveAction } from '../types'
import type { Timeline, Track } from '@/lib/types'
import { validateId, validateRange } from '../validators/_shared'

const VALID_TRACK_TYPES: ReadonlyArray<Track['type']> = ['video', 'audio', 'image', 'text', 'graphics', 'scene']

function withTimeline(state: ProjectState, timeline: Timeline): ProjectState {
  return {
    ...state,
    project: {
      ...state.project,
      timeline,
      updatedAt: new Date().toISOString(),
    },
  }
}

function ensureTimeline(state: ProjectState): Timeline {
  return state.project.timeline ?? { tracks: [] }
}

export function reduceTrackAdd(state: ProjectState, action: TrackAddAction): ActionResult {
  const { trackId, type, name, position } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  if (!VALID_TRACK_TYPES.includes(type as Track['type'])) {
    return {
      success: false,
      error: {
        code: 'INCOMPATIBLE_TYPE',
        message: `Invalid track type "${type}". Allowed: ${VALID_TRACK_TYPES.join(', ')}`,
      },
    }
  }

  const timeline = ensureTimeline(state)
  if (timeline.tracks.some((t) => t.id === trackId)) {
    return {
      success: false,
      error: { code: 'DUPLICATE_ID', message: `Track ${trackId} already exists` },
    }
  }
  if (typeof position === 'number') {
    const r = validateRange(position, 0, timeline.tracks.length, 'position')
    if (r) return { success: false, error: r }
  }

  const idx = typeof position === 'number' ? position : timeline.tracks.length
  const newTrack: Track = {
    id: trackId,
    name: name ?? `Track ${timeline.tracks.length + 1}`,
    type,
    clips: [],
    muted: false,
    locked: false,
    position: idx,
  }
  const tracks: Track[] = [...timeline.tracks.slice(0, idx), newTrack, ...timeline.tracks.slice(idx)]
  // Rebase positions so they stay 0..N-1
  const repositioned = tracks.map((t, i) => (t.position === i ? t : { ...t, position: i }))

  const inverse: TrackRemoveAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'track/remove',
    params: { trackId, prior: { track: newTrack, index: idx } },
  }

  return {
    success: true,
    state: withTimeline(state, { ...timeline, tracks: repositioned }),
    inverseAction: inverse,
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceTrackRemove(state: ProjectState, action: TrackRemoveAction): ActionResult {
  const { trackId } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }

  const timeline = ensureTimeline(state)
  const idx = timeline.tracks.findIndex((t) => t.id === trackId)
  if (idx === -1) {
    return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }
  }
  const removed = timeline.tracks[idx]
  const tracks = timeline.tracks.filter((t) => t.id !== trackId).map((t, i) => ({ ...t, position: i }))

  const inverse = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay' as const,
    runId: action.runId,
    version: action.version,
    type: 'track/add' as const,
    params: { trackId, type: removed.type, name: removed.name, position: idx },
    // The full prior track (with clips) cannot be reconstructed by the
    // standard track/add reducer alone, so the inverse path is a partial
    // restore — clips are recoverable via the parallel clip/add inverses
    // emitted when each clip was originally added. For a true round-trip
    // (which the round-trip property test asserts), the caller must use
    // the explicit prior snapshot path.
  }

  return {
    success: true,
    state: withTimeline(state, { ...timeline, tracks }),
    inverseAction: inverse,
    warnings:
      removed.clips.length > 0
        ? [`Removed track had ${removed.clips.length} clip(s); inverse will not re-attach them.`]
        : undefined,
    effects: [{ kind: 'schedule-project-save' }],
  }
}
