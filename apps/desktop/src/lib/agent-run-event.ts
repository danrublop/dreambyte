/**
 * Shared, PII-free contract for one completed agent run, emitted as product
 * telemetry (`agent_run_completed`). Lives at the lib root so both the
 * telemetry transport (`telemetry.ts`) and the analytics producer
 * (`agents/run-analytics.ts`) depend on one definition instead of drifting.
 *
 * Everything here is bucketed or enum — never a raw cost, duration, or any
 * free text — so the event carries product signal without leaking spend
 * figures or anything that could identify a user or project. See the PII
 * contract at the top of `telemetry.ts`.
 */

export type RunOutcome = 'success' | 'partial' | 'failure' | 'aborted' | 'permission_blocked'

export interface FrustrationSignal {
  detected: boolean
  level: 'none' | 'mild' | 'moderate' | 'high'
  triggers: string[]
  /** 0-1 score, higher = more frustrated */
  score: number
}

/** Spend bucket for one run. Coarse on purpose — telemetry never sees a raw $ figure. */
export type CostBand = 'free' | 'lt_1c' | 'lt_10c' | 'lt_1d' | 'gte_1d'

/** Wall-clock bucket for one run. */
export type DurationBand = 'lt_5s' | 'lt_30s' | 'lt_2m' | 'lt_5m' | 'gte_5m'

export interface AgentRunEvent {
  /** Terminal classification of the run. */
  outcome: RunOutcome
  /** Bucketed user-frustration level detected on the prompt. */
  frustrationLevel: FrustrationSignal['level']
  /** Spend bucket (not the raw cost). */
  costBand: CostBand
  /** Duration bucket. */
  durationBand: DurationBand
  /** Resolved provider, e.g. 'anthropic' | 'openai' | 'google' | 'local'. */
  provider: string
}

/** Map a run's USD cost into a coarse band. Negatives and NaN clamp to 'free'. */
export function toCostBand(costUsd: number): CostBand {
  if (!(costUsd > 0)) return 'free' // catches 0, negative, and NaN
  if (costUsd < 0.01) return 'lt_1c'
  if (costUsd < 0.1) return 'lt_10c'
  if (costUsd < 1) return 'lt_1d'
  return 'gte_1d'
}

/** Map a run's wall-clock duration (ms) into a coarse band. */
export function toDurationBand(durationMs: number): DurationBand {
  if (durationMs < 5_000) return 'lt_5s'
  if (durationMs < 30_000) return 'lt_30s'
  if (durationMs < 120_000) return 'lt_2m'
  if (durationMs < 300_000) return 'lt_5m'
  return 'gte_5m'
}
