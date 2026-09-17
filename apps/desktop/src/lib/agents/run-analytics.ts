/**
 * Run-level analytics for the Dreambyte agent system.
 *
 * Captures signals that help improve agent quality:
 * - Frustration detection (regex on user messages)
 * - Run outcome classification (success/partial/failure)
 * - Tool success rates
 * - Session health metrics
 *
 * All signals are logged to the generation_logs table via analysisNotes
 * and to the agent logger trace for structured analysis.
 */

import type { AgentLogger } from './logger'
import type { ToolCallRecord, UsageStats } from './types'
import { toCostBand, toDurationBand, type FrustrationSignal, type RunOutcome } from '../agent-run-event'

export type { FrustrationSignal, RunOutcome } from '../agent-run-event'
import { trackAgentRun } from '../telemetry'

// ── Frustration Detection ────────────────────────────────────────────────────
//
// Detects signs of developer frustration in user messages.
// Uses tiered pattern matching: explicit profanity, exasperation patterns,
// and repeated failure language. NOT used to judge — used to flag runs
// where the user experience may need improvement.

const FRUSTRATION_PATTERNS = {
  /** Explicit frustration language (highest signal) */
  explicit: /\b(fuck|shit|damn|crap|hell|ass|wtf|ffs|goddamn|bullshit|dammit)\b/i,

  /** Exasperation and giving-up language */
  exasperation: /\b(ugh+|argh+|gah+|omg|smh|sigh|jesus|christ|for.?fuck.?sake)\b/i,

  /** Repeated failure / stuck patterns */
  stuck:
    /\b(still (not|doesn'?t|won'?t|isn'?t|broken|wrong)|again!+|not working|keeps? (failing|breaking|crashing)|try(ing)? again|one more time|last (try|attempt)|give up|this is (broken|impossible|terrible|awful|useless|garbage|trash))\b/i,

  /** Negative quality assessment */
  quality:
    /\b(looks? (terrible|awful|horrible|ugly|wrong|bad|broken|nothing)|where.?s the|completely wrong|not what I (asked|wanted|said)|waste of time|useless)\b/i,

  /** Capslock shouting (3+ consecutive uppercase words) */
  shouting: /\b[A-Z]{2,}\s+[A-Z]{2,}\s+[A-Z]{2,}\b/,

  /** Excessive punctuation (frustration typing) */
  punctuation: /[!?]{3,}|\.{4,}/,
}

/**
 * Analyze a user message for frustration signals.
 * Returns a structured signal with detection level and triggers.
 */
export function detectFrustration(message: string): FrustrationSignal {
  const triggers: string[] = []
  let score = 0

  if (FRUSTRATION_PATTERNS.explicit.test(message)) {
    triggers.push('explicit_language')
    score += 0.5
  }
  if (FRUSTRATION_PATTERNS.exasperation.test(message)) {
    triggers.push('exasperation')
    score += 0.3
  }
  if (FRUSTRATION_PATTERNS.stuck.test(message)) {
    triggers.push('stuck_pattern')
    score += 0.4
  }
  if (FRUSTRATION_PATTERNS.quality.test(message)) {
    triggers.push('negative_quality')
    score += 0.3
  }
  if (FRUSTRATION_PATTERNS.shouting.test(message)) {
    triggers.push('shouting')
    score += 0.2
  }
  if (FRUSTRATION_PATTERNS.punctuation.test(message)) {
    triggers.push('excessive_punctuation')
    score += 0.1
  }

  score = Math.min(1, score)

  const level: FrustrationSignal['level'] =
    score === 0 ? 'none' : score < 0.3 ? 'mild' : score < 0.6 ? 'moderate' : 'high'

  return { detected: score > 0, level, triggers, score }
}

// ── Run Outcome Classification ───────────────────────────────────────────────

export interface RunMetrics {
  outcome: RunOutcome
  /** Total wall-clock time in ms */
  durationMs: number
  /** Number of tool-loop iterations used */
  iterationsUsed: number
  iterationsMax: number
  /** Tool execution stats */
  toolCallsTotal: number
  toolCallsSucceeded: number
  toolCallsFailed: number
  /** Scenes created vs planned */
  scenesPlanned: number
  scenesCreated: number
  scenesVerified: number
  /** Whether the run hit the iteration limit */
  hitIterationLimit: boolean
  /** Frustration signal from the user's prompt */
  frustration: FrustrationSignal
  /** Cost */
  usage: UsageStats
  /** Per-tool success rates */
  toolSuccessRates: Record<string, { total: number; succeeded: number; rate: number }>
}

/**
 * Compute run metrics from completed agent run data.
 */
export function computeRunMetrics(opts: {
  toolCalls: ToolCallRecord[]
  usage: UsageStats
  durationMs: number
  iterationsUsed: number
  iterationsMax: number
  scenesPlanned: number
  scenesCreated: number
  scenesVerified: number
  userMessage: string
  wasAborted: boolean
  wasPermissionBlocked: boolean
}): RunMetrics {
  const { toolCalls, usage, durationMs, iterationsUsed, iterationsMax } = opts

  // Tool success/failure counts (success is on tc.output.success)
  const toolCallsSucceeded = toolCalls.filter((tc) => tc.output?.success !== false).length
  const toolCallsFailed = toolCalls.filter((tc) => tc.output?.success === false).length
  const hitIterationLimit = iterationsUsed >= iterationsMax

  // Per-tool success rates
  const toolSuccessRates: Record<string, { total: number; succeeded: number; rate: number }> = {}
  for (const tc of toolCalls) {
    if (!toolSuccessRates[tc.toolName]) {
      toolSuccessRates[tc.toolName] = { total: 0, succeeded: 0, rate: 0 }
    }
    toolSuccessRates[tc.toolName].total++
    if (tc.output?.success !== false) toolSuccessRates[tc.toolName].succeeded++
  }
  for (const entry of Object.values(toolSuccessRates)) {
    entry.rate = entry.total > 0 ? entry.succeeded / entry.total : 0
  }

  // Classify outcome
  let outcome: RunOutcome
  if (opts.wasAborted) {
    outcome = 'aborted'
  } else if (opts.wasPermissionBlocked) {
    outcome = 'permission_blocked'
  } else if (opts.scenesPlanned > 0 && opts.scenesCreated >= opts.scenesPlanned) {
    outcome = 'success'
  } else if (opts.scenesCreated > 0) {
    outcome = 'partial'
  } else if (toolCallsSucceeded > 0) {
    outcome = toolCallsFailed > toolCallsSucceeded ? 'failure' : 'partial'
  } else {
    outcome = toolCalls.length === 0 ? 'success' : 'failure' // No tools = text-only response = success
  }

  return {
    outcome,
    durationMs,
    iterationsUsed,
    iterationsMax,
    toolCallsTotal: toolCalls.length,
    toolCallsSucceeded,
    toolCallsFailed,
    scenesPlanned: opts.scenesPlanned,
    scenesCreated: opts.scenesCreated,
    scenesVerified: opts.scenesVerified,
    hitIterationLimit,
    frustration: detectFrustration(opts.userMessage),
    usage,
    toolSuccessRates,
  }
}

/**
 * Serialize run metrics into a compact analysisNotes string
 * for storage in the generation_logs table.
 */
export function serializeRunMetrics(metrics: RunMetrics): string {
  const parts: string[] = []

  parts.push(`outcome=${metrics.outcome}`)
  parts.push(`duration=${(metrics.durationMs / 1000).toFixed(1)}s`)
  parts.push(`iterations=${metrics.iterationsUsed}/${metrics.iterationsMax}`)
  parts.push(`tools=${metrics.toolCallsSucceeded}/${metrics.toolCallsTotal} ok`)

  if (metrics.scenesPlanned > 0) {
    parts.push(`scenes=${metrics.scenesCreated}/${metrics.scenesPlanned} built`)
  }
  if (metrics.scenesVerified > 0) {
    parts.push(`verified=${metrics.scenesVerified}`)
  }
  if (metrics.hitIterationLimit) {
    parts.push('HIT_ITERATION_LIMIT')
  }
  if (metrics.frustration.detected) {
    parts.push(`frustration=${metrics.frustration.level}(${metrics.frustration.triggers.join(',')})`)
  }

  // Flag tools with <50% success rate
  const problematicTools = Object.entries(metrics.toolSuccessRates)
    .filter(([, v]) => v.total >= 2 && v.rate < 0.5)
    .map(([name, v]) => `${name}(${v.succeeded}/${v.total})`)
  if (problematicTools.length > 0) {
    parts.push(`failing_tools=[${problematicTools.join(',')}]`)
  }

  return parts.join(' | ')
}

/**
 * Log run analytics to the agent logger and emit a bucketed product-telemetry
 * event. Call this at the end of every agent run (success or failure).
 *
 * `provider` defaults to 'unknown' so existing callers keep working; pass the
 * resolved provider to attribute the run. The telemetry event carries only
 * bucketed/enum fields (see AgentRunEvent) and no-ops entirely when telemetry
 * is disabled, so this is safe to call unconditionally.
 */
export function logRunAnalytics(logger: AgentLogger, metrics: RunMetrics, provider = 'unknown'): void {
  logger.log('analytics', serializeRunMetrics(metrics), {
    outcome: metrics.outcome,
    frustrationLevel: metrics.frustration.level,
    frustrationScore: metrics.frustration.score,
    toolSuccessRate:
      metrics.toolCallsTotal > 0 ? (metrics.toolCallsSucceeded / metrics.toolCallsTotal).toFixed(2) : 'n/a',
    scenesBuilt: `${metrics.scenesCreated}/${metrics.scenesPlanned}`,
    costUsd: metrics.usage.costUsd.toFixed(4),
  })

  // Product signal: bucketed, PII-free, fire-and-forget (no-op when telemetry off).
  trackAgentRun({
    outcome: metrics.outcome,
    frustrationLevel: metrics.frustration.level,
    costBand: toCostBand(metrics.usage.costUsd),
    durationBand: toDurationBand(metrics.durationMs),
    provider,
  })

  if (metrics.frustration.detected) {
    logger.warn('analytics', `Frustration detected: ${metrics.frustration.level}`, {
      triggers: metrics.frustration.triggers,
      score: metrics.frustration.score,
    })
  }

  if (metrics.hitIterationLimit) {
    logger.warn('analytics', 'Run hit iteration limit — may have incomplete results')
  }

  const failedTools = Object.entries(metrics.toolSuccessRates).filter(([, v]) => v.total >= 2 && v.rate < 0.5)
  if (failedTools.length > 0) {
    logger.warn(
      'analytics',
      `Tools with high failure rate: ${failedTools.map(([n, v]) => `${n}(${v.rate.toFixed(0)}%)`).join(', ')}`,
    )
  }
}
