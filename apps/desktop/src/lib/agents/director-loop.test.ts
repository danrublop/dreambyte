// @vitest-environment node
/**
 * Tests for runDirectorLoop.
 *
 * The director loop builds the WHOLE video in ONE agent context (so scenes read as one
 * film), replacing the blind per-scene fan-out. These prove: (a) buildDirectorPrompt
 * lays out every beat in order with its pinned id + the coherence instruction, and
 * (b) runDirectorLoop dispatches ONE whole-video agent (on a whole-video build its
 * scopeForeignSceneIds is empty — it owns every scene; on a PARTIAL build the scenes
 * outside its beats are foreign) rather than N scoped clones, merges built scenes AND
 * the timeline back, and returns one SubAgentResult per beat.
 *
 * runAgent is mocked so no real provider call happens; we inspect the single scoped
 * invocation and the merged world/results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub only runAgent — keep the real DEFAULT_RUN_CONFIG so orchestrator module-load
// (SUB_AGENT_TIMEOUT_MS) still works, exactly like orchestrator.test.ts.
const { mockRunAgent } = vi.hoisted(() => ({ mockRunAgent: vi.fn() }))
vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner')>()
  return { ...actual, runAgent: mockRunAgent }
})

import { runDirectorLoop, buildDirectorPrompt, renderDirectorSkillGuides } from './director-loop'
import { ensureSceneShells, SUB_AGENT_TIMEOUT_MS } from './orchestrator'
import { loadSkillForSceneType } from '../skills/registry'
import type { SceneSpec } from './types'
import { AgentLogger } from './logger'
import type { SSEEvent } from './types'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

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

/**
 * Mock the ONE director agent: returns every scene in its cloned world with content,
 * plus a PASSING verify_scene per scene id — so the whole video comes back built and
 * verified (no corrective pass needed). This is the single call the director makes.
 */
function mockDirectorAgent() {
  mockRunAgent.mockImplementation(async (o: Any) => {
    const scenes = (o.scenes ?? []) as Any[]
    const toolCalls = scenes.flatMap((s) => [
      { id: `w-${s.id}`, toolName: 'write_scene_code', input: { sceneId: s.id }, durationMs: 1 },
      {
        id: `v-${s.id}`,
        toolName: 'verify_scene',
        input: { sceneId: s.id },
        output: { success: true, data: { issues: [] } },
        durationMs: 1,
      },
    ])
    return {
      fullText: '',
      toolCalls,
      usage: { inputTokens: 300, outputTokens: 150, apiCalls: 1, costUsd: 4, totalDurationMs: 120 },
      updatedScenes: scenes.map((s) => ({ ...s, reactCode: 'export function S(){return null}' })),
      updatedGlobalStyle: o.globalStyle,
      stopReason: 'completed',
      agentType: 'scene-maker',
      modelId: 'claude-sonnet-4-6',
    }
  })
}

/** All runAgent calls whose scope is the WHOLE video (owns every scene → no foreign ids). */
function wholeVideoCalls() {
  return mockRunAgent.mock.calls.filter(
    (c) => Array.isArray((c[0] as Any).scopeForeignSceneIds) && (c[0] as Any).scopeForeignSceneIds.length === 0,
  )
}

beforeEach(() => {
  mockRunAgent.mockReset()
})

describe('buildDirectorPrompt — the whole-video shot list', () => {
  it('lists every beat IN ORDER with its pinned scene id, name, and purpose', () => {
    const plan = makeScenePlan(3)
    const world = makeWorld(3)
    const sceneMap = ensureSceneShells(plan as Any, world as Any, new AgentLogger())
    const prompt = buildDirectorPrompt(plan as Any, sceneMap, '')

    // Ordered beat headers with the pinned world ids (s0/s1/s2 matched by name).
    expect(prompt).toMatch(/Beat 1\/3 — "Scene 1"\s+\(scene id: s0\)/)
    expect(prompt).toMatch(/Beat 2\/3 — "Scene 2"\s+\(scene id: s1\)/)
    expect(prompt).toMatch(/Beat 3\/3 — "Scene 3"\s+\(scene id: s2\)/)
    expect(prompt.indexOf('Beat 1')).toBeLessThan(prompt.indexOf('Beat 2'))
    expect(prompt.indexOf('Beat 2')).toBeLessThan(prompt.indexOf('Beat 3'))
    expect(prompt).toContain('Purpose 2')
  })

  it('carries the coherence mandate (one film, build in order, do not reset)', () => {
    const plan = makeScenePlan(2)
    const world = makeWorld(2)
    const sceneMap = ensureSceneShells(plan as Any, world as Any, new AgentLogger())
    const prompt = buildDirectorPrompt(plan as Any, sceneMap, '')
    expect(prompt).toMatch(/DIRECTOR/)
    expect(prompt).toMatch(/one .*film|reads as one/i)
    expect(prompt).toMatch(/IN ORDER/)
    expect(prompt).toMatch(/do NOT reset/i)
  })

  it('injects hand-off and carried-motif cues when the plan declares them', () => {
    const plan = {
      title: 'T',
      scenes: [
        {
          name: 'A',
          purpose: 'p',
          sceneType: 'react',
          duration: 8,
          handoffToNext: { type: 'match-cut', note: 'the circle' },
        },
        { name: 'B', purpose: 'p', sceneType: 'react', duration: 8, carriedElements: ['the orange arrow'] },
      ],
      totalDuration: 16,
    }
    const world = { scenes: [], globalStyle: { palette: [] }, scenePlan: plan }
    const sceneMap = ensureSceneShells(plan as Any, world as Any, new AgentLogger())
    const prompt = buildDirectorPrompt(plan as Any, sceneMap, '')
    expect(prompt).toMatch(/match-cut/)
    expect(prompt).toContain('the circle')
    expect(prompt).toContain('the orange arrow')
  })

  it("surfaces the plan's mediaLayers so the director generates imagery (not CSS)", () => {
    const plan = {
      title: 'T',
      scenes: [
        {
          name: 'Hero',
          purpose: 'p',
          sceneType: 'react',
          duration: 8,
          mediaLayers: 'a cinematic drone shot of the coast',
        },
      ],
      totalDuration: 8,
    }
    const world = { scenes: [], globalStyle: { palette: [] }, scenePlan: plan }
    const sceneMap = ensureSceneShells(plan as Any, world as Any, new AgentLogger())
    const prompt = buildDirectorPrompt(plan as Any, sceneMap, '')
    expect(prompt).toContain('cinematic drone shot of the coast')
    expect(prompt).toMatch(/generate_image|generate_veo3_video/)
  })
})

describe('runDirectorLoop — one whole-video mind, not a fan-out', () => {
  it('dispatches EXACTLY ONE whole-video agent that owns every scene (empty foreign scope)', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    // One and only one call is scoped to the whole video (the director build). The
    // fan-out would instead scope each of N sub-agents to a single scene (foreign = rest).
    const whole = wholeVideoCalls()
    expect(whole).toHaveLength(1)
    const call = whole[0][0] as Any
    expect(call.sceneContext).toBe('all')
    expect(call.selectedSceneId).toBeNull()
    // Its prompt is the shot list covering every beat.
    expect(call.message).toContain('Scene 1')
    expect(call.message).toContain('Scene 2')
    expect(call.message).toContain('Scene 3')
  })

  it('returns one SubAgentResult per beat, keyed to the pinned scene id, all built', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    const results = await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.sceneId)).toEqual(['s0', 's1', 's2'])
    expect(results.every((r) => r.success)).toBe(true)
    expect(results.every((r) => r.verifyPassed === true)).toBe(true)
    // Usage attributed once (to beat 0) so the parent aggregate isn't N×-counted.
    expect(results[0].usage.costUsd).toBe(4)
    expect(results.slice(1).every((r) => r.usage.costUsd === 0)).toBe(true)
  })

  it('merges the director-built code back into the parent world by id', async () => {
    mockDirectorAgent()
    const world = makeWorld(2)
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(world.scenes.every((s: Any) => s.reactCode === 'export function S(){return null}')).toBe(true)
  })

  it('emits a sub_agent_start and sub_agent_complete for every beat', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    const events: SSEEvent[] = []
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
    })
    expect(events.filter((e) => e.type === 'sub_agent_start')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'sub_agent_complete')).toHaveLength(3)
  })

  it('does not land scenes when the parent aborted mid-build', async () => {
    mockDirectorAgent()
    const world = makeWorld(2)
    const controller = new AbortController()
    controller.abort()
    const results = await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: { ...makeParentOpts(), abortSignal: controller.signal } as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    // Results still describe each beat, but nothing was merged into the world.
    expect(results).toHaveLength(2)
    expect(world.scenes.every((s: Any) => !s.reactCode)).toBe(true)
  })
})

describe('runDirectorLoop — composite verify integration (Phase 2)', () => {
  const run = (world: Any, reviewCut: Any, events: SSEEvent[]) =>
    runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: (e: SSEEvent) => events.push(e),
      logger: new AgentLogger(),
      reviewCut,
    })

  it('invokes reviewCut with the built scenes and surfaces the summary', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    let seen: Any = null
    const events: SSEEvent[] = []
    await run(
      world,
      async (scenes: Any) => {
        seen = scenes
        return { reviewable: true, summary: 'reads as one film', findings: [] }
      },
      events,
    )
    expect(seen.map((s: Any) => s.sceneId)).toEqual(['s0', 's1', 's2'])
    expect(seen[0]).toMatchObject({ sceneId: 's0', durationSec: 8 })
    expect(events.some((e) => e.type === 'token' && /Composite verify: reads as one film/.test(e.token ?? ''))).toBe(
      true,
    )
  })

  it('honest-skips (visible token) when the reviewer returns not-reviewable — never a silent pass', async () => {
    mockDirectorAgent()
    const events: SSEEvent[] = []
    await run(makeWorld(3), async () => ({ reviewable: false, findings: [], note: 'no vision engine' }), events)
    expect(
      events.some((e) => e.type === 'token' && /Composite verify skipped: no vision engine/.test(e.token ?? '')),
    ).toBe(true)
  })

  it('folds a scene-mapped high finding into that scene’s corrective input', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    const events: SSEEvent[] = []
    // A high continuity finding on s1 must reach the corrective pass — it drives an
    // additional scoped fix for s1 (a call the plain build did not make).
    const before = mockRunAgent.mock.calls.length
    await run(
      world,
      async () => ({
        reviewable: true,
        summary: 's',
        findings: [{ kind: 'continuity', severity: 'high', sceneId: 's1', detail: 'palette resets at the cut' }],
      }),
      events,
    )
    // The finding text reaches a corrective sub-agent scoped to s1 (foreign = the others).
    const fixCall = mockRunAgent.mock.calls
      .slice(before)
      .find((c) => Array.isArray((c[0] as Any).scopeForeignSceneIds) && (c[0] as Any).scopeForeignSceneIds.length > 0)
    expect(fixCall).toBeTruthy()
  })

  it('dispatches a scoped corrective for EACH scene with a high finding (bounded parallel, ⑥.2)', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    const events: SSEEvent[] = []
    const before = mockRunAgent.mock.calls.length
    // Two scenes carry high findings → two independent correctives run (concurrently,
    // under the atomic ledger reserve). Each is a scoped fix (foreign = the others).
    await run(
      world,
      async () => ({
        reviewable: true,
        summary: 's',
        findings: [
          { kind: 'continuity', severity: 'high', sceneId: 's0', detail: 'palette resets at s0' },
          { kind: 'continuity', severity: 'high', sceneId: 's2', detail: 'motif drops at s2' },
        ],
      }),
      events,
    )
    const scopedFixes = mockRunAgent.mock.calls
      .slice(before)
      .filter((c) => Array.isArray((c[0] as Any).scopeForeignSceneIds) && (c[0] as Any).scopeForeignSceneIds.length > 0)
    // One scoped corrective per flagged scene.
    const fixedSceneIds = new Set(scopedFixes.map((c) => (c[0] as Any).selectedSceneId))
    expect(fixedSceneIds).toEqual(new Set(['s0', 's2']))
  })

  it('surfaces a cut-wide finding (no sceneId) as a token', async () => {
    mockDirectorAgent()
    const events: SSEEvent[] = []
    await run(
      makeWorld(3),
      async () => ({
        reviewable: true,
        summary: 's',
        findings: [{ kind: 'pacing', severity: 'medium', detail: 'uneven rhythm across the cut' }],
      }),
      events,
    )
    expect(events.some((e) => e.type === 'token' && /uneven rhythm across the cut/.test(e.token ?? ''))).toBe(true)
  })
})

describe('renderDirectorSkillGuides — the director gets the fan-out’s renderer guide bodies', () => {
  const three = (s: Partial<SceneSpec>): SceneSpec => ({
    name: '3D',
    purpose: 'a 3d orbit',
    sceneType: 'three',
    duration: 8,
    ...s,
  })

  it('injects the renderer guide body once even when several beats share the renderer (dedup)', () => {
    const guide = loadSkillForSceneType('three')!
    const block = renderDirectorSkillGuides([three({ name: 'A' }), three({ name: 'B' })], null)
    // Body present…
    expect(block).toContain(guide.guide.slice(0, 60))
    // …exactly once, not per beat.
    const occurrences = block.split('## Loaded skill — ').length - 1
    expect(occurrences).toBe(1)
  })

  it('returns empty for an all-react plan with no distilled style (react carries its own guidance)', () => {
    const react: SceneSpec = { name: 'Intro', purpose: 'title card', sceneType: 'react', duration: 8 }
    expect(renderDirectorSkillGuides([react, react], null)).toBe('')
  })
})

// ── Lane F: three correctness gaps on the orchestration path ─────────────────

/** The ONE director dispatch. Correctives pin a `selectedSceneId`; the director never does. */
function directorCall(): Any {
  const c = mockRunAgent.mock.calls.find(
    (call) => (call[0] as Any).sceneContext === 'all' && (call[0] as Any).selectedSceneId === null,
  )
  return c![0] as Any
}

describe('F1 — the director is scoped to the beats it was dispatched to build', () => {
  it('whole-video build: scope stays EMPTY (the director owns every scene — unchanged)', async () => {
    mockDirectorAgent()
    const world = makeWorld(3)
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(directorCall().scopeForeignSceneIds).toEqual([])
  })

  it('PARTIAL build: every scene outside the dispatched beats is foreign', async () => {
    // A 3-beat plan dispatched inside a 20-scene project. Before the fix the scope was a
    // hardcoded [], so executeTool's guard (gated on size > 0) never ran and the director
    // could rewrite — or delete_scene — any of the other 17 scenes.
    mockDirectorAgent()
    const world = makeWorld(20)
    const plan = makeScenePlan(3) // names "Scene 1".."Scene 3" → pinned to s0/s1/s2
    await runDirectorLoop({
      scenePlan: plan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    const foreign: string[] = directorCall().scopeForeignSceneIds
    expect(foreign).toHaveLength(17)
    // The three dispatched beats stay writable…
    expect(foreign).not.toContain('s0')
    expect(foreign).not.toContain('s1')
    expect(foreign).not.toContain('s2')
    // …everything else is off-limits.
    expect(foreign).toEqual(expect.arrayContaining(['s3', 's10', 's19']))
  })

  it('a scene the director dropped from its clone is NOT deleted from the parent world', async () => {
    // Evidence for the "delete_scene succeeds in the clone and vanishes at merge" claim:
    // the merge only writes the PINNED beats back, so a scene missing from updatedScenes
    // simply survives in the parent — the agent would have reported a deletion that never
    // happened. With the scope above, a foreign delete_scene is now a tool error instead.
    mockRunAgent.mockImplementation(async (o: Any) => {
      const scenes = (o.scenes ?? []) as Any[]
      return {
        fullText: '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
        // s1 "deleted" inside the clone; s0 built.
        updatedScenes: scenes
          .filter((s) => s.id !== 's1')
          .map((s) => ({ ...s, reactCode: 'export function S(){return null}' })),
        updatedGlobalStyle: o.globalStyle,
        stopReason: 'completed',
        agentType: 'scene-maker',
        modelId: 'claude-sonnet-4-6',
      }
    })
    const world = makeWorld(2)
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(world.scenes.map((s: Any) => s.id)).toContain('s1')
  })
})

describe('F2 — the director runs under a wall-clock timeout', () => {
  /** A director that never returns unless its abort signal fires (a stalled provider call). */
  function mockHangingDirector() {
    mockRunAgent.mockImplementation((o: Any) => {
      if (o.selectedSceneId)
        return Promise.resolve({
          /* corrective — resolve immediately */ fullText: '',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0, costUsd: 0, totalDurationMs: 0 },
          updatedScenes: o.scenes ?? [],
          updatedGlobalStyle: o.globalStyle,
          stopReason: 'completed',
          agentType: 'scene-maker',
          modelId: 'claude-sonnet-4-6',
        })
      return new Promise((resolve) => {
        o.abortSignal?.addEventListener('abort', () =>
          resolve({
            fullText: '',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, apiCalls: 1, costUsd: 0, totalDurationMs: 0 },
            // Nothing finished before the deadline.
            updatedScenes: o.scenes ?? [],
            updatedGlobalStyle: o.globalStyle,
            stopReason: 'aborted',
            agentType: 'scene-maker',
            modelId: 'claude-sonnet-4-6',
          }),
        )
      })
    })
  }

  it('a stalled provider call cannot hang the build forever — it aborts and reports honestly', async () => {
    // Before the fix the director was spawned with a bare runScopedSubAgent: no
    // buildSceneWithTimeout, no SUB_AGENT_TIMEOUT_MS, and the iteration/tool counters
    // cannot advance mid-await — so this never resolved.
    vi.useFakeTimers()
    try {
      mockHangingDirector()
      const world = makeWorld(2)
      const events: SSEEvent[] = []
      const pending = runDirectorLoop({
        scenePlan: world.scenePlan as Any,
        parentWorld: world as Any,
        parentOpts: makeParentOpts() as Any,
        emit: (e: SSEEvent) => events.push(e),
        logger: new AgentLogger(),
      })
      // The bound scales with beats: 2 scenes → 2× the per-scene budget.
      await vi.advanceTimersByTimeAsync(SUB_AGENT_TIMEOUT_MS * 2 + 1_000)
      const results = await pending
      expect(results).toHaveLength(2)
      // Honest surfacing — not a silent green run.
      expect(events.some((e) => e.type === 'token' && /time limit/i.test(e.token ?? ''))).toBe(true)
      expect(results.every((r) => r.verifyPassed === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT abort a healthy build that runs longer than a single scene budget', async () => {
    // The per-scene constant would guillotine a legitimate multi-beat director run; the
    // bound must scale with the number of beats.
    vi.useFakeTimers()
    try {
      mockRunAgent.mockImplementation(
        (o: Any) =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  fullText: '',
                  toolCalls: (o.scenes ?? []).map((s: Any) => ({
                    id: `v-${s.id}`,
                    toolName: 'verify_scene',
                    input: { sceneId: s.id },
                    output: { success: true, data: { issues: [] } },
                    durationMs: 1,
                  })),
                  usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
                  updatedScenes: (o.scenes ?? []).map((s: Any) => ({ ...s, reactCode: 'export function S(){}' })),
                  updatedGlobalStyle: o.globalStyle,
                  stopReason: 'completed',
                  agentType: 'scene-maker',
                  modelId: 'claude-sonnet-4-6',
                }),
              SUB_AGENT_TIMEOUT_MS * 2, // longer than ONE scene's budget, inside a 4-beat run's
            )
          }),
      )
      const world = makeWorld(4)
      const events: SSEEvent[] = []
      const pending = runDirectorLoop({
        scenePlan: world.scenePlan as Any,
        parentWorld: world as Any,
        parentOpts: makeParentOpts() as Any,
        emit: (e: SSEEvent) => events.push(e),
        logger: new AgentLogger(),
      })
      await vi.advanceTimersByTimeAsync(SUB_AGENT_TIMEOUT_MS * 2 + 1_000)
      const results = await pending
      expect(results.every((r) => r.success)).toBe(true)
      expect(events.some((e) => e.type === 'token' && /time limit/i.test(e.token ?? ''))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('F3 — the timeline the director edits is merged back into the parent world', () => {
  /** A director that follows the prompt's timeline-audio instruction: add_track + place_clip. */
  function mockDirectorWithMusicBed() {
    mockRunAgent.mockImplementation(async (o: Any) => {
      const scenes = (o.scenes ?? []) as Any[]
      // It edits ITS OWN cloned timeline (forwarded from the parent), as the real tools do.
      // Clone like the real runAgent does — a sub-agent mutates its OWN copy, so this
      // test can only pass if the merge actually carries it home.
      const timeline = JSON.parse(JSON.stringify(o.timeline ?? { tracks: [], markers: [] }))
      timeline.tracks = [
        ...(timeline.tracks ?? []),
        { id: 'A2', kind: 'audio', name: 'Music', clips: [{ id: 'c1', assetId: 'bed.mp3', startSec: 0 }] },
      ]
      return {
        fullText: '',
        toolCalls: [
          { id: 't1', toolName: 'add_track', input: { kind: 'audio' }, output: { success: true }, durationMs: 1 },
          { id: 't2', toolName: 'place_clip', input: { trackId: 'A2' }, output: { success: true }, durationMs: 1 },
          // Passing verifies so no corrective sub-agent runs — this test must prove the
          // DIRECTOR's own merge, not the corrective path's.
          ...scenes.map((s) => ({
            id: `v-${s.id}`,
            toolName: 'verify_scene',
            input: { sceneId: s.id },
            output: { success: true, data: { issues: [] } },
            durationMs: 1,
          })),
        ],
        usage: { inputTokens: 1, outputTokens: 1, apiCalls: 1, costUsd: 0, totalDurationMs: 1 },
        updatedScenes: scenes.map((s) => ({ ...s, reactCode: 'export function S(){return null}' })),
        updatedGlobalStyle: o.globalStyle,
        updatedTimeline: timeline,
        stopReason: 'completed',
        agentType: 'scene-maker',
        modelId: 'claude-sonnet-4-6',
      }
    })
  }

  it("lands the director's music bed on the MERGED world (not just the tool call)", async () => {
    // The tool call always succeeded — inside the sub-agent's clone. The bug was that the
    // merge only carried `scenes`, so the mutation was discarded and the MP4 exported
    // silent while the run reported success. Assert the merged world, not the call.
    mockDirectorWithMusicBed()
    const world = makeWorld(2) as Any
    world.timeline = { tracks: [{ id: 'V1', kind: 'video', clips: [] }], markers: [] }
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    const trackIds = (world.timeline?.tracks ?? []).map((t: Any) => t.id)
    expect(trackIds).toContain('A2')
    expect(world.timeline.tracks.find((t: Any) => t.id === 'A2').clips).toHaveLength(1)
  })

  it("forwards the parent's timeline INTO the director so it edits the real sequence", async () => {
    mockDirectorWithMusicBed()
    const world = makeWorld(1) as Any
    world.timeline = { tracks: [{ id: 'V1', kind: 'video', clips: [] }], markers: [] }
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(directorCall().timeline.tracks.map((t: Any) => t.id)).toContain('V1')
    // …and the pre-existing track survives the merge.
    expect(world.timeline.tracks.map((t: Any) => t.id)).toContain('V1')
  })

  it('a director that never touches the timeline leaves the parent timeline alone', async () => {
    mockDirectorAgent() // no timeline tools → runAgent carries out `undefined`
    const world = makeWorld(2) as Any
    const original = { tracks: [{ id: 'V1', kind: 'video', clips: [] }], markers: [] }
    world.timeline = original
    await runDirectorLoop({
      scenePlan: world.scenePlan as Any,
      parentWorld: world as Any,
      parentOpts: makeParentOpts() as Any,
      emit: () => {},
      logger: new AgentLogger(),
    })
    expect(world.timeline).toBe(original)
  })
})
