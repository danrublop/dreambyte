/**
 * Track flag reducers.
 *
 * Toggle-style mutations on a single Track field. All four share the same
 * shape: read prior, write new, emit an explicit inverse that restores the
 * prior. Same-value writes are no-ops but still emit a self-cancelling
 * inverse so action_log + WAL stay coherent.
 */

import type {
  ActionResult,
  ProjectState,
  TrackHideAction,
  TrackLockAction,
  TrackMuteAction,
  TrackSetPanAction,
  TrackSetVolumeAction,
  TrackSoloAction,
} from '../types'
import type { Timeline, Track } from '@/lib/types'
import { MAX_STAGE_GAIN, UNITY_GAIN, clamp } from '@/lib/audio/mix-math'
import { validateId } from '../validators/_shared'

function findTrack(timeline: Timeline | null | undefined, trackId: string): Track | null {
  if (!timeline) return null
  return timeline.tracks.find((t) => t.id === trackId) ?? null
}

function withTrack(state: ProjectState, trackId: string, patch: Partial<Track>): ProjectState {
  const timeline = state.project.timeline ?? { tracks: [] }
  return {
    ...state,
    project: {
      ...state.project,
      timeline: {
        ...timeline,
        tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      },
      updatedAt: new Date().toISOString(),
    },
  }
}

export function reduceTrackLock(state: ProjectState, action: TrackLockAction): ActionResult {
  const { trackId, locked } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }

  return {
    success: true,
    state: withTrack(state, trackId, { locked }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/lock',
      params: { trackId, locked: track.locked, prior: { locked } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceTrackMute(state: ProjectState, action: TrackMuteAction): ActionResult {
  const { trackId, muted } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }

  return {
    success: true,
    state: withTrack(state, trackId, { muted }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/mute',
      params: { trackId, muted: track.muted, prior: { muted } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceTrackSolo(state: ProjectState, action: TrackSoloAction): ActionResult {
  const { trackId, solo } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }

  const priorSolo = track.solo ?? false
  return {
    success: true,
    state: withTrack(state, trackId, { solo }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/solo',
      params: { trackId, solo: priorSolo, prior: { solo } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * Mixer fader gain. Clamps to the per-stage ceiling (0..2 = +6 dB) and rejects
 * edits to a locked track (a fader move is an edit; locked means no edits). The
 * inverse restores the prior linear gain, defaulting to unity when unset.
 */
export function reduceTrackSetVolume(state: ProjectState, action: TrackSetVolumeAction): ActionResult {
  const { trackId } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }
  if (track.locked) return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${trackId} is locked` } }

  // Non-finite (incl ±Infinity) → silence, matching the pre-shared-clamp
  // behavior; the shared clamp only floors NaN and would pass +Infinity → +6 dB.
  const volume = Number.isFinite(action.params.volume) ? clamp(action.params.volume, 0, MAX_STAGE_GAIN) : 0
  const priorVolume = track.volume ?? UNITY_GAIN
  return {
    success: true,
    state: withTrack(state, trackId, { volume }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/setVolume',
      params: { trackId, volume: priorVolume, prior: { volume } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * Stereo pan, clamped -1..+1. Locked tracks reject (same rationale as volume).
 */
export function reduceTrackSetPan(state: ProjectState, action: TrackSetPanAction): ActionResult {
  const { trackId } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }
  if (track.locked) return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${trackId} is locked` } }

  // Non-finite → center (the neutral pan), not a hard-left clamp artifact.
  const pan = Number.isFinite(action.params.pan) ? clamp(action.params.pan, -1, 1) : 0
  const priorPan = track.pan ?? 0
  return {
    success: true,
    state: withTrack(state, trackId, { pan }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/setPan',
      params: { trackId, pan: priorPan, prior: { pan } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceTrackHide(state: ProjectState, action: TrackHideAction): ActionResult {
  const { trackId, hidden } = action.params
  const idErr = validateId(trackId, 'trackId')
  if (idErr) return { success: false, error: idErr }
  const track = findTrack(state.project.timeline, trackId)
  if (!track) return { success: false, error: { code: 'TRACK_NOT_FOUND', message: `Track ${trackId} not found` } }

  const priorHidden = track.hidden ?? false
  return {
    success: true,
    state: withTrack(state, trackId, { hidden }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'track/hide',
      params: { trackId, hidden: priorHidden, prior: { hidden } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}
