import { describe, it, expect } from 'vitest'
import { checkSceneLockViolation, sceneIdForAction } from './scene-lock-guard'
import type { Action, ProjectState } from './types'
import { SCENE_LOCK_STALE_MS, type SceneLock, type LockOwner } from '../store/scene-lock'

const NOW = 1_000_000
const fresh = (owner: LockOwner): SceneLock => ({
  owner,
  source: 'in-app',
  acquiredAt: NOW,
  lastActivityAt: NOW,
})
const staleLock = (owner: LockOwner): SceneLock => ({
  owner,
  source: 'in-app',
  acquiredAt: 0,
  lastActivityAt: NOW - SCENE_LOCK_STALE_MS - 1, // past the stale threshold
})

const stateWith = (lock: SceneLock | null): ProjectState =>
  ({ scenes: [{ id: 's1', lock }] }) as unknown as ProjectState

const act = (source: Action['source'], sceneId: string | null = 's1'): Action =>
  ({
    id: 'a1',
    timestamp: 0,
    source,
    runId: null,
    version: 1,
    type: 'scene/update',
    params: sceneId == null ? {} : { sceneId, patch: {} },
  }) as unknown as Action

describe('checkSceneLockViolation', () => {
  it('allows when no lock is held (the until-acquisition-wired no-op case)', () => {
    expect(checkSceneLockViolation(stateWith(null), act('agent'), NOW)).toBeNull()
    expect(checkSceneLockViolation(stateWith(null), act('user'), NOW)).toBeNull()
  })

  it('rejects an agent action on a user-held scene, and vice versa', () => {
    const a = checkSceneLockViolation(stateWith(fresh('user')), act('agent'), NOW)
    expect(a?.code).toBe('SCENE_LOCKED')
    expect(a?.details?.owner).toBe('user')
    const u = checkSceneLockViolation(stateWith(fresh('agent')), act('user'), NOW)
    expect(u?.code).toBe('SCENE_LOCKED')
    expect(u?.details?.owner).toBe('agent')
  })

  it('allows the owner to keep acting on their own scene', () => {
    expect(checkSceneLockViolation(stateWith(fresh('user')), act('user'), NOW)).toBeNull()
    expect(checkSceneLockViolation(stateWith(fresh('agent')), act('agent'), NOW)).toBeNull()
  })

  it('treats a stale lock as absent (allows — takeover is handled elsewhere)', () => {
    expect(checkSceneLockViolation(stateWith(staleLock('user')), act('agent'), NOW)).toBeNull()
  })

  it('never gates replay/migration actions even against an opposing lock', () => {
    expect(checkSceneLockViolation(stateWith(fresh('user')), act('replay'), NOW)).toBeNull()
    expect(checkSceneLockViolation(stateWith(fresh('agent')), act('migration'), NOW)).toBeNull()
  })

  it('allows when the action has no resolvable scene, or the scene is missing', () => {
    expect(checkSceneLockViolation(stateWith(fresh('user')), act('agent', null), NOW)).toBeNull()
    expect(checkSceneLockViolation(stateWith(fresh('user')), act('agent', 'other-scene'), NOW)).toBeNull()
  })
})

describe('sceneIdForAction', () => {
  it('reads params.sceneId, null when absent', () => {
    expect(sceneIdForAction(act('user', 's7'))).toBe('s7')
    expect(sceneIdForAction(act('user', null))).toBeNull()
  })
})
