// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the telemetry transport so the hook can be asserted without a network
// call or real opt-in state. Must be declared before importing run-analytics.
vi.mock('../telemetry', () => ({ trackAgentRun: vi.fn() }))

import { detectFrustration, computeRunMetrics, logRunAnalytics, type RunMetrics } from './run-analytics'
import { toCostBand, toDurationBand } from '../agent-run-event'
import { trackAgentRun } from '../telemetry'
import type { ToolCallRecord, UsageStats } from './types'

const USAGE: UsageStats = {
  inputTokens: 100,
  outputTokens: 50,
  apiCalls: 1,
  costUsd: 0.02,
  totalDurationMs: 1000,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
}

function tool(name: string, success: boolean): ToolCallRecord {
  return { toolName: name, input: {}, output: { success } } as unknown as ToolCallRecord
}

const baseMetricsOpts = {
  toolCalls: [] as ToolCallRecord[],
  usage: USAGE,
  durationMs: 1000,
  iterationsUsed: 1,
  iterationsMax: 15,
  scenesPlanned: 0,
  scenesCreated: 0,
  scenesVerified: 0,
  userMessage: 'make a scene',
  wasAborted: false,
  wasPermissionBlocked: false,
}

describe('detectFrustration', () => {
  it('returns none for a calm message', () => {
    const s = detectFrustration('please add a title scene')
    expect(s.detected).toBe(false)
    expect(s.level).toBe('none')
    expect(s.score).toBe(0)
  })

  it.each([
    ['explicit_language', 'what the fuck is this'],
    ['exasperation', 'ugh this again omg'],
    ['stuck_pattern', "it's still not working"],
    ['negative_quality', 'this looks terrible'],
    ['shouting', 'WHY IS THIS BROKEN AGAIN'],
    ['excessive_punctuation', 'fix it???'],
  ])('flags %s', (trigger, message) => {
    const s = detectFrustration(message)
    expect(s.detected).toBe(true)
    expect(s.triggers).toContain(trigger)
    expect(s.score).toBeGreaterThan(0)
  })

  it('escalates level with stacked signals and clamps score at 1', () => {
    const mild = detectFrustration('fix it???') // punctuation only, 0.1
    expect(mild.level).toBe('mild')
    const high = detectFrustration('fuck this is still not working, looks terrible!!!')
    expect(high.level).toBe('high')
    expect(high.score).toBeLessThanOrEqual(1)
  })
})

describe('computeRunMetrics — outcome classification (all 5 states)', () => {
  it('aborted wins over everything', () => {
    const m = computeRunMetrics({ ...baseMetricsOpts, wasAborted: true, scenesPlanned: 1, scenesCreated: 1 })
    expect(m.outcome).toBe('aborted')
  })

  it('permission_blocked when flagged (and not aborted)', () => {
    const m = computeRunMetrics({ ...baseMetricsOpts, wasPermissionBlocked: true })
    expect(m.outcome).toBe('permission_blocked')
  })

  it('success when all planned scenes were built', () => {
    const m = computeRunMetrics({ ...baseMetricsOpts, scenesPlanned: 2, scenesCreated: 2 })
    expect(m.outcome).toBe('success')
  })

  it('partial when some but not all planned scenes were built', () => {
    const m = computeRunMetrics({ ...baseMetricsOpts, scenesPlanned: 3, scenesCreated: 1 })
    expect(m.outcome).toBe('partial')
  })

  it('failure when tools ran but mostly failed and no scenes built', () => {
    const m = computeRunMetrics({
      ...baseMetricsOpts,
      toolCalls: [tool('write_scene_code', false), tool('write_scene_code', false), tool('verify_scene', true)],
    })
    expect(m.outcome).toBe('failure')
  })

  it('success for a text-only response (no tools, no scenes)', () => {
    const m = computeRunMetrics({ ...baseMetricsOpts, toolCalls: [] })
    expect(m.outcome).toBe('success')
  })
})

describe('computeRunMetrics — per-tool success rates', () => {
  it('computes per-tool rate and counts at boundaries', () => {
    const m = computeRunMetrics({
      ...baseMetricsOpts,
      toolCalls: [tool('a', true), tool('a', false), tool('b', true)],
    })
    expect(m.toolSuccessRates.a).toEqual({ total: 2, succeeded: 1, rate: 0.5 })
    expect(m.toolSuccessRates.b).toEqual({ total: 1, succeeded: 1, rate: 1 })
    expect(m.toolCallsSucceeded).toBe(2)
    expect(m.toolCallsFailed).toBe(1)
  })

  it('treats missing output.success as a success (only explicit false is a failure)', () => {
    const noOutput = { toolName: 'c', input: {} } as unknown as ToolCallRecord
    const m = computeRunMetrics({ ...baseMetricsOpts, toolCalls: [noOutput] })
    expect(m.toolSuccessRates.c.rate).toBe(1)
    expect(m.toolCallsFailed).toBe(0)
  })
})

describe('cost / duration bucketers', () => {
  it.each([
    [0, 'free'],
    [-1, 'free'],
    [NaN, 'free'],
    [0.005, 'lt_1c'],
    [0.05, 'lt_10c'],
    [0.5, 'lt_1d'],
    [5, 'gte_1d'],
  ])('toCostBand(%s) = %s', (cost, band) => {
    expect(toCostBand(cost as number)).toBe(band)
  })

  it.each([
    [1000, 'lt_5s'],
    [10_000, 'lt_30s'],
    [60_000, 'lt_2m'],
    [200_000, 'lt_5m'],
    [600_000, 'gte_5m'],
  ])('toDurationBand(%s) = %s', (ms, band) => {
    expect(toDurationBand(ms as number)).toBe(band)
  })
})

describe('logRunAnalytics telemetry hook', () => {
  const logger = { log: vi.fn(), warn: vi.fn() } as unknown as Parameters<typeof logRunAnalytics>[0]

  beforeEach(() => {
    vi.mocked(trackAgentRun).mockClear()
  })

  it('fires a bucketed AgentRunEvent with the resolved provider', () => {
    const metrics = computeRunMetrics({
      ...baseMetricsOpts,
      usage: { ...USAGE, costUsd: 0.42 },
      durationMs: 65_000,
      scenesPlanned: 1,
      scenesCreated: 1,
    }) as RunMetrics
    logRunAnalytics(logger, metrics, 'anthropic')
    expect(trackAgentRun).toHaveBeenCalledTimes(1)
    expect(trackAgentRun).toHaveBeenCalledWith({
      outcome: 'success',
      frustrationLevel: 'none',
      costBand: 'lt_1d',
      durationBand: 'lt_2m',
      provider: 'anthropic',
    })
  })

  it("defaults provider to 'unknown' when omitted", () => {
    const metrics = computeRunMetrics(baseMetricsOpts) as RunMetrics
    logRunAnalytics(logger, metrics)
    expect(trackAgentRun).toHaveBeenCalledWith(expect.objectContaining({ provider: 'unknown' }))
  })
})
