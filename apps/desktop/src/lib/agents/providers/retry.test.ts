import { describe, it, expect } from 'vitest'
import { classifyStreamError, computeBackoffMs, MAX_STREAM_RETRIES, authErrorMessage } from './retry'

describe('classifyStreamError', () => {
  it('classifies 429 as a retriable rate limit', () => {
    expect(classifyStreamError({ status: 429 })).toMatchObject({ retriable: true, isRateLimit: true, status: 429 })
  })

  it('classifies 5xx as retriable but not a rate limit (no backoff-retry)', () => {
    expect(classifyStreamError({ status: 503 })).toMatchObject({ retriable: true, isRateLimit: false })
  })

  it('treats unknown status (network drop) as retriable', () => {
    expect(classifyStreamError(new Error('socket hang up'))).toMatchObject({ retriable: true })
  })

  it('classifies 4xx (non-429) as non-retriable', () => {
    expect(classifyStreamError({ status: 400 })).toMatchObject({ retriable: false, isRateLimit: false })
    expect(classifyStreamError({ status: 401 })).toMatchObject({ retriable: false })
  })

  it('detects rate limits / overloads from the message when no status is present', () => {
    expect(classifyStreamError(new Error('429 Too Many Requests'))).toMatchObject({ isRateLimit: true })
    expect(classifyStreamError(new Error('model overloaded'))).toMatchObject({ isRateLimit: true })
    expect(classifyStreamError(new Error('rate_limit exceeded'))).toMatchObject({ isRateLimit: true })
  })

  it('reads status off response.status too', () => {
    expect(classifyStreamError({ response: { status: 429 } })).toMatchObject({ isRateLimit: true })
  })
})

describe('authErrorMessage', () => {
  it('returns a friendly, actionable message for a 401', () => {
    const m401 = authErrorMessage({ status: 401 }, 'Anthropic')
    expect(m401).toMatch(/Anthropic API key was rejected/)
    expect(m401).toMatch(/Settings → Models/)
    expect(m401).toContain('(401)')
  })

  it('detects auth failures from the message when no/ambiguous status is present', () => {
    expect(authErrorMessage(new Error('invalid x-api-key'), 'Anthropic')).toMatch(/rejected/)
    expect(authErrorMessage(new Error('authentication_error: ...'), 'deepseek')).toMatch(/deepseek API key/)
    expect(authErrorMessage(new Error('Incorrect API key provided'), 'OpenAI')).toMatch(/rejected/)
    // A 403 that names the key IS treated as an auth failure (via the message).
    expect(authErrorMessage({ status: 403, message: 'invalid api key' }, 'OpenAI')).toMatch(/rejected/)
  })

  it('does NOT misclassify a bare 403 (quota / region / permission) as a key problem', () => {
    // The most important false-positive guard: a valid key hitting a quota or
    // region block must NOT be told to re-enter its key.
    expect(authErrorMessage({ status: 403 }, 'OpenAI')).toBeNull()
    expect(authErrorMessage(new Error('PERMISSION_DENIED: quota exceeded'), 'Gemini')).toBeNull()
    expect(authErrorMessage({ status: 403, message: 'Forbidden: region not supported' }, 'OpenAI')).toBeNull()
  })

  it('returns null for non-auth errors so the caller falls back to the raw message', () => {
    expect(authErrorMessage({ status: 429 }, 'Anthropic')).toBeNull()
    expect(authErrorMessage({ status: 500 }, 'Anthropic')).toBeNull()
    expect(authErrorMessage(new Error('socket hang up'), 'Anthropic')).toBeNull()
  })

  it('reads status off response.status too', () => {
    expect(authErrorMessage({ response: { status: 401 } }, 'Gemini')).toMatch(/Gemini API key was rejected/)
  })
})

describe('computeBackoffMs', () => {
  it('honors a retry-after header (seconds), capped at 120s', () => {
    const err = { headers: { get: (k: string) => (k === 'retry-after' ? '7' : null) } }
    expect(computeBackoffMs(err, 0)).toBe(7000)
    const huge = { headers: { get: () => '9999' } }
    expect(computeBackoffMs(huge, 0)).toBe(120_000)
  })

  it('falls back to jittered defaults that grow per attempt', () => {
    // attempt 0 base 15s ±15% jitter → [12.75s, 17.25s]
    const a0 = computeBackoffMs(new Error('x'), 0)
    expect(a0).toBeGreaterThanOrEqual(12_750)
    expect(a0).toBeLessThanOrEqual(17_250)
    // attempt 1 base 45s
    const a1 = computeBackoffMs(new Error('x'), 1)
    expect(a1).toBeGreaterThanOrEqual(38_250)
    expect(a1).toBeLessThanOrEqual(51_750)
  })

  it('exposes a sane retry ceiling', () => {
    expect(MAX_STREAM_RETRIES).toBe(3)
  })
})
