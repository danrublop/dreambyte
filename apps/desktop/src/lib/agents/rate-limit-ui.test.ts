// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  isRateLimitError,
  parseRetryAfterSeconds,
  buildRateLimitNotice,
  tickCountdown,
  canRetryNow,
  countdownLabel,
  DEFAULT_RATE_LIMIT_RETRY_SEC,
  MAX_RATE_LIMIT_RETRY_SEC,
} from './rate-limit-ui'

describe('isRateLimitError', () => {
  it('matches HTTP 429', () => {
    expect(isRateLimitError('Agent error: 429 Too Many Requests')).toBe(true)
  })
  it('matches textual rate_limit / rate limit', () => {
    expect(isRateLimitError('rate_limit_error: too many tokens')).toBe(true)
    expect(isRateLimitError('hit the rate limit')).toBe(true)
  })
  it('matches provider overload (529 / overloaded)', () => {
    expect(isRateLimitError('Error: 529 overloaded_error')).toBe(true)
    expect(isRateLimitError('the model is overloaded')).toBe(true)
  })
  it('does not match unrelated errors', () => {
    expect(isRateLimitError('500 Internal Server Error')).toBe(false)
    expect(isRateLimitError('401 authentication failed')).toBe(false)
    expect(isRateLimitError('')).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
  })
  it('does not match 429 embedded in a larger number', () => {
    expect(isRateLimitError('error code 14290')).toBe(false)
  })
})

describe('parseRetryAfterSeconds', () => {
  it('parses retry-after: N', () => {
    expect(parseRetryAfterSeconds('429; retry-after: 42')).toBe(42)
  })
  it('parses retry_after=N and retryAfter N', () => {
    expect(parseRetryAfterSeconds('retry_after=18')).toBe(18)
    expect(parseRetryAfterSeconds('retryAfter 7')).toBe(7)
  })
  it('parses the "retry in Ns" backoff phrasing', () => {
    expect(parseRetryAfterSeconds('Rate limit hit — retrying in 15s (attempt 1/3)')).toBe(15)
  })
  it('rounds fractional seconds up', () => {
    expect(parseRetryAfterSeconds('retry-after: 2.3')).toBe(3)
  })
  it('clamps to the max', () => {
    expect(parseRetryAfterSeconds('retry-after: 9999')).toBe(MAX_RATE_LIMIT_RETRY_SEC)
  })
  it('returns null when absent or non-positive', () => {
    expect(parseRetryAfterSeconds('429 Too Many Requests')).toBeNull()
    expect(parseRetryAfterSeconds('retry-after: 0')).toBeNull()
    expect(parseRetryAfterSeconds(null)).toBeNull()
  })
})

describe('buildRateLimitNotice', () => {
  it('returns null for a non-rate-limit error', () => {
    expect(buildRateLimitNotice('500 Internal Server Error')).toBeNull()
  })
  it('seeds the countdown from an embedded retry-after', () => {
    const notice = buildRateLimitNotice('429 rate_limit; retry-after: 20')
    expect(notice).not.toBeNull()
    expect(notice!.retryAfterSec).toBe(20)
    expect(notice!.message).toMatch(/rate limit/i)
  })
  it('falls back to the default countdown when no retry-after is present', () => {
    const notice = buildRateLimitNotice('429 Too Many Requests')
    expect(notice!.retryAfterSec).toBe(DEFAULT_RATE_LIMIT_RETRY_SEC)
  })
})

describe('tickCountdown / canRetryNow / countdownLabel', () => {
  it('ticks down and never goes negative', () => {
    expect(tickCountdown(3)).toBe(2)
    expect(tickCountdown(1)).toBe(0)
    expect(tickCountdown(0)).toBe(0)
  })
  it('offers retry only at zero', () => {
    expect(canRetryNow(5)).toBe(false)
    expect(canRetryNow(0)).toBe(true)
    expect(canRetryNow(-1)).toBe(true)
  })
  it('labels the countdown', () => {
    expect(countdownLabel(12)).toBe('Retry available in 12s')
    expect(countdownLabel(0)).toBe('You can retry now.')
  })
})
