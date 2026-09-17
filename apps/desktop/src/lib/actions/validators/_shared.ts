/**
 * Shared validator helpers.
 *
 * Each per-action validator is then 5-15 lines built from these primitives.
 * Helpers return `null` on success or an ActionError on failure — that lets
 * callers chain with `??`/early-return without nested try/catch.
 */

import type { ActionError, ProjectState } from '../types'

/**
 * Dreambyte scenes were historically given short ids (e.g. `scene-1`). The router
 * + DB columns accept anything matching `[a-zA-Z0-9_-]+`, so we keep the
 * action layer permissive: a uuid is allowed but not required. The strict
 * uuid check is reserved for new project-level ids where we control the
 * generator end-to-end.
 */
const ID_RE = /^[a-zA-Z0-9_-]+$/

export function validateId(id: unknown, field = 'id'): ActionError | null {
  if (typeof id !== 'string' || id.length === 0) {
    return { code: 'INVALID_PARAMS', message: `${field} must be a non-empty string` }
  }
  if (!ID_RE.test(id)) {
    return {
      code: 'INVALID_PARAMS',
      message: `${field} contains invalid characters (allowed: a-z, A-Z, 0-9, '-', '_')`,
    }
  }
  return null
}

export function validateRange(value: unknown, min: number, max: number, field: string): ActionError | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { code: 'INVALID_PARAMS', message: `${field} must be a finite number` }
  }
  if (value < min || value > max) {
    return {
      code: 'OUT_OF_BOUNDS',
      message: `${field} must be in [${min}, ${max}] (got ${value})`,
    }
  }
  return null
}

export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): ActionError | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return {
      code: 'INVALID_PARAMS',
      message: `${field} must be one of: ${allowed.join(', ')}`,
    }
  }
  return null
}

export type EntityKind = 'scene' | 'layer' | 'project'

export function validateExists(
  state: ProjectState,
  id: string,
  kind: EntityKind,
  parentSceneId?: string,
): ActionError | null {
  switch (kind) {
    case 'scene':
      if (!state.scenes.find((s) => s.id === id)) {
        return { code: 'SCENE_NOT_FOUND', message: `Scene ${id} not found` }
      }
      return null
    case 'layer': {
      if (!parentSceneId) {
        return { code: 'INVALID_PARAMS', message: 'parentSceneId required for layer existence check' }
      }
      const scene = state.scenes.find((s) => s.id === parentSceneId)
      if (!scene) {
        return { code: 'SCENE_NOT_FOUND', message: `Scene ${parentSceneId} not found` }
      }
      if (!(scene.aiLayers ?? []).find((l) => l.id === id)) {
        return { code: 'LAYER_NOT_FOUND', message: `Layer ${id} not found in scene ${parentSceneId}` }
      }
      return null
    }
    case 'project':
      if (!state.project || state.project.id !== id) {
        return { code: 'PROJECT_NOT_LOADED', message: `Project ${id} not loaded` }
      }
      return null
  }
}

/** Reject a patch that includes the row's primary key. */
export function validateNoIdPatch(patch: Record<string, unknown> | undefined): ActionError | null {
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'id')) {
    return { code: 'INVALID_PARAMS', message: 'patch must not include `id` (use the dedicated id param)' }
  }
  return null
}
