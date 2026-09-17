/**
 * Video job deadline policy.
 *
 * Video generation is async + polled. Without a deadline a stuck "pending" job is polled
 * forever and its reserved spend leaks (the budget reservation is in-memory and only swept
 * on a coarse stale timer). A persisted videoJobs row carries a `deadlineAt`; the poll loop
 * enforces it — past the deadline a still-pending job is marked `timeout`, its reservation
 * released, and a clear error returned instead of an infinite spinner.
 *
 * Pure + dependency-free so the policy is unit-testable without a DB or a clock.
 */

// Wall-clock budget per provider before a still-pending job is declared timed out. Video
// gen runs minutes (Veo3 2-10m, Kling/Runway similar); 15m is a generous ceiling that still
// bounds a wedged job. hasOwn lookup so an inherited key can't masquerade as a provider.
const DEFAULT_MAX_MS = 15 * 60_000
const PROVIDER_MAX_MS: Record<string, number> = {
  veo3: 15 * 60_000,
  kling: 15 * 60_000,
  runway: 15 * 60_000,
}

export function maxJobDurationMs(providerId: string): number {
  return Object.hasOwn(PROVIDER_MAX_MS, providerId) ? PROVIDER_MAX_MS[providerId] : DEFAULT_MAX_MS
}

/** Deadline (epoch ms) for a job started at `startedAtMs` on `providerId`. */
export function deadlineFor(providerId: string, startedAtMs: number): number {
  return startedAtMs + maxJobDurationMs(providerId)
}

/** True once the deadline has passed. Inclusive so an exact-deadline poll counts as expired. */
export function isJobExpired(deadlineAtMs: number, nowMs: number): boolean {
  return nowMs >= deadlineAtMs
}

/** Human-facing timeout message for a job that blew its deadline. */
export function timeoutMessage(providerId: string): string {
  const minutes = Math.round(maxJobDurationMs(providerId) / 60_000)
  return `Video generation timed out after ${minutes} minutes (provider: ${providerId}). The reserved budget was released; try again.`
}
