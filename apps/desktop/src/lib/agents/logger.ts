/**
 * Structured agent logger with correlation ID for Dreambyte.
 *
 * Creates a run-scoped logger that:
 * - Tags every console line with [run:XXXX] for grep-ability
 * - Accumulates a structured trace (array of timestamped events)
 * - Returns the trace for DB persistence in generation_logs.run_trace
 */

import { v4 as uuidv4 } from 'uuid'

export interface TraceEvent {
  ts: number // ms since run start
  level: 'info' | 'warn' | 'error'
  phase: string // route, context, iteration, tool, generation, done, error
  message: string
  data?: Record<string, unknown>
}

export interface TraceSummary {
  runId: string
  totalMs: number
  iterations: number
  toolCalls: number
  errors: number
  phases: Record<string, number> // phase → total ms spent
}

export class AgentLogger {
  readonly runId: string
  readonly shortId: string
  readonly startTime: number
  private events: TraceEvent[] = []
  private phaseTimers: Map<string, number> = new Map()

  constructor(runId?: string) {
    this.runId = runId ?? uuidv4()
    this.shortId = this.runId.slice(0, 8)
    this.startTime = Date.now()
  }

  private elapsed(): number {
    return Date.now() - this.startTime
  }

  private push(level: 'info' | 'warn' | 'error', phase: string, message: string, data?: Record<string, unknown>) {
    const event: TraceEvent = { ts: this.elapsed(), level, phase, message }
    if (data) event.data = data
    this.events.push(event)

    const prefix = `[run:${this.shortId}][${phase}]`
    const suffix = data ? ` ${JSON.stringify(data)}` : ''
    if (level === 'error') {
      console.error(`${prefix} ${message}${suffix}`)
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}${suffix}`)
    } else {
      console.log(`${prefix} ${message}${suffix}`)
    }
  }

  log(phase: string, message: string, data?: Record<string, unknown>) {
    this.push('info', phase, message, data)
  }

  warn(phase: string, message: string, data?: Record<string, unknown>) {
    this.push('warn', phase, message, data)
  }

  error(phase: string, message: string, data?: Record<string, unknown>) {
    this.push('error', phase, message, data)
  }

  /** Start a timer for a phase. Call endPhase() to record duration. */
  startPhase(phase: string) {
    this.phaseTimers.set(phase, Date.now())
  }

  /** End a phase timer and return elapsed ms. */
  endPhase(phase: string): number {
    const start = this.phaseTimers.get(phase)
    if (!start) return 0
    this.phaseTimers.delete(phase)
    return Date.now() - start
  }

  /** Get the full trace for DB persistence. */
  getTrace(): TraceEvent[] {
    return this.events
  }

  /** Get a compact summary for quick inspection. */
  getSummary(): TraceSummary {
    const totalMs = this.elapsed()
    let iterations = 0
    let toolCalls = 0
    let errors = 0
    const phases: Record<string, number> = {}

    for (const e of this.events) {
      if (e.phase === 'iteration' && e.message.startsWith('Start')) iterations++
      if (e.phase === 'tool' && e.message.startsWith('Complete')) toolCalls++
      if (e.level === 'error') errors++
      // Accumulate durations from data.durationMs
      if (e.data?.durationMs && typeof e.data.durationMs === 'number') {
        phases[e.phase] = (phases[e.phase] ?? 0) + e.data.durationMs
      }
    }

    return { runId: this.runId, totalMs, iterations, toolCalls, errors, phases }
  }
}
