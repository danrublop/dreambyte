// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

import { extractBriefWithRetry } from './extract-project-brief'
import type { ProjectBrief } from '@/lib/types'

/**
 * Regression gate: a transient brief-extraction failure must not permanently
 * strip OKF film craft from the run (the craft gate skips when projectBrief is
 * null). The retry chokepoint must: retry once, surface each failed attempt, and return
 * null only when BOTH attempts fail.
 */

const FAKE: ProjectBrief = { videoType: 'explainer', confidence: 0.5 } as unknown as ProjectBrief

describe('extractBriefWithRetry (#1)', () => {
  it('returns the brief on first success with no retry', async () => {
    const attempt = vi.fn(async () => FAKE)
    const onAttemptFail = vi.fn()
    const out = await extractBriefWithRetry(attempt, { timeoutMs: 1000, onAttemptFail })
    expect(out).toBe(FAKE)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onAttemptFail).not.toHaveBeenCalled()
  })

  it('retries once after a failure and then succeeds', async () => {
    let n = 0
    const attempt = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('parse fail')
      return FAKE
    })
    const onAttemptFail = vi.fn()
    const out = await extractBriefWithRetry(attempt, { timeoutMs: 1000, onAttemptFail })
    expect(out).toBe(FAKE)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onAttemptFail).toHaveBeenCalledTimes(1)
  })

  it('returns null after BOTH attempts fail, surfacing both', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('boom')
    })
    const onAttemptFail = vi.fn()
    const out = await extractBriefWithRetry(attempt, { timeoutMs: 1000, attempts: 2, onAttemptFail })
    expect(out).toBeNull()
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onAttemptFail).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry when a slow first attempt exhausts the overall deadline (#1)', async () => {
    // FAKE TIMERS, deliberately. `remaining = deadlineMs - (Date.now() - start)`,
    // and this case sets deadlineMs === timeoutMs, so `remaining` lands exactly on
    // the `<= 0` boundary. Under real timers a millisecond of rounding on a loaded
    // machine leaves remaining = 1, which authorises a second attempt that is then
    // given a 1 ms timeout and dies instantly — the assertion below flips to
    // "called 2 times" and the run goes red for no reason. It failed exactly that
    // way on CI while passing locally and on every PR branch.
    //
    // Advancing a fake clock past the deadline makes the boundary a fact rather
    // than a race, and still tests the real thing: elapsed > deadline → no retry.
    vi.useFakeTimers()
    try {
      const attempt = vi.fn(() => new Promise<ProjectBrief>((r) => setTimeout(() => r(FAKE), 200)))
      const onAttemptFail = vi.fn()
      const pending = extractBriefWithRetry(attempt, { timeoutMs: 30, deadlineMs: 30, attempts: 2, onAttemptFail })
      // Past the 30 ms attempt timeout AND the 30 ms overall deadline.
      await vi.advanceTimersByTimeAsync(31)
      const out = await pending
      expect(out).toBeNull()
      expect(attempt).toHaveBeenCalledTimes(1) // budget gone → no second attempt
      expect(onAttemptFail).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('DOES retry within the deadline when the first attempt fails fast (#1)', async () => {
    let n = 0
    const attempt = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('fast parse fail')
      return FAKE
    })
    const out = await extractBriefWithRetry(attempt, { timeoutMs: 1000, deadlineMs: 5000, attempts: 2 })
    expect(out).toBe(FAKE)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('treats a slow attempt as a timeout, then retries', async () => {
    let n = 0
    const attempt = vi.fn(async () => {
      n += 1
      if (n === 1) return new Promise<ProjectBrief>((r) => setTimeout(() => r(FAKE), 200))
      return FAKE
    })
    const onAttemptFail = vi.fn()
    const out = await extractBriefWithRetry(attempt, { timeoutMs: 20, attempts: 2, onAttemptFail })
    expect(out).toBe(FAKE)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onAttemptFail).toHaveBeenCalledTimes(1)
    expect(String(onAttemptFail.mock.calls[0][0])).toContain('timed out')
  })
})
