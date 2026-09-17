// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-agent-usage-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { runMigrations } from './migrate'
import { closeDb, logAgentUsage, getAgentUsageSummary } from './index'

// A fixed "old" timestamp (2023-11-14, unixepoch seconds) for date-range tests.
const OLD_EPOCH = 1700000000

const migrationsFolder = path.resolve(__dirname, './migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  // p1: one successful top-level run + one failed sub-agent run (parentRunId set).
  await logAgentUsage({
    projectId: 'p1',
    agentType: 'scene-maker',
    modelId: 'claude-x',
    provider: 'anthropic',
    outcome: 'success',
    runId: 'r1',
    inputTokens: 100,
    outputTokens: 50,
    apiCalls: 2,
    toolCalls: 3,
    costUsd: 0.01,
    durationMs: 1200,
  })
  await logAgentUsage({
    projectId: 'p1',
    agentType: 'researcher',
    modelId: 'gpt-x',
    provider: 'openai',
    outcome: 'error',
    runId: 'r2',
    parentRunId: 'r1',
    inputTokens: 10,
    outputTokens: 5,
    apiCalls: 1,
    toolCalls: 0,
    costUsd: 0.002,
    durationMs: 300,
  })
  // p2: a minimal call with no optional fields — provider should bucket as 'unknown'.
  await logAgentUsage({
    projectId: 'p2',
    agentType: 'scene-maker',
    modelId: 'm',
    inputTokens: 1,
    outputTokens: 1,
    apiCalls: 1,
    toolCalls: 0,
    costUsd: 0.0001,
    durationMs: 10,
  })
  // p3: an OLD row (2023) inserted raw so we control created_at — drives the
  // date-range filter tests. logAgentUsage always stamps "now", so we bypass it.
  const raw = createClient({ url: process.env.DATABASE_URL as string })
  await raw.execute({
    sql: `INSERT INTO agent_usage
      (id, project_id, agent_type, model_id, input_tokens, output_tokens, api_calls, tool_calls, cost_usd, duration_ms, run_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: ['old1', 'p3', 'scene-maker', 'old-model', 7, 7, 1, 0, 0.005, 100, 'rold', OLD_EPOCH],
  })
  raw.close()
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('getAgentUsageSummary', () => {
  it('aggregates global totals across all projects (3 recent + 1 old = 4 rows)', async () => {
    const s = await getAgentUsageSummary()
    expect(s.totalInputTokens).toBe(118)
    expect(s.totalOutputTokens).toBe(63)
    expect(s.totalApiCalls).toBe(5)
    expect(s.totalToolCalls).toBe(3)
    expect(s.totalRuns).toBe(4)
    expect(s.errorRuns).toBe(1)
    expect(s.totalCostUsd).toBeCloseTo(0.0171, 6)
  })

  it('breaks spend down by provider, bucketing null providers as "unknown"', async () => {
    const s = await getAgentUsageSummary()
    expect(Object.keys(s.byProvider).sort()).toEqual(['anthropic', 'openai', 'unknown'])
    expect(s.byProvider.unknown.count).toBe(2) // p2 + old p3 row, both provider-less
    expect(s.byProvider.anthropic.costUsd).toBeCloseTo(0.01, 6)
  })

  it('breaks spend down by agent type', async () => {
    const s = await getAgentUsageSummary()
    expect(s.byAgent['scene-maker'].count).toBe(3) // p1, p2, p3
    expect(s.byAgent.researcher.count).toBe(1)
  })

  it('breaks spend down by model id', async () => {
    const s = await getAgentUsageSummary()
    expect(Object.keys(s.byModel).sort()).toEqual(['claude-x', 'gpt-x', 'm', 'old-model'])
    expect(s.byModel['claude-x'].count).toBe(1)
    expect(s.byModel['claude-x'].costUsd).toBeCloseTo(0.01, 6)
  })

  it('returns a run drill-down with parent/child correlation, excluding rows with no runId', async () => {
    const s = await getAgentUsageSummary()
    const byId = Object.fromEntries(s.runs.map((r) => [r.runId, r]))
    expect(s.runs.length).toBe(3) // r1, r2, rold — p2 row has no runId so it is excluded
    expect(byId.r1.parentRunId).toBeNull()
    expect(byId.r2.parentRunId).toBe('r1') // sub-agent correlated to parent
    expect(byId.r2.outcome).toBe('error')
  })

  it('aggregates by month (YYYY-MM) from unixepoch-seconds created_at', async () => {
    const s = await getAgentUsageSummary()
    // 3 recent rows in the current month + 1 old row in 2023-11 → at least 2 months.
    expect(s.byMonth.length).toBeGreaterThanOrEqual(2)
    expect(s.byMonth[0].month).toMatch(/^\d{4}-\d{2}$/) // newest first
    expect(s.byMonth.some((m) => m.month === '2023-11')).toBe(true)
    const monthTotal = s.byMonth.reduce((acc, m) => acc + m.count, 0)
    expect(monthTotal).toBe(4)
  })

  it('scopes totals and breakdowns to a single project', async () => {
    const s = await getAgentUsageSummary('p1')
    expect(s.totalRuns).toBe(2)
    expect(s.errorRuns).toBe(1)
    expect(Object.keys(s.byProvider).sort()).toEqual(['anthropic', 'openai'])
    // p2's 'unknown' provider row must not leak into the p1 scope.
    expect(s.byProvider.unknown).toBeUndefined()
  })

  it('date-range filter excludes rows older than the window (regression-class)', async () => {
    // The 2023 row is far outside any recent window; the 3 "now" rows are inside.
    const recent = await getAgentUsageSummary(undefined, { days: 7 })
    expect(recent.totalRuns).toBe(3)
    expect(recent.byMonth.some((m) => m.month === '2023-11')).toBe(false)
    expect(recent.byModel['old-model']).toBeUndefined()
  })

  it('date-range undefined (all time) includes the old row', async () => {
    const all = await getAgentUsageSummary(undefined, undefined)
    expect(all.totalRuns).toBe(4)
    expect(all.byModel['old-model'].count).toBe(1)
  })

  it('combines project + date-range filters', async () => {
    // p3's only row is the old one; a recent window scoped to p3 is empty.
    const p3recent = await getAgentUsageSummary('p3', { days: 7 })
    expect(p3recent.totalRuns).toBe(0)
    const p3all = await getAgentUsageSummary('p3', undefined)
    expect(p3all.totalRuns).toBe(1)
  })
})

/**
 * Prompt-cache accounting.
 *
 * The runner has always collected cache_creation_input_tokens /
 * cache_read_input_tokens off message_start and accumulated them across turns — and
 * then dropped them at the INSERT. That is the single reason every audit of this
 * repo has recorded the cache hit rate as "unmeasured": the caching work in #388 and
 * #402 shipped with no way to tell afterwards whether it did anything.
 */
describe('agent_usage cache token columns', () => {
  it('round-trips the counters the runner already had', async () => {
    await logAgentUsage({
      projectId: 'p-cache',
      agentType: 'scene-maker',
      modelId: 'claude-x',
      provider: 'anthropic',
      outcome: 'success',
      runId: 'r-cache',
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationTokens: 30_000,
      cacheReadTokens: 120_000,
      apiCalls: 4,
      toolCalls: 6,
      costUsd: 0.42,
      durationMs: 5_000,
    })
    const client = createClient({ url: `file:${tmpDb}` })
    const rows = await client.execute({
      sql: 'SELECT cache_creation_tokens, cache_read_tokens FROM agent_usage WHERE run_id = ?',
      args: ['r-cache'],
    })
    client.close()
    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0].cache_creation_tokens)).toBe(30_000)
    expect(Number(rows.rows[0].cache_read_tokens)).toBe(120_000)
  })

  it('records "not reported" as NULL, never as zero', async () => {
    // A provider that reports no cache usage must not be indistinguishable from a run
    // that got zero cache hits — that is the same lie pointing the other way, and it
    // would poison any hit-rate average computed over these rows.
    await logAgentUsage({
      projectId: 'p-cache',
      agentType: 'scene-maker',
      modelId: 'local-model',
      provider: 'local',
      outcome: 'success',
      runId: 'r-nocache',
      inputTokens: 10,
      outputTokens: 5,
      apiCalls: 1,
      toolCalls: 0,
      costUsd: 0,
      durationMs: 10,
    })
    const client = createClient({ url: `file:${tmpDb}` })
    const rows = await client.execute({
      sql: 'SELECT cache_creation_tokens, cache_read_tokens FROM agent_usage WHERE run_id = ?',
      args: ['r-nocache'],
    })
    client.close()
    expect(rows.rows[0].cache_creation_tokens).toBeNull()
    expect(rows.rows[0].cache_read_tokens).toBeNull()
  })

  it('the summary REPORTS them, and counts only the runs that actually reported', async () => {
    // #407 wrote these columns and nothing ever read them: absent from
    // getAgentUsageSummary, its type, and the Usage panel. Both rows above are in
    // p-cache; only one reported, so the "no cache data" run must not be averaged
    // in as a 0% hit rate (NULL is not 0 — sum/count skip it).
    const s = await getAgentUsageSummary('p-cache')
    expect(s.totalCacheCreationTokens).toBe(30_000)
    expect(s.totalCacheReadTokens).toBe(120_000)
    expect(s.totalRuns).toBe(2)
    expect(s.cacheReportingRuns, 'the silent run must not count as a measured 0%').toBe(1)
    // 120k read / 150k cacheable = 80% hit — the number #388/#402 shipped blind.
    const hitRate = s.totalCacheReadTokens / (s.totalCacheReadTokens + s.totalCacheCreationTokens)
    expect(hitRate).toBeCloseTo(0.8, 6)
  })
})
