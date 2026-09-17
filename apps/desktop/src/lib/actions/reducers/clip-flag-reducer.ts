/**
 * Clip flag reducers.
 *
 *   clip/setSpeed   — playback rate in [0.25, 4.0]. Adjusts the clip's
 *                     timeline duration to keep the source duration constant
 *                     (newDuration = sourceDuration / speed). Audio clips can
 *                     opt into pitch-lock (varispeed off).
 *   clip/setBlend   — blendMode + optional blendOpacity (0..1).
 *   clip/fade       — fadeIn / fadeOut seconds, each <= clip duration.
 *
 * Each reducer captures the prior values so the inverse is a single
 * self-cancelling action.
 */

import type {
  ActionResult,
  ProjectState,
  ClipSetSpeedAction,
  ClipSetBlendAction,
  ClipSetColorGradeAction,
  ClipFadeAction,
  ClipSetTransformAction,
} from '../types'
import type { Clip, Timeline, Track } from '@/lib/types'
import { validateId, validateRange } from '../validators/_shared'

const SPEED_MIN = 0.25
const SPEED_MAX = 4.0

function findClip(timeline: Timeline | null | undefined, clipId: string): { track: Track; clip: Clip } | null {
  if (!timeline) return null
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

function withClipPatch(state: ProjectState, trackId: string, clipId: string, patch: Partial<Clip>): ProjectState {
  const timeline = state.project.timeline ?? { tracks: [] }
  return {
    ...state,
    project: {
      ...state.project,
      timeline: {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) } : t,
        ),
      },
      updatedAt: new Date().toISOString(),
    },
  }
}

export function reduceClipSetSpeed(state: ProjectState, action: ClipSetSpeedAction): ActionResult {
  const { clipId, speed, lockAudioPitch } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  const rangeErr = validateRange(speed, SPEED_MIN, SPEED_MAX, 'speed')
  if (rangeErr) return { success: false, error: rangeErr }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  // The clip's existing duration was sourceDuration/oldSpeed. We solve back
  // for sourceDuration and recompute. Treat undefined as 1.0.
  const oldSpeed = found.clip.speed || 1
  const sourceDuration = found.clip.duration * oldSpeed
  const newDuration = sourceDuration / speed

  const patch: Partial<Clip> = { speed, duration: newDuration }
  if (lockAudioPitch !== undefined) patch.lockAudioPitch = lockAudioPitch

  return {
    success: true,
    state: withClipPatch(state, found.track.id, clipId, patch),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/setSpeed',
      params: {
        clipId,
        speed: oldSpeed,
        lockAudioPitch: found.clip.lockAudioPitch,
        prior: { speed, lockAudioPitch, duration: newDuration },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceClipSetBlend(state: ProjectState, action: ClipSetBlendAction): ActionResult {
  const { clipId, blendMode, blendOpacity } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (typeof blendMode !== 'string' || blendMode.length === 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'blendMode required' } }
  }
  if (blendOpacity !== undefined) {
    const r = validateRange(blendOpacity, 0, 1, 'blendOpacity')
    if (r) return { success: false, error: r }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const priorMode = found.clip.blendMode
  const priorOpacity = found.clip.blendOpacity

  const patch: Partial<Clip> = { blendMode }
  if (blendOpacity !== undefined) patch.blendOpacity = blendOpacity

  return {
    success: true,
    state: withClipPatch(state, found.track.id, clipId, patch),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/setBlend',
      params: {
        clipId,
        blendMode: priorMode ?? 'normal',
        blendOpacity: priorOpacity,
        prior: { blendMode, blendOpacity },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * clip/setColorGrade — set the color grade on a media clip. The
 * handler (apply_color) has already merged the patch onto the prior grade, so
 * `grade` is the complete new grade ({} clears it). Captures the prior grade for
 * a self-cancelling inverse.
 */
export function reduceClipSetColorGrade(state: ProjectState, action: ClipSetColorGradeAction): ActionResult {
  const { clipId, grade } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (!grade || typeof grade !== 'object') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'grade object required' } }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const priorGrade = found.clip.grade

  return {
    success: true,
    state: withClipPatch(state, found.track.id, clipId, { grade }),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/setColorGrade',
      params: { clipId, grade: priorGrade ?? {}, prior: { grade } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceClipFade(state: ProjectState, action: ClipFadeAction): ActionResult {
  const { clipId, fadeIn, fadeOut } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  if (fadeIn !== undefined) {
    const r = validateRange(fadeIn, 0, found.clip.duration, 'fadeIn')
    if (r) return { success: false, error: r }
  }
  if (fadeOut !== undefined) {
    const r = validateRange(fadeOut, 0, found.clip.duration, 'fadeOut')
    if (r) return { success: false, error: r }
  }
  if (fadeIn !== undefined && fadeOut !== undefined && fadeIn + fadeOut > found.clip.duration) {
    return {
      success: false,
      error: {
        code: 'INVALID_TIME_RANGE',
        message: `fadeIn + fadeOut (${fadeIn + fadeOut}s) exceeds clip duration (${found.clip.duration}s)`,
      },
    }
  }

  const priorFadeIn = found.clip.fadeIn
  const priorFadeOut = found.clip.fadeOut

  const patch: Partial<Clip> = {}
  if (fadeIn !== undefined) patch.fadeIn = fadeIn
  if (fadeOut !== undefined) patch.fadeOut = fadeOut

  return {
    success: true,
    state: withClipPatch(state, found.track.id, clipId, patch),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/fade',
      params: {
        clipId,
        fadeIn: priorFadeIn,
        fadeOut: priorFadeOut,
        prior: { fadeIn, fadeOut },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * Patch the static transform fields (position / scale / rotation / opacity)
 * on a clip. Keyframes at the current time still override these at render,
 * so `setTransform` is the "base value" tweak the Inspector uses when no
 * keyframe is being authored.
 */
export function reduceClipSetTransform(state: ProjectState, action: ClipSetTransformAction): ActionResult {
  const { clipId, position, scale, rotation, opacity } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }

  if (rotation !== undefined) {
    if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: 'rotation must be a finite number' } }
    }
  }
  if (opacity !== undefined) {
    const r = validateRange(opacity, 0, 1, 'opacity')
    if (r) return { success: false, error: r }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const patch: Partial<Clip> = {}
  const prior: NonNullable<ClipSetTransformAction['params']['prior']> = {}

  if (position !== undefined) {
    patch.position = { ...found.clip.position, ...position }
    prior.position = found.clip.position
  }
  if (scale !== undefined) {
    patch.scale = { ...found.clip.scale, ...scale }
    prior.scale = found.clip.scale
  }
  if (rotation !== undefined) {
    patch.rotation = rotation
    prior.rotation = found.clip.rotation
  }
  if (opacity !== undefined) {
    patch.opacity = opacity
    prior.opacity = found.clip.opacity
  }

  return {
    success: true,
    state: withClipPatch(state, found.track.id, clipId, patch),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'clip/setTransform',
      params: {
        clipId,
        position: prior.position,
        scale: prior.scale,
        rotation: prior.rotation,
        opacity: prior.opacity,
        prior: { position: patch.position, scale: patch.scale, rotation: patch.rotation, opacity: patch.opacity },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}
