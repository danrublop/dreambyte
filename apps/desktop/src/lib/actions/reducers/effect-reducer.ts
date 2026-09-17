/**
 * Effect (filter) reducers.
 *
 * Filters live on `Clip.filters`. The key is `type` — only one of each
 * filter type can be attached to a clip at a time. `add` rejects when the
 * filter type is already present; `update` patches the value; `remove`
 * detaches by type.
 */

import type {
  ActionResult,
  ProjectState,
  EffectAddAction,
  EffectUpdateAction,
  EffectRemoveAction,
  EffectSetGradeFiltersAction,
} from '../types'
import type { Clip, ClipFilter, Timeline, Track } from '@/lib/types'
import { validateId, validateEnum } from '../validators/_shared'

const FILTER_TYPES = [
  'blur',
  'brightness',
  'contrast',
  'saturate',
  'grayscale',
  'sepia',
  'hue-rotate',
  'tone-curve',
] as const

/** Mirrors GRADE_FILTER_TYPES in src/lib/edit-engines/color-grades.ts (no import:
 *  reducers stay dependency-free of the edit-engines layer). */
const GRADE_MANAGED_TYPES = ['brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate'] as const

function findClip(timeline: Timeline | null | undefined, clipId: string): { track: Track; clip: Clip } | null {
  if (!timeline) return null
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

function withFilters(state: ProjectState, trackId: string, clipId: string, filters: ClipFilter[]): ProjectState {
  const timeline = state.project.timeline ?? { tracks: [] }
  return {
    ...state,
    project: {
      ...state.project,
      timeline: {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, filters } : c)) } : t,
        ),
      },
      updatedAt: new Date().toISOString(),
    },
  }
}

export function reduceEffectAdd(state: ProjectState, action: EffectAddAction): ActionResult {
  const { clipId, filter } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  const typeErr = validateEnum(filter?.type, FILTER_TYPES, 'filter.type')
  if (typeErr) return { success: false, error: typeErr }
  if (typeof filter.value !== 'number' || !Number.isFinite(filter.value)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'filter.value must be a finite number' } }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  if (found.clip.filters.some((f) => f.type === filter.type)) {
    return {
      success: false,
      error: {
        code: 'DUPLICATE_ID',
        message: `Filter "${filter.type}" already attached to clip ${clipId}`,
        suggestion: 'Use effect/update to change its value instead.',
      },
    }
  }

  const newFilters = [...found.clip.filters, filter]

  return {
    success: true,
    state: withFilters(state, found.track.id, clipId, newFilters),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'effect/remove',
      params: {
        clipId,
        filterType: filter.type,
        prior: { filter, index: newFilters.length - 1 },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceEffectUpdate(state: ProjectState, action: EffectUpdateAction): ActionResult {
  const { clipId, filterType, value, curve } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  const typeErr = validateEnum(filterType, FILTER_TYPES, 'filterType')
  if (typeErr) return { success: false, error: typeErr }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'value must be a finite number' } }
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const idx = found.clip.filters.findIndex((f) => f.type === filterType)
  if (idx === -1) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: `Filter "${filterType}" not on clip ${clipId}` },
    }
  }
  const prior = found.clip.filters[idx]
  // `curve` (tone-curve payload) is patched only when supplied, so plain
  // value updates on other filter types are unaffected.
  const newFilters = found.clip.filters.map((f, i) =>
    i === idx ? { ...f, value, ...(curve !== undefined ? { curve } : {}) } : f,
  )

  return {
    success: true,
    state: withFilters(state, found.track.id, clipId, newFilters),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'effect/update',
      params: {
        clipId,
        filterType,
        value: prior.value,
        // `undefined` means "don't patch", so restore an absent prior curve
        // as {} — all channels missing, which evaluates as identity.
        ...(curve !== undefined ? { curve: prior.curve ?? {} } : {}),
        prior: { value, ...(curve !== undefined ? { curve } : {}) },
      },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

/**
 * Replace the clip's entire grade-managed filter set in ONE action (grading
 * UI): swapping looks or dragging intensity is a single undo step instead of
 * an add/remove per filter type. `gradeFilters` is the complete new managed
 * set — [] clears the grade. Blur (spatial) is never grade-managed and is
 * preserved untouched.
 */
export function reduceEffectSetGradeFilters(state: ProjectState, action: EffectSetGradeFiltersAction): ActionResult {
  const { clipId, gradeFilters } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  if (!Array.isArray(gradeFilters)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: 'gradeFilters must be an array' } }
  }
  const seen = new Set<string>()
  for (const f of gradeFilters) {
    const typeErr = validateEnum(f?.type, GRADE_MANAGED_TYPES, 'gradeFilters[].type')
    if (typeErr) return { success: false, error: typeErr }
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) {
      return {
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'gradeFilters[].value must be a finite number' },
      }
    }
    if (seen.has(f.type)) {
      return { success: false, error: { code: 'DUPLICATE_ID', message: `Duplicate grade filter type "${f.type}"` } }
    }
    seen.add(f.type)
  }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }

  const managed = new Set<string>(GRADE_MANAGED_TYPES)
  const priorManaged = found.clip.filters.filter((f) => managed.has(f.type))
  const kept = found.clip.filters.filter((f) => !managed.has(f.type))
  const newFilters = [...kept, ...gradeFilters]

  return {
    success: true,
    state: withFilters(state, found.track.id, clipId, newFilters),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'effect/setGradeFilters',
      params: { clipId, gradeFilters: priorManaged, prior: { gradeFilters } },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}

export function reduceEffectRemove(state: ProjectState, action: EffectRemoveAction): ActionResult {
  const { clipId, filterType } = action.params
  const idErr = validateId(clipId, 'clipId')
  if (idErr) return { success: false, error: idErr }
  const typeErr = validateEnum(filterType, FILTER_TYPES, 'filterType')
  if (typeErr) return { success: false, error: typeErr }

  const found = findClip(state.project.timeline, clipId)
  if (!found) return { success: false, error: { code: 'CLIP_NOT_FOUND', message: `Clip ${clipId} not found` } }
  if (found.track.locked) {
    return { success: false, error: { code: 'TRACK_LOCKED', message: `Track ${found.track.id} is locked` } }
  }
  const idx = found.clip.filters.findIndex((f) => f.type === filterType)
  if (idx === -1) {
    return {
      success: false,
      error: { code: 'INVALID_PARAMS', message: `Filter "${filterType}" not on clip ${clipId}` },
    }
  }
  const removed = found.clip.filters[idx]
  const newFilters = found.clip.filters.filter((_, i) => i !== idx)

  return {
    success: true,
    state: withFilters(state, found.track.id, clipId, newFilters),
    inverseAction: {
      id: `inv-${action.id}`,
      timestamp: action.timestamp,
      source: 'replay',
      runId: action.runId,
      version: action.version,
      type: 'effect/add',
      params: { clipId, filter: removed },
    },
    effects: [{ kind: 'schedule-project-save' }],
  }
}
