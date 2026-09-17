import { describe, it, expect } from 'vitest'
import { maxJobDurationMs, deadlineFor, isJobExpired, timeoutMessage } from './video-job-deadline'

describe('video job deadline policy', () => {
  it('returns a per-provider max, falling back to the default for unknown providers', () => {
    expect(maxJobDurationMs('veo3')).toBe(15 * 60_000)
    expect(maxJobDurationMs('runway')).toBe(15 * 60_000)
    // unknown provider → default (and an inherited key like "toString" must NOT resolve)
    expect(maxJobDurationMs('nope')).toBe(15 * 60_000)
    expect(maxJobDurationMs('toString')).toBe(15 * 60_000)
  })

  it('deadlineFor adds the provider budget to the start time', () => {
    expect(deadlineFor('veo3', 1_000)).toBe(1_000 + 15 * 60_000)
  })

  it('isJobExpired is inclusive at the deadline', () => {
    const deadline = deadlineFor('veo3', 0)
    expect(isJobExpired(deadline, deadline - 1)).toBe(false)
    expect(isJobExpired(deadline, deadline)).toBe(true) // exact deadline counts as expired
    expect(isJobExpired(deadline, deadline + 1)).toBe(true)
  })

  it('timeoutMessage states the minutes and that budget was released', () => {
    const msg = timeoutMessage('veo3')
    expect(msg).toMatch(/15 minutes/)
    expect(msg).toMatch(/released/)
  })
})
