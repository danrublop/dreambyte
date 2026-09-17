import { describe, it, expect } from 'vitest'
import { reachedTrimEnd, replayTargetOnPlay, shouldAdvance } from './preview-advance'

describe('reachedTrimEnd', () => {
  it('triggers once the scene-local time reaches the trimmed out-point', () => {
    expect(reachedTrimEnd(3, 3)).toBe(true)
    expect(reachedTrimEnd(3, 3.5)).toBe(true)
  })

  it('does not trigger before the out-point', () => {
    expect(reachedTrimEnd(3, 2.9)).toBe(false)
  })

  it('never triggers for an untrimmed clip (no trimEnd)', () => {
    // Untrimmed clips end via the iframe's onEnded, not the watchdog.
    expect(reachedTrimEnd(null, 999)).toBe(false)
    expect(reachedTrimEnd(undefined, 999)).toBe(false)
  })

  it('treats trimEnd of 0 as a real out-point, not absent', () => {
    expect(reachedTrimEnd(0, 0)).toBe(true)
  })
})

describe('shouldAdvance', () => {
  it('advances from the scene that is currently playing and not yet advancing', () => {
    expect(shouldAdvance({ fromSceneId: 'a', selectedSceneId: 'a', advancingSceneId: null })).toBe(true)
  })

  it('rejects a stale request for a scene we already left (late onEnded after watchdog moved on)', () => {
    // Watchdog already advanced a -> b; a's iframe fires onEnded later. We are on b now.
    expect(shouldAdvance({ fromSceneId: 'a', selectedSceneId: 'b', advancingSceneId: null })).toBe(false)
  })

  it('rejects a repeat while the same scene is mid-advance (tick re-firing before selection settles)', () => {
    expect(shouldAdvance({ fromSceneId: 'a', selectedSceneId: 'a', advancingSceneId: 'a' })).toBe(false)
  })

  it('allows a different scene to advance even if another is mid-advance', () => {
    expect(shouldAdvance({ fromSceneId: 'b', selectedSceneId: 'b', advancingSceneId: 'a' })).toBe(true)
  })

  it('rejects when nothing is selected', () => {
    expect(shouldAdvance({ fromSceneId: 'a', selectedSceneId: null, advancingSceneId: null })).toBe(false)
  })
})

describe('replayTargetOnPlay (C2 transport completed → replay)', () => {
  it('plays normally (null) when not completed', () => {
    expect(replayTargetOnPlay({ completed: false, firstSceneId: 'a' })).toBeNull()
  })

  it('replays from the first scene when completed (multi-scene)', () => {
    expect(replayTargetOnPlay({ completed: true, firstSceneId: 'a' })).toBe('a')
  })

  it('replays the single scene when completed (single-scene: first === last)', () => {
    // A single-scene project ends on its only scene; the next play restarts it.
    expect(replayTargetOnPlay({ completed: true, firstSceneId: 'only' })).toBe('only')
  })

  it('returns null when completed but there is no renderable first scene', () => {
    expect(replayTargetOnPlay({ completed: true, firstSceneId: null })).toBeNull()
    expect(replayTargetOnPlay({ completed: true, firstSceneId: undefined })).toBeNull()
  })
})
