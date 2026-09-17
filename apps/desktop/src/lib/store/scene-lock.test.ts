// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  tryAcquire,
  tryTouch,
  tryForceTakeover,
  getEffectiveLock,
  isStale,
  formatLockAge,
  preserveUserHeldScenes,
  SCENE_LOCK_STALE_MS,
  type SceneLock,
} from './scene-lock'
import type { Scene } from '../types/scene'

function sceneWithLock(lock: SceneLock | null): Scene {
  return { id: 'scene-1', lock } as unknown as Scene
}

describe('tryAcquire', () => {
  it('grants the lock when the scene is unlocked', () => {
    const r = tryAcquire(sceneWithLock(null), 'user', 'in-app', 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lock.owner).toBe('user')
      expect(r.lock.acquiredAt).toBe(1000)
      expect(r.lock.lastActivityAt).toBe(1000)
      expect(r.lock.source).toBe('in-app')
    }
  })

  it('grants the lock to the same owner — refreshes activity', () => {
    const existing: SceneLock = { owner: 'user', acquiredAt: 1000, lastActivityAt: 1500, source: 'in-app' }
    const r = tryAcquire(sceneWithLock(existing), 'user', 'in-app', 2000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lock.acquiredAt).toBe(1000) // preserved
      expect(r.lock.lastActivityAt).toBe(2000) // refreshed
    }
  })

  it('refuses when held by another owner and lock is fresh', () => {
    const existing: SceneLock = { owner: 'agent', acquiredAt: 1000, lastActivityAt: 1500, source: 'in-app' }
    const r = tryAcquire(sceneWithLock(existing), 'user', 'in-app', 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('held-by-other')
      expect(r.existing.owner).toBe('agent')
    }
  })

  it('grants the lock when the existing lock is stale (>30s)', () => {
    const existing: SceneLock = { owner: 'agent', acquiredAt: 0, lastActivityAt: 1000, source: 'in-app' }
    const now = 1000 + SCENE_LOCK_STALE_MS + 1
    const r = tryAcquire(sceneWithLock(existing), 'user', 'in-app', now)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lock.owner).toBe('user') // ownership transferred — stale lock counts as absent
    }
  })
})

describe('tryTouch', () => {
  it('refuses when there is no lock', () => {
    const r = tryTouch(sceneWithLock(null), 'user')
    expect(r.ok).toBe(false)
  })

  it('refuses when caller is not the owner', () => {
    const existing: SceneLock = { owner: 'agent', acquiredAt: 1000, lastActivityAt: 1500, source: 'in-app' }
    const r = tryTouch(sceneWithLock(existing), 'user', 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wrong-owner')
  })

  it('bumps lastActivityAt when caller owns the lock', () => {
    const existing: SceneLock = { owner: 'user', acquiredAt: 1000, lastActivityAt: 1500, source: 'in-app' }
    const r = tryTouch(sceneWithLock(existing), 'user', 2000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lock.acquiredAt).toBe(1000)
      expect(r.lock.lastActivityAt).toBe(2000)
    }
  })
})

describe('tryForceTakeover', () => {
  it('grants when there is no lock to take over', () => {
    const r = tryForceTakeover(sceneWithLock(null), 'user', 'in-app', 1000)
    expect(r.ok).toBe(true)
  })

  it('refuses when the existing lock is fresh', () => {
    const existing: SceneLock = { owner: 'agent', acquiredAt: 0, lastActivityAt: 1000, source: 'in-app' }
    const r = tryForceTakeover(sceneWithLock(existing), 'user', 'in-app', 1000 + SCENE_LOCK_STALE_MS - 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-stale')
  })

  it('grants takeover after the staleness threshold', () => {
    const existing: SceneLock = { owner: 'agent', acquiredAt: 0, lastActivityAt: 1000, source: 'in-app' }
    const r = tryForceTakeover(sceneWithLock(existing), 'user', 'in-app', 1000 + SCENE_LOCK_STALE_MS + 1)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lock.owner).toBe('user')
    }
  })
})

describe('getEffectiveLock', () => {
  it('treats stale locks as absent', () => {
    const stale: SceneLock = { owner: 'agent', acquiredAt: 0, lastActivityAt: 1000, source: 'in-app' }
    expect(getEffectiveLock(sceneWithLock(stale), 1000 + SCENE_LOCK_STALE_MS + 1)).toBeNull()
  })

  it('returns the lock when it is fresh', () => {
    const fresh: SceneLock = { owner: 'user', acquiredAt: 1000, lastActivityAt: 1500, source: 'in-app' }
    expect(getEffectiveLock(sceneWithLock(fresh), 2000)).toEqual(fresh)
  })
})

describe('preserveUserHeldScenes', () => {
  const fresh = (owner: 'user' | 'agent', now: number): SceneLock => ({
    owner,
    acquiredAt: now,
    lastActivityAt: now,
    source: 'in-app',
  })
  const scene = (id: string, tag: string, lock: SceneLock | null): Scene => ({ id, tag, lock }) as unknown as Scene

  it('keeps the current version of a user-held scene, drops the incoming agent overwrite', () => {
    const now = 10_000
    const current = [scene('s1', 'user-edit', fresh('user', now)), scene('s2', 'old', null)]
    const incoming = [scene('s1', 'agent-overwrite', null), scene('s2', 'agent-new', null)]
    const out = preserveUserHeldScenes(current, incoming, now)
    expect((out[0] as any).tag).toBe('user-edit') // preserved
    expect((out[1] as any).tag).toBe('agent-new') // not user-held → incoming wins
  })

  it('lets the agent overwrite a scene whose user lock has gone stale', () => {
    const acquired = 0
    const now = SCENE_LOCK_STALE_MS + 1 // user lock is now stale → effectively absent
    const current = [
      scene('s1', 'user-edit', { owner: 'user', acquiredAt: acquired, lastActivityAt: acquired, source: 'in-app' }),
    ]
    const incoming = [scene('s1', 'agent-overwrite', null)]
    const out = preserveUserHeldScenes(current, incoming, now)
    expect((out[0] as any).tag).toBe('agent-overwrite')
  })

  it('passes through a brand-new scene the agent adds (no current match)', () => {
    const now = 5_000
    const out = preserveUserHeldScenes([], [scene('new', 'fresh', null)], now)
    expect((out[0] as any).tag).toBe('fresh')
  })

  it('does not preserve an agent-held scene against the agent (only user wins)', () => {
    const now = 5_000
    const current = [scene('s1', 'agent-was-here', fresh('agent', now))]
    const incoming = [scene('s1', 'agent-overwrite', null)]
    const out = preserveUserHeldScenes(current, incoming, now)
    expect((out[0] as any).tag).toBe('agent-overwrite')
  })
})

describe('isStale + formatLockAge', () => {
  it('isStale fires past the threshold', () => {
    const lock: SceneLock = { owner: 'user', acquiredAt: 0, lastActivityAt: 1000, source: 'in-app' }
    expect(isStale(lock, 1000 + SCENE_LOCK_STALE_MS - 1)).toBe(false)
    expect(isStale(lock, 1000 + SCENE_LOCK_STALE_MS + 1)).toBe(true)
  })

  it('formatLockAge handles common cases', () => {
    const lock: SceneLock = { owner: 'user', acquiredAt: 1000, lastActivityAt: 1000, source: 'in-app' }
    expect(formatLockAge(lock, 1000)).toBe('now')
    expect(formatLockAge(lock, 1500)).toBe('now') // <1s
    expect(formatLockAge(lock, 4000)).toBe('3s ago')
    expect(formatLockAge(lock, 65000)).toBe('1m ago')
  })
})
