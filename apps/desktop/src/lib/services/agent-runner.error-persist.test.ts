// @vitest-environment node
/**
 * A1 (v6 T2) — the service persists the live world on the runner's error path.
 *
 * Before T2: persist sat inside the success try; the service catch never
 * persisted, so a run that threw after building real scenes dropped the work.
 * runAgent now attaches the live world to its rejection (`_worldScenes` +
 * `_world`); the service catch persists those through the SAME retry path the
 * success path uses (and through the A0 placeholder guard inside
 * persistScenesFromAgentRun).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SSEEvent } from '@/lib/agents/types'

const h = vi.hoisted(() => {
  const runAgent = vi.fn()
  const persistScenesFromAgentRun = vi.fn(async () => true)
  const getRunCheckpoint = vi.fn(async () => null as unknown)
  const clearRunCheckpoint = vi.fn(async () => undefined)
  return { runAgent, persistScenesFromAgentRun, getRunCheckpoint, clearRunCheckpoint }
})

vi.mock('@/lib/agents/runner', () => ({
  runAgent: h.runAgent,
  DEFAULT_RUN_CONFIG: { maxToolIterations: 40 },
}))
vi.mock('@/lib/db/queries/projects', () => ({ persistScenesFromAgentRun: h.persistScenesFromAgentRun }))
vi.mock('@/lib/db/queries/branch-proposals', () => ({
  getRunCheckpoint: h.getRunCheckpoint,
  clearRunCheckpoint: h.clearRunCheckpoint,
}))
vi.mock('@/lib/db/queries/generation-logs', () => ({
  createGenerationLog: vi.fn(async () => 'genlog-1'),
  updateGenerationLog: vi.fn(async () => undefined),
}))
vi.mock('@/lib/db', () => {
  const chain = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = Promise.resolve([])
    p.from = () => p
    p.where = () => p
    p.orderBy = () => p
    p.limit = () => p
    return p
  }
  return { db: { select: () => chain() } }
})
vi.mock('@/lib/db/queries/user-memory', () => ({
  getMemoriesScoped: vi.fn(async () => []),
  upsertMemory: vi.fn(async () => undefined),
  adjustMemoryKeyConfidence: vi.fn(async () => 0),
}))
vi.mock('@/lib/agents/memory-extractor', () => ({ extractMemories: vi.fn(() => []) }))
vi.mock('@/lib/agents/semantic-memory', () => ({ extractSemanticMemories: vi.fn(async () => []) }))
vi.mock('@/lib/agents/built-in-hooks', () => ({ registerBuiltInHooks: vi.fn() }))
vi.mock('@/lib/agents/mock-agent-stream', () => ({ runMockAgentStream: vi.fn(async () => undefined) }))
vi.mock('@/lib/agents/run-analytics', () => ({
  detectFrustration: vi.fn(() => ({ detected: false, level: 0, triggers: [] })),
  computeRunMetrics: vi.fn(() => ({})),
  logRunAnalytics: vi.fn(),
  serializeRunMetrics: vi.fn(() => ''),
}))
vi.mock('@/lib/agents/logger', () => {
  class SilentLogger {
    runId = 'svc-test-run'
    constructor(runId?: string) {
      if (runId) this.runId = runId
    }
    log() {}
    warn() {}
    error() {}
    debug() {}
    getTrace() {
      return []
    }
  }
  return { AgentLogger: SilentLogger }
})
vi.mock('@/lib/logger', () => {
  const noop = () => {}
  const stub = { debug: noop, log: noop, info: noop, warn: noop, error: noop }
  return { createLogger: () => stub }
})

import { runAgentRequest, type AgentAPIRequest } from './agent-runner'

function makeBody(overrides: Partial<AgentAPIRequest> = {}): AgentAPIRequest {
  return {
    message: 'hello',
    scenes: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalStyle: { presetId: null } as any,
    projectName: 'svc-test',
    outputMode: 'mp4',
    projectId: 'proj-svc',
    branchId: null,
    ...overrides,
  }
}

async function run(body: AgentAPIRequest): Promise<SSEEvent[]> {
  const events: SSEEvent[] = []
  await runAgentRequest({
    body,
    authenticatedUserId: null,
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
  })
  return events
}

function rejectionWithWorld(scenes: unknown[]) {
  return Object.assign(new Error('provider exploded'), {
    _stopReason: 'error',
    _agentHandled: true,
    _worldScenes: scenes,
    _world: { globalStyle: { presetId: 'whiteboard' }, sceneGraph: { nodes: [{ id: 'n1' }], edges: [] } },
  })
}

beforeEach(() => {
  h.runAgent.mockReset()
  h.persistScenesFromAgentRun.mockReset().mockResolvedValue(true)
  h.getRunCheckpoint.mockReset().mockResolvedValue(null)
  h.clearRunCheckpoint.mockReset().mockResolvedValue(undefined)
})

describe('A1 (T2) — error-path persist', () => {
  it('persists the live world scenes attached to the rejection', async () => {
    h.runAgent.mockRejectedValue(rejectionWithWorld([{ id: 's1', reactCode: 'REAL' }]))
    await run(makeBody())
    expect(h.persistScenesFromAgentRun).toHaveBeenCalledTimes(1)
    const [projectId, payload, branchId] = h.persistScenesFromAgentRun.mock.calls[0] as unknown as [
      string,
      any,
      string | null,
    ]
    expect(projectId).toBe('proj-svc')
    expect(branchId).toBe(null)
    expect((payload as any).scenes).toEqual([{ id: 's1', reactCode: 'REAL' }])
    expect((payload as any).globalStyle).toEqual({ presetId: 'whiteboard' })
    expect((payload as any).sceneGraph).toEqual({ nodes: [{ id: 'n1' }], edges: [] })
  })

  it('still emits an error event AND never clears the checkpoint on the error path', async () => {
    h.getRunCheckpoint.mockResolvedValue(null)
    h.runAgent.mockRejectedValue(rejectionWithWorld([{ id: 's1', reactCode: 'REAL' }]))
    const events = await run(makeBody())
    // _agentHandled means runAgent already emitted the error; the service must not double-emit.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
  })

  it('does NOT persist when the rejection carries no world (failure before setup)', async () => {
    h.runAgent.mockRejectedValue(Object.assign(new Error('early boom'), { _stopReason: 'error', _agentHandled: true }))
    await run(makeBody())
    expect(h.persistScenesFromAgentRun).not.toHaveBeenCalled()
  })

  it('does NOT persist when the world has zero scenes', async () => {
    h.runAgent.mockRejectedValue(rejectionWithWorld([]))
    await run(makeBody())
    expect(h.persistScenesFromAgentRun).not.toHaveBeenCalled()
  })

  it('retries the error-path persist up to 3 times when it keeps failing', async () => {
    h.runAgent.mockRejectedValue(rejectionWithWorld([{ id: 's1', reactCode: 'REAL' }]))
    h.persistScenesFromAgentRun.mockResolvedValue(false)
    await run(makeBody())
    expect(h.persistScenesFromAgentRun).toHaveBeenCalledTimes(3)
  })

  it('A3: emits persist_done on the error path so the renderer can wait (out-of-band-forwarded)', async () => {
    h.runAgent.mockRejectedValue(rejectionWithWorld([{ id: 's1', reactCode: 'REAL' }]))
    const events = await run(makeBody())
    const pd = events.find((e) => e.type === 'persist_done')
    expect(pd).toBeTruthy()
    expect(pd!.runId).toBeTruthy()
    expect(pd!.persistOk).toBe(true) // persist succeeded
  })

  it('A3: emits persist_done (persistOk:false) on the error path even when nothing was persisted', async () => {
    // No world on the rejection → nothing to persist, but the renderer still
    // needs the signal so its refresh stops waiting (routes to version-poll).
    h.runAgent.mockRejectedValue(Object.assign(new Error('early'), { _stopReason: 'error', _agentHandled: true }))
    const events = await run(makeBody())
    const pd = events.find((e) => e.type === 'persist_done')
    expect(pd).toBeTruthy()
    expect(pd!.persistOk).toBe(false)
  })

  it('A3: emits persist_done on the SUCCESS path too', async () => {
    h.runAgent.mockResolvedValue({
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      fullText: 'ok',
      toolCalls: [],
      updatedScenes: [{ id: 's1', reactCode: 'REAL' }],
      updatedGlobalStyle: { presetId: null },
      updatedSceneGraph: { nodes: [], edges: [] },
      updatedScenePlan: null,
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      logger: { runId: 'svc-test-run', getTrace: () => [] },
      stopReason: 'completed',
    })
    const events = await run(makeBody())
    const pd = events.find((e) => e.type === 'persist_done')
    expect(pd).toBeTruthy()
    expect(pd!.persistOk).toBe(true)
  })

  it('[REGRESSION] success path still persists exactly once (unchanged)', async () => {
    h.runAgent.mockResolvedValue({
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      fullText: 'ok',
      toolCalls: [],
      updatedScenes: [{ id: 's1', reactCode: 'REAL' }],
      updatedGlobalStyle: { presetId: null },
      updatedSceneGraph: { nodes: [], edges: [] },
      updatedScenePlan: null,
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      logger: { runId: 'svc-test-run', getTrace: () => [] },
      stopReason: 'completed',
    })
    await run(makeBody())
    expect(h.persistScenesFromAgentRun).toHaveBeenCalledTimes(1)
  })
})
