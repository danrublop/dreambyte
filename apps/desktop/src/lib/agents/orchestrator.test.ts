// @vitest-environment node
/**
 * Tests for orchestrator.ts — the shared build scaffolding: scene shells, task
 * packets, acceptance evaluation, skill selection, and the corrective fix pass.
 *
 * These helpers have exactly one live driver, runDirectorLoop, so the wiring tests
 * here dispatch through it. runAgent is mocked — no real provider calls happen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock the runner so the orchestrator's `runAgent` is a captured stub. The mock
// returns the sub-agent's scenes with content added (so success=true) and a
// controllable per-scene cost.
const { mockRunAgent } = vi.hoisted(() => ({ mockRunAgent: vi.fn() }))
// Partial mock: stub only runAgent. Keep the real DEFAULT_RUN_CONFIG (and the
// rest) so orchestrator.ts can derive SUB_AGENT_TIMEOUT_MS from it at module load.
vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner')>()
  return { ...actual, runAgent: mockRunAgent }
})

import { runDirectorLoop } from './director-loop'
import {
  ensureSceneShells,
  runScopedSceneFix,
  buildTaskPacket,
  renderTaskPacket,
  evaluateAcceptance,
  overflowIssueFor,
  buildActiveToolsForSceneType,
  assembleScenePrompt,
  selectSkillsForScene,
  buildSceneSelectionTrace,
  formatSelectionTrace,
  CORRECTIVE_FIX_RESERVE_USD,
  SUB_AGENT_TIMEOUT_MS,
} from './orchestrator'
import { loadSkillForSceneType, reindexSkills, loadSkill } from '../skills/registry'
import { observeStyle, stubProse, renderStyleSkill, writeStyleSkill, selectProjectStyle } from '../skills/distill'
import { DEFAULT_RUN_CONFIG } from './runner'
import { makeRunCostLedger, commitCost } from './run-cost-ledger'
import { AgentLogger } from './logger'
import type { SSEEvent, SceneSpec } from './types'

function makeScenePlan(n: number) {
  return {
    title: 'Test video',
    scenes: Array.from({ length: n }, (_, i) => ({
      name: `Scene ${i + 1}`,
      purpose: `Purpose ${i + 1}`,
      sceneType: 'react',
      duration: 8,
    })),
    totalDuration: n * 8,
  }
}

function makeWorld(n: number) {
  return {
    scenes: Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      name: `Scene ${i + 1}`,
      duration: 8,
      bgColor: '#000000',
      sceneType: 'react',
    })),
    globalStyle: { palette: [] },
    sceneGraph: { nodes: [], edges: [], startSceneId: '' },
    scenePlan: makeScenePlan(n),
  }
}

function makeParentOpts() {
  return {
    message: 'build it',
    scenes: [],
    globalStyle: { palette: [] },
    projectName: 'test',
    outputMode: 'mp4',
    modelOverride: 'claude-sonnet-4-6',
  }
}

/** Mock runAgent: returns the passed scenes with content + a controllable cost. */
function mockSubAgent(costUsd: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => ({
    fullText: '',
    toolCalls: [{ id: 'tc', toolName: 'write_scene_code', input: {}, durationMs: 1 }],
    usage: { inputTokens: 100, outputTokens: 50, apiCalls: 1, costUsd, totalDurationMs: 50 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
    updatedGlobalStyle: o.globalStyle,
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function budgetsOf(calls: any[]): Array<number | undefined> {
  return calls.map((c) => c[0]?.runConfig?.maxRunCostUsd)
}

/** Mock a sub-agent that commits its cost to the shared ledger, the way the real
 *  runner does — so the orchestrator's ledger-driven guardrails can be tested.
 *  Emits a passing verify_scene for its target scene so it represents a fully
 *  built-and-verified scene (verify-or-fix would otherwise re-dispatch it). */
function mockSubAgentCommitsToLedger(costUsd: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => {
    if (o.costLedger) commitCost(o.costLedger, costUsd)
    return {
      fullText: '',
      toolCalls: [
        { id: 'tc', toolName: 'write_scene_code', input: {}, durationMs: 1 },
        {
          id: 'v',
          toolName: 'verify_scene',
          input: { sceneId: o.selectedSceneId },
          output: { success: true, data: { issues: [] } },
          durationMs: 1,
        },
      ],
      usage: { inputTokens: 100, outputTokens: 50, apiCalls: 1, costUsd, totalDurationMs: 50 },
      stopReason: 'completed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

/** Mock a sub-agent that builds content AND reports a verify_scene verdict. */
function mockSubAgentWithVerify(verifySuccess: boolean, sceneId: string, issues: string[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => ({
    fullText: '',
    toolCalls: [
      { id: 'w', toolName: 'write_scene_code', input: { sceneId }, durationMs: 1 },
      {
        id: 'v',
        toolName: 'verify_scene',
        input: { sceneId },
        output: { success: verifySuccess, data: { issues } },
        durationMs: 1,
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
    updatedGlobalStyle: o.globalStyle,
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
  }))
}

/** Mock a sub-agent that FAILS verify on its first run and PASSES on the next —
 *  exercising the auto-redispatch corrective pass. */
function mockSubAgentFailThenFix() {
  let call = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => {
    call++
    const ok = call > 1 // first build fails verify, corrective pass passes
    return {
      fullText: '',
      toolCalls: [
        { id: 'w', toolName: 'write_scene_code', input: { sceneId: 's0' }, durationMs: 1 },
        {
          id: 'v',
          toolName: 'verify_scene',
          input: { sceneId: 's0' },
          output: { success: ok, data: { issues: ok ? [] : ['BROKEN: undefined var foo'] } },
          durationMs: 1,
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

/** Mock a sub-agent that always fails verify and commits cost to the ledger. */
function mockSubAgentFailAndCommit(costUsd: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => {
    if (o.costLedger) commitCost(o.costLedger, costUsd)
    return {
      fullText: '',
      toolCalls: [
        { id: 'w', toolName: 'write_scene_code', input: { sceneId: 's0' }, durationMs: 1 },
        {
          id: 'v',
          toolName: 'verify_scene',
          input: { sceneId: 's0' },
          output: { success: false, data: { issues: ['still broken'] } },
          durationMs: 1,
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd, totalDurationMs: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

/** P1-2: mock a sub-agent whose FIRST run wall-clock-times-out (runner returns a
 *  partial world with stopReason 'aborted') after a STALE passing verify — the
 *  worst case: content exists and an earlier verify said "success", so without the
 *  timeout gate the half-built scene would ship. The corrective run then completes
 *  cleanly (stopReason 'completed' + a real passing verify). */
function mockSubAgentTimeoutThenFix() {
  let call = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => {
    call++
    const timedOut = call === 1
    return {
      fullText: '',
      toolCalls: [
        { id: 'w', toolName: 'write_scene_code', input: { sceneId: 's0' }, durationMs: 1 },
        {
          id: 'v',
          toolName: 'verify_scene',
          input: { sceneId: 's0' },
          // First pass: a stale pass captured BEFORE the deadline hit.
          output: { success: true, data: { issues: [] } },
          durationMs: 1,
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      // Partial content is present on both runs (the timeout left a half-built scene).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
      stopReason: timedOut ? 'aborted' : 'completed',
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

/** P2: mock a sub-agent that BUILDS content but NEVER calls verify_scene on its
 *  first run (verifyPassed → undefined), then verifies clean on the corrective
 *  run. Exercises the verify-or-fix gate: an unverified scene must be re-dispatched. */
function mockSubAgentUnverifiedThenVerify() {
  let call = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => {
    call++
    const verified = call > 1
    return {
      fullText: '',
      toolCalls: verified
        ? [
            { id: 'w', toolName: 'write_scene_code', input: { sceneId: 's0' }, durationMs: 1 },
            {
              id: 'v',
              toolName: 'verify_scene',
              input: { sceneId: 's0' },
              output: { success: true, data: { issues: [] } },
              durationMs: 1,
            },
          ]
        : [{ id: 'w', toolName: 'write_scene_code', input: { sceneId: 's0' }, durationMs: 1 }],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
      stopReason: 'completed',
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

beforeEach(() => {
  mockRunAgent.mockReset()
})

describe('ensureSceneShells — deterministic scene identity (pinned ids)', () => {
  // Regression (world-cup run: 0/7 scenes landed): planned scenes used to be
  // re-found by name, so a rename / re-plan / reorder lost the merge target.
  // Shells pin the plan's id into the world, making the merge a pure id lookup.
  const plan = (scenes: Array<{ id: string; name: string }>): unknown => ({
    title: 'V',
    scenes: scenes.map((s) => ({ ...s, purpose: 'p', sceneType: 'react', duration: 8 })),
    totalDuration: scenes.length * 8,
  })

  it('creates one pinned shell per planned scene in an empty world', () => {
    const world = makeEmptyWorld()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = ensureSceneShells(makeScenePlan(7) as any, world as any, new AgentLogger())
    expect(map.size).toBe(7)
    expect(world.scenes).toHaveLength(7)
  })

  it('reuses existing shells on a repeat dispatch of the same plan (no duplicates)', () => {
    const world = makeEmptyWorld()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p1 = plan([
      { id: 'sid-a', name: 'Hook' },
      { id: 'sid-b', name: 'Body' },
    ]) as any
    ensureSceneShells(p1, world as never, new AgentLogger())
    ensureSceneShells(p1, world as never, new AgentLogger())
    expect(world.scenes).toHaveLength(2)
  })

  it('re-plan drift guard: a REORDERED + RENAMED plan that kept its ids maps by id, not position', () => {
    const world = makeEmptyWorld()
    ensureSceneShells(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plan([
        { id: 'sid-a', name: 'Hook' },
        { id: 'sid-b', name: 'Body' },
      ]) as any,
      world as never,
      new AgentLogger(),
    )
    const map = ensureSceneShells(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plan([
        { id: 'sid-b', name: 'Main Body' },
        { id: 'sid-a', name: 'The Big Hook' },
      ]) as any,
      world as never,
      new AgentLogger(),
    )
    expect(world.scenes).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(world.scenes.map((s: any) => s.id).sort()).toEqual(['sid-a', 'sid-b'])
    // planned[0] is now sid-b — a positional match would have handed back sid-a.
    expect(map.get(0)?.id).toBe('sid-b')
    expect(map.get(1)?.id).toBe('sid-a')
  })
})

/**
 * Regression: the world-cup run built 0/7 scenes despite 17/18 write_scene_code
 * succeeding. Root cause — matchScenePlanToScenes only maps planned scenes onto
 * scenes that ALREADY exist in the world, so a scene the sub-agent creates itself
 * had to be re-found by a fragile `name === planned.name || prompt.includes(...)`
 * guess. A renamed scene, a drifted plan, or a short-id write into another id-space
 * broke that guess → "no content produced" → nothing merged → 0/N → the parent
 * looped re-planning. The fix pre-creates a shell with a pinned id for every
 * unmatched planned scene, so the merge is a pure id lookup.
 *
 * These tests start from an EMPTY world (the case the existing suite never covered
 * — it always pre-seeded a name-matched scene per plan entry).
 */
function makeEmptyWorld() {
  return {
    scenes: [] as unknown[],
    globalStyle: { palette: [] },
    sceneGraph: { nodes: [], edges: [], startSceneId: '' },
    scenePlan: makeScenePlan(0),
  }
}

/** Sub-agent that fills its scoped scene but RENAMES it — proving the orchestrator
 *  reconciles by id, not by the (now-drifted) name. Reports a passing verify keyed
 *  to the scoped scene id so no corrective pass is needed. */
function mockSubAgentRenames() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => ({
    fullText: '',
    toolCalls: [
      { id: 'w', toolName: 'write_scene_code', input: { sceneId: o.selectedSceneId }, durationMs: 1 },
      {
        id: 'v',
        toolName: 'verify_scene',
        input: { sceneId: o.selectedSceneId },
        output: { success: true, data: { issues: [] } },
        durationMs: 1,
      },
    ],
    usage: { inputTokens: 100, outputTokens: 50, apiCalls: 1, costUsd: 0, totalDurationMs: 50 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, name: `drifted-${s.name}`, sceneCode: 'built' })),
    updatedGlobalStyle: o.globalStyle,
    agentType: 'scene-maker',
    modelId: 'claude-sonnet-4-6',
  }))
}

describe('verification as contract (C.2a #1)', () => {
  it('surfaces a built-but-failed-verification scene as a consistency issue', async () => {
    mockSubAgentWithVerify(false, 's0', ['BROKEN: undefined variable foo'])
    const events: SSEEvent[] = []
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    // The scene still merged (it has content), but verifyPassed is false...
    expect(results[0].success).toBe(true)
    expect(results[0].verifyPassed).toBe(false)
    // ...and the failure is surfaced to the Director, not swallowed.
    const tok = events.find((e) => e.type === 'token' && /failed verification/i.test(e.token ?? ''))
    expect(tok).toBeTruthy()
  })

  it('flags a scene the sub-agent never verified', async () => {
    mockSubAgent(0) // builds content, never calls verify_scene
    const events: SSEEvent[] = []
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    expect(results[0].verifyPassed).toBeUndefined()
    const tok = events.find((e) => e.type === 'token' && /not verified/i.test(e.token ?? ''))
    expect(tok).toBeTruthy()
  })

  it('a passing verify produces no verification consistency issue', async () => {
    mockSubAgentWithVerify(true, 's0', [])
    const events: SSEEvent[] = []
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    expect(results[0].verifyPassed).toBe(true)
    const tok = events.find((e) => e.type === 'token' && /(failed verification|not verified)/i.test(e.token ?? ''))
    expect(tok).toBeFalsy()
  })
})

describe('machine-checked acceptance criteria (C.2a)', () => {
  const checks = [
    { kind: 'content' as const, label: 'has content' },
    { kind: 'narration' as const, label: 'narration added' },
    { kind: 'chart' as const, label: 'chart rendered' },
  ]

  it('reports every check unmet on an empty scene', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', name: 'x', duration: 8 } as any
    expect(evaluateAcceptance(checks, scene)).toEqual(['has content', 'narration added', 'chart rendered'])
  })

  it('all met: content via sceneCode, narration via real TTS file, chart via data-bearing layer', () => {
    const scene = {
      id: 's',
      sceneCode: 'x',
      audioLayer: {
        enabled: true,
        tts: { text: 'Welcome to the demo.', status: 'ready', src: 'https://cdn/narration.mp3' },
      },
      chartLayers: [{ data: [{ label: 'a', value: 1 }] }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(evaluateAcceptance(checks, scene)).toEqual([])
  })

  it('narration unmet when tts has text but no audio file (client-only TTS exports silent)', () => {
    // The exact silent-narration class: a client-only provider stores
    // src: null, status: 'ready' and add_narration warns the export is silent —
    // it must NOT pass the gate.
    const scene = {
      id: 's',
      sceneCode: 'x',
      audioLayer: { enabled: true, tts: { text: 'Welcome to the demo.', status: 'ready', src: null } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(evaluateAcceptance([{ kind: 'narration' as const, label: 'narration added' }], scene)).toEqual([
      'narration added',
    ])
  })

  it('chart unmet when data is {value: NaN} (renders an empty plot)', () => {
    const scene = {
      id: 's',
      sceneCode: 'x',
      chartLayers: [{ data: { value: NaN } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(evaluateAcceptance([{ kind: 'chart' as const, label: 'chart rendered' }], scene)).toEqual(['chart rendered'])
  })

  it('chart unmet when object data is all-null ({foo: null})', () => {
    const scene = {
      id: 's',
      sceneCode: 'x',
      chartLayers: [{ data: { foo: null } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(evaluateAcceptance([{ kind: 'chart' as const, label: 'chart rendered' }], scene)).toEqual(['chart rendered'])
  })

  it('chart met for a number-callout {value: 42} and a gauge {value, max}', () => {
    for (const data of [
      { value: 42, label: 'KPI' },
      { value: 7, max: 10 },
    ]) {
      const scene = { id: 's', sceneCode: 'x', chartLayers: [{ data }] } as any
      expect(evaluateAcceptance([{ kind: 'chart' as const, label: 'chart rendered' }], scene)).toEqual([])
    }
  })

  it('duration: within +30% ok, over-run flagged, but a VO-narrated scene is exempt (never truncate audio)', () => {
    const check = { kind: 'duration' as const, label: 'fits duration', expectedDuration: 10 }
    // within tolerance (10 * 1.3 = 13)
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', duration: 12 } as any)).toEqual([])
    // over by >30%, no narration → dead-air flagged
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', duration: 20 } as any)).toEqual(['fits duration'])
    // over, but carries a real voiceover → exempt (the eng-review's key conflict fix)
    const narrated = {
      id: 's',
      sceneCode: 'x',
      duration: 20,
      audioLayer: { enabled: true, tts: { text: 'a real voiceover line', status: 'ready', src: 'https://cdn/n.mp3' } },
    } as any
    expect(evaluateAcceptance([check], narrated)).toEqual([])
    // under-duration is never flagged (not dead air)
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', duration: 6 } as any)).toEqual([])
  })

  it('transition: met on exact match, unmet on a clobber to a different value or the default none', () => {
    const check = { kind: 'transition' as const, label: 'transition matches plan', expectedTransition: 'wipe-left' }
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', transition: 'wipe-left' } as any)).toEqual([])
    // a set_all_transitions clobber to dissolve is caught
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', transition: 'dissolve' } as any)).toEqual([
      'transition matches plan',
    ])
    expect(evaluateAcceptance([check], { id: 's', sceneCode: 'x', transition: 'none' } as any)).toEqual([
      'transition matches plan',
    ])
  })

  it('overflowIssueFor: null when no overflow, a concrete issue naming elements when present', () => {
    expect(overflowIssueFor({}, 's1')).toBeNull()
    expect(overflowIssueFor({ _sceneOverflowState: {} }, 's1')).toBeNull()
    const world = {
      _sceneOverflowState: {
        s1: [
          { id: 'div:"MOROCCO"', overflowPx: 40 },
          { id: 'span:"2030"', overflowPx: 12 },
        ],
      },
    }
    const issue = overflowIssueFor(world, 's1')
    expect(issue).toMatch(/2 element\(s\) spill past the frame/)
    expect(issue).toMatch(/MOROCCO/)
    expect(overflowIssueFor(world, undefined)).toBeNull()
  })

  it('buildActiveToolsForSceneType: react gets bridge categories + video (was silently ["motion"])', () => {
    const cats = buildActiveToolsForSceneType('react')
    for (const c of ['motion', 'three', 'd3', 'canvas2d', 'svg', 'lottie', 'video', 'audio', 'assets']) {
      expect(cats).toContain(c)
    }
    // video is granted to every scene type now (was stranded — no type mapped to it)
    expect(buildActiveToolsForSceneType('svg')).toContain('video')
    // parent can still withhold video
    expect(buildActiveToolsForSceneType('react', ['motion', 'audio'])).not.toContain('video')
  })

  it('buildActiveToolsForSceneType: react (the default renderer) is avatar-eligible', () => {
    // A presenter scene is normally react — avatar tools must reach it.
    expect(buildActiveToolsForSceneType('react')).toContain('avatars')
    // parent can still withhold avatars
    expect(buildActiveToolsForSceneType('react', ['motion', 'audio', 'assets'])).not.toContain('avatars')
    // a non-benefiting type (pure d3 chart) still doesn't get avatars
    expect(buildActiveToolsForSceneType('d3')).not.toContain('avatars')
  })

  it('buildTaskPacket surfaces planned mediaLayers so the imagery actually gets built', () => {
    const planned = {
      name: 'Hero',
      purpose: 'open',
      sceneType: 'react',
      duration: 6,
      mediaLayers: 'a photoreal product shot floating over gradient',
    } as unknown as SceneSpec
    const packet = buildTaskPacket(planned)
    const rendered = renderTaskPacket(packet)
    expect(rendered).toContain('photoreal product shot')
    expect(rendered).toMatch(/generate_image|generate_veo3_video/)
  })

  it('narration EVIDENCE: enabled but no TTS text is NOT met (silent-narration class)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', sceneCode: 'x', audioLayer: { enabled: true } } as any
    expect(evaluateAcceptance([{ kind: 'narration' as const, label: 'narration added' }], scene)).toEqual([
      'narration added',
    ])
  })

  it('narration EVIDENCE: enabled with text but status "error" is NOT met', () => {
    const scene = {
      id: 's',
      sceneCode: 'x',
      audioLayer: { enabled: true, tts: { text: 'Welcome to the demo.', status: 'error' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(evaluateAcceptance([{ kind: 'narration' as const, label: 'narration added' }], scene)).toEqual([
      'narration added',
    ])
  })

  const chartCheck = [{ kind: 'chart' as const, label: 'chart rendered' }]

  it('chart EVIDENCE: a layer with empty array data is NOT met', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', sceneCode: 'x', chartLayers: [{ data: [] }] } as any
    expect(evaluateAcceptance(chartCheck, scene)).toEqual(['chart rendered'])
  })

  it('chart EVIDENCE: empty object data is NOT met', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', sceneCode: 'x', chartLayers: [{ data: {} }] } as any
    expect(evaluateAcceptance(chartCheck, scene)).toEqual(['chart rendered'])
  })

  it('chart EVIDENCE: OBJECT-shaped data (number/gauge/plotly) IS met — not array-only', () => {
    const cases = [
      { data: { value: 40, label: 'Profit' } }, // number
      { data: { value: 72, max: 100 } }, // gauge
      { data: { traces: [{ x: [1], y: [2] }] } }, // plotly
    ]
    for (const layer of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scene = { id: 's', sceneCode: 'x', chartLayers: [layer] } as any
      expect(evaluateAcceptance(chartCheck, scene)).toEqual([])
    }
  })

  it('chart EVIDENCE: plotly with empty traces is NOT met', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', sceneCode: 'x', chartLayers: [{ data: { traces: [] } }] } as any
    expect(evaluateAcceptance(chartCheck, scene)).toEqual(['chart rendered'])
  })

  it('partial: content + data-bearing chart present, narration missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = { id: 's', sceneCode: 'x', chartLayers: [{ data: [{ label: 'a', value: 1 }] }] } as any
    expect(evaluateAcceptance(checks, scene)).toEqual(['narration added'])
  })

  it('imagery gate: a visualForm=imagery beat with placed media passes, pure CSS fails', () => {
    const packet = buildTaskPacket({ name: 'a', purpose: 'p', sceneType: 'react', duration: 8, visualForm: 'imagery' })
    expect(packet.checks.map((c) => c.kind)).toContain('imagery')
    const imageryCheck = packet.checks.filter((c) => c.kind === 'imagery')
    // Pure CSS reactCode, no media layer → unmet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cssOnly = { id: 's', reactCode: 'return <div style={{background:"linear-gradient(...)"}}/>' } as any
    expect(evaluateAcceptance(imageryCheck, cssOnly)).toEqual(['planned imagery placed (media layer, not CSS)'])
    // A placed AI image layer → met.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withMedia = { id: 's', reactCode: 'x', aiLayers: [{ type: 'image', src: 'u' }] } as any
    expect(evaluateAcceptance(imageryCheck, withMedia)).toEqual([])
  })

  it('3d gate: a visualForm=3d beat with a Three.js layer passes, a flat div fails', () => {
    const packet = buildTaskPacket({ name: 'a', purpose: 'p', sceneType: 'react', duration: 8, visualForm: '3d' })
    const threeCheck = packet.checks.filter((c) => c.kind === '3d')
    expect(threeCheck.length).toBe(1)
    // Flat CSS mock, no ThreeJSLayer/THREE → unmet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flat = { id: 's', reactCode: 'return <div/>' } as any
    expect(evaluateAcceptance(threeCheck, flat)).toEqual(['3D rendered (Three.js, not a flat mock)'])
    // <ThreeJSLayer> bridge in reactCode → met.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const three = { id: 's', reactCode: 'return <ThreeJSLayer setup={fn}/>' } as any
    expect(evaluateAcceptance(threeCheck, three)).toEqual([])
  })

  it('diagram/stat visualForms add NO structural gate (pure JSX/CSS is a valid build)', () => {
    for (const vf of ['diagram', 'stat', 'text'] as const) {
      const packet = buildTaskPacket({ name: 'a', purpose: 'p', sceneType: 'react', duration: 8, visualForm: vf })
      expect(packet.checks.map((c) => c.kind)).not.toContain('imagery')
      expect(packet.checks.map((c) => c.kind)).not.toContain('3d')
    }
  })

  it('buildTaskPacket emits content + duration by default, +narration/+chart/+transition when planned', () => {
    // A planned duration always adds a duration check (fires only on a >30% dead-air
    // over-run, and VO-narrated scenes are exempt — see evaluateAcceptance).
    const bare = buildTaskPacket({ name: 'a', purpose: 'p', sceneType: 'react', duration: 8 })
    expect(bare.checks.map((c) => c.kind)).toEqual(['content', 'duration'])
    const full = buildTaskPacket({
      name: 'a',
      purpose: 'p',
      sceneType: 'd3',
      duration: 8,
      narrationDraft: 'hello',
      chartSpec: { type: 'bar', dataDescription: 'x' },
      transition: 'wipe-left',
    })
    expect(full.checks.map((c) => c.kind)).toEqual(['content', 'narration', 'chart', 'duration', 'transition'])
    const transitionCheck = full.checks.find((c) => c.kind === 'transition')
    expect(transitionCheck?.expectedTransition).toBe('wipe-left')
    // A default 'none' transition adds NO transition check (scoped to real intent).
    const noneTransition = buildTaskPacket({
      name: 'a',
      purpose: 'p',
      sceneType: 'react',
      duration: 8,
      transition: 'none',
    })
    expect(noneTransition.checks.map((c) => c.kind)).toEqual(['content', 'duration'])
  })

  it('surfaces an unmet criterion through orchestration (narration required, not added)', async () => {
    mockSubAgentWithVerify(true, 's0', []) // verify passes, but the built scene has no audio
    const sb = {
      title: 't',
      scenes: [{ name: 'Scene 1', purpose: 'p', sceneType: 'react', duration: 8, narrationDraft: 'Hello there' }],
      totalDuration: 8,
    }
    const events: SSEEvent[] = []
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: sb as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    expect(results[0].unmetCriteria).toContain('narration was added')
    const tok = events.find((e) => e.type === 'token' && /did not meet acceptance/i.test(e.token ?? ''))
    expect(tok).toBeTruthy()
  })
})

describe('auto-redispatch — corrective pass (C.2a)', () => {
  it('re-dispatches a corrective sub-agent that fixes a failed scene', async () => {
    mockSubAgentFailThenFix()
    const events: SSEEvent[] = []
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    // Initial build + one corrective build.
    expect(mockRunAgent).toHaveBeenCalledTimes(2)
    // The corrective call got a fix-focused packet naming the prior failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const correctiveMsg = (mockRunAgent.mock.calls[1][0] as any).message as string
    expect(correctiveMsg).toMatch(/Fix required|FIX the scene/i)
    expect(correctiveMsg).toContain('BROKEN: undefined var foo')
    // Final verdict reflects the fix — and no failed-verification token survives.
    expect(results[0].verifyPassed).toBe(true)
    expect(events.find((e) => e.type === 'token' && /failed verification/i.test(e.token ?? ''))).toBeFalsy()
  })

  it('does not re-dispatch a scene that already passed', async () => {
    mockSubAgentWithVerify(true, 's0', [])
    await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(mockRunAgent).toHaveBeenCalledTimes(1) // no corrective pass
  })

  it('skips the corrective pass when the cost ledger is over cap', async () => {
    mockSubAgentFailAndCommit(6) // first build commits $6, fails verify
    const ledger = makeRunCostLedger(5) // cap below what one build spends
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: () => {},
      logger: new AgentLogger(),
      costLedger: ledger,
    })
    // Batch built once ($0<$5), spent $6; corrective guard sees $6>$5 → skipped.
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(results[0].verifyPassed).toBe(false) // never fixed
  })

  it('P2: a scene built but never verified (verifyPassed undefined) is re-dispatched', async () => {
    // First run produces content but skips verify_scene → verifyPassed undefined.
    // The old gate (`=== false`) let it ship unproven; verify-or-fix re-dispatches.
    mockSubAgentUnverifiedThenVerify()
    const results = await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(1) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    // Undefined verdict triggered a corrective pass (initial + one corrective).
    // Without the fix the undefined verdict is ignored → called once.
    expect(mockRunAgent).toHaveBeenCalledTimes(2)
    // The corrective run verified clean.
    expect(results[0].verifyPassed).toBe(true)
  })
})

describe('SUB_AGENT_TIMEOUT_MS invariant (hardening)', () => {
  it('outlives a single generation tool call so gen-heavy scenes are not killed mid-build', () => {
    // The bug this guards: a 90s sub-agent timeout below the 120s generation
    // tool timeout aborted image/TTS/video builds mid-call. The wall-clock
    // backstop must comfortably exceed one generation call.
    expect(SUB_AGENT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RUN_CONFIG.generationToolTimeoutMs)
    // And it should clear ~2 back-to-back generations (headroom for build+verify).
    expect(SUB_AGENT_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_RUN_CONFIG.generationToolTimeoutMs * 2)
  })
})

describe('buildTaskPacket / renderTaskPacket (C.2a)', () => {
  const base: SceneSpec = {
    name: 'Intro',
    purpose: 'Hook the viewer',
    sceneType: 'react',
    duration: 8,
  }

  it('owns an existing scene id when a shell exists', () => {
    const packet = buildTaskPacket(base, {
      id: 'scene-x',
      name: 'Intro',
      duration: 8,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(packet.sceneId).toBe('scene-x')
    expect(packet.purpose).toBe('Hook the viewer')
    expect(packet.verification).toMatch(/verify_scene/)
  })

  it('has a null scope when the sub-agent must create the scene', () => {
    const packet = buildTaskPacket(base, undefined)
    expect(packet.sceneId).toBeNull()
    expect(renderTaskPacket(packet)).toContain('Create and build one scene')
  })

  it('derives acceptance criteria from the scene-spec fields', () => {
    const packet = buildTaskPacket(
      {
        ...base,
        visualElements: 'a bar chart growing',
        narrationDraft: 'Revenue tripled.',
        chartSpec: { type: 'bar', dataDescription: 'quarterly revenue' },
        transition: 'fade',
      },
      undefined,
    )
    const text = packet.acceptanceCriteria.join('\n')
    expect(text).toMatch(/a bar chart growing/)
    expect(text).toMatch(/Revenue tripled/)
    expect(text).toMatch(/\bchart\b/)
    expect(text).toMatch(/fade/)
    expect(text).toMatch(/duration of 8s/)
  })
})

describe('PR2 — deterministic bridge-skill injection ($0 prompt-assembly)', () => {
  it('injects the threejs bridge guide into a react scene whose purpose mentions a 3D globe', () => {
    const planned: SceneSpec = {
      name: 'Globe',
      purpose: 'a rotating 3d globe of the world',
      sceneType: 'react',
      duration: 8,
    }
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned)
    const three = loadSkillForSceneType('three')!
    expect(three).toBeTruthy()
    // header + a real substring of the three guide both reach the prompt — proving
    // the bridge guide is wired to the sub-agent without any model call.
    expect(prompt).toContain(`## Loaded skill — ${three.metadata.name}`)
    expect(prompt).toContain(three.guide.slice(0, 60))
  })

  it('injects nothing for a plain react scene (PR1 base null, no bridge intent)', () => {
    const planned: SceneSpec = {
      name: 'Intro',
      purpose: 'a title card that fades in',
      sceneType: 'react',
      duration: 6,
    }
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned)
    expect(prompt).not.toContain('## Loaded skill')
  })

  it('keeps PR1 base injection for a dedicated three scene without double-injecting', () => {
    const planned: SceneSpec = { name: '3D', purpose: 'a 3d orbit scene', sceneType: 'three', duration: 8 }
    const { base, guides } = selectSkillsForScene(planned)
    expect(base?.metadata.id).toBe('threejs-3d-scene')
    // base and the 3d-bridge resolve to the same skill → deduped to one guide.
    expect(guides.map((g) => g.metadata.id)).toEqual(['threejs-3d-scene'])
  })
})

describe('PR2 — selection trace shape', () => {
  it('populates a trace for a react scene leaning on a 3D bridge (soft mismatch)', () => {
    const planned: SceneSpec = {
      id: 'sc1',
      name: 'Globe',
      purpose: 'a rotating 3d globe',
      sceneType: 'react',
      duration: 8,
    }
    const trace = buildSceneSelectionTrace(planned)
    expect(trace.sceneId).toBe('sc1')
    expect(trace.sceneType).toBe('react')
    expect(trace.injected).toContain('threejs-3d-scene')
    expect(trace.bridgeHints).toContain('threejs-3d-scene')
    expect(trace.flowWarnings).toEqual([])
    expect(trace.override).toMatch(/sceneType left unchanged/)
  })

  it('omits override when the planner sceneType already matches the bridge', () => {
    const planned: SceneSpec = { name: '3D', purpose: 'a 3d orbit scene', sceneType: 'three', duration: 8 }
    expect(buildSceneSelectionTrace(planned).override).toBeUndefined()
  })

  it('falls back to the scene name when the plan omits an id', () => {
    const planned: SceneSpec = { name: 'NoId', purpose: 'a plain intro', sceneType: 'react', duration: 6 }
    expect(buildSceneSelectionTrace(planned).sceneId).toBe('NoId')
  })

  it('formats a compact, human-readable block', () => {
    const block = formatSelectionTrace([
      {
        sceneId: 'sc1',
        sceneType: 'react',
        injected: ['threejs-3d-scene'],
        bridgeHints: ['threejs-3d-scene'],
        flowWarnings: [],
        override: 'mismatch note',
      },
    ])
    expect(block).toContain('Skill selection trace')
    expect(block).toContain('[react] "sc1" → threejs-3d-scene')
    expect(block).toContain('mismatch note')
  })
})

describe('PR2 — selection trace SSE emission', () => {
  it('emits exactly one selection_trace block during the plan phase, before any sub-agent', async () => {
    mockSubAgent(0)
    const events: SSEEvent[] = []
    await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: makeScenePlan(2) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentWorld: makeWorld(2) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    const traceEvents = events.filter((e) => e.type === 'selection_trace')
    expect(traceEvents).toHaveLength(1)
    expect(traceEvents[0].selectionTrace).toHaveLength(2)
    expect(traceEvents[0].message).toContain('Skill selection trace')

    // Plan phase: the trace must precede the first sub_agent_start.
    const traceIdx = events.findIndex((e) => e.type === 'selection_trace')
    const firstSubIdx = events.findIndex((e) => e.type === 'sub_agent_start')
    expect(traceIdx).toBeGreaterThanOrEqual(0)
    expect(firstSubIdx).toBeGreaterThan(traceIdx)
  })
})

// ── T6: E2 auto-load read path ($0 prompt-assembly) ──────────────────────────
describe('E2 auto-load — distilled style injected via the selectSkillsForScene seam (T6)', () => {
  // Isolate the writable styles dir under a tmp $HOME and seed a fixture style.
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined
  let styleId: string

  beforeEach(async () => {
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    tmpHome = mkdtempSync(join(tmpdir(), 'db-orch-style-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    reindexSkills()
    // Seed a distilled style with strong intent tags so a matching build picks it up.
    const obs = {
      ...observeStyle({
        id: 'seed-proj',
        scenes: [
          { id: 's', name: 'S', bgColor: '#101418', sceneType: 'react', cameraMotion: null, duration: 5 } as never,
        ],
        globalStyle: {
          presetId: null,
          paletteOverride: ['#101418', '#e8e4d8', '#c8553d', '#3a7ca5'],
          bgColorOverride: null,
          fontOverride: 'Söhne',
          bodyFontOverride: null,
          strokeColorOverride: null,
        } as never,
      }),
    }
    const prose = stubProse(obs, 'Editorial Calm')
    prose.tags = ['editorial', 'calm', 'data-story']
    const { id, markdown } = renderStyleSkill(obs, prose)
    styleId = id
    await writeStyleSkill(id, markdown)
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    try {
      rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    reindexSkills()
  })

  it('a build whose intent matches the style → assembled prompt carries the style guide', () => {
    const style = selectProjectStyle('an editorial calm data-story explainer')
    expect(style).not.toBeNull()
    expect(style!.metadata.id).toBe(styleId)

    const planned: SceneSpec = { name: 'Intro', purpose: 'a plain title card', sceneType: 'react', duration: 6 }
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned, style)
    // The distinct project-style framing + a real substring of the guide both land.
    expect(prompt).toContain(`## Project style — ${style!.metadata.name}`)
    expect(prompt).toContain(style!.guide.slice(0, 40))
  })

  it('no intent match → nothing injected (null select, plain prompt)', () => {
    const style = selectProjectStyle('a heavy 3d simulation of colliding asteroids')
    // The seeded style has none of those tokens → no match.
    expect(style).toBeNull()
    const planned: SceneSpec = { name: 'Intro', purpose: 'a plain title card', sceneType: 'react', duration: 6 }
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned, style)
    expect(prompt).not.toContain('## Project style')
  })

  it('empty intent → null (no style force-applied to an unrelated build)', () => {
    expect(selectProjectStyle('')).toBeNull()
  })

  it('drift: the selected style resolves to a non-null loadable skill', () => {
    const style = selectProjectStyle('editorial calm')
    expect(style).not.toBeNull()
    expect(loadSkill(style!.metadata.id)).not.toBeNull()
    expect(style!.metadata.origin).toBe('distilled')
  })

  it('trace records styleApplied = the injected style id (project-wide)', () => {
    const style = selectProjectStyle('editorial calm data-story')
    const planned: SceneSpec = { name: 'A', purpose: 'intro', sceneType: 'react', duration: 6 }
    const trace = buildSceneSelectionTrace(planned, style)
    expect(trace.styleApplied).toBe(styleId)
    // formatSelectionTrace surfaces it once, project-wide.
    expect(formatSelectionTrace([trace])).toContain(`project style: ${styleId}`)
  })

  it('no style → trace.styleApplied is null', () => {
    const planned: SceneSpec = { name: 'A', purpose: 'intro', sceneType: 'react', duration: 6 }
    expect(buildSceneSelectionTrace(planned, null).styleApplied).toBeNull()
  })
})

describe('runScopedSceneFix — atomic cost reserve at dispatch (⑥.2)', () => {
  // Correctives run in bounded parallel (director-loop). A read-only cap check would
  // let N concurrent fixes all see the same pre-spend, all pass, and overshoot. The
  // reserve makes admission atomic: each dispatch commits its estimate BEFORE the
  // await, so later dispatches see the prior reservations. Isolate the reserve here
  // by committing NO actual cost in the build — the only ledger movement is the
  // per-fix reserve (held across the await, refunded after).
  it('admits concurrent correctives only while the reservation fits under the cap', async () => {
    mockSubAgent(0) // builds content, commits nothing to the ledger
    const reserve = CORRECTIVE_FIX_RESERVE_USD
    const cap = 10
    // Headroom for exactly 2 reservations, not a 3rd (2.33 × reserve).
    const ledger = makeRunCostLedger(cap)
    commitCost(ledger, cap - reserve * 2.33)
    const preSpend = ledger.spentUsd
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world = makeWorld(5) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planned = makeScenePlan(5).scenes[0] as any

    const outcomes = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      world.scenes.map((s: any, i: number) =>
        runScopedSceneFix({
          sceneId: s.id,
          sceneIndex: i,
          sceneName: s.name,
          planned,
          existingScene: s,
          priorIssues: ['fix me'],
          parentWorld: world,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parentOpts: makeParentOpts() as any,
          emit: () => {},
          logger: new AgentLogger(),
          costLedger: ledger,
          totalScenes: 5,
        }),
      ),
    )

    const admitted = outcomes.filter((o) => !o.skippedOverCap).length
    const skipped = outcomes.filter((o) => o.skippedOverCap).length
    expect(admitted).toBe(2) // only the two whose reservation fit under the cap
    expect(skipped).toBe(3) // the rest were denied atomically, not run
    // Reservations were refunded 1:1 after each fix — ledger back to the pre-spend,
    // and it never blew past the cap during flight.
    expect(ledger.spentUsd).toBeCloseTo(preSpend, 5)
    expect(ledger.spentUsd).toBeLessThanOrEqual(cap)
    // Only the admitted fixes actually dispatched a sub-agent build.
    expect(mockRunAgent).toHaveBeenCalledTimes(2)
  })

  it('denies every corrective once the ledger is already at the cap', async () => {
    mockSubAgent(0)
    const ledger = makeRunCostLedger(5)
    commitCost(ledger, 5) // exactly at cap → no reservation fits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world = makeWorld(3) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planned = makeScenePlan(3).scenes[0] as any
    const outcomes = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      world.scenes.map((s: any, i: number) =>
        runScopedSceneFix({
          sceneId: s.id,
          sceneIndex: i,
          sceneName: s.name,
          planned,
          existingScene: s,
          priorIssues: ['fix me'],
          parentWorld: world,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parentOpts: makeParentOpts() as any,
          emit: () => {},
          logger: new AgentLogger(),
          costLedger: ledger,
          totalScenes: 3,
        }),
      ),
    )
    expect(outcomes.every((o) => o.skippedOverCap)).toBe(true)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })
})

describe('F3 — the build merges a builder’s timeline back into the parent world', () => {
  it("lands a builder's placed clip on the MERGED world, not just in its clone", async () => {
    // Same defect as the director's: add_track/place_clip stay in a builder's toolset and
    // the prompt points at them for timeline audio, but this merge loop only ever carried
    // `scenes` — so the sequence edit was discarded and the export went out silent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunAgent.mockImplementation(async (o: any) => {
      // Clone like the real runAgent does — a sub-agent mutates its OWN copy, so this
      // test can only pass if the merge below actually carries it home.
      const timeline = JSON.parse(JSON.stringify(o.timeline ?? { tracks: [], markers: [] }))
      timeline.tracks = [...(timeline.tracks ?? []), { id: 'A2', kind: 'audio', clips: [{ id: 'c1' }] }]
      return {
        fullText: '',
        toolCalls: [
          { id: 't1', toolName: 'place_clip', input: { trackId: 'A2' }, output: { success: true }, durationMs: 1 },
          {
            id: 'v',
            toolName: 'verify_scene',
            input: { sceneId: o.selectedSceneId },
            output: { success: true, data: { issues: [] } },
            durationMs: 1,
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
        updatedGlobalStyle: o.globalStyle,
        updatedTimeline: timeline,
        stopReason: 'completed',
        agentType: 'scene-maker',
        modelId: 'claude-sonnet-4-6',
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world = makeWorld(1) as any
    world.timeline = { tracks: [{ id: 'V1', kind: 'video', clips: [] }], markers: [] }
    await runDirectorLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scenePlan: world.scenePlan as any,
      parentWorld: world,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parentOpts: makeParentOpts() as any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackIds = (world.timeline?.tracks ?? []).map((t: any) => t.id)
    expect(trackIds).toContain('V1') // the parent's own track was forwarded, not lost
    expect(trackIds).toContain('A2') // …and the builder's clip landed
  })
})
