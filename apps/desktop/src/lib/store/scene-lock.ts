// Scene-level mutual exclusion lock
//
// Mutual exclusion: at any moment a
// scene is owned by exactly one editor (agent OR user, never both), so
// no conflict modal is needed
// — collisions cannot happen by construction.
//
// State machine:
//   - acquire(sceneId, owner): if unlocked OR same owner, sets the lock
//     and arms an idle timer; returns true. If owned by someone else and
//     not stale, returns false. If owned by someone else but stale (>30s
//     since last activity), the caller must explicitly call
//     forceTakeover() — acquire never silently steals a lock.
//
//   - touch(sceneId, owner): bumps lastActivityAt and re-arms the idle
//     timer. Cheap; safe to call on every keystroke / every tool call.
//     Returns false if the caller does not currently own the lock.
//
//   - release(sceneId): clears the lock and cancels the idle timer.
//
//   - forceTakeover(sceneId, newOwner): only succeeds if the existing
//     lock is older than the staleness threshold. Used by the "Take
//     over" button in the lock badge.
//
// Idle timeout: 3s of inactivity → auto-release.
// Stale-takeover threshold: 30s since lastActivityAt.
//
// The lock lives on `scene.lock` (TS-only; persisted via the sceneBlob
// path so no DB migration is needed for v1). Idle timers live in this
// module's module-level WeakMap-equivalent (a Map keyed by sceneId)
// so they survive Zustand's structural sharing.

import type { Scene } from '../types/scene'

export type LockOwner = 'agent' | 'user'

export type LockSource = 'in-app' | 'mcp-stdio' | 'mcp-http' | 'unknown'

export interface SceneLock {
  owner: LockOwner
  acquiredAt: number
  lastActivityAt: number
  source: LockSource
}

export const SCENE_LOCK_IDLE_MS = 3000
export const SCENE_LOCK_STALE_MS = 30000

export type AcquireOutcome = { ok: true; lock: SceneLock } | { ok: false; reason: 'held-by-other'; existing: SceneLock }

export type TouchOutcome = { ok: true; lock: SceneLock } | { ok: false; reason: 'no-lock' | 'wrong-owner' }

export type TakeoverOutcome = { ok: true; lock: SceneLock } | { ok: false; reason: 'not-stale'; existing: SceneLock }

/**
 * Returns the lock as it exists right now, treating stale locks as
 * effectively absent. Pure — does not mutate the scene.
 */
export function getEffectiveLock(scene: Scene, now = Date.now()): SceneLock | null {
  const lock = scene.lock ?? null
  if (!lock) return null
  if (now - lock.lastActivityAt > SCENE_LOCK_STALE_MS) return null
  return lock
}

export function tryAcquire(
  scene: Scene,
  owner: LockOwner,
  source: LockSource = 'unknown',
  now = Date.now(),
): AcquireOutcome {
  const effective = getEffectiveLock(scene, now)
  if (effective && effective.owner !== owner) {
    return { ok: false, reason: 'held-by-other', existing: effective }
  }
  // Either unlocked, lock is stale, or same owner — refresh.
  const lock: SceneLock = effective
    ? { ...effective, lastActivityAt: now }
    : { owner, source, acquiredAt: now, lastActivityAt: now }
  return { ok: true, lock }
}

export function tryTouch(scene: Scene, owner: LockOwner, now = Date.now()): TouchOutcome {
  const lock = scene.lock ?? null
  if (!lock) return { ok: false, reason: 'no-lock' }
  if (lock.owner !== owner) return { ok: false, reason: 'wrong-owner' }
  return { ok: true, lock: { ...lock, lastActivityAt: now } }
}

export function tryForceTakeover(
  scene: Scene,
  newOwner: LockOwner,
  source: LockSource = 'unknown',
  now = Date.now(),
): TakeoverOutcome {
  const lock = scene.lock ?? null
  if (!lock) {
    return { ok: true, lock: { owner: newOwner, source, acquiredAt: now, lastActivityAt: now } }
  }
  if (now - lock.lastActivityAt <= SCENE_LOCK_STALE_MS) {
    return { ok: false, reason: 'not-stale', existing: lock }
  }
  return { ok: true, lock: { owner: newOwner, source, acquiredAt: now, lastActivityAt: now } }
}

/**
 * Format a time-since-now for the badge UI. Returns short strings like
 * "now", "3s ago", "12s ago". Inputs older than 60s degrade to "1m ago"
 * etc. — at that point the lock is already past the stale threshold,
 * so the UI should be offering a take-over anyway.
 */
export function formatLockAge(lock: SceneLock, now = Date.now()): string {
  const elapsedSec = Math.max(0, Math.floor((now - lock.acquiredAt) / 1000))
  if (elapsedSec < 1) return 'now'
  if (elapsedSec < 60) return `${elapsedSec}s ago`
  const elapsedMin = Math.floor(elapsedSec / 60)
  return `${elapsedMin}m ago`
}

export function isStale(lock: SceneLock, now = Date.now()): boolean {
  return now - lock.lastActivityAt > SCENE_LOCK_STALE_MS
}

/**
 * Cursor-model overwrite protection for a forward AGENT scene apply. Given the LIVE current
 * scenes and an incoming agent-produced scene array, returns a merged array where any scene the
 * user currently holds (an effective 'user' lock) keeps its current version — the agent's
 * snapshot is stale and must not clobber an in-progress user edit. Scenes the user does not hold
 * pass through as incoming. Pure. Shared by the agent reducer AND the store's raw-set fallback so
 * the "exactly one editor per scene" invariant holds on both agent-apply paths.
 */
export function preserveUserHeldScenes(currentScenes: Scene[], incomingScenes: Scene[], now = Date.now()): Scene[] {
  const currentById = new Map(currentScenes.map((s) => [s.id, s]))
  return incomingScenes.map((incoming) => {
    const current = currentById.get(incoming.id)
    if (current && getEffectiveLock(current, now)?.owner === 'user') return current
    return incoming
  })
}
