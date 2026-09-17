/**
 * Project reducer. Handles `project/update` — patches Project metadata
 * (name, description, settings, sceneGraph, etc.). Patch must not include `id`.
 */

import type { ActionResult, ProjectState, ProjectUpdateAction } from '../types'
import { validateNoIdPatch } from '../validators/_shared'

export function reduceProjectUpdate(state: ProjectState, action: ProjectUpdateAction): ActionResult {
  const { patch } = action.params
  const noIdErr = validateNoIdPatch(patch as Record<string, unknown>)
  if (noIdErr) return { success: false, error: noIdErr }

  const target = state.project as unknown as Record<string, unknown>
  const prior: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    prior[k] = target[k]
  }

  const newProject = {
    ...state.project,
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  const inverse: ProjectUpdateAction = {
    id: `inv-${action.id}`,
    timestamp: action.timestamp,
    source: 'replay',
    runId: action.runId,
    version: action.version,
    type: 'project/update',
    params: { patch: prior as Partial<typeof state.project> },
  }

  return {
    success: true,
    state: { ...state, project: newProject },
    inverseAction: inverse,
    effects: [{ kind: 'schedule-project-save' }],
  }
}
