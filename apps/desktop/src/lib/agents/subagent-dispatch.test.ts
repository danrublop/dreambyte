/**
 * Unit tests for runScopedSubAgent — the generic sub-agent spawn primitive
 * extracted from the orchestrator's scene builder (Phase 0).
 *
 * runAgent is mocked so no real provider calls happen; we capture the call args
 * and assert the spawn contract: isolated world clone, toolset pass-through,
 * isSubAgent flag, scope, ledger threading, and the runConfig (caps + budget)
 * the orchestrator's budget tests depend on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRunAgent } = vi.hoisted(() => ({ mockRunAgent: vi.fn() }))
vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner')>()
  return { ...actual, runAgent: mockRunAgent }
})

import { runScopedSubAgent } from './subagent-dispatch'
import { AgentLogger } from './logger'
import { makeRunCostLedger } from './run-cost-ledger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeParentWorld(): any {
  return {
    scenes: [
      { id: 's0', name: 'Scene 1', duration: 8, bgColor: '#000', sceneType: 'react' },
      { id: 's1', name: 'Scene 2', duration: 8, bgColor: '#000', sceneType: 'react' },
    ],
    globalStyle: { palette: ['#fff'] },
    sceneGraph: { nodes: [], edges: [], startSceneId: '' },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeParentOpts(): any {
  return {
    message: 'parent',
    scenes: [],
    globalStyle: { palette: [] },
    projectName: 'test',
    outputMode: 'mp4',
    modelOverride: 'claude-sonnet-4-6',
    modelConfigs: [
      {
        id: 'ollama-tongyi',
        provider: 'local',
        modelId: 'tongyi',
        localModelName: 'tongyi',
        endpoint: 'http://localhost:11434',
      },
    ],
  }
}

function mockOk() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockRunAgent.mockImplementation(async (o: any) => ({
    fullText: 'done',
    toolCalls: [{ id: 'tc', toolName: 'write_scene_code', input: {}, durationMs: 1 }],
    usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0.1, totalDurationMs: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedScenes: (o.scenes ?? []).map((s: any) => ({ ...s, sceneCode: 'built' })),
    updatedGlobalStyle: o.globalStyle,
    agentType: o.agentOverride,
    modelId: 'claude-sonnet-4-6',
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseOpts(overrides: Record<string, any> = {}) {
  return {
    agentType: 'scene-maker' as const,
    prompt: 'build scene s0',
    activeTools: ['create_scene', 'write_scene_code', 'verify_scene'],
    parentWorld: makeParentWorld(),
    parentOpts: makeParentOpts(),
    emit: vi.fn(),
    logger: new AgentLogger(),
    subAgentId: 'sub-1',
    label: 'Scene 1',
    maxIterations: 15,
    maxToolCalls: 50,
    ...overrides,
  }
}

beforeEach(() => {
  mockRunAgent.mockReset()
  mockOk()
})

describe('runScopedSubAgent', () => {
  it('forwards mp4Settings — a 9:16 project must not build 16:9 scenes', async () => {
    // This literal forwards ~35 fields and used to omit this one. Without it
    // resolveProjectDimensions falls back to 16:9/1920x1080, so every scene builder in
    // a portrait project authored to a landscape frame while its own brief said 9:16 —
    // and export regenerates the wrapper, so nothing downstream could undo it.
    const parentOpts = makeParentOpts()
    parentOpts.mp4Settings = { aspectRatio: '9:16', resolution: '1080p', format: 'mp4' }
    await runScopedSubAgent(baseOpts({ parentOpts }))
    expect(mockRunAgent.mock.calls[0][0].mp4Settings).toEqual({
      aspectRatio: '9:16',
      resolution: '1080p',
      format: 'mp4',
    })
  })

  it('spawns with isSubAgent and passes the toolset + prompt + agentType through', async () => {
    await runScopedSubAgent(baseOpts())
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.isSubAgent).toBe(true)
    expect(call.message).toBe('build scene s0')
    // No agentOverride — the runner defaults to the single agent (scene-maker).
    expect(call.activeTools).toEqual(['create_scene', 'write_scene_code', 'verify_scene'])
    expect(call.maxIterations).toBe(15)
  })

  it('pins runConfig.maxToolCalls and sets maxRunCostUsd only when a budget is given', async () => {
    await runScopedSubAgent(baseOpts({ maxToolCalls: 50, budgetUsd: 7 }))
    let call = mockRunAgent.mock.calls[0][0]
    expect(call.runConfig.maxToolCalls).toBe(50)
    expect(call.runConfig.maxRunCostUsd).toBe(7)

    mockRunAgent.mockClear()
    await runScopedSubAgent(baseOpts({ maxToolCalls: 50, budgetUsd: undefined }))
    call = mockRunAgent.mock.calls[0][0]
    expect(call.runConfig.maxToolCalls).toBe(50)
    expect('maxRunCostUsd' in call.runConfig).toBe(false)
  })

  it('threads scopeForeignSceneIds and the shared cost ledger', async () => {
    const ledger = makeRunCostLedger(25)
    await runScopedSubAgent(baseOpts({ scopeForeignSceneIds: ['s1'], costLedger: ledger }))
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.scopeForeignSceneIds).toEqual(['s1'])
    expect(call.costLedger).toBe(ledger) // same reference, not a copy
    // D4 invariant: a sub-agent is EITHER aggregated by its parent OR self-logging,
    // never both. Scene builders spawned this way ARE aggregated by the orchestrator
    // handoff, so they must not opt in — that is the documented double-billing bug.
    expect(call.selfLogUsage).toBeFalsy()
  })

  it('forwards the parent TIMELINE — a builder that places a clip must not edit an empty sequence', async () => {
    // add_track/place_clip are deliberately kept in a sub-agent's toolset and the builder
    // prompt points at them for timeline audio, but this literal never forwarded the
    // timeline: the builder read an EMPTY sequence and everything it placed was lost.
    const parentWorld = makeParentWorld()
    parentWorld.timeline = { tracks: [{ id: 'A1', kind: 'audio', clips: [] }], markers: [] }
    await runScopedSubAgent(baseOpts({ parentWorld }))
    expect(mockRunAgent.mock.calls[0][0].timeline).toEqual(parentWorld.timeline)
  })

  it('forwards timeline as null (not undefined) when the project has none — init_timeline fabricates', async () => {
    await runScopedSubAgent(baseOpts())
    expect(mockRunAgent.mock.calls[0][0].timeline).toBeNull()
  })

  it('passes an isolated CLONE of the parent world (mutating it cannot affect the parent)', async () => {
    const opts = baseOpts()
    await runScopedSubAgent(opts)
    const call = mockRunAgent.mock.calls[0][0]
    // Not the same array/object references as the parent world.
    expect(call.scenes).not.toBe(opts.parentWorld.scenes)
    expect(call.scenes[0]).not.toBe(opts.parentWorld.scenes[0])
    expect(call.globalStyle).not.toBe(opts.parentWorld.globalStyle)
    // But deep-equal at spawn time.
    expect(call.scenes).toEqual(opts.parentWorld.scenes)
    // Mutating the clone does not leak back to the parent.
    call.scenes[0].name = 'MUTATED'
    expect(opts.parentWorld.scenes[0].name).toBe('Scene 1')
  })

  it('returns the raw runAgent result unchanged', async () => {
    const result = await runScopedSubAgent(baseOpts())
    expect(result.updatedScenes).toHaveLength(2)
    expect(result.updatedScenes[0].sceneCode).toBe('built')
    expect(result.usage.costUsd).toBe(0.1)
    expect(result.toolCalls[0].toolName).toBe('write_scene_code')
  })
})

import {
  normalizeSubagentType,
  allowedToolsForSubagent,
  runTypedSubAgent,
  resolveResearchModelId,
} from './subagent-dispatch'
import type { ModelConfig } from './model-config'

describe('resolveResearchModelId', () => {
  const deepseek = { id: 'deepseek-v4-flash', provider: 'deepseek', enabled: true } as ModelConfig
  const deepseekOff = { id: 'deepseek-v4-flash', provider: 'deepseek', enabled: false } as ModelConfig

  it('inherit (undefined) for falsy or "inherit"', () => {
    expect(resolveResearchModelId(null, [deepseek], true, true)).toBeUndefined()
    expect(resolveResearchModelId('', [deepseek], true, true)).toBeUndefined()
    expect(resolveResearchModelId('inherit', [deepseek], true, true)).toBeUndefined()
  })
  it('passes an explicit model id straight through', () => {
    expect(resolveResearchModelId('ollama-tongyi', [], false, false)).toBe('ollama-tongyi')
  })
  it('auto → DeepSeek only when search backend + enabled DeepSeek + key all present', () => {
    expect(resolveResearchModelId('auto', [deepseek], true, true)).toBe('deepseek-v4-flash')
  })
  it('auto → inherit when any prerequisite is missing', () => {
    expect(resolveResearchModelId('auto', [deepseek], false, true)).toBeUndefined() // no search backend
    expect(resolveResearchModelId('auto', [deepseek], true, false)).toBeUndefined() // no key
    expect(resolveResearchModelId('auto', [deepseekOff], true, true)).toBeUndefined() // not enabled
    expect(resolveResearchModelId('auto', [], true, true)).toBeUndefined() // no deepseek model
  })
})

describe('normalizeSubagentType', () => {
  it('canonicalizes known aliases', () => {
    expect(normalizeSubagentType('Explore')).toBe('Explore')
    expect(normalizeSubagentType('explorer')).toBe('Explore')
    expect(normalizeSubagentType('research')).toBe('Explore')
    expect(normalizeSubagentType('planner')).toBe('Plan')
    expect(normalizeSubagentType('verify')).toBe('Verification')
    expect(normalizeSubagentType('reviewer')).toBe('Verification')
    expect(normalizeSubagentType('  EX-PLORE ')).toBe('Explore') // whitespace/sep-insensitive
  })
  it('falls back to general-purpose for unknown/empty', () => {
    expect(normalizeSubagentType(undefined)).toBe('general-purpose')
    expect(normalizeSubagentType('')).toBe('general-purpose')
    expect(normalizeSubagentType('frobnicate')).toBe('general-purpose')
  })
})

describe('allowedToolsForSubagent', () => {
  const MUTATING = ['create_scene', 'write_scene_code', 'patch_layer_code', 'add_layer', 'scene_props']
  it('Explore and Verification toolsets contain NO mutating tools (read-only guarantee)', () => {
    for (const type of ['Explore', 'Verification'] as const) {
      const tools = allowedToolsForSubagent(type) ?? []
      for (const m of MUTATING) expect(tools).not.toContain(m)
      expect(tools.length).toBeGreaterThan(0)
    }
  })
  it('Explore can research, Verification can verify', () => {
    expect(allowedToolsForSubagent('Explore')).toContain('web_search')
    expect(allowedToolsForSubagent('Verification')).toContain('verify_scene')
  })
  it('Explore can discover media (stock + archival) — read-only asset URLs, not prose', () => {
    const tools = allowedToolsForSubagent('Explore') ?? []
    expect(tools).toContain('find_media')
  })
  it('Plan includes the plan/todo writers but no scene mutations', () => {
    const tools = allowedToolsForSubagent('Plan') ?? []
    expect(tools).toContain('write_plan')
    expect(tools).toContain('update_todos')
    for (const m of MUTATING) expect(tools).not.toContain(m)
  })
  it('general-purpose returns null (inherit parent toolset)', () => {
    expect(allowedToolsForSubagent('general-purpose')).toBeNull()
  })
})

describe('runTypedSubAgent', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ctx(overrides: Record<string, any> = {}) {
    return {
      parentWorld: makeParentWorld(),
      parentOpts: { ...makeParentOpts(), activeTools: ['create_scene', 'write_scene_code'], ...overrides.parentOpts },
      emit: vi.fn(),
      logger: new AgentLogger(),
      ...overrides,
    }
  }

  it('Explore spawns with the read-only toolset + role-framed prompt, returns the brief', async () => {
    const res = await runTypedSubAgent({ subagentType: 'Explore', task: 'research WebGPU adoption' }, ctx())
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.isSubAgent).toBe(true)
    expect(call.activeTools).toEqual(allowedToolsForSubagent('Explore'))
    expect(call.message).toContain('Explore sub-agent')
    expect(call.message).toContain('research WebGPU adoption')
    expect(res.success).toBe(true)
    expect((res.data as any).subagentType).toBe('Explore')
    expect((res.data as any).brief).toBe('done')
    // The brief is also returned under `report` — the key the runner's summarizer
    // preserves verbatim (a `brief` >500 chars is truncated to a husk), so long
    // research findings + asset URLs actually reach the parent.
    expect((res.data as any).report).toBe('done')
  })

  it('general-purpose inherits the parent toolset', async () => {
    await runTypedSubAgent({ subagentType: 'general-purpose', task: 'do a thing' }, ctx())
    expect(mockRunAgent.mock.calls[0][0].activeTools).toEqual(['create_scene', 'write_scene_code'])
  })

  it('routes research (Explore) onto researchModelId when set; other types inherit the parent model', async () => {
    const parentOpts = { ...makeParentOpts(), modelOverride: 'claude-opus-4-8', researchModelId: 'ollama-tongyi' }
    await runTypedSubAgent({ subagentType: 'Explore', task: 'research X' }, ctx({ parentOpts }))
    expect(mockRunAgent.mock.calls[0][0].modelOverride).toBe('ollama-tongyi')
    // modelConfigs MUST be forwarded, or a local research model can't resolve its
    // endpoint/localModelName in the sub-agent → Ollama 404 (the E2E-caught bug).
    expect(mockRunAgent.mock.calls[0][0].modelConfigs).toBe(parentOpts.modelConfigs)

    mockRunAgent.mockClear()
    await runTypedSubAgent({ subagentType: 'Verification', task: 'check scene 1' }, ctx({ parentOpts }))
    expect(mockRunAgent.mock.calls[0][0].modelOverride).toBe('claude-opus-4-8')
  })

  it('refuses recursion: a sub-agent cannot dispatch a sub-agent', async () => {
    const res = await runTypedSubAgent(
      { subagentType: 'Explore', task: 'x' },
      ctx({ parentOpts: { ...makeParentOpts(), isSubAgent: true } }),
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cannot dispatch/i)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('rejects an empty task without spawning', async () => {
    const res = await runTypedSubAgent({ subagentType: 'Explore', task: '   ' }, ctx())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/task/i)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('surfaces an empty brief as failure, not silent success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunAgent.mockImplementation(async (o: any) => ({
      fullText: '   ',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
      updatedScenes: o.scenes ?? [],
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'm',
    }))
    const res = await runTypedSubAgent({ subagentType: 'Verification', task: 'check scene 1' }, ctx())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/without producing a brief/i)
  })

  it('logs its OWN usage row — nobody aggregates a typed sub-agent (D4)', async () => {
    // The runner skips logSpend/logAgentUsage for every sub-agent because the
    // ORCHESTRATOR folds its scene builders into the parent's totals. Typed
    // dispatches are not folded in by anyone, so they were invisible in
    // agent_usage and api_spend entirely. selfLogUsage is the opt-in; it must be
    // set here and NOWHERE else, or the orchestrator path double-bills.
    await runTypedSubAgent({ subagentType: 'Explore', task: 'research X' }, ctx())
    const call = mockRunAgent.mock.calls.at(-1)![0]
    expect(call.isSubAgent).toBe(true)
    expect(call.selfLogUsage).toBe(true)
    // parentRunId links the row to the parent run rather than double-counting into it.
    expect(call.parentRunId).toBeTruthy()
  })
})

describe('runTypedSubAgent — degenerate termination (F1: do not report a cut-off run as success)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ctxF1(overrides: Record<string, any> = {}) {
    return {
      parentWorld: makeParentWorld(),
      parentOpts: { ...makeParentOpts(), ...overrides.parentOpts },
      emit: vi.fn(),
      logger: new AgentLogger(),
      ...overrides,
    }
  }

  it('cost cap reached → failure, even though fullText is non-empty (the runner appends a cap notice)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunAgent.mockImplementation(async (o: any) => ({
      fullText: '\n\nCost limit reached ($25.00 / $25.00 cap). Stopping to prevent overspend.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 25, totalDurationMs: 1 },
      updatedScenes: o.scenes ?? [],
      updatedGlobalStyle: o.globalStyle,
      agentType: 'scene-maker',
      modelId: 'm',
    }))
    const overCap = {
      spentUsd: 26,
      seedUsd: 0,
      capUsd: 25,
      warned80: true,
      mediaGenCount: 0,
      mediaGenCap: 60,
      researchCount: 0,
      researchCap: 24,
    }
    const res = await runTypedSubAgent({ subagentType: 'Explore', task: 'research X' }, ctxF1({ costLedger: overCap }))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cost cap/i)
  })

  it('aborted run → failure, not a partial brief', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await runTypedSubAgent(
      { subagentType: 'Explore', task: 'research X' },
      ctxF1({ parentOpts: { ...makeParentOpts(), abortSignal: ac.signal } }),
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/aborted/i)
  })
})
