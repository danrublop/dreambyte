// @vitest-environment node
// Override the global DATABASE_URL stub from src/test/setup.ts before any module
// loads. logSpend() inside runAgent uses libsql, which only accepts libsql/file
// URLs. Using `file::memory:` keeps the runner happy without touching real disk.
process.env.DATABASE_URL = 'file::memory:'

/**
 * Integration tests for the agent loop in runner.ts.
 *
 * These drive runAgent() against a MockAnthropicClient that replays scripted
 * SSE events from the fixtures in runner.fixtures.ts. The point is to lock in
 * loop behavior — iteration counting, tool dispatch, error recovery,
 * compaction — so refactoring runner.ts (Step 4 of the foundation bundle) can
 * happen without regressions.
 *
 * What these tests intentionally do NOT cover:
 *   - Real tool side effects (DB writes, scene HTML generation). Tools that
 *     succeed in fixtures use minimal-side-effect handlers; the
 *     tool-failure-rollback fixture uses a deliberately bogus tool name to
 *     exercise the failure path without depending on tool implementations.
 *   - Provider-specific quirks for OpenAI/Google. Step 1 covers Anthropic; if
 *     someone adds analogous mock clients for the other providers later, they
 *     can extend this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Stub the DB-write helpers runAgent calls in its post-run accounting block.
// Without this, every test logs a 60-line DrizzleQueryError stack trace
// because the in-memory SQLite has no schema (no migrations were run). The
// runner already swallows these errors — the noise was just visual. Mocking
// at the boundary is cleaner than depending on a fully-migrated test DB.
vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof import('../db')>('../db')
  return {
    ...actual,
    logSpend: vi.fn(async () => undefined),
    logAgentUsage: vi.fn(async () => undefined),
  }
})

// Silence per-iteration info logs from the agent runner so the test summary
// isn't buried under hundreds of lines. Two log surfaces to mute:
//   - src/lib/logger (the module-level `log` inside runner.ts and friends)
//   - src/lib/agents/logger.ts AgentLogger (per-run iteration/tool logs)
// When debugging a failing test, comment these out to get the noise back.
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
    summary() {
      return ''
    }
  }
  return { ...actual, AgentLogger: SilentLogger }
})

import {
  runAgent,
  shouldHandoffToOrchestrator,
  shouldFanOutToBranches,
  reportUnconsumedSteers,
  getToolTimeout,
} from './runner'
import { PARENT_ONLY_TOOL_NAMES } from './tools'
import { enqueueSteer, drainSteers, steerQueueDepth } from './pending-steers'
import { AgentLogger } from './logger'
// The mocked DB spend loggers (see vi.mock('../db') above) — imported so PR8
// tests can assert call counts (sub-agent double-log guard).
import { logSpend } from '../db'
// Every provider resolves its client from providers.ts.
import {
  __setProviderClientsForTesting,
  __setProviderClientsForTesting as __setProvidersStoreForTesting,
  resetProviderClients,
  resetProviderClients as resetProvidersStore,
} from './providers'
import { registerAdapter, getAdapter, __resetAdapterRegistryForTesting } from './providers/adapter'
import type { ProviderAdapter, NormalizedStreamEvent, StreamChatOptions } from './providers/adapter'
import { MockAnthropicClient } from './mock-anthropic'
import {
  MockGoogleClient,
  geminiText,
  geminiFunctionCall,
  geminiUsage,
  geminiFinish,
  geminiGrounding,
} from './mock-google'
import { MockOpenAIClient, oaiText, oaiFinish, oaiToolCallChunks } from './mock-openai'
import {
  ALL_FIXTURES,
  FIXTURES_BY_NAME,
  type Fixture,
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
import type { SSEEvent } from './types'
import type { Scene, GlobalStyle } from '../types'

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal GlobalStyle that satisfies the required fields. The runner reads
 *  these via buildAgentContext / serializeWorldState — neither requires more
 *  than the shape below. */
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

interface RunResult {
  events: SSEEvent[]
  result: Awaited<ReturnType<typeof runAgent>> | null
  error: Error | null
  client: MockAnthropicClient
}

/** Drive runAgent against a fixture and capture every SSE event + the final
 *  result (or error). Returns once runAgent resolves or rejects. */
async function runFixture(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof runAgent>[0]> = {},
): Promise<RunResult> {
  const client = new MockAnthropicClient(fixture.responses)
  __setProviderClientsForTesting({ anthropic: client })

  const events: SSEEvent[] = []
  const emit = (e: SSEEvent) => events.push(e)

  const baseScenes: Scene[] = []
  const baseGlobalStyle = makeGlobalStyle()

  let result: Awaited<ReturnType<typeof runAgent>> | null = null
  let error: Error | null = null
  try {
    result = await runAgent({
      message: 'test prompt',
      scenes: baseScenes,
      globalStyle: baseGlobalStyle,
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      // Cap iterations safely above expected so the fixture's own end_turn drives termination.
      maxIterations: Math.max(fixture.expected.iterations + 2, 5),
      emit,
      ...overrides,
    })
  } catch (e) {
    error = e as Error
  }

  return { events, result, error, client }
}

// ── Reset state between tests ────────────────────────────────────────────────

beforeEach(() => {
  // Make sure each test starts with no leftover client from a prior test.
  resetProviderClients()
})

afterEach(() => {
  // Drop the mock so production code paths can't accidentally pick it up
  // if a later test forgets to inject.
  resetProviderClients()
})

// ── Regression: server tools must keep their `type` field ────────────────────
//
// Anthropic distinguishes "server tools" (web_search, code_execution etc.) from
// "custom tools". Server tools carry a `type` field and intentionally have no
// input_schema. Earlier the runner mapped every tool to {name, description,
// input_schema} which silently stripped `type` from server tools and the API
// rejected the request with `tools.<n>.custom.input_schema: Field required`.
// This test asserts the request shape stays correct when web_search has been
// swapped to its native server-tool form.

describe('runAgent — Anthropic request shape', () => {
  it('preserves server-tool `type` field when web_search is swapped to native', async () => {
    const fixture = FIXTURES_BY_NAME['happy-path']
    const client = new MockAnthropicClient(fixture.responses)
    __setProviderClientsForTesting({ anthropic: client })
    await runAgent({
      message: 'test prompt',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      webSearchEnabled: true, // turns on the swap
      maxIterations: 3,
      emit: () => {},
    })
    expect(client.requests.length).toBeGreaterThan(0)
    const tools = client.requests[0].params.tools as Array<Record<string, unknown>>
    // Every tool sent to Anthropic must be one of:
    //   - a server tool: has `type` field, no input_schema
    //   - a custom tool: has input_schema, no `type` field
    // Mixed/missing both is what triggers the 400 from the API.
    const broken = tools.filter((t) => {
      const hasType = typeof t.type === 'string'
      const hasSchema = t.input_schema && typeof t.input_schema === 'object'
      return !hasType && !hasSchema
    })
    expect(broken).toEqual([])
  })
})

// ── Mock infra sanity ────────────────────────────────────────────────────────
//
// These tests cover the test infrastructure itself. They run fast, prove the
// MockAnthropicClient is wired up correctly, and would catch regressions in
// the helper layer before they confuse downstream fixture tests.

describe('MockAnthropicClient', () => {
  it('serves scripted responses in order', async () => {
    const fixture = FIXTURES_BY_NAME['happy-path']
    const client = new MockAnthropicClient(fixture.responses)

    const stream = client.messages.stream({ model: 'claude-sonnet-4-6' } as any)
    const collected: string[] = []
    for await (const event of stream as any) {
      collected.push((event as { type: string }).type)
    }

    expect(collected).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    const finalMsg = await stream.finalMessage()
    expect(finalMsg.id).toBe('msg_happy_01')
    expect(finalMsg.stop_reason).toBe('end_turn')
  })

  it('throws a clear error if asked for more iterations than scripted', () => {
    const client = new MockAnthropicClient([])
    expect(() => client.messages.stream({} as any)).toThrow(/no fixture left in queue/)
  })

  it('captures each request for assertion', async () => {
    const fixture = FIXTURES_BY_NAME['happy-path']
    const client = new MockAnthropicClient(fixture.responses)
    client.messages.stream({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] } as any)
    expect(client.requests).toHaveLength(1)
    expect(client.requests[0].method).toBe('stream')
    expect(client.requests[0].params.model).toBe('claude-sonnet-4-6')
  })
})

// ── Fixture-driven loop tests ────────────────────────────────────────────────

describe('runAgent — happy-path fixture', () => {
  it('completes a single-iteration text-only response', async () => {
    const { events, result, error, client } = await runFixture(FIXTURES_BY_NAME['happy-path'])

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(client.iterationCount).toBe(1)
    expect(client.isEmpty()).toBe(true)

    // Token events should have been emitted in order.
    const tokenEvents = events.filter((e) => e.type === 'token')
    const concatenated = tokenEvents.map((e) => e.token ?? '').join('')
    expect(concatenated).toContain('Hello!')
    expect(concatenated).toContain('How can I help?')

    // No tool calls expected.
    const toolEvents = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_complete')
    expect(toolEvents).toHaveLength(0)

    // Final returned text contains both fragments.
    expect(result!.fullText).toContain('Hello! How can I help?')
  })
})

describe('runAgent — single-tool fixture', () => {
  it('runs a tool, feeds the result back, completes on iteration 2', async () => {
    const { events, result, error, client } = await runFixture(FIXTURES_BY_NAME['single-tool'])

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(client.iterationCount).toBe(2)
    expect(client.isEmpty()).toBe(true)

    // tool_start should fire for the scripted bogus tool.
    const toolStarts = events.filter((e) => e.type === 'tool_start').map((e) => e.toolName)
    expect(toolStarts).toContain('__test_tool_a__')

    // tool_complete should record success:false for an unrecognized tool.
    const toolComplete = events.find((e) => e.type === 'tool_complete' && e.toolName === '__test_tool_a__')
    expect(toolComplete).toBeDefined()
    expect(toolComplete?.toolResult?.success).toBe(false)
  })
})

describe('runAgent — multi-tool-loop fixture', () => {
  it('advances the iteration counter cleanly across 3 tool calls + final text', async () => {
    const { result, error, client } = await runFixture(FIXTURES_BY_NAME['multi-tool-loop'])

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(client.iterationCount).toBe(4)
    expect(client.isEmpty()).toBe(true)
  })
})

describe('runAgent — tool-failure-rollback fixture', () => {
  it('emits a failure event and continues when a tool call fails', async () => {
    const { events, result, error, client } = await runFixture(FIXTURES_BY_NAME['tool-failure-rollback'])

    // Loop should NOT throw — tool failures are surfaced as events, not exceptions.
    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(client.iterationCount).toBe(2)

    // tool_complete should record success:false for the bogus tool.
    const failedToolComplete = events.find((e) => e.type === 'tool_complete' && e.toolName === '__nonexistent_tool__')
    expect(failedToolComplete).toBeDefined()
    expect(failedToolComplete?.toolResult?.success).toBe(false)
  })
})

describe('runAgent — compaction-trigger fixture', () => {
  it('completes successfully with a low compaction threshold + history', async () => {
    // Build a long synthetic chat history so compaction has something to chew on.
    const longHistory = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'Lorem ipsum '.repeat(200), // ~200 tokens each, well above 6k threshold once summed
      timestamp: Date.now() - (12 - i) * 1000,
    }))

    const { result, error, client } = await runFixture(FIXTURES_BY_NAME['compaction-trigger'], {
      history: longHistory as any,
      runConfig: {
        compactionMaxTokens: 500, // force compaction to trigger early
        compactionPreserveRecent: 2,
      },
    })

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(client.iterationCount).toBe(2)
  })
})

// ── Smoke check: every registered fixture should at least run ────────────────

describe('all fixtures — smoke', () => {
  it.each(ALL_FIXTURES.map((f) => [f.name, f] as const))('runs %s without throwing', async (_name, fixture) => {
    const { error } = await runFixture(
      fixture,
      fixture.name === 'compaction-trigger'
        ? {
            history: Array.from({ length: 12 }, (_, i) => ({
              id: `h${i}`,
              role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
              content: 'Lorem ipsum '.repeat(200),
              timestamp: Date.now() - (12 - i) * 1000,
            })) as any,
            runConfig: { compactionMaxTokens: 500, compactionPreserveRecent: 2 },
          }
        : {},
    )
    expect(error).toBeNull()
  })
})

// ── Workstream C: agent-decided orchestrator handoff ─────────────────────────

describe('shouldHandoffToOrchestrator', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = (n: number) =>
    ({ title: 't', scenes: Array.from({ length: n }, (_, i) => ({ name: `S${i}` })), totalDuration: n * 8 }) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tc = (toolName: string, success?: boolean) =>
    ({ id: 'x', toolName, input: {}, durationMs: 1, ...(success !== undefined ? { output: { success } } : {}) }) as any

  it('fires when the agent explicitly calls dispatch_scene_builder (any agent, even 1 scene)', () => {
    expect(shouldHandoffToOrchestrator(false, sb(1), [tc('plan_scenes'), tc('dispatch_scene_builder')])).toBe(true)
  })

  it('does NOT fire on a FAILED dispatch call (e.g. dispatched before a scene plan existed)', () => {
    // A failed dispatch must not "stick" and trigger orchestration once a scene plan
    // appears on a later iteration.
    expect(shouldHandoffToOrchestrator(false, sb(3), [tc('dispatch_scene_builder', false)])).toBe(false)
  })

  it('never fires inside a sub-agent, even if dispatch was called', () => {
    expect(shouldHandoffToOrchestrator(true, sb(3), [tc('dispatch_scene_builder')])).toBe(false)
  })

  it('never fires without a scene plan', () => {
    expect(shouldHandoffToOrchestrator(false, null, [tc('dispatch_scene_builder')])).toBe(false)
  })

  it('does NOT fire on the old director heuristic — delegation is now purely agent-decided', () => {
    // The director-only fallback (>=3 scenes + styled + not yet built) was removed
    // after the triage eval proved the prompt path. Planning + styling without an
    // explicit dispatch_scene_builder call no longer triggers orchestration.
    expect(shouldHandoffToOrchestrator(false, sb(3), [tc('set_global_style')])).toBe(false)
    expect(shouldHandoffToOrchestrator(false, sb(3), [tc('plan_scenes'), tc('set_all_transitions')])).toBe(false)
  })
})

// ── Phase A: agent-decided branch fan-out ────────────────────────────────────

describe('shouldFanOutToBranches', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tc = (toolName: string, success?: boolean) =>
    ({ id: 'x', toolName, input: {}, durationMs: 1, ...(success !== undefined ? { output: { success } } : {}) }) as any

  it('fires on a successful dispatch_to_branches call (no scene plan needed)', () => {
    expect(shouldFanOutToBranches(false, [tc('dispatch_to_branches')])).toBe(true)
  })

  it('does NOT fire on a FAILED dispatch_to_branches call', () => {
    expect(shouldFanOutToBranches(false, [tc('dispatch_to_branches', false)])).toBe(false)
  })

  it('never fires inside a sub-agent (a fanned-out branch must not itself fan out)', () => {
    expect(shouldFanOutToBranches(true, [tc('dispatch_to_branches')])).toBe(false)
  })

  it('does not fire without the tool call', () => {
    expect(shouldFanOutToBranches(false, [tc('dispatch_scene_builder'), tc('plan_scenes')])).toBe(false)
  })
})

describe('runAgent — adapter path on the wire (Phase 3.1)', () => {
  afterEach(() => {
    resetProvidersStore()
  })

  it('actually SENDS the conversation-cache breakpoint on the wire', async () => {
    // markConversationCache has a good unit test — and deleting the two call sites
    // that USE it turned nothing red across 509 tests in 24 files. Conversation-history
    // caching is a major cost win (the tool schemas are cached separately), so an
    // un-wired version is a silent, large bill with a green suite.
    //
    // Assert the wire, not the function: the request the provider actually received
    // must carry cache_control on the last content block of the last message.
    const { client } = await runFixture(FIXTURES_BY_NAME['multi-tool-loop'])
    const withHistory = client.requests.filter((r) => ((r.params.messages as unknown[])?.length ?? 0) > 1)
    expect(withHistory.length, 'no multi-message turn to inspect').toBeGreaterThan(0)

    const cached = withHistory.filter((r) => {
      const msgs = r.params.messages as { content: unknown }[]
      const last = msgs[msgs.length - 1]
      if (!Array.isArray(last?.content) || last.content.length === 0) return false
      const tail = last.content[last.content.length - 1] as { cache_control?: unknown }
      return !!tail?.cache_control
    })
    expect(cached.length, 'conversation-history cache breakpoint never reached the provider').toBe(withHistory.length)
  })
})

// ── C1/T6: Anthropic usage accumulates across turns (the money bug) ──────────
//
// Every fixture turn reports input_tokens: 100 / output_tokens: 50 via
// finalMessage (runner.fixtures.ts). The runner used to OVERWRITE the run
// totals each turn for Anthropic, so a 4-turn run reported 100/50 — one
// turn's bill — and the cost cap + spend log under-counted. Both branches
// must now SUM per-turn usage: 4 turns → 400/200.

describe('runAgent — usage accumulates across turns (C1/T6)', () => {
  afterEach(() => {
    resetProvidersStore()
  })

  it('4-turn run sums per-turn usage (4 × 100/50 → 400/200)', async () => {
    const { result, error } = await runFixture(FIXTURES_BY_NAME['multi-tool-loop'])
    expect(error).toBeNull()
    expect(result?.usage.inputTokens).toBe(400)
    expect(result?.usage.outputTokens).toBe(200)
  })

  it('two-phase: stream-deltas-then-finalMsg never double-counts a turn', async () => {
    // single-tool streams deltas (100 in via message_start, 30+5 out via
    // message_delta) AND gets finalMessage corrections (100/50 per turn).
    // A double-count would exceed 200/100; an overwrite would report 100/50.
    const { result, error } = await runFixture(FIXTURES_BY_NAME['single-tool'])
    expect(error).toBeNull()
    expect(result?.usage.inputTokens).toBe(200)
    expect(result?.usage.outputTokens).toBe(100)
  })

  it('[REGRESSION] single-turn totals unchanged (100/50)', async () => {
    const { result } = await runFixture(FIXTURES_BY_NAME['happy-path'])
    expect(result?.usage.inputTokens).toBe(100)
    expect(result?.usage.outputTokens).toBe(50)
  })
})

// ── D1/D4 (v5 T7): stopReason threaded out of runAgent at every exit ─────────
//
// The runner's return previously carried no stop reason, so the service layer
// could not tell a finished build from a cap stop — and round-cap exhaustion
// looked exactly like success. One test per reachable exit reason; 'aborted'
// via the mid-turn adapter abort is covered in abort-checkpoint-resume.test.ts.

describe('runAgent — stopReason per exit site (D1/D4, v5 T7)', () => {
  afterEach(() => {
    resetProvidersStore()
  })

  it("'completed' on a normal end_turn run", async () => {
    const { result } = await runFixture(FIXTURES_BY_NAME['happy-path'])
    expect(result?.stopReason).toBe('completed')
  })

  it("'round_cap' when the iteration cap exhausts with work remaining — plus a run_stopped event (D4)", async () => {
    // single-tool's first turn ends with tool_use (work remaining); cap the run
    // at 1 iteration so the loop falls out of the while condition.
    const { result, events, error } = await runFixture(FIXTURES_BY_NAME['single-tool'], { maxIterations: 1 })
    expect(error).toBeNull()
    expect(result?.stopReason).toBe('round_cap')
    const stopped = events.find((e) => e.type === 'run_stopped')
    expect(stopped?.stopReason).toBe('round_cap')
    expect(stopped?.message).toContain('Round limit reached')
    // The visible chat text explains the stop too (not a silent end).
    expect(result?.fullText).toContain('Round limit reached')
  })

  it("'completed' (NOT round_cap) when the model finishes on the last allowed iteration", async () => {
    // happy-path ends on iteration 1 via end_turn; with the cap at exactly 1
    // the completion break fires inside the iteration — no false round_cap.
    const { result, events } = await runFixture(FIXTURES_BY_NAME['happy-path'], { maxIterations: 1 })
    expect(result?.stopReason).toBe('completed')
    expect(events.find((e) => e.type === 'run_stopped')).toBeUndefined()
  })

  it("'cost_cap' when the run cost cap trips", async () => {
    const { result, events } = await runFixture(FIXTURES_BY_NAME['single-tool'], {
      runConfig: { maxRunCostUsd: 0.000001 },
    })
    expect(result?.stopReason).toBe('cost_cap')
    const stopped = events.find((e) => e.type === 'run_stopped')
    expect(stopped?.stopReason).toBe('cost_cap')
    // D10: the stop message names the cap and the spend.
    expect(stopped?.message).toMatch(/Cost cap \(\$[\d.]+\) reached — \$[\d.]+ spent\./)
  })

  it('trips the cap BEFORE dispatching a tool, not after paying for one', async () => {
    // The test above passes even with the pre-tool gate disabled, because the
    // POST-tool cost check still stops the run and still reports 'cost_cap'. Mutation
    // testing exploited exactly that: `stopForCostCapBeforeTools` was made unable to
    // fire (`if (true) return false`) and 168 tests stayed green.
    //
    // The observable difference is whether a tool was dispatched. The whole point of
    // the pre-tool gate is that an over-cap run does not pay for one more tool round —
    // a dispatched tool cannot be un-billed. So: zero tool calls.
    const { result } = await runFixture(FIXTURES_BY_NAME['single-tool'], {
      runConfig: { maxRunCostUsd: 0.000001 },
    })
    expect(result?.stopReason).toBe('cost_cap')
    // EXECUTED tools, not emitted events: a `tool_start` event is emitted just before
    // this gate runs, so the event fires either way and asserting on it proves nothing.
    // `toolCalls` only gains an entry once a tool actually ran and was billed.
    expect(result?.toolCalls ?? [], 'an over-cap run executed a tool anyway').toEqual([])
  })

  it('a FAILED render is reported as a failed tool call, not a successful export', async () => {
    // Mutation testing deleted `result.success = false` from the export fulfilment
    // block and 320 tests across 16 files stayed green — the agent would cheerfully
    // tell the user it exported an MP4 that was never written. The only nearby
    // coverage, src/lib/store/export-outcome.test.ts, asserts against a hand-rolled copy
    // of this logic rather than this code, so it could not have caught it.
    //
    // Drive the REAL round-trip: the runner emits `export_request` and awaits the
    // renderer; we reject that pending export the way a failed render does.
    const { rejectPendingExport } = await import('./pending-exports')
    const events: SSEEvent[] = []
    const { result } = await runFixture(repeatedToolFixture('export', 1, { resolution: '1080p' }), {
      emit: (e: SSEEvent) => {
        events.push(e)
        if (e.type === 'export_request' && e.exportId) {
          // Reject on a later tick so the runner is already awaiting the promise.
          const id = e.exportId
          setTimeout(() => rejectPendingExport(id, 'render crashed'), 0)
        }
      },
    })

    expect(
      events.some((e) => e.type === 'export_request'),
      'no export_request was emitted',
    ).toBe(true)
    expect(
      result?.toolCalls?.some((t) => t.toolName === 'export'),
      'export never ran',
    ).toBe(true)

    // `toolCalls` entries carry no result, so assert the tool_complete event — which is
    // also what the UI renders and what gets serialized back to the model.
    const done = events.find((e) => e.type === 'tool_complete' && e.toolName === 'export') as
      | { toolResult?: { success?: boolean; error?: string } }
      | undefined
    expect(done, 'no tool_complete for export').toBeDefined()
    expect(done?.toolResult?.success, 'a failed render was reported to the model as a success').toBe(false)
    expect(done?.toolResult?.error).toMatch(/MP4 export failed/)
  })

  it("'tool_call_cap' when the tool-call cap trips", async () => {
    const { result, events } = await runFixture(FIXTURES_BY_NAME['happy-path'], {
      runConfig: { maxToolCalls: 0 },
    })
    expect(result?.stopReason).toBe('tool_call_cap')
    expect(events.find((e) => e.type === 'run_stopped')?.stopReason).toBe('tool_call_cap')
  })

  it("'stuck_invalid_args' on the invalid-tool-args structural stop", async () => {
    const { result, events } = await runFixture(FIXTURES_BY_NAME['invalid-args-guard'])
    expect(result?.stopReason).toBe('stuck_invalid_args')
    expect(events.find((e) => e.type === 'run_stopped')?.stopReason).toBe('stuck_invalid_args')
  })

  it("'aborted' when the client was already disconnected at loop entry", async () => {
    const ac = new AbortController()
    ac.abort()
    const { result, error } = await runFixture(FIXTURES_BY_NAME['happy-path'], { abortSignal: ac.signal })
    expect(error).toBeNull()
    expect(result?.stopReason).toBe('aborted')
  })

  it("'error' rides on the rejection as _stopReason (the promise rejects, no return object)", async () => {
    // Truncate the script so the second model call throws (queue exhausted).
    const truncated: Fixture = {
      ...FIXTURES_BY_NAME['single-tool'],
      responses: FIXTURES_BY_NAME['single-tool'].responses.slice(0, 1),
    }
    const { error } = await runFixture(truncated)
    expect(error).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((error as any)._stopReason).toBe('error')
    // The turn produced nothing visible, so the runner spends its one empty-turn
    // retry (EMPTY_TURN_RETRY_DELAY_MS = 20s) before giving up — hence the timeout.
  }, 40_000)
})

// ── P0-1 (v7 Lane C): no-progress (stuck / ping-pong) loop guard ─────────────
//
// A model that repeats the same mutating tool call (or ping-pongs between two)
// with no state delta must be steered once, then hard-stopped with `stuck` +
// checkpoint, well before the 40-iteration / 150-call / $cost caps fire. Poll
// tools that legitimately repeat while waiting on async work must NOT trip it.
//
// These drive the Anthropic adapter (the same path runFixture uses for the cap
// tests above). The detector reads only the tool NAME + input + result, so
// unknown tool names work fine — they execute as no-delta failures, exactly the
// stall signature, without needing real tool side effects.
import { STUCK_WINDOW, STUCK_STOP_GRACE } from './stuck-detector'

/** A fixture that calls `toolName` for `count` tool turns, then ends with a final
 *  text turn. Every tool turn is identical, so a mutating tool produces the stuck
 *  signature and a poll tool is exempt.
 *
 *  `input` must satisfy the tool's REQUIRED args. Empty `{}` works for the synthetic
 *  `__stuck_*__` names, but a real registered tool with required params trips the
 *  invalid-args guard (MAX_INVALID_ARGS_RETRIES → 'stuck_invalid_args') long before
 *  the stuck-loop guard under test ever sees the repetition. */
function repeatedToolFixture(toolName: string, count: number, input: Record<string, unknown> = {}): Fixture {
  const args = JSON.stringify(input)
  const toolResponses = Array.from({ length: count }, (_, i) => ({
    events: [
      messageStart({ id: `msg_rep_${i}` }),
      toolUseBlockStart({ id: `toolu_${i}`, name: toolName, index: 0 }),
      toolUseInputDelta(args, 0),
      blockStop(0),
      messageDelta({ stopReason: 'tool_use' as const }),
    ],
    finalMessage: finalToolUseMessage({
      id: `msg_rep_${i}`,
      toolUses: [{ id: `toolu_${i}`, name: toolName, input }],
    }),
  }))
  return {
    name: `repeated-${toolName}`,
    description: `${count}x ${toolName} then end_turn`,
    responses: [
      ...toolResponses,
      {
        events: [
          messageStart({ id: 'msg_rep_done' }),
          textBlockStart(0),
          textDelta('Done.', 0),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn' }),
        ],
        finalMessage: finalTextMessage({ id: 'msg_rep_done', text: 'Done.', stopReason: 'end_turn' }),
      },
    ],
    expected: { iterations: count + 1, finalText: 'Done.', toolCalls: [toolName], success: true },
  }
}

describe('runAgent — no-progress (stuck) loop guard (P0-1)', () => {
  it('steers once then hard-stops with `stuck` + run_stopped when a mutating tool repeats no-delta', async () => {
    // Enough identical no-delta calls to clear the window (steer) + the grace
    // window (stop). High maxIterations so the ROUND cap can't fire first.
    const count = STUCK_WINDOW + STUCK_STOP_GRACE + 3
    const fixture = repeatedToolFixture('__stuck_mutating_tool__', count)
    const { result, events, error } = await runFixture(fixture, { maxIterations: count + 5 })

    expect(error).toBeNull()
    expect(result?.stopReason).toBe('stuck')

    const stopped = events.find((e) => e.type === 'run_stopped')
    expect(stopped?.stopReason).toBe('stuck')
    expect(stopped?.message).toMatch(/repeating tool calls with no effect/i)
    expect(result?.fullText).toMatch(/repeating tool calls with no effect/i)
  })

  it('a single mutating-tool repeat does NOT consume the whole iteration budget (stops early)', async () => {
    const count = STUCK_WINDOW + STUCK_STOP_GRACE + 3
    const fixture = repeatedToolFixture('__stuck_mutating_tool__', count)
    const { result } = await runFixture(fixture, { maxIterations: count + 5 })
    // It stopped for `stuck`, NOT round_cap — i.e. it cut the loop short.
    expect(result?.stopReason).toBe('stuck')
    expect(result?.stopReason).not.toBe('round_cap')
  })

  it("repeated get_status(kind:'export') (poll) does NOT trip — runs to normal completion", async () => {
    // Many identical poll calls; without the exemption this would `stuck`-stop.
    const count = STUCK_WINDOW + STUCK_STOP_GRACE + 5
    // jobId is REQUIRED. This test previously passed with `{}` only because
    // get_status(kind:'export') was missing from AGENT_TOOLS['scene-maker'] and so was never
    // offered — the args were never checked against a schema. Now that the agent can
    // actually export, a poll has to look like a real poll.
    const fixture = repeatedToolFixture('get_status', count, { kind: 'export', jobId: 'export_job_1' })
    const { result, events } = await runFixture(fixture, { maxIterations: count + 5 })

    expect(result?.stopReason).toBe('completed')
    expect(events.find((e) => e.type === 'run_stopped')).toBeUndefined()
  })

  it('distinct mutating tools across iterations do NOT trip (multi-tool-loop completes)', async () => {
    // The shipped multi-tool-loop fixture calls 3 DISTINCT tools then ends —
    // distinct signatures must never look like a stall.
    const { result, events } = await runFixture(FIXTURES_BY_NAME['multi-tool-loop'])
    expect(result?.stopReason).toBe('completed')
    expect(events.find((e) => e.type === 'run_stopped' && e.stopReason === 'stuck')).toBeUndefined()
  })

  it('injects exactly ONE steering note before the stop', async () => {
    const count = STUCK_WINDOW + STUCK_STOP_GRACE + 3
    const fixture = repeatedToolFixture('__stuck_mutating_tool__', count)
    const { client } = await runFixture(fixture, { maxIterations: count + 5 })
    // Count how many requests carried the stuck steering note in their messages.
    const noteHits = client.requests.filter((r) =>
      JSON.stringify(r.params.messages).includes('with no effect on the project'),
    ).length
    expect(noteHits).toBeGreaterThanOrEqual(1)
    // The note text appears once injected — assert it didn't get injected on
    // every iteration (one-time steer, not spam). Once injected it persists in
    // history, so every SUBSEQUENT request echoes it; the guard is that it was
    // first added on a single iteration, which the stop firing shortly after
    // confirms (only a few iterations elapse between steer and stop).
    expect(noteHits).toBeLessThanOrEqual(STUCK_STOP_GRACE + 2)
  })
})

// ── Phase 3.1: Google + OpenAI adapter paths through the runner ───────────────
//
// Text-only streaming, tool loops, citations, and the OpenAI Responses path —
// asserted end-to-end through the runner on the adapter path (the legacy
// per-provider branches these were once compared against are gone).

/** Drive runAgent with an injected provider client + model, capturing output. */
async function runWithClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  modelOverride: string,
): Promise<RunResult> {
  __setProviderClientsForTesting(pickStore(client))
  const events: SSEEvent[] = []
  let result: Awaited<ReturnType<typeof runAgent>> | null = null
  let error: Error | null = null
  try {
    result = await runAgent({
      message: 'test prompt',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: modelOverride as Parameters<typeof runAgent>[0]['modelOverride'],
      maxIterations: 4,
      emit: (e: SSEEvent) => events.push(e),
    })
  } catch (e) {
    error = e as Error
  }
  return { events, result, error, client: client as MockAnthropicClient }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickStore(client: any): any {
  if (client instanceof MockGoogleClient) return { google: client }
  if (client instanceof MockOpenAIClient) return { openai: client }
  return { anthropic: client }
}

/** Every provider adapter currently registered — restored after a test swaps in
 *  a fake, so a later test doesn't hit "No provider adapter registered". */
function snapshotAdapters(): ProviderAdapter[] {
  const ids = ['google', 'anthropic', 'openai', 'deepseek', 'qwen', 'kimi', 'local'] as const
  return ids.map((id) => getAdapter(id)).filter((a): a is ProviderAdapter => a !== undefined)
}

function textProjection(r: RunResult) {
  return {
    fullText: r.result?.fullText ?? null,
    inputTokens: r.result?.usage.inputTokens ?? null,
    outputTokens: r.result?.usage.outputTokens ?? null,
    error: r.error?.message ?? null,
  }
}

describe('runAgent — Google adapter through the runner (Phase 3.1)', () => {
  afterEach(() => {
    resetProviderClients()
    resetProvidersStore()
  })

  const textScenario = () => ({
    chunks: [geminiText('gem '), geminiText('reply'), geminiUsage(7, 3), geminiFinish()],
  })

  it('routes text output through the Gemini adapter', async () => {
    const out = textProjection(await runWithClient(new MockGoogleClient([textScenario()]), 'gemini-2.5-flash'))
    expect(out.fullText).toContain('gem reply')
    expect(out.inputTokens).toBe(7)
  })

  it('runs a tool loop through the shared tail', async () => {
    const client = new MockGoogleClient([
      { chunks: [geminiFunctionCall('__test_tool_a__', { x: 1 }), geminiUsage(10, 4), geminiFinish()] },
      { chunks: [geminiText('Done.'), geminiUsage(12, 2), geminiFinish()] },
    ])
    const r = await runWithClient(client, 'gemini-2.5-flash')
    expect(r.error).toBeNull()
    expect((r.result?.toolCalls ?? []).map((t) => t.toolName)).toContain('__test_tool_a__')
    expect(r.result?.fullText).toContain('Done.')
    expect(client.captured.length).toBe(2) // two iterations streamed
  })

  it('emits a sources event from grounding metadata', async () => {
    const client = new MockGoogleClient([
      { chunks: [geminiText('see'), geminiGrounding([{ uri: 'https://x.com', title: 'X' }]), geminiFinish()] },
    ])
    const r = await runWithClient(client, 'gemini-2.5-flash')
    const sources = r.events.find((e) => e.type === 'sources')
    expect(sources).toBeTruthy()
  })
})

describe('runAgent — OpenAI adapter through the runner (Phase 3.1)', () => {
  afterEach(() => {
    resetProviderClients()
    resetProvidersStore()
  })

  const textScenario = () => ({
    chunks: [oaiText('oai '), oaiText('reply'), oaiFinish('stop', { prompt_tokens: 8, completion_tokens: 2 })],
  })

  it('streams text-only output through the OpenAI adapter', async () => {
    const adapter = textProjection(await runWithClient(new MockOpenAIClient({ chat: [textScenario()] }), 'gpt-4o'))
    expect(adapter.fullText).toContain('oai reply')
    expect(adapter.inputTokens).toBe(8)
  })

  it('runs a tool loop through the shared tail', async () => {
    const client = new MockOpenAIClient({
      chat: [
        {
          chunks: [
            ...oaiToolCallChunks(0, 'call_1', '__test_tool_a__', '{"x":1}'),
            oaiFinish('tool_calls', { prompt_tokens: 10, completion_tokens: 4 }),
          ],
        },
        { chunks: [oaiText('Done.'), oaiFinish('stop', { prompt_tokens: 12, completion_tokens: 2 })] },
      ],
    })
    const r = await runWithClient(client, 'gpt-4o')
    expect(r.error).toBeNull()
    expect((r.result?.toolCalls ?? []).map((t) => t.toolName)).toContain('__test_tool_a__')
    expect(r.result?.fullText).toContain('Done.')
    expect(client.capturedChat.length).toBe(2)
  })
})

// ── Phase 2: typed sub-agent dispatch end-to-end (real runner + real context-builder) ──
//
// The Phase-1 unit tests mocked runAgent, so they could not catch the toolset-scoping
// bug (context-builder treating activeTools as an enable model, not an allowlist). This
// drives a real dispatch_subagent call through the actual runner, runTypedSubAgent,
// runScopedSubAgent, and context-builder — only the model client is mocked. It asserts:
//   1. the parent is offered dispatch_subagent,
//   2. the spawned Explore sub-agent's OFFERED tools are scoped (no create_scene) — the
//      integration-level proof of the toolAllowlist fix,
//   3. the sub-agent's brief comes back to the parent as a tool_result and the loop continues.
describe('typed sub-agent dispatch (Phase 2, adapter path)', () => {
  afterEach(() => resetProvidersStore())

  it('parent dispatches Explore, sub-agent is scoped read-only, brief returns and the loop continues', async () => {
    const BRIEF = 'Brief: WebGPU ships in all major 2026 browsers; cite caniuse.'
    const responses = [
      // Parent turn 1 → call dispatch_subagent(Explore).
      {
        events: [
          messageStart({}),
          toolUseBlockStart({ id: 'tu_1', name: 'dispatch_subagent', index: 0 }),
          toolUseInputDelta(JSON.stringify({ subagentType: 'Explore', task: 'research WebGPU browser support' })),
          blockStop(0),
          messageDelta({ stopReason: 'tool_use' }),
          messageStop(),
        ],
        finalMessage: finalToolUseMessage({
          toolUses: [
            {
              id: 'tu_1',
              name: 'dispatch_subagent',
              input: { subagentType: 'Explore', task: 'research WebGPU browser support' },
            },
          ],
        }),
      },
      // Sub-agent turn → produce the brief, end_turn.
      {
        events: [
          messageStart({}),
          textBlockStart(0),
          textDelta(BRIEF),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn' }),
          messageStop(),
        ],
        finalMessage: finalTextMessage({ text: BRIEF, stopReason: 'end_turn' }),
      },
      // Parent turn 2 → final answer using the brief, end_turn.
      {
        events: [
          messageStart({}),
          textBlockStart(0),
          textDelta('Done — used the research.'),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn' }),
          messageStop(),
        ],
        finalMessage: finalTextMessage({ text: 'Done — used the research.', stopReason: 'end_turn' }),
      },
    ]

    const client = new MockAnthropicClient(responses)
    __setProvidersStoreForTesting({ anthropic: client })

    const result = await runAgent({
      message: 'make a video explaining WebGPU',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      maxIterations: 5,
      // Sub-agents are opt-in now (single-agent is the default) — this test is
      // about the dispatch path, so turn them on explicitly.
      runConfig: { subAgents: true },
      emit: () => {},
    })

    // Three model calls: parent#1 (dispatch), sub-agent, parent#2 (final).
    expect(client.requests).toHaveLength(3)

    const toolNames = (req: (typeof client.requests)[number]) =>
      ((req.params as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name).filter(Boolean) as string[]

    // 1. Parent is offered dispatch_subagent.
    expect(toolNames(client.requests[0])).toContain('dispatch_subagent')

    // 2. The Explore sub-agent's OFFERED tools are scoped read-only — the integration
    //    proof of the toolAllowlist fix. create_scene must be absent; a read tool present.
    const subTools = toolNames(client.requests[1])
    expect(subTools).not.toContain('create_scene')
    expect(subTools).not.toContain('write_scene_code')
    expect(subTools).toContain('inspect')
    // The sub-agent is NOT re-offered dispatch_subagent (no recursion surface).
    expect(subTools).not.toContain('dispatch_subagent')

    // 3. The brief returned to the parent as a tool_result before parent turn 2.
    expect(JSON.stringify(client.requests[2].params.messages)).toContain(BRIEF)

    // The run completed with the parent's post-research answer.
    expect(result.fullText).toContain('Done — used the research.')
  })

  it('general-purpose sub-agent (NO allowlist) loses parent-only dispatch tools via the isSubAgent strip ', async () => {
    // The Explore test above passes via Explore's strict toolAllowlist — it
    // cannot detect a regression in the isSubAgent strip itself (mutation-verified:
    // deleting the runner's contextOpts wiring left the rest of the suite green). general-purpose has NO allowlist
    // (allowedToolsForSubagent → null), so here the strip is the ONLY thing
    // standing between the dispatch_* schemas and the sub-agent's prompt —
    // this pins the full chain: runScopedSubAgent sets isSubAgent → runner
    // contextOpts → buildAgentContext → filterToolsForAgent strip.
    const BRIEF = 'Subtask done.'
    const responses = [
      {
        events: [
          messageStart({}),
          toolUseBlockStart({ id: 'tu_gp', name: 'dispatch_subagent', index: 0 }),
          toolUseInputDelta(JSON.stringify({ subagentType: 'general-purpose', task: 'do a focused subtask' })),
          blockStop(0),
          messageDelta({ stopReason: 'tool_use' }),
          messageStop(),
        ],
        finalMessage: finalToolUseMessage({
          toolUses: [
            {
              id: 'tu_gp',
              name: 'dispatch_subagent',
              input: { subagentType: 'general-purpose', task: 'do a focused subtask' },
            },
          ],
        }),
      },
      {
        events: [
          messageStart({}),
          textBlockStart(0),
          textDelta(BRIEF),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn' }),
          messageStop(),
        ],
        finalMessage: finalTextMessage({ text: BRIEF, stopReason: 'end_turn' }),
      },
      {
        events: [
          messageStart({}),
          textBlockStart(0),
          textDelta('Wrapped up.'),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn' }),
          messageStop(),
        ],
        finalMessage: finalTextMessage({ text: 'Wrapped up.', stopReason: 'end_turn' }),
      },
    ]

    const client = new MockAnthropicClient(responses)
    __setProvidersStoreForTesting({ anthropic: client })

    await runAgent({
      message: 'build the thing',
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      maxIterations: 5,
      // Explicit opt-in: the default is single-agent, and this test is about what a
      // sub-agent is offered once one exists.
      runConfig: { subAgents: true },
      emit: () => {},
    })

    expect(client.requests).toHaveLength(3)
    const toolNames = (req: (typeof client.requests)[number]) =>
      ((req.params as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name).filter(Boolean) as string[]

    const parentTools = new Set(toolNames(client.requests[0]))
    const subTools = new Set(toolNames(client.requests[1]))
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(parentTools.has(name), `parent missing "${name}"`).toBe(true)
      expect(subTools.has(name), `general-purpose sub-agent still offered "${name}"`).toBe(false)
    }
    // The strip is surgical: the sub-agent keeps its real build tools.
    expect(subTools.has('write_scene_code')).toBe(true)

    // Prompt/schema parity: the sub-agent's
    // system prompt must not instruct calling the stripped tools — the
    // delegation section is swapped for the no-delegation note.
    const systemText = (req: (typeof client.requests)[number]) =>
      JSON.stringify((req.params as { system?: unknown }).system ?? '')
    expect(systemText(client.requests[0])).toContain('Delegation mechanics')
    expect(systemText(client.requests[1])).not.toContain('dispatch_scene_builder')
    expect(systemText(client.requests[1])).toContain('focused sub-agent')
  })
})

// ── D1: mid-run steering (drain into context, consumed/unconsumed, sub-agent guard) ──
//
// The mocked AgentLogger (top of file) gives every run runId 'test-run', so a
// steer enqueued under 'test-run' before runFixture is drained by the run's
// top-level loop. The sub-agent guard is the !opts.isSubAgent flag, independent
// of runId.

describe('runAgent — mid-run steering (D1)', () => {
  const RUN = 'test-run' // matches the mocked SilentLogger.runId
  beforeEach(() => {
    drainSteers(RUN) // isolate: clear any leftover inbox
  })
  afterEach(() => {
    drainSteers(RUN)
  })

  it('drains a queued steer into the iteration context and emits steer_consumed', async () => {
    enqueueSteer(RUN, { id: 's1', text: 'STEER-MARKER make scene 2 blue' })
    const { events, client } = await runFixture(FIXTURES_BY_NAME['happy-path'])

    // The steer landed as a user turn in the request sent to the model...
    const sentMessages = JSON.stringify(client.requests[0].params.messages)
    expect(sentMessages).toContain('STEER-MARKER make scene 2 blue')

    // ...as a PLAIN STRING content (D1.11), not an object array.
    expect(sentMessages).not.toContain('"type":"text","text":"STEER-MARKER')

    // ...and steer_consumed was emitted with the id.
    const consumed = events.find((e: SSEEvent) => e.type === 'steer_consumed')
    expect(consumed?.ids).toEqual(['s1'])

    // inbox drained
    expect(steerQueueDepth(RUN)).toBe(0)
  })

  it('drains MULTIPLE queued steers into one newline-joined FIFO turn with all ids', async () => {
    enqueueSteer(RUN, { id: 's1', text: 'first steer' })
    enqueueSteer(RUN, { id: 's2', text: 'second steer' })
    const { events, client } = await runFixture(FIXTURES_BY_NAME['happy-path'])

    // Both texts, joined by a newline, in FIFO order, as one user turn.
    expect(JSON.stringify(client.requests[0].params.messages)).toContain('first steer\\nsecond steer')
    const consumed = events.find((e: SSEEvent) => e.type === 'steer_consumed')
    expect(consumed?.ids).toEqual(['s1', 's2'])
    expect(steerQueueDepth(RUN)).toBe(0)
  })

  it('a sub-agent run does NOT drain the parent inbox (no steer_consumed)', async () => {
    enqueueSteer(RUN, { id: 's2', text: 'SUB-MARKER should not appear' })
    const { events, client } = await runFixture(FIXTURES_BY_NAME['happy-path'], { isSubAgent: true })

    expect(JSON.stringify(client.requests[0].params.messages)).not.toContain('SUB-MARKER')
    expect(events.find((e: SSEEvent) => e.type === 'steer_consumed')).toBeUndefined()
    // The steer is left for the parent (still queued; teardown is also a no-op for sub-agents).
    expect(steerQueueDepth(RUN)).toBe(1)
  })

  it('reportUnconsumedSteers: leftover steer → steer_unconsumed + inbox cleared', () => {
    enqueueSteer(RUN, { id: 'u1', text: 'never reached an LLM call' })
    const events: SSEEvent[] = []
    reportUnconsumedSteers(RUN, false, (e) => events.push(e), new AgentLogger())

    expect(events).toEqual([{ type: 'steer_unconsumed', ids: ['u1'] }])
    expect(steerQueueDepth(RUN)).toBe(0)
  })

  it('reportUnconsumedSteers: no-op for a sub-agent (leaves the parent inbox alone)', () => {
    enqueueSteer(RUN, { id: 'u2', text: 'parent owns this' })
    const events: SSEEvent[] = []
    reportUnconsumedSteers(RUN, true, (e) => events.push(e), new AgentLogger())

    expect(events).toEqual([])
    expect(steerQueueDepth(RUN)).toBe(1)
  })

  it('reportUnconsumedSteers: empty inbox → no event', () => {
    const events: SSEEvent[] = []
    reportUnconsumedSteers(RUN, false, (e) => events.push(e), new AgentLogger())
    expect(events).toEqual([])
  })
})

// ── review_scene_motion — per-scene scope gate (audit A1/A2, outside-voice #8) ──
//
// The runner intercepts the review_scene_motion tool to export a clip + run the
// motion/sync pass. Unlike review_video (a whole-cut action a scoped builder may
// NOT run), motion review is per-scene: a scope-bound builder MAY review its OWN
// scene and is refused ONLY for a foreign scene. These tests drive the gate
// without a vision provider — the refusal path short-circuits before any engine
// work, and the own-scene path (with no API keys) degrades to an honest
// reviewable:false engine note rather than the scope refusal.

function motionReviewFixture(sceneId: string): Fixture {
  return {
    name: 'motion-review-scope',
    description: "Iteration 1: review(scope:'motion') tool_use. Iteration 2: end_turn.",
    responses: [
      {
        events: [
          messageStart({ id: 'msg_mr_01' }),
          toolUseBlockStart({ id: 'toolu_mr', name: 'review', index: 0 }),
          toolUseInputDelta(JSON.stringify({ scope: 'motion', sceneId }), 0),
          blockStop(0),
          messageDelta({ stopReason: 'tool_use', outputTokens: 20 }),
        ],
        finalMessage: finalToolUseMessage({
          id: 'msg_mr_01',
          toolUses: [{ id: 'toolu_mr', name: 'review', input: { scope: 'motion', sceneId } }],
        }),
      },
      {
        events: [
          messageStart({ id: 'msg_mr_02' }),
          textBlockStart(0),
          textDelta('Done.', 0),
          blockStop(0),
          messageDelta({ stopReason: 'end_turn', outputTokens: 5 }),
        ],
        finalMessage: finalTextMessage({ id: 'msg_mr_02', text: 'Done.', stopReason: 'end_turn' }),
      },
    ],
    expected: { iterations: 2, finalText: 'Done.', toolCalls: ['review'], success: true },
  }
}

const ownScene = {
  id: 'own',
  name: 'Own scene',
  duration: 5,
  bgColor: '#000000',
  sceneType: 'react',
  audioLayer: { enabled: false },
} as unknown as Scene

/** Pull the spliced reviewBrief out of the review_scene_motion tool_complete event. */
function reviewBriefFromEvents(events: SSEEvent[]): { reviewable: boolean; note?: string } | undefined {
  const ev = events.find((e) => e.type === 'tool_complete' && (e.toolResult?.data as any)?.reviewBrief !== undefined)
  return (ev?.toolResult?.data as any)?.reviewBrief
}

describe('runAgent — review_scene_motion scope gate', () => {
  // Resolver reads process.env directly; clear vision keys so engine resolution
  // is deterministic (both native + frame resolvers return null → no capture).
  // ALSO stub the capability probe: it hits the REAL local Ollama
  // (localhost:11434) — a developer with a pulled vision model would otherwise
  // make an engine resolvable and change these tests' behavior.
  const KEYS = ['GOOGLE_AI_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY']
  const HERMETIC_CAPS = {
    ollamaModels: [] as string[],
    hasAnthropicKey: false,
    hasOpenAIKey: false,
    hasGoogleKey: false,
    hasCuda: false,
    compatKeys: {},
  }
  let saved: Record<string, string | undefined> = {}
  beforeEach(async () => {
    const registry = await import('./services/media-understanding-registry')
    vi.spyOn(registry, 'probeCapabilities').mockResolvedValue({ ...HERMETIC_CAPS })
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('refuses a FOREIGN scene for a scope-bound builder (never reviews it)', async () => {
    const { events } = await runFixture(motionReviewFixture('own'), {
      scenes: [ownScene],
      isSubAgent: true,
      scopeForeignSceneIds: ['own'], // the requested scene is foreign to this builder
    })
    const brief = reviewBriefFromEvents(events)
    expect(brief?.reviewable).toBe(false)
    expect(brief?.note).toMatch(/belongs to another scope/)
  })

  it('ALLOWS a scope-bound builder to review its OWN scene (degrades honestly, not a scope refusal)', async () => {
    const { events } = await runFixture(motionReviewFixture('own'), {
      scenes: [ownScene],
      isSubAgent: true,
      scopeForeignSceneIds: ['some-other-scene'], // 'own' is NOT foreign → allowed past the gate
    })
    const brief = reviewBriefFromEvents(events)
    expect(brief?.reviewable).toBe(false)
    // Passed the scope gate: the note is about the missing engine, NOT the scope refusal.
    expect(brief?.note).not.toMatch(/another scope/)
    expect(brief?.note).toMatch(/engine/i)
  })

  it('an AVAILABLE engine with an UN-PINNED request must not crash the resolver', async () => {
    // Regression pin: resolveCutReviewEngine once computed
    // `requested.startsWith(engine.id)` UNCONDITIONALLY — with requested
    // undefined (auto / the motion frame-fallback) and any resolvable engine,
    // every un-pinned cut review threw `Cannot read properties of undefined`.
    // It hid for months because keyless environments never resolved an
    // engine; the first machine with a pulled Ollama vision model crashed.
    const registry = await import('./services/media-understanding-registry')
    vi.spyOn(registry, 'probeCapabilities').mockResolvedValue({
      ...HERMETIC_CAPS,
      ollamaModels: ['moondream:latest'],
    })
    const { resolveCutReviewEngine } = await import('./runner')
    await expect(resolveCutReviewEngine(undefined)).resolves.toBeTruthy() // no throw
    await expect(resolveCutReviewEngine('auto')).resolves.toBeTruthy()
    // A pin still gets the honest no-substitution refusal, not a crash.
    const pinned = await resolveCutReviewEngine('cloud:gemini')
    expect(pinned.engineId).toBeNull()
    expect(pinned.note).toMatch(/unavailable; not substituting/)
  })
})

// ── C4: runtime gate for non-tool-capable models ──────────────────────────────
//
// Models explicitly flagged `supportsTools: false` (e.g. o1; deepseek-v4-pro
// carried the flag historically before the reasoning-replay fix proved it
// tool-capable) were
// "guarded" only by a code comment — an explicit override with no
// enabledModelIds list sailed past resolveModel's fallback filtering and into
// the tool loop, where the provider 400s on the tool schemas. The gate fails
// fast at context time, BEFORE any provider call.

describe('runAgent — non-tool-model gate (C4)', () => {
  it('fails fast with an actionable error when the override model cannot call tools', async () => {
    const { events, error, client } = await runFixture(ALL_FIXTURES[0], {
      modelOverride: 'o1' as never,
    })

    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/does not support tool calling/)
    // The error event reached the UI…
    const errEvent = events.find((e) => e.type === 'error') as { error?: string } | undefined
    expect(errEvent?.error).toMatch(/does not support tool calling/)
    // …and no provider request was ever made.
    expect(client.requests).toHaveLength(0)
  })

  it('tool-capable models pass the gate (control)', async () => {
    const { error, client } = await runFixture(ALL_FIXTURES[0])
    expect(error?.message ?? '').not.toMatch(/does not support tool calling/)
    expect(client.requests.length).toBeGreaterThan(0)
  })
})

// ── P1-7 (v7 Wave 2): mid-stream inactivity stall must retry, not die ─────────
//
// A single mid-stream network stall (the per-event inactivity timeout in
// providers/stream-timeout.ts, default 90s) THROWS out of the adapter's stream.
// The runner's catch (runner.ts ~3796) fabricates an empty makeErrorTurn whose
// text/toolUseBlocks are wiped, so the only honest "what reached the user this
// attempt" signal is the counting emit. Before this fix the gate counted
// thinking tokens and tool_start, so a stall after THINKING-ONLY or a PARTIAL
// tool_use looked non-empty and the run died — a healthy long build killed by
// one blip. The fix keys the empty-turn retry on USER-VISIBLE TEXT only:
//   • stall after thinking-only  → retry whole turn (nothing user-visible)
//   • stall after partial tool args → retry (tool never dispatched)
//   • stall after visible text    → do NOT retry (would duplicate output)
//   • persistent stall            → bounded by emptyRetried (one retry), so the
//                                    run terminates instead of looping forever.
//
// These drive the ADAPTER path with a scripted fake ProviderAdapter registered
// for 'anthropic' (the same seam the consumer unit tests use), so the throw
// originates exactly where withInactivityTimeout would raise it, and the
// runner's retry gate — not the adapter's own backoff — is what's under test.

describe('runAgent — mid-stream inactivity stall retry (P1-7)', () => {
  // The real adapters are registered at module import. Snapshot them ALL so the
  // suite's other adapter-path tests still work after we swap in fakes.
  let realAdapters: ProviderAdapter[] = []

  beforeEach(() => {
    realAdapters = snapshotAdapters()
    __resetAdapterRegistryForTesting()
  })

  afterEach(() => {
    __resetAdapterRegistryForTesting()
    for (const a of realAdapters) registerAdapter(a)
  })

  /** Register a fake 'anthropic' adapter whose Nth streamChat call yields
   *  `scripts[N]` then takes an action: 'throw' (mid-stream stall, like the
   *  inactivity timeout) or 'end' (clean end_turn). Records the call count. */
  function registerScriptedAdapter(scripts: Array<{ events: NormalizedStreamEvent[]; after: 'throw' | 'end' }>): {
    calls: () => number
  } {
    let call = 0
    const adapter: ProviderAdapter = {
      id: 'anthropic',
      async *streamChat(_opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
        // Clamp to the last script so a persistently-stalling stream keeps
        // throwing rather than running out of scripts.
        const script = scripts[Math.min(call, scripts.length - 1)]
        call++
        for (const e of script.events) {
          await Promise.resolve() // real async boundary, like the SDK
          yield e
        }
        if (script.after === 'throw') {
          throw new Error('Stream inactivity timeout after 90000ms: Anthropic stream')
        }
        // 'end' — clean finish.
        yield { type: 'message_stop', stopReason: 'end_turn' }
      },
    }
    registerAdapter(adapter)
    return { calls: () => call }
  }

  async function runAdapter(): Promise<RunResult> {
    __setProvidersStoreForTesting({ anthropic: new MockAnthropicClient([]) })
    const events: SSEEvent[] = []
    let result: Awaited<ReturnType<typeof runAgent>> | null = null
    let error: Error | null = null
    try {
      result = await runAgent({
        message: 'test prompt',
        scenes: [],
        globalStyle: makeGlobalStyle(),
        projectName: 'test-project',
        outputMode: 'mp4',
        modelOverride: 'claude-sonnet-4-6',
        maxIterations: 4,
        emit: (e: SSEEvent) => events.push(e),
      })
    } catch (e) {
      error = e as Error
    }
    return { events, result, error, client: new MockAnthropicClient([]) }
  }

  it('(a) stall after THINKING-ONLY → whole turn is retried (run survives)', async () => {
    const adapter = registerScriptedAdapter([
      // Attempt 1: only a thinking token, then a mid-stream stall.
      { events: [{ type: 'thinking_delta', text: 'let me plan this build' }], after: 'throw' },
      // Attempt 2 (the retry): clean end_turn, no tools — run completes.
      { events: [{ type: 'text_delta', text: 'Done.' }], after: 'end' },
    ])
    const { error } = await runAdapter()
    expect(error).toBeNull() // did NOT die on the stall
    expect(adapter.calls()).toBe(2) // streamChat re-invoked = retried
  }, 30_000) // eats the real 20s EMPTY_TURN_RETRY_DELAY_MS, like error-checkpoint.test.ts

  it('(b) stall after PARTIAL tool args → whole turn is retried (run survives)', async () => {
    const adapter = registerScriptedAdapter([
      // Attempt 1: tool_use started + a partial (incomplete) args delta, then stall.
      // No tool_use_stop → the tool was never completed nor dispatched.
      {
        events: [
          { type: 'tool_use_start', id: 'toolu_1', name: 'write_scene_code' },
          { type: 'tool_use_input_delta', id: 'toolu_1', partialJson: '{"sceneId":"s1"' },
        ],
        after: 'throw',
      },
      // Attempt 2 (the retry): clean end_turn — run completes.
      { events: [{ type: 'text_delta', text: 'Recovered.' }], after: 'end' },
    ])
    const { error } = await runAdapter()
    expect(error).toBeNull()
    expect(adapter.calls()).toBe(2)
  }, 30_000)

  it('(c) stall after VISIBLE TEXT → NOT retried (run dies; no duplicate output)', async () => {
    const adapter = registerScriptedAdapter([
      // Attempt 1: real visible assistant text reached the UI, THEN a stall.
      // Re-running would re-emit the text — so the gate must NOT retry.
      { events: [{ type: 'text_delta', text: 'Here is the plan: step one…' }], after: 'throw' },
      // A second script exists, but it must never be reached.
      { events: [{ type: 'text_delta', text: 'SHOULD-NOT-RUN' }], after: 'end' },
    ])
    const { error } = await runAdapter()
    expect(error).not.toBeNull() // the stream error propagated — run died
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((error as any)._stopReason).toBe('error')
    expect(adapter.calls()).toBe(1) // no retry → no duplicated visible output
  })

  it('(d) PERSISTENT stall → terminates within the retry bound (no infinite loop)', async () => {
    // Every attempt stalls after thinking-only. The thinking-only gate would
    // retry forever if unbounded; emptyRetried caps it at one retry.
    const adapter = registerScriptedAdapter([
      { events: [{ type: 'thinking_delta', text: 'thinking' }], after: 'throw' },
    ])
    const { error } = await runAdapter()
    expect(error).not.toBeNull() // gave up rather than looping
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((error as any)._stopReason).toBe('error')
    // Exactly one retry: the original attempt + one retry, then it gives up.
    expect(adapter.calls()).toBe(2)
  }, 30_000)
})

// P0-B (solidity audit): the adapter internally recovers a retriable 429 within a
// SINGLE streamChat — it emits the backoff `error` event, then real content, then
// a clean message_stop. The consumer keeps `error` set (as a record of the retry)
// but reports a real stopReason. The runner must gate the throw on stopReason, not
// raw `error`, or a COMPLETED run dies on its most common recoverable failure.
describe('runAgent — recovered-429 within one stream does NOT fail the run (P0-B)', () => {
  let realAdapters: ProviderAdapter[] = []

  beforeEach(() => {
    realAdapters = snapshotAdapters()
    __resetAdapterRegistryForTesting()
  })

  afterEach(() => {
    __resetAdapterRegistryForTesting()
    for (const a of realAdapters) registerAdapter(a)
  })

  /** Register a fake 'anthropic' adapter whose single streamChat yields exactly
   *  `events`, with NO mid-stream throw (the adapter already recovered the 429
   *  internally). Records the call count so we can assert no retry happened. */
  function registerOneShotAdapter(events: NormalizedStreamEvent[]): { calls: () => number } {
    let call = 0
    const adapter: ProviderAdapter = {
      id: 'anthropic',
      async *streamChat(_opts: StreamChatOptions): AsyncIterable<NormalizedStreamEvent> {
        call++
        for (const e of events) {
          await Promise.resolve() // real async boundary, like the SDK
          yield e
        }
      },
    }
    registerAdapter(adapter)
    return { calls: () => call }
  }

  async function runOnce(): Promise<{ result: Awaited<ReturnType<typeof runAgent>> | null; error: Error | null }> {
    __setProvidersStoreForTesting({ anthropic: new MockAnthropicClient([]) })
    let result: Awaited<ReturnType<typeof runAgent>> | null = null
    let error: Error | null = null
    try {
      result = await runAgent({
        message: 'test prompt',
        scenes: [],
        globalStyle: makeGlobalStyle(),
        projectName: 'test-project',
        outputMode: 'mp4',
        modelOverride: 'claude-sonnet-4-6',
        maxIterations: 4,
        emit: () => {},
      })
    } catch (e) {
      error = e as Error
    }
    return { result, error }
  }

  it('recovered 429 (error → text → end_turn) → run completes, does NOT throw', async () => {
    const adapter = registerOneShotAdapter([
      { type: 'error', message: 'Rate limit hit — retrying in 15s', retriable: true }, // backoff
      { type: 'text_delta', text: 'Done — scene built.' }, // committed text after recovery
      { type: 'usage_update', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'message_stop', stopReason: 'end_turn' }, // real terminal stopReason
    ])
    const { result, error } = await runOnce()
    expect(error).toBeNull() // the recovered 429 did NOT kill the completed run
    expect(result).not.toBeNull()
    expect(adapter.calls()).toBe(1) // single streamChat — the adapter recovered internally
  })

  it('CONTROL: terminal error (error → stopReason "error") DOES throw', async () => {
    const adapter = registerOneShotAdapter([
      { type: 'error', message: 'overloaded', retriable: true },
      { type: 'message_stop', stopReason: 'error' }, // adapter gave up — genuine terminal failure
    ])
    const { error } = await runOnce()
    expect(error).not.toBeNull() // a genuine terminal error must still propagate
    expect(error?.message).toMatch(/overloaded/i)
  }, 30_000) // an empty terminal-error turn eats the real EMPTY_TURN_RETRY_DELAY_MS before it throws
})

// P0-C (solidity audit): the OUTER per-tool timeout (runner's getToolTimeout →
// withTimeout) must match the INNER dispatch race (tool-executor's toolTimeoutMs).
// Previously getToolTimeout only knew the 120s GENERATION tier and fell every paid
// MEDIA_GEN tool back to 60s — shadowing the 180s media tier so slow paid media
// timed out, got retried, and orphaned a double-billed asset.
describe('getToolTimeout — delegates to the executor tier table (P0-C)', () => {
  it('a MEDIA_GEN tool gets the 180s tier (was 60s before the fix)', () => {
    expect(getToolTimeout('generate_image')).toBe(180_000)
    expect(getToolTimeout('add_music')).toBe(180_000)
    expect(getToolTimeout('dub_video')).toBe(180_000)
  })

  it('a GENERATION tool gets the 120s tier', () => {
    expect(getToolTimeout('add_layer')).toBe(120_000)
    expect(getToolTimeout('write_scene_code')).toBe(120_000)
  })

  it('a plain tool gets the 60s default', () => {
    expect(getToolTimeout('reorder_scenes')).toBe(60_000)
    expect(getToolTimeout('some_unknown_read_tool')).toBe(60_000)
  })
})

// ── PR8: runner-and-cost remediation ──────────────────────────────────────────
describe('PR8 — OpenAI invalid-args retry (P1-4)', () => {
  afterEach(() => {
    resetProviderClients()
    resetProvidersStore()
  })

  it('feeds the validation error back and retries instead of hard-stopping on the FIRST invalid-args call', async () => {
    // Iteration 1 emits a tool call with malformed JSON args → invalid-args
    // path. Before the fix this set stopBecauseInvalidToolArgs and broke the
    // whole run; now it records the error result and falls through so the model
    // gets a turn to correct — iteration 2 then completes cleanly.
    const client = new MockOpenAIClient({
      chat: [
        {
          chunks: [
            ...oaiToolCallChunks(0, 'call_1', '__test_tool_a__', '{ this is not json'),
            oaiFinish('tool_calls', { prompt_tokens: 10, completion_tokens: 4 }),
          ],
        },
        {
          chunks: [oaiText('Fixed the call.'), oaiFinish('stop', { prompt_tokens: 5, completion_tokens: 2 })],
        },
      ],
    })
    const r = await runWithClient(client, 'gpt-4o')
    expect(r.error).toBeNull()
    // Retried, not hard-stopped: run reaches a clean completion.
    expect(r.result?.stopReason).toBe('completed')
    expect(r.result?.stopReason).not.toBe('stuck_invalid_args')
    // The retry surfaced a warning to the user.
    expect(
      r.events.some(
        (e) => e.type === 'warning' && /invalid arguments; the agent will retry/i.test(String(e.message ?? '')),
      ),
    ).toBe(true)
    // Both iterations streamed (the second only happens because we retried).
    expect((client as unknown as { capturedChat: unknown[] }).capturedChat.length).toBe(2)
  })

  it('still hard-stops once the invalid-args retries are exhausted', async () => {
    // Three consecutive malformed-args turns > MAX_INVALID_ARGS_RETRIES(2) → stop.
    const badTurn = () => ({
      chunks: [
        ...oaiToolCallChunks(0, 'call_x', '__test_tool_a__', '{ still bad'),
        oaiFinish('tool_calls', { prompt_tokens: 4, completion_tokens: 1 }),
      ],
    })
    const client = new MockOpenAIClient({ chat: [badTurn(), badTurn(), badTurn(), badTurn()] })
    const r = await runWithClient(client, 'gpt-4o')
    expect(r.error).toBeNull()
    expect(r.result?.stopReason).toBe('stuck_invalid_args')
  })
})

describe('PR8 — totalApiCalls excludes the phantom on a guard stop (P2)', () => {
  it('does not count the iteration whose top-of-loop cost guard breaks before any provider call', async () => {
    // single-tool: iteration 1 makes a real provider call (a tool), then the tiny
    // cap trips at the top of iteration 2 BEFORE the provider is called. apiCalls
    // must be 1 (the one real call), not 2. Before the fix, totalApiCalls++ ran
    // at the top of the loop and counted the aborted iteration too.
    const { result } = await runFixture(FIXTURES_BY_NAME['single-tool'], {
      runConfig: { maxRunCostUsd: 0.000001 },
    })
    expect(result?.stopReason).toBe('cost_cap')
    expect(result?.usage.apiCalls).toBe(1)
  })
})

describe('PR8 — sub-agent LLM spend is not double-logged (P2)', () => {
  beforeEach(() => vi.mocked(logSpend).mockClear())
  afterEach(() => resetProviderClients())

  it('a TOP-LEVEL run logs its agent spend once', async () => {
    await runFixture(FIXTURES_BY_NAME['happy-path'])
    const agentLogs = vi.mocked(logSpend).mock.calls.filter(([, apiName]) => String(apiName).startsWith('agent:'))
    expect(agentLogs.length).toBe(1)
  })

  it('a SUB-AGENT run does NOT self-log its agent spend (the parent aggregates it)', async () => {
    await runFixture(FIXTURES_BY_NAME['happy-path'], { isSubAgent: true })
    const agentLogs = vi.mocked(logSpend).mock.calls.filter(([, apiName]) => String(apiName).startsWith('agent:'))
    expect(agentLogs.length).toBe(0)
  })
})

// ── Single-agent by default (LANE A) ─────────────────────────────────────────
// The requirement: "it should only use sub agents upon request." These pin the
// three states — default, asked-for-in-the-message, and the Settings toggle —
// against the real runner, because the previous default was a code path the
// parent could not come back from (a successful dispatch_scene_builder BREAKS
// the parent loop for good).
describe('single-agent by default; sub-agents only on request', () => {
  afterEach(() => {
    resetProviderClients()
    resetProvidersStore()
  })

  const toolNames = (req: { params: unknown }) =>
    ((req.params as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name).filter(Boolean) as string[]

  /** One turn that calls dispatch_scene_builder, then a final text turn. */
  const dispatchThenFinish = (finalText: string) => [
    {
      events: [
        messageStart({}),
        toolUseBlockStart({ id: 'tu_dsb', name: 'dispatch_scene_builder', index: 0 }),
        toolUseInputDelta(JSON.stringify({ reason: 'structure locked' })),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
        messageStop(),
      ],
      finalMessage: finalToolUseMessage({
        toolUses: [{ id: 'tu_dsb', name: 'dispatch_scene_builder', input: { reason: 'structure locked' } }],
      }),
    },
    {
      events: [
        messageStart({}),
        textBlockStart(0),
        textDelta(finalText),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
        messageStop(),
      ],
      finalMessage: finalTextMessage({ text: finalText, stopReason: 'end_turn' }),
    },
  ]

  const run = (message: string, runConfig: Record<string, unknown>, client: MockAnthropicClient) => {
    __setProvidersStoreForTesting({ anthropic: client })
    return runAgent({
      message,
      scenes: [],
      globalStyle: makeGlobalStyle(),
      projectName: 'test-project',
      outputMode: 'mp4',
      modelOverride: 'claude-sonnet-4-6',
      maxIterations: 5,
      runConfig: { ...runConfig },
      emit: () => {},
    })
  }

  it('DEFAULT: offers no build-delegation tool and never hands the build off', async () => {
    const client = new MockAnthropicClient(dispatchThenFinish('Built them myself.'))
    const result = await run('make a 6-scene video explaining WebGPU', {}, client)

    // 1. The schemas are not on the wire at all.
    const offered = toolNames(client.requests[0])
    expect(offered).not.toContain('dispatch_scene_builder')
    expect(offered).not.toContain('dispatch_subagent')
    // It keeps everything it needs to build the video itself.
    expect(offered).toContain('plan_scenes')
    expect(offered).toContain('write_scene_code')

    // 2. The prompt agrees with the schemas — no phantom instruction.
    const system = JSON.stringify((client.requests[0].params as { system?: unknown }).system ?? '')
    expect(system).not.toContain('dispatch_scene_builder')
    expect(system).toContain('you build the whole video yourself')

    // 3. Belt and braces: a call that gets through ANYWAY (hallucinated name, stale
    //    context) honest-fails, and the parent gets its next turn instead of the run
    //    ending in orchestration. THIS is the regression that matters.
    expect(client.requests).toHaveLength(2)
    expect(result.fullText).toContain('Built them myself.')
    expect(result.fullText).not.toContain('Orchestration complete')
    const dsb = result.toolCalls.find((tc) => tc.toolName === 'dispatch_scene_builder')
    expect(dsb?.output?.success).toBe(false)
  })

  it('ON REQUEST: an explicit ask in the message enables sub-agents', async () => {
    const client = new MockAnthropicClient(dispatchThenFinish('done'))
    await run('make a 6-scene explainer — use sub-agents to build the scenes', {}, client)
    const offered = toolNames(client.requests[0])
    expect(offered).toContain('dispatch_scene_builder')
    expect(offered).toContain('dispatch_subagent')
    const system = JSON.stringify((client.requests[0].params as { system?: unknown }).system ?? '')
    expect(system).toContain('Delegation mechanics')
  })

  it('TOGGLE: Settings → Agents "Use sub-agents" enables them with a neutral message', async () => {
    const client = new MockAnthropicClient(dispatchThenFinish('done'))
    await run('make a 6-scene explainer about tides', { subAgents: true }, client)
    expect(toolNames(client.requests[0])).toContain('dispatch_scene_builder')
  })
})
