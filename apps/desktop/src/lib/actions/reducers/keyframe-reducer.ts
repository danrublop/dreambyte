/**
 * Keyframe reducers.
 *
 * Keyframes live on `Clip.keyframes` and are identified by (property, time).
 * The reducer rejects an add when a keyframe with the same (property, time)
 * already exists — the inspector should call `keyframe/update` instead.
 *
 * Time is clip-relative seconds (0 = clip start). Must be in [0, duration].
 */

import type {
  ActionResult,
  ProjectState,
  KeyframeAddAction,
  KeyframeUpdateAction,
  KeyframeRemoveAction,
} from '../types'
import type { Clip, Keyframe, Timeline, Track } from '@/lib/types'
import { validateId, validateRange } from '../validators/_shared'

function findClip(timeline: Timeline | null | undefined, clipId: string): { track: Track; clip: Clip } | null {
  if (!timeline) return null
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

function withClipKeyframes(state: ProjectState, trackId: string, clipId: string, keyframes: Keyframe[]): ProjectState {
  const timeline = state.project.timeline ?? { tracks: [] }
  return {
    ...state,
    project: {
      ...state.project,
      timeline: {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, keyframes } : c)) } : t,
        ),
      },
      updatedAt: new Date().toISOString(),
    },
  }
}

/** Keep the keyframe array sorted by time so the renderer doesn't have to. */
function insertSorted(keyframes: Keyframe[], kf: Keyframe): Keyframe[] {
  const idx = keyframes.findIndex((k) => k.time > kf.time)
  if (idx === -1) return [...keyframes, kf]
  return [...keyframes.slice(0, idx), kf, ...keyframes.slice(idx)]
}

export function reduceKeyframeAdd(state: ProjectState, action: KeyframeAddAction): ActionResult {
  const { clipId, keyframe } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (!keyframe || typeof keyframe.property !== 'string') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'keyframe.property required' } }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const r = validateRange(keyframe.time, 0, found.clip.duration, 'keyframe.time')
  if (r) return { success: false, error: r }

  const conflict = found.clip.keyframes.find(
    (k) => k.property === keyframe.property && Math.abs(k.time - keyframe.time) < 1e-6,
  )
  if (conflict) {
    return {
      success: false,
      error: {
        code: 'KEYFRAME_CONFLICT',
        message: `Keyframe for "${keyframe.property}" at t=${keyframe.time}s already exists`,
        suggestion: 'Use keyframe/update to change its value instead.',
      },
    }
  }

  const newKeyframes = insertSorted(found.clip.keyframes, keyframe)

  return {
    success: true,
    state: withClipKeyframes(state, found.track.id, clipId, newKeyframes),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'keyframe/remove',
      params: {
        clipId,
        property: keyframe.property,
        time: keyframe.time,
        prior: { keyframe },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceKeyframeUpdate(state: ProjectState, action: KeyframeUpdateAction): ActionResult {
  const { clipId, property, time, patch } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const idx = found.clip.keyframes.findIndex((k) => k.property === property && Math.abs(k.time - time) < 1e-6)
  if (idx === -1) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAMS',
        message: `No keyframe for "${property}" at t=${time}s`,
      },
    }
  }

  const target = found.clip.keyframes[idx]
  // If the patch moves the keyframe in time, recheck against other keyframes
  // for collision and resort.
  const nextKf: Keyframe = { ...target, ...patch }
  if (typeof nextKf.time === 'number') {
    const r = validateRange(nextKf.time, 0, found.clip.duration, 'patch.time')
    if (r) return { success: false, error: r }
  }
  if (nextKf.time !== target.time) {
    const collision = found.clip.keyframes.find(
      (k, i) => i !== idx && k.property === nextKf.property && Math.abs(k.time - nextKf.time) < 1e-6,
    )
    if (collision) {
      return {
        success: false,
        error: {
          code: 'KEYFRAME_CONFLICT',
          message: `Another keyframe for "${nextKf.property}" already exists at t=${nextKf.time}s`,
        },
      }
    }
  }

  const without = [...found.clip.keyframes.slice(0, idx), ...found.clip.keyframes.slice(idx + 1)]
  const newKeyframes = insertSorted(without, nextKf)

  // Inverse: write `target` back. We patch the moved keyframe by time
  // (post-move) and supply the prior fields.
  const priorPatch: Partial<Keyframe> = {}
  for (const k of Object.keys(patch) as Array<keyof Keyframe>) {
    priorPatch[k] = target[k] as never
  }

  return {
    success: true,
    state: withClipKeyframes(state, found.track.id, clipId, newKeyframes),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'keyframe/update',
      params: { clipId, property, time: nextKf.time, patch: priorPatch, prior: patch },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceKeyframeRemove(state: ProjectState, action: KeyframeRemoveAction): ActionResult {
  const { clipId, property, time } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const target = found.clip.keyframes.find((k) => k.property === property && Math.abs(k.time - time) < 1e-6)
  if (!target) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: `No keyframe for "${property}" at t=${time}s` },
    }
  }

  const newKeyframes = found.clip.keyframes.filter((k) => k !== target)

  return {
    success: true,
    state: withClipKeyframes(state, found.track.id, clipId, newKeyframes),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'keyframe/add',
      params: { clipId, keyframe: target },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}
