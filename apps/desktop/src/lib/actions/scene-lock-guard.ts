/**
 * Scene-lock enforcement (cursor model): a scene is owned by exactly one editor at a time
 * (agent OR user). This pure guard runs in the executor BEFORE the reducer and rejects an
 * action whose `source` conflicts with the scene's current owner — the agent can't mutate a
 * scene the user holds, and vice versa. The conflict modal is eliminated by construction.
 *
 * Crux: `action.source` is dispatcher-stamped and unspoofable (executor.ts), so it is the
 * authoritative "who is acting". The lock owner ('agent' | 'user') is compared against it.
 *
 * Safety: if no lock is held (or it's stale, or the scene/source can't be resolved) the guard
 * returns null = allow. So until acquisition is wired, this changes NOTHING — every scene is
 * unlocked, every action passes. Enforcement only bites once a lock is actually acquired.
 */

import type { Action, ActionError, ProjectState } from './types'
import { getEffectiveLock } from '../store/scene-lock'

/** The scene an action targets, or null. Nearly every scene/layer action carries params.sceneId. */
export function sceneIdForAction(action: Action): string | null {
  const sid = (action.params as { sceneId?: unknown }).sceneId
  return typeof sid === 'string' && sid.length > 0 ? sid : null
}

/**
 * Returns a SCENE_LOCKED error if `action` would mutate a scene currently owned by the OTHER
 * editor; null otherwise. Only 'user'/'agent' actions can conflict — 'replay'/'migration' are
 * system-recorded (the origin already happened) and never gated.
 */
export function checkSceneLockViolation(state: ProjectState, action: Action, now = Date.now()): ActionError | null {
  if (action.source !== 'user' && action.source !== 'agent') return null
  const sceneId = sceneIdForAction(action)
  if (!sceneId) return null // no resolvable target scene → don't enforce (safe default)
  const scene = state.scenes.find((s) => s.id === sceneId)
  if (!scene) return null // scene missing → let the reducer return its own SCENE_NOT_FOUND
  const lock = getEffectiveLock(scene, now)
  if (lock && lock.owner !== action.source) {
    return {
      code: 'SCENE_LOCKED',
      message: `Scene ${sceneId} is currently held by the ${lock.owner}.`,
      suggestion:
        action.source === 'agent'
          ? 'The user is editing this scene. Wait for them to finish, or ask them to hand it off.'
          : 'The agent is working on this scene. Wait, or use "Take over" on the lock badge.',
      details: { sceneId, owner: lock.owner },
    }
  }
  return null
}
