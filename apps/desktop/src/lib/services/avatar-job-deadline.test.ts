import { describe, it, expect } from 'vitest'
import {
  avatarMaxJobDurationMs,
  avatarDeadlineFor,
  isAvatarExpired,
  isAvatarDeadlinePassed,
  avatarTimeoutMessage,
  avatarSceneFitDuration,
} from './avatar-job-deadline'

describe('avatar-job-deadline', () => {
  const MAX = 15 * 60_000

  it('uses a 15-minute ceiling', () => {
    expect(avatarMaxJobDurationMs()).toBe(MAX)
  })

  it('deadline is start + max', () => {
    expect(avatarDeadlineFor(1_000)).toBe(1_000 + MAX)
  })

  it('is not expired before the deadline', () => {
    const start = 1_000
    expect(isAvatarExpired(start, start + MAX - 1)).toBe(false)
  })

  it('is expired at and after the deadline (inclusive)', () => {
    const start = 1_000
    expect(isAvatarExpired(start, start + MAX)).toBe(true)
    expect(isAvatarExpired(start, start + MAX + 1)).toBe(true)
  })

  it('never expires a job with no start time (legacy layers poll as before)', () => {
    expect(isAvatarExpired(undefined, 9_999_999_999)).toBe(false)
    expect(isAvatarExpired(NaN, 9_999_999_999)).toBe(false)
  })

  it('timeout message names the budget in minutes', () => {
    expect(avatarTimeoutMessage()).toContain('15 minutes')
  })

  describe('isAvatarDeadlinePassed (persisted deadline, v4 #8)', () => {
    it('is not passed before the deadline', () => {
      expect(isAvatarDeadlinePassed(1000, 999)).toBe(false)
    })
    it('is passed at and after the deadline (inclusive, matches video isJobExpired)', () => {
      expect(isAvatarDeadlinePassed(1000, 1000)).toBe(true)
      expect(isAvatarDeadlinePassed(1000, 1001)).toBe(true)
    })
    it('never passes a missing/invalid deadline (legacy row polls as before)', () => {
      expect(isAvatarDeadlinePassed(null, 9_999_999_999)).toBe(false)
      expect(isAvatarDeadlinePassed(undefined, 9_999_999_999)).toBe(false)
      expect(isAvatarDeadlinePassed(NaN, 9_999_999_999)).toBe(false)
    })
  })

  // Shared by the agent get_avatar_status AND the renderer reconcile so they can't drift.
  describe('avatarSceneFitDuration', () => {
    it('extends the scene to fit a longer avatar (startAt + realDuration)', () => {
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: 25, sceneDuration: 8 })).toBe(25)
      expect(avatarSceneFitDuration({ startAt: 3, realDuration: 25, sceneDuration: 8 })).toBe(28)
    })
    it('never shrinks a scene already long enough (returns null)', () => {
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: 6, sceneDuration: 20 })).toBeNull()
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: 8, sceneDuration: 8 })).toBeNull()
    })
    it('returns null when the real duration is unknown/invalid', () => {
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: null, sceneDuration: 8 })).toBeNull()
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: NaN, sceneDuration: 8 })).toBeNull()
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: 0, sceneDuration: 8 })).toBeNull()
    })
    it('caps the extension at the 30-min export ceiling', () => {
      expect(avatarSceneFitDuration({ startAt: 0, realDuration: 1e9, sceneDuration: 8 })).toBe(30 * 60)
    })
    it('tolerates garbage startAt (falls back to 0)', () => {
      expect(avatarSceneFitDuration({ startAt: NaN, realDuration: 12, sceneDuration: 8 })).toBe(12)
    })
  })
})
