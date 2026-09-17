/**
 * Shared stream-retry policy for provider adapters.
 *
 * Before this module, only the Anthropic adapter retried transient failures
 * (429 / 5xx); the OpenAI and Google adapters computed a `retriable` flag but
 * acted on nothing, so one rate-limit ended the run. This centralizes the
 * *policy* — what's retriable, how long to back off — so all three adapters
 * behave consistently. Each adapter keeps its own retry LOOP (stream lifecycles
 * differ per SDK); they share this detection + backoff.
 *
 * Key safety rule, enforced by each caller (not here): never retry once the
 * stream has yielded content. A partially-streamed turn can't be cleanly
 * re-run, so mid-stream failures surface as errors. This module only covers
 * creation-time and pre-first-event failures.
 */

import type { NormalizedStreamEvent } from './adapter'

export const MAX_STREAM_RETRIES = 3
/** Jittered fallback backoff (seconds) per attempt when no retry-after header. */
const BACKOFF_SECONDS = [15, 45, 90] as const
/** Cap an honored retry-after so a hostile/huge header can't stall for minutes. */
const MAX_RETRY_AFTER_SEC = 120

// ── Test seam ─────────────────────────────────────────────────────────────────
// Tests override the sleep to avoid waiting real backoff intervals. The `__`
// prefix + ForTesting suffix matches __setProviderClientsForTesting. Production
// must not call these.
let _sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function __setRetrySleepForTesting(fn: (ms: number) => Promise<void>): void {
  _sleepFn = fn
}
export function __resetRetrySleepForTesting(): void {
  _sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sleep that also resolves immediately if the abort signal fires. Without this,
 * a cancelled run would block for the full 15–120s backoff before noticing the
 * disconnect (and could then fire another provider request after the user left).
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return _sleepFn(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    void _sleepFn(ms).then(finish)
  })
}

export interface StreamErrorClass {
  /** HTTP status if the SDK exposed one. */
  status?: number
  /** Worth retrying at all (429 or 5xx; unknown status is treated as retriable). */
  retriable: boolean
  /** Specifically a rate limit — the case the backoff loop is designed for. */
  isRateLimit: boolean
}

/**
 * Classify a thrown stream/SDK error. Mirrors the detection the OpenAI and
 * Google adapters already used inline (`status === 429 || status >= 500`),
 * plus a message-text fallback for rate limits the SDK didn't tag with a status.
 */
export function classifyStreamError(err: unknown): StreamErrorClass {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status: number | undefined = e?.status ?? e?.response?.status
  const msg = String(e?.message ?? '')
  const isRateLimit = status === 429 || /rate[_ ]?limit|429|overloaded|too many requests/i.test(msg)
  const isServer = status !== undefined && status >= 500
  // Unknown status (network/connection drop) is retriable — same as the OpenAI
  // and Google adapters' prior inline `status === undefined` branch.
  const retriable = isRateLimit || isServer || status === undefined
  return { status, retriable, isRateLimit }
}

/**
 * Friendly message for an authentication failure (a rejected / expired / wrong
 * API key), or null if the error isn't an auth failure. The raw SDK text for a
 * 401 is opaque ("<Provider> stream error: 401 ...") and gives a non-technical
 * user nothing to act on — the most likely real onboarding mistake is a
 * mistyped or expired key. Returns a clear "key was rejected — check Settings"
 * string for 401/403 (and common auth-error message shapes); callers fall back
 * to the raw message when this returns null. The MISSING-key case is handled
 * upstream by the agent IPC pre-flight; this covers present-but-invalid keys.
 */
export function authErrorMessage(err: unknown, providerLabel: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status: number | undefined = e?.status ?? e?.response?.status
  const msg = String(e?.message ?? '')
  // 401 is unambiguously an auth failure. A bare 403 is NOT: providers return
  // 403 for quota, region, or permission/API-not-enabled blocks on a perfectly
  // valid key (e.g. Google's PERMISSION_DENIED, OpenAI region blocks), so only
  // treat it as a key problem when the message itself names the key/auth. Over-
  // claiming would send a user with a working key off to re-enter it.
  const isAuth =
    status === 401 ||
    /invalid[_ ]?api[_ ]?key|invalid x-api-key|incorrect api key|api key not valid|authentication[_ ]?error|unauthenticated/i.test(
      msg,
    )
  if (!isAuth) return null
  const code = status ? ` (${status})` : ''
  return `Your ${providerLabel} API key was rejected${code}. Open Settings → Models and check that the key is correct and active.`
}

/** Read a retry-after header off the various shapes SDKs expose it on. */
function readRetryAfterSec(err: unknown): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const header =
    e?.headers?.get?.('retry-after') ??
    e?.response?.headers?.get?.('retry-after') ??
    e?.responseHeaders?.['retry-after']
  return Number(header)
}

/** Backoff (ms) for a given attempt: honored retry-after (capped) or jittered default. */
export function computeBackoffMs(err: unknown, attempt: number): number {
  const retryAfterSec = readRetryAfterSec(err)
  const baseBackoffSec = BACKOFF_SECONDS[attempt] ?? 90
  const waitSec =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(retryAfterSec, MAX_RETRY_AFTER_SEC)
      : baseBackoffSec * (0.85 + Math.random() * 0.3)
  return Math.round(waitSec * 1000)
}

/**
 * Yield the retry-backoff signal and sleep before the next attempt. Surfaced as
 * a retriable `error` event because NormalizedStreamEvent has no `warning`
 * variant; the consumer renders it as a non-fatal "retrying in Ns" notice.
 */
export async function* yieldRetryBackoff(
  err: unknown,
  attempt: number,
  maxRetries: number = MAX_STREAM_RETRIES,
  abortSignal?: AbortSignal,
): AsyncGenerator<NormalizedStreamEvent> {
  const waitMs = computeBackoffMs(err, attempt)
  yield {
    type: 'error',
    message: `Rate limit hit — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`,
    retriable: true,
  }
  await sleepWithAbort(waitMs, abortSignal)
}
