// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

/**
 * D3 (v5 T7, D13#6) — adapter abort must reach the disconnect checkpoint.
 *
 * The adapter path's mid-turn abort used to `break` out of the while loop,
 * skipping the TOP-OF-LOOP disconnect handler that persists the resume
 * checkpoint — on the default path for every cloud provider. The fix routes
 * the abort through `continue` so the next loop entry checkpoints, and first
 * synthesizes "skipped" tool_results for the aborted turn's tool_use blocks
 * (the abort fires after the model turn returns but BEFORE its tools execute,
 * so the in-memory history would otherwise carry dangling tool_use).
 *
 * Per the plan, checkpoint EXISTENCE alone does not pass: the checkpoint is
 * also RESUMED here, and the resumed run's first API call must be
 * Anthropic-well-formed (every assistant tool_use answered by a tool_result
 * in the following user message; no dangling tool_use).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof import('../db')>('../db')
  return {
    ...actual,
    logSpend: vi.fn(async () => undefined),
    logAgentUsage: vi.fn(async () => undefined),
  }
})

// The runner persists checkpoints through the branch-proposals queries — mock
// so no real SQLite is needed and the persisted checkpoint can be inspected.
vi.mock('../db/queries/branch-proposals', () => ({
  persistRunCheckpoint: vi.fn().mockResolvedValue(undefined),
  getRunCheckpoint: vi.fn().mockResolvedValue(null),
  clearRunCheckpoint: vi.fn().mockResolvedValue(undefined),
}))

// create_scene's action emitter appends to the action_log table — stub it so
// the fire-and-forget write doesn't spam errors against the schemaless test DB.
vi.mock('../db/queries/action-log', () => ({
  appendActionRow: vi.fn(async () => undefined),
}))

// Silence the runner's log surfaces (same idiom as runner.integration.test.ts).
vi.mock('../logger', () => {
  const noop = () => {}
  const stub = { debug: noop, log: noop, info: noop, warn: noop, error: noop }
  return { createLogger: () => stub }
})
vi.mock('./logger', async () => {
  const actual = await vi.importActual<typeof import('./logger')>('./logger')
  class SilentLogger {
    runId = 'test-run'
    log() {}
    warn() {}
    error() {}
    debug() {}
    startPhase() {}
    endPhase() {
      return 0
    }
    getEvents() {
      return []
    }
    getTrace() {
      return []
    }
    summary() {
      return ''
    }
  }
  return { ...actual, AgentLogger: SilentLogger }
})

import { runAgent } from './runner'
import {
  __setProviderClientsForTesting as __setProvidersStoreForTesting,
  resetProviderClients as resetProvidersStore,
} from './providers'
import { MockAnthropicClient } from './mock-anthropic'
import {
  messageStart,
  textBlockStart,
  textDelta,
  toolUseBlockStart,
  toolUseInputDelta,
  blockStop,
  messageDelta,
  messageStop,
  finalTextMessage,
  finalToolUseMessage,
} from './runner.fixtures'
import { persistRunCheckpoint } from '../db/queries/branch-proposals'
import type { RunCheckpoint, ScenePlan, SSEEvent } from './types'
import type { GlobalStyle } from '../types'

const mockedPersist = persistRunCheckpoint as ReturnType<typeof vi.fn>

function makeGlobalStyle(): GlobalStyle {
  return {
    presetId: null,
    paletteOverride: null,
    bgColorOverride: null,
    fontOverride: null,
    bodyFontOverride: null,
    strokeColorOverride: null,
  }
}

const SCENE_PLAN: ScenePlan = {
  title: 'Two-scene build',
  scenes: [
    { name: 'Scene 1', purpose: 'Opening', sceneType: 'react', duration: 8 },
    { name: 'Scene 2', purpose: 'Closing', sceneType: 'react', duration: 8 },
  ],
  totalDuration: 16,
}

/** One scripted model turn that calls create_scene with valid args. */
function createSceneTurn(n: number) {
  const input = JSON.stringify({ name: `Scene ${n}`, prompt: `Scene ${n} content`, duration: 8 })
  return {
    events: [
      messageStart({ id: `msg_cs_${n}` }),
      toolUseBlockStart({ id: `toolu_cs_${n}`, name: 'create_scene', index: 0 }),
      toolUseInputDelta(input, 0),
      blockStop(0),
      messageDelta({ stopReason: 'tool_use' }),
      messageStop(),
    ],
    finalMessage: finalToolUseMessage({
      id: `msg_cs_${n}`,
      toolUses: [{ id: `toolu_cs_${n}`, name: 'create_scene', input: JSON.parse(input) }],
    }),
  }
}

const END_TURN_RESPONSE = {
  events: [
    messageStart({ id: 'msg_resume_done' }),
    textBlockStart(0),
    textDelta('Finished the remaining scene.', 0),
    blockStop(0),
    messageDelta({ stopReason: 'end_turn' }),
    messageStop(),
  ],
  finalMessage: finalTextMessage({ id: 'msg_resume_done', text: 'Finished the remaining scene.' }),
}

/** Anthropic well-formedness: every tool_use id in an assistant message must
 *  be answered by a tool_result with that id in the NEXT (user) message. */
function findDanglingToolUses(messages: Array<{ role: string; content: unknown }>): string[] {
  const dangling: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const toolUseIds = (m.content as Array<{ type?: string; id?: string }>)
      .filter((b) => b?.type === 'tool_use' && typeof b.id === 'string')
      .map((b) => b.id as string)
    if (toolUseIds.length === 0) continue
    const next = messages[i + 1]
    const resultIds = new Set(
      next && next.role === 'user' && Array.isArray(next.content)
        ? (next.content as Array<{ type?: string; tool_use_id?: string }>)
            .filter((b) => b?.type === 'tool_result')
            .map((b) => b.tool_use_id)
        : [],
    )
    for (const id of toolUseIds) if (!resultIds.has(id)) dangling.push(id)
  }
  return dangling
}

beforeEach(() => {
  mockedPersist.mockClear()
})

afterEach(() => {
  resetProvidersStore()
})

describe('adapter abort mid-turn → checkpoint written AND resumable (D3)', () => {
  it('checkpoints via the top-of-loop disconnect handler, then the resumed run’s first API call is well-formed', async () => {
    // ── Phase 1: the aborted run ──────────────────────────────────────────
    // Turn 1 creates Scene 1 (real in-memory create_scene). The abort fires on
    // turn 2's tool_start — after the model turn streams its tool_use, before
    // the tool executes. Pre-fix, the abort `break` skipped the disconnect
    // checkpoint entirely and this test's persist assertion fails.
    const client = new MockAnthropicClient([createSceneTurn(1), createSceneTurn(2)])
    __setProvidersStoreForTesting({ anthropic: client })

    const ac = new AbortController()
    let toolStarts = 0
    const events: SSEEvent[] = []
    const emit = (e: SSEEvent) => {
      events.push(e)
      if (e.type === 'tool_start' && e.toolName === 'create_scene') {
        toolStarts++
        if (toolStarts === 2) ac.abort()
      }
    }

    const result = await runAgent({
      message: 'Build the two scenes',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'd3-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      projectId: 'proj-d3',
      branchId: null,
      initialScenePlan: SCENE_PLAN,
      maxIterations: 5,
      abortSignal: ac.signal,
      emit,
    })

    expect(ac.signal.aborted).toBe(true)
    expect(result.stopReason).toBe('aborted')

    // The disconnect checkpoint persisted, with the work done so far.
    expect(mockedPersist).toHaveBeenCalledTimes(1)
    const [projectId, branchId, checkpoint] = mockedPersist.mock.calls[0] as [string, string | null, RunCheckpoint]
    expect(projectId).toBe('proj-d3')
    expect(branchId).toBeNull()
    expect(checkpoint.reason).toBe('disconnect')
    expect(checkpoint.completedSceneIds).toHaveLength(1)
    expect(checkpoint.scenePlan?.scenes).toHaveLength(2)
    // Scene 2 (index 1) is the remaining work.
    expect(checkpoint.remainingSceneIndexes).toEqual([1])
    expect(checkpoint.worldSnapshot.scenes).toHaveLength(1)
    expect(checkpoint.worldSnapshot.scenes[0].name).toBe('Scene 1')

    // The conversation now survives the interruption as a bounded, image-free
    // digest. Before this the checkpoint carried only a world snapshot, so a
    // resume genuinely had no idea what had been asked or tried.
    expect(checkpoint.conversationDigest).toBeTruthy()
    expect(checkpoint.conversationDigest).toContain('Build the two scenes') // the user's ask
    expect(checkpoint.conversationDigest).toContain('create_scene') // what the agent tried
    // Bounded by construction, and no base64 ever reaches the DB column.
    expect(checkpoint.conversationDigest!.length).toBeLessThanOrEqual(24_000)
    expect(checkpoint.conversationDigest).not.toMatch(/base64|data:image/)

    // ── Phase 2: RESUME from that checkpoint (the service-layer contract:
    // history reset, message rebuilt, world restored from the snapshot). ────
    const resumeClient = new MockAnthropicClient([END_TURN_RESPONSE])
    __setProvidersStoreForTesting({ anthropic: resumeClient })

    const built = checkpoint.completedSceneIds.length
    const total = checkpoint.scenePlan?.scenes.length ?? 0
    const resumeResult = await runAgent({
      message: `Continue building the video. ${built} of ${total} scenes are already built. Build the remaining scenes following the scenePlan.`,
      history: [],
      scenes: checkpoint.worldSnapshot.scenes,
      globalStyle: checkpoint.worldSnapshot.globalStyle,
      sceneGraph: checkpoint.worldSnapshot.sceneGraph,
      initialScenePlan: checkpoint.scenePlan,
      projectName: 'd3-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      projectId: 'proj-d3',
      branchId: null,
      maxIterations: 5,
      emit: () => {},
    })

    expect(resumeResult.stopReason).toBe('completed')

    // The resumed run actually called the API (otherwise the well-formedness
    // check below would be vacuous)…
    expect(resumeClient.requests.length).toBeGreaterThan(0)
    // …and its first request carries no dangling tool_use: every assistant
    // tool_use is answered by a tool_result in the following user message.
    //
    // STILL A FORWARD GUARD: RunCheckpoint now persists a
    // conversationDigest — but it is flattened PLAIN TEXT injected into the
    // resume prompt, never structured tool_use/tool_result blocks. So the
    // aborted run's tool_use blocks still cannot reach this request and this
    // assertion cannot fail TODAY. Kept because that is exactly the property
    // being defended: if a resume ever replays structured history, this is the
    // assertion that catches a dangling tool_use breaking the Anthropic API on
    // resume. The load-bearing abort coverage is the
    // disconnect-checkpoint persistence assertion above and the synthesized
    // skipped-tool_result proxy test below.
    const params = resumeClient.requests[0].params as { messages: Array<{ role: string; content: unknown }> }
    expect(Array.isArray(params.messages)).toBe(true)
    expect(params.messages.length).toBeGreaterThan(0)
    expect(findDanglingToolUses(params.messages)).toEqual([])
  })

  it('synthesizes "skipped" tool_results for the aborted turn (no dangling tool_use in-memory)', async () => {
    // Observable proxy for the in-memory bookkeeping: the aborted turn's
    // create_scene must NOT have executed (only Scene 1 exists), yet the run
    // exits via the disconnect handler ('aborted'), not silently.
    const client = new MockAnthropicClient([createSceneTurn(1), createSceneTurn(2)])
    __setProvidersStoreForTesting({ anthropic: client })

    const ac = new AbortController()
    let toolStarts = 0
    const result = await runAgent({
      message: 'Build the two scenes',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'd3-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      projectId: 'proj-d3',
      initialScenePlan: SCENE_PLAN,
      maxIterations: 5,
      abortSignal: ac.signal,
      emit: (e: SSEEvent) => {
        if (e.type === 'tool_start' && e.toolName === 'create_scene') {
          toolStarts++
          if (toolStarts === 2) ac.abort()
        }
      },
    })

    // Turn 2's tool never ran: one scene, not two.
    expect(result.updatedScenes).toHaveLength(1)
    expect(result.updatedScenes[0].name).toBe('Scene 1')
    expect(result.stopReason).toBe('aborted')
    // And the checkpoint reflects exactly that state.
    expect(mockedPersist).toHaveBeenCalledTimes(1)
    const checkpoint = mockedPersist.mock.calls[0][2] as RunCheckpoint
    expect(checkpoint.completedSceneIds).toHaveLength(1)
  })
})
