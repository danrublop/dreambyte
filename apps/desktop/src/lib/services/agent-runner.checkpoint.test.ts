// @vitest-environment node
/**
 * D2 + D9 (v5 T7) — checkpoint lifecycle in the service layer.
 *
 * runAgentRequest used to clear the run checkpoint whenever
 * `resumedCheckpoint && body.projectId` — i.e. a resumed run that stopped at a
 * cap/abort DELETED the very checkpoint it needed to resume again, while a
 * fresh run's completion left a stale snapshot around to clobber newer work.
 *
 * Target state (the lifecycle diagram in agent-runner.ts):
 *   - clear ONLY when stopReason === 'completed' AND scene persistence
 *     succeeded — REGARDLESS of whether the run was a resume (D9: completion
 *     supersedes; no stale snapshot outlives a finished build),
 *   - NEVER clear on cap/abort/stuck stops,
 *   - NEVER clear when persistScenesFromAgentRun failed all retries (the
 *     checkpoint may hold the last durable copy of the work).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentRunStopReason, SSEEvent } from '@/lib/agents/types'

// ── Mocks (vi.hoisted so the factories can share them) ───────────────────────

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

vi.mock('@/lib/db/queries/projects', () => ({
  persistScenesFromAgentRun: h.persistScenesFromAgentRun,
}))

vi.mock('@/lib/db/queries/branch-proposals', () => ({
  getRunCheckpoint: h.getRunCheckpoint,
  clearRunCheckpoint: h.clearRunCheckpoint,
}))

vi.mock('@/lib/db/queries/generation-logs', () => ({
  createGenerationLog: vi.fn(async () => 'genlog-1'),
  updateGenerationLog: vi.fn(async () => undefined),
}))

// Chainable thenable standing in for drizzle's query builder — the service
// fetches project assets + the project row before running the agent.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRunnerResult(stopReason: AgentRunStopReason) {
  return {
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
    fullText: 'done',
    toolCalls: [],
    updatedScenes: [],
    updatedGlobalStyle: { presetId: null },
    updatedSceneGraph: { nodes: [], edges: [] },
    updatedScenePlan: null,
    usage: { inputTokens: 10, outputTokens: 5, apiCalls: 1, costUsd: 0.001, totalDurationMs: 5 },
    logger: { runId: 'svc-test-run', getTrace: () => [] },
    stopReason,
  }
}

function makeCheckpoint() {
  return {
    runId: 'prior-run',
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
    scenePlan: {
      title: 't',
      scenes: [{ name: 'Scene 1', purpose: 'p', sceneType: 'react', duration: 8 }],
      totalDuration: 8,
    },
    completedSceneIds: ['s1'],
    remainingSceneIndexes: [],
    progress: { scenesCreated: ['s1'] },
    worldSnapshot: { scenes: [], globalStyle: { presetId: null }, sceneGraph: { nodes: [], edges: [] } },
    originalMessage: 'build it',
    partialUsage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
    createdAt: new Date().toISOString(),
    reason: 'cost-cap',
  }
}

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

beforeEach(() => {
  h.runAgent.mockReset()
  h.persistScenesFromAgentRun.mockReset().mockResolvedValue(true)
  h.getRunCheckpoint.mockReset().mockResolvedValue(null)
  h.clearRunCheckpoint.mockReset().mockResolvedValue(undefined)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkpoint lifecycle (D2 + D9)', () => {
  it('resumed run stopping at a cap RETAINS the checkpoint (used to delete it)', async () => {
    h.getRunCheckpoint.mockResolvedValue(makeCheckpoint())
    h.runAgent.mockResolvedValue(makeRunnerResult('cost_cap'))
    await run(makeBody({ resumeCheckpoint: true }))
    expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
  })

  it.each(['tool_call_cap', 'round_cap', 'aborted', 'stuck_invalid_args'] as AgentRunStopReason[])(
    'resumed run stopping with %s retains the checkpoint',
    async (stopReason) => {
      h.getRunCheckpoint.mockResolvedValue(makeCheckpoint())
      h.runAgent.mockResolvedValue(makeRunnerResult(stopReason))
      await run(makeBody({ resumeCheckpoint: true }))
      expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
    },
  )

  it('FRESH run completion clears the (projectId, branchId) slot (D9: completion supersedes)', async () => {
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody())
    expect(h.clearRunCheckpoint).toHaveBeenCalledTimes(1)
    expect(h.clearRunCheckpoint).toHaveBeenCalledWith('proj-svc', null)
  })

  it('[REGRESSION] resumed run completion still clears the checkpoint', async () => {
    h.getRunCheckpoint.mockResolvedValue(makeCheckpoint())
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody({ resumeCheckpoint: true }))
    expect(h.clearRunCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('CRITICAL corner: completion with persist-failed-all-retries NEVER clears (last durable copy)', async () => {
    h.getRunCheckpoint.mockResolvedValue(makeCheckpoint())
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    h.persistScenesFromAgentRun.mockResolvedValue(false) // fails all 3 attempts
    const events = await run(makeBody({ resumeCheckpoint: true }))
    expect(h.persistScenesFromAgentRun).toHaveBeenCalledTimes(3)
    expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
    // The user is told persistence failed (pre-existing warning behavior).
    expect(events.some((e) => e.type === 'warning' && /could not be saved/.test(e.message ?? ''))).toBe(true)
  })

  // ── P1: resume seeds the cost ledger from the checkpoint's prior spend ───────
  // Without this, a run stopped at the $5 cap got a fresh $5 budget on resume,
  // so stop→resume loops spent N× the ceiling. We assert the seed (resumeSpentUsd)
  // threaded into runAgent equals the checkpoint's partialUsage.costUsd.
  it('resumed run seeds runAgent with resumeSpentUsd = checkpoint.partialUsage.costUsd', async () => {
    const cp = makeCheckpoint()
    cp.partialUsage.costUsd = 4.8
    h.getRunCheckpoint.mockResolvedValue(cp)
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody({ resumeCheckpoint: true }))
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(h.runAgent.mock.calls[0][0]).toMatchObject({ resumeSpentUsd: 4.8 })
  })

  it('a fresh (non-resume) run seeds runAgent with resumeSpentUsd = 0', async () => {
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody())
    expect(h.runAgent.mock.calls[0][0]).toMatchObject({ resumeSpentUsd: 0 })
  })

  it('resume with a missing/NaN checkpoint cost falls back to resumeSpentUsd = 0', async () => {
    const cp = makeCheckpoint()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cp.partialUsage as any).costUsd = NaN
    h.getRunCheckpoint.mockResolvedValue(cp)
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody({ resumeCheckpoint: true }))
    expect(h.runAgent.mock.calls[0][0]).toMatchObject({ resumeSpentUsd: 0 })
  })

  it('runner rejection (stopReason rides the error) never clears the checkpoint', async () => {
    h.getRunCheckpoint.mockResolvedValue(makeCheckpoint())
    const err = Object.assign(new Error('boom'), { _stopReason: 'error', _agentHandled: true })
    h.runAgent.mockRejectedValue(err)
    await run(makeBody({ resumeCheckpoint: true }))
    expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
  })

  it('no projectId → no clear attempted (nothing to scope the slot to)', async () => {
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody({ projectId: undefined }))
    expect(h.clearRunCheckpoint).not.toHaveBeenCalled()
  })
})

// Resume used to be silently lossy: the runner got a one-sentence synthetic
// prompt ("Continue building the video. 1 of 1 scenes are already built.") and
// nothing told the user that the conversation, their reference media, and every
// rendered frame the agent had looked at were gone. Two halves to the fix — carry
// what can be carried (a bounded text digest), and SAY what can't.
describe('resume honesty (I2)', () => {
  it('replays the checkpoint conversation digest into the resumed run', async () => {
    h.getRunCheckpoint.mockResolvedValue({
      ...makeCheckpoint(),
      conversationDigest: 'USER: build a 3-scene explainer\nASSISTANT: [tool_use create_scene] {"name":"Scene 1"}',
    })
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    await run(makeBody({ resumeCheckpoint: true, message: 'Resume interrupted build' }))

    const msg = h.runAgent.mock.calls[0][0].message as string
    expect(msg).toContain('build a 3-scene explainer')
    expect(msg).toContain('create_scene')
    expect(msg).toContain('<prior_run_transcript>')
    // Still carries the resume instruction — the digest is context, not a re-do order.
    expect(msg).toContain('Continue building the video')
  })

  it('warns the user what a resume could NOT restore', async () => {
    h.getRunCheckpoint.mockResolvedValue({ ...makeCheckpoint(), conversationDigest: 'USER: hi' })
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    const events = await run(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeBody({ resumeCheckpoint: true, referenceMedia: [{ url: 'dreambyte://uploads/a.png' }] as any }),
    )
    const warning = events.find((e) => e.type === 'warning' && typeof e.message === 'string' && /Resuming from a saved checkpoint/.test(e.message))
    expect(warning, 'resume must announce itself').toBeTruthy()
    expect((warning as { message: string }).message).toContain('rendered scene frames')

    // This used to assert the warning named reference media as LOST, pinning a
    // bug: the resume path hard-dropped body.referenceMedia while the same
    // message told the user to "Re-attach anything the agent still needs" — an
    // unescapable loop. Media attached to THIS request now reaches the runner,
    // so it is not lost and must not be announced as such.
    expect(h.runAgent.mock.calls[0][0].referenceMedia).toEqual([{ url: 'dreambyte://uploads/a.png' }])
    expect((warning as { message: string }).message).not.toContain('reference media attached to the earlier run')
  })

  it('names the earlier run’s media as lost when nothing is attached now', async () => {
    h.getRunCheckpoint.mockResolvedValue({ ...makeCheckpoint(), conversationDigest: 'USER: hi' })
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    const events = await run(makeBody({ resumeCheckpoint: true }))
    const warning = events.find((e) => e.type === 'warning' && typeof e.message === 'string' && /Resuming from a saved checkpoint/.test(e.message))
    expect((warning as { message: string }).message).toContain('reference media attached to the earlier run')
  })

  it('says so when a checkpoint predates digest capture, instead of implying history came back', async () => {
    h.getRunCheckpoint.mockResolvedValue(makeCheckpoint()) // no conversationDigest
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    const events = await run(makeBody({ resumeCheckpoint: true }))
    const warning = events.find((e) => e.type === 'warning' && typeof e.message === 'string' && /Resuming from a saved checkpoint/.test(e.message)) as {
      message: string
    }
    expect(warning.message).toContain('predates digest capture')
    // …and no empty transcript block is injected.
    expect(h.runAgent.mock.calls[0][0].message).not.toContain('<prior_run_transcript>')
  })

  it('Resume with no checkpoint on file tells the user it is starting fresh (used to be a silent rebuild + rebill)', async () => {
    h.getRunCheckpoint.mockResolvedValue(null)
    h.runAgent.mockResolvedValue(makeRunnerResult('completed'))
    const events = await run(makeBody({ resumeCheckpoint: true }))
    expect(events.some((e) => e.type === 'warning' && typeof e.message === 'string' && /No saved checkpoint was found/.test(e.message))).toBe(true)
  })
})
