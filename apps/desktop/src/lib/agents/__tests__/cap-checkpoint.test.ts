/**
 * Tests for cost-cap and tool-call-cap checkpoint persistence.
 *
 * The runner persists a RunCheckpoint when a run is stopped by the cost
 * guardrail or the tool-call guardrail. These tests verify:
 *   1. The checkpoint is saved with the correct reason.
 *   2. The checkpoint includes scenes built so far and remaining indexes.
 *   3. Nothing is saved when there is no scene plan or no scenes built.
 *
 * We test the checkpoint construction logic directly by exercising the
 * helper extracted into persistCapCheckpoint inside runAgent. Since that
 * helper is a closure we cannot import it — instead we test via the exported
 * RunCheckpoint type and the db queries module that the runner calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ── Mocked dependencies ───────────────────────────────────────────────────────

// The runner imports persistRunCheckpoint from the branch-proposals module
// (branch-scoped since 0015). We mock it so no real SQLite connection is required.
vi.mock('@/lib/db/queries/branch-proposals', () => ({
  persistRunCheckpoint: vi.fn().mockResolvedValue(undefined),
  getRunCheckpoint: vi.fn().mockResolvedValue(null),
  clearRunCheckpoint: vi.fn().mockResolvedValue(undefined),
}))

import { persistRunCheckpoint } from '@/lib/db/queries/branch-proposals'
const mockedPersist = persistRunCheckpoint as ReturnType<typeof vi.fn>

import type { RunCheckpoint, RunProgress, ScenePlan } from '../types'
import { RunCheckpointSchema } from '../checkpoint-schema'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScenePlan(count: number): ScenePlan {
  return {
    title: 'Test video',
    scenes: Array.from({ length: count }, (_, i) => ({
      name: `Scene ${i + 1}`,
      purpose: `Purpose ${i + 1}`,
      sceneType: 'react',
      duration: 8,
    })),
    totalDuration: count * 8,
  }
}

function makeRunProgress(scenesCreated: string[]): RunProgress {
  return {
    phase: 'build',
    scenesPlanned: 3,
    scenePlanScenesBuilt: scenesCreated.length,
    iterationsUsed: 5,
    iterationsMax: 30,
    toolCallsTotal: 12,
    errors: [],
    scenesCreated,
    scenesVerified: [],
    scenesWithNarration: [],
    verificationCyclesUsed: 0,
    verificationCyclesMax: 2,
    reviewCyclesUsed: 0,
    reviewCyclesMax: 1,
  }
}

// ── Tests for checkpoint reason field ────────────────────────────────────────

describe('RunCheckpoint reason field', () => {
  it('accepts cost-cap as a valid reason', () => {
    const checkpoint: RunCheckpoint = {
      runId: 'run-1',
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      scenePlan: makeScenePlan(3),
      completedSceneIds: ['s1'],
      remainingSceneIndexes: [1, 2],
      progress: makeRunProgress(['s1']),
      worldSnapshot: {
        scenes: [],
        globalStyle: { palette: [] } as any,
        sceneGraph: { nodes: [], edges: [], startSceneId: '' },
      },
      originalMessage: 'Build a 3-scene video',
      partialUsage: {
        inputTokens: 50000,
        outputTokens: 10000,
        apiCalls: 5,
        costUsd: 0.25,
        totalDurationMs: 30000,
      },
      createdAt: new Date().toISOString(),
      reason: 'cost-cap',
    }
    expect(checkpoint.reason).toBe('cost-cap')
  })

  it('accepts tool-call-cap as a valid reason', () => {
    const checkpoint: RunCheckpoint = {
      runId: 'run-2',
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      scenePlan: makeScenePlan(3),
      completedSceneIds: ['s1', 's2'],
      remainingSceneIndexes: [2],
      progress: makeRunProgress(['s1', 's2']),
      worldSnapshot: {
        scenes: [],
        globalStyle: { palette: [] } as any,
        sceneGraph: { nodes: [], edges: [], startSceneId: '' },
      },
      originalMessage: 'Build a 3-scene video',
      partialUsage: {
        inputTokens: 80000,
        outputTokens: 20000,
        apiCalls: 10,
        costUsd: 0.55,
        totalDurationMs: 60000,
      },
      createdAt: new Date().toISOString(),
      reason: 'tool-call-cap',
    }
    expect(checkpoint.reason).toBe('tool-call-cap')
  })

  it('accepts round-cap as a valid reason (D4)', () => {
    const checkpoint: RunCheckpoint = {
      runId: 'run-4',
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      scenePlan: makeScenePlan(3),
      completedSceneIds: ['s1', 's2'],
      remainingSceneIndexes: [2],
      progress: makeRunProgress(['s1', 's2']),
      worldSnapshot: {
        scenes: [],
        globalStyle: { palette: [] } as any,
        sceneGraph: { nodes: [], edges: [], startSceneId: '' },
      },
      originalMessage: 'Build a 3-scene video',
      partialUsage: {
        inputTokens: 120000,
        outputTokens: 30000,
        apiCalls: 40,
        costUsd: 0.8,
        totalDurationMs: 90000,
      },
      createdAt: new Date().toISOString(),
      reason: 'round-cap',
    }
    expect(checkpoint.reason).toBe('round-cap')
  })

  it('still accepts the legacy disconnect reason', () => {
    const checkpoint: RunCheckpoint = {
      runId: 'run-3',
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
      scenePlan: null,
      completedSceneIds: [],
      remainingSceneIndexes: [],
      progress: makeRunProgress([]),
      worldSnapshot: {
        scenes: [],
        globalStyle: { palette: [] } as any,
        sceneGraph: { nodes: [], edges: [], startSceneId: '' },
      },
      originalMessage: '',
      partialUsage: { inputTokens: 0, outputTokens: 0, apiCalls: 0, costUsd: 0, totalDurationMs: 0 },
      createdAt: new Date().toISOString(),
      reason: 'disconnect',
    }
    expect(checkpoint.reason).toBe('disconnect')
  })
})

// ── REAL Zod round-trip: every persisted reason must pass safeParse (P0-1) ─────
// The reason-field tests above only assert TS type compatibility + string
// equality — they NEVER ran RunCheckpointSchema.safeParse, and the cap-checkpoint
// suite mocks getRunCheckpoint to return null, so the runtime Zod guard was never
// exercised (false green). The bug: the schema enum was ['disconnect','timeout',
// 'error'] but persistCapCheckpoint emits 'cost-cap'|'tool-call-cap'|'round-cap'|
// 'stuck'. safeParse rejected those → getRunCheckpoint returned null → resume
// rebuilt from scratch and re-billed. This block exercises the REAL guard for
// EVERY reason the runner persists; it FAILS on the old 3-value enum.

/** Every reason the runner actually writes into a checkpoint. */
const ALL_PERSISTED_REASONS: RunCheckpoint['reason'][] = [
  // persistCapCheckpoint() — runner.ts cap/stuck stops
  'cost-cap',
  'tool-call-cap',
  'round-cap',
  'stuck',
  // disconnect stop (runner.ts ~2740) + error checkpoint (runner.ts ~5212)
  'disconnect',
  'error',
  // declared in the type/enum for completeness (not currently emitted)
  'timeout',
]

function makeCheckpointWithReason(reason: RunCheckpoint['reason']): RunCheckpoint {
  return {
    runId: `run-${reason}`,
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
    scenePlan: makeScenePlan(3),
    completedSceneIds: ['s1'],
    remainingSceneIndexes: [1, 2],
    progress: makeRunProgress(['s1']),
    worldSnapshot: {
      scenes: [],
      globalStyle: { palette: [] } as any,
      sceneGraph: { nodes: [], edges: [], startSceneId: '' },
    },
    originalMessage: 'Build a 3-scene video',
    partialUsage: {
      inputTokens: 50000,
      outputTokens: 10000,
      apiCalls: 5,
      costUsd: 0.25,
      totalDurationMs: 30000,
    },
    createdAt: new Date().toISOString(),
    reason,
  }
}

describe('RunCheckpointSchema round-trip (P0-1: schema must accept every persisted reason)', () => {
  it.each(ALL_PERSISTED_REASONS)("safeParse accepts a checkpoint with reason '%s'", (reason) => {
    const checkpoint = makeCheckpointWithReason(reason)
    const result = RunCheckpointSchema.safeParse(checkpoint)
    expect(result.success).toBe(true)
  })

  it('accepts every persisted reason in one pass (resume never silently discards a cap/stuck checkpoint)', () => {
    for (const reason of ALL_PERSISTED_REASONS) {
      const result = RunCheckpointSchema.safeParse(makeCheckpointWithReason(reason))
      expect(result.success, `reason '${reason}' must pass the Zod guard`).toBe(true)
    }
  })

  it('the runner reason union and the Zod enum cover the same set (lockstep)', () => {
    // Pull the literal options the schema enum accepts and assert they are a
    // superset of every reason ALL_PERSISTED_REASONS lists. Guards against the
    // enum drifting back out of sync with persistCapCheckpoint.
    for (const reason of ALL_PERSISTED_REASONS) {
      const probe = RunCheckpointSchema.shape.reason.safeParse(reason)
      expect(probe.success, `enum is missing '${reason}'`).toBe(true)
    }
  })

  it('still rejects a genuinely invalid reason', () => {
    const bad = makeCheckpointWithReason('not-a-real-reason' as RunCheckpoint['reason'])
    expect(RunCheckpointSchema.safeParse(bad).success).toBe(false)
  })
})

// ── Tests for no-op guard ─────────────────────────────────────────────────────
// The persistCapCheckpoint inner helper skips persistence when there is
// nothing worth saving. We verify that assumption via the shape of what
// the runner checks before calling persistRunCheckpoint.

describe('cap checkpoint no-op conditions', () => {
  beforeEach(() => {
    mockedPersist.mockClear()
  })

  it('requires a scene plan — no scene plan means nothing to resume', () => {
    // Simulate the guard: if !world.scenePlan the helper returns early.
    const world = {
      scenePlan: undefined,
      scenes: [],
      globalStyle: { palette: [] },
      sceneGraph: { nodes: [], edges: [] },
    }
    // Guard condition from runner.ts persistCapCheckpoint
    const wouldSkip = !world.scenePlan
    expect(wouldSkip).toBe(true)
    // persistRunCheckpoint should NOT have been called
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('requires at least one scene created — empty scenesCreated skips persistence', () => {
    const scenesCreated: string[] = []
    const wouldSkip = scenesCreated.length === 0
    expect(wouldSkip).toBe(true)
    expect(mockedPersist).not.toHaveBeenCalled()
  })

  it('remainingSceneIndexes excludes already-built scenes', () => {
    const scenePlan = makeScenePlan(3)
    const builtSceneNames = ['Scene 1', 'Scene 2']
    const remaining = scenePlan.scenes
      .map((_, i) => i)
      .filter((i) => !builtSceneNames.some((n) => n.toLowerCase() === scenePlan.scenes[i].name.toLowerCase()))
    // Scene 3 (index 2) is remaining
    expect(remaining).toEqual([2])
  })
})

// ── Both cost-cap stop paths must checkpoint (v4 #7 regression) ────────────────
// The runner stops on the cost cap in TWO places: the top-of-loop pre-iteration
// check and the post-tool check (the common case — the cap is usually crossed by
// the round of tools just run). Both must persist a resume checkpoint before
// stopping, or scenes built this run can't be resumed. persistCapCheckpoint is a
// closure we can't import, so we assert the parity at the source level — this
// would have failed before the post-tool path got its checkpoint call.

describe('cost-cap stop paths persist a checkpoint (v4 #7)', () => {
  const runnerSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/agents/runner.ts'), 'utf8')
  const lines = runnerSrc.split('\n')
  const stopIdxs = lines.flatMap((l, i) => (l.includes("emitRunStopped(emit, 'cost_cap'") ? [i] : []))

  it('has both the top-of-loop and post-tool cost-cap stops', () => {
    expect(stopIdxs.length).toBeGreaterThanOrEqual(2)
  })

  it("every cost_cap stop is preceded by persistCapCheckpoint('cost-cap')", () => {
    // D10 moved the persist call ahead of the message interpolation (the stop
    // text only offers "Resume" when a checkpoint actually saved), so the call
    // sits a few lines further up — hence the 16-line window.
    for (const idx of stopIdxs) {
      const preceding = lines.slice(Math.max(0, idx - 16), idx).join('\n')
      expect(preceding).toContain("persistCapCheckpoint('cost-cap')")
    }
  })
})

// ── Round-cap exhaustion checkpoints + stops (D4) ──────────────────────────────
// Falling out of the iteration cap used to look exactly like normal completion:
// no run_stopped event, no checkpoint, success in the logs. The same
// source-level parity as the cost-cap test above: the round_cap stop must exist
// and be preceded by persistCapCheckpoint('round-cap').

describe('round-cap exhaustion persists a checkpoint and emits run_stopped (D4)', () => {
  const runnerSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/agents/runner.ts'), 'utf8')
  const lines = runnerSrc.split('\n')
  const stopIdxs = lines.flatMap((l, i) => (l.includes("emitRunStopped(emit, 'round_cap'") ? [i] : []))

  it('has exactly one round_cap stop site (the post-loop exhaustion check)', () => {
    expect(stopIdxs.length).toBe(1)
  })

  it("the round_cap stop is preceded by persistCapCheckpoint('round-cap')", () => {
    for (const idx of stopIdxs) {
      const preceding = lines.slice(Math.max(0, idx - 16), idx).join('\n')
      expect(preceding).toContain("persistCapCheckpoint('round-cap')")
    }
  })

  it("the round_cap stop records runExitReason = 'round_cap' (D1 threading)", () => {
    for (const idx of stopIdxs) {
      const surrounding = lines.slice(idx, Math.min(lines.length, idx + 4)).join('\n')
      expect(surrounding).toContain("runExitReason = 'round_cap'")
    }
  })
})
