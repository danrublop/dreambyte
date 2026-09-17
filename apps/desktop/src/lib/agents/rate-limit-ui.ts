/**
 * Pure helpers for the chat 429 / rate-limit UX.
 *
 * The component only wires: it classifies the error string, derives a
 * retry-after countdown, and ticks the countdown down. All of that logic lives
 * here so it's unit-testable without a React render.
 *
 * Error shapes that reach the client (see src/lib/agents/runner.ts:3252+ and the
 * AgentChat catch block): the in-app runner retries 429s itself up to 3 times,
 * then rethrows the provider error — its `.message` carries "429" and/or
 * "rate_limit". The error also surfaces as a `{ type: 'error', error }` SSE
 * event prefixed "Agent error:". Provider rate-limit / overload shapes also use
 * "overloaded" / "529". A `retry-after` value (seconds) is sometimes embedded in
 * the message text; when present we seed the countdown from it.
 */

/** Default seconds to wait before re-enabling Retry when no retry-after is given. */
export const DEFAULT_RATE_LIMIT_RETRY_SEC = 30

/** Cap the countdown so a bogus header can't pin the button forever. */
export const MAX_RATE_LIMIT_RETRY_SEC = 120

/**
 * Is this error message a rate-limit / overload condition? Matches the provider
 * shapes that can survive the runner's internal retries: HTTP 429, the textual
 * "rate limit" form, and provider overload (Anthropic 529 / "overloaded").
 */
export function isRateLimitError(message: string | null | undefined): boolean {
  if (!message) return false
  return /\b429\b|\b529\b|rate[_ ]?limit|overloaded/i.test(message)
}

/**
 * Parse a retry-after hint (in seconds) out of an error message, if present.
 * Recognises `retry-after: 30`, `retry_after=30`, `retryAfter 30`, and the bare
 * "retry in 30s" phrasing the runner's backoff logs use. Returns null when no
 * usable, finite, positive value is found. Clamped to MAX_RATE_LIMIT_RETRY_SEC.
 */
export function parseRetryAfterSeconds(message: string | null | undefined): number | null {
  if (!message) return null
  const patterns = [/retry[-_ ]?after["'\s:=]+(\d+(?:\.\d+)?)/i, /retry(?:ing)?\s+in\s+(\d+(?:\.\d+)?)\s*s/i]
  for (const re of patterns) {
    const m = message.match(re)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0) {
        return Math.min(Math.ceil(n), MAX_RATE_LIMIT_RETRY_SEC)
      }
    }
  }
  return null
}

export interface RateLimitNotice {
  /** User-facing message for the chat bubble. */
  message: string
  /** Seconds remaining before Retry is offered; counts down to 0. */
  retryAfterSec: number
}

/**
 * Build the initial rate-limit notice for a detected 429. Seeds the countdown
 * from an embedded retry-after when available, else the default. Returns null
 * when the error is not a rate-limit error (caller falls through to its other
 * error branches).
 */
export function buildRateLimitNotice(message: string | null | undefined): RateLimitNotice | null {
  if (!isRateLimitError(message)) return null
  const parsed = parseRetryAfterSeconds(message)
  const retryAfterSec = parsed ?? DEFAULT_RATE_LIMIT_RETRY_SEC
  return {
    message: 'Rate limit reached. The provider is throttling requests.',
    retryAfterSec,
  }
}

/** One countdown tick: never goes below 0. */
export function tickCountdown(seconds: number): number {
  return seconds > 0 ? seconds - 1 : 0
}

/** Whether the Retry action should be offered (countdown elapsed). */
export function canRetryNow(seconds: number): boolean {
  return seconds <= 0
}

/** Human-readable countdown label, e.g. "Retry available in 12s". */
export function countdownLabel(seconds: number): string {
  if (seconds <= 0) return 'You can retry now.'
  return `Retry available in ${seconds}s`
}
