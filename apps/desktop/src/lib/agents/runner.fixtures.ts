/**
 * Typed event constructors and the 5 baseline fixtures driven by
 * runner.integration.test.ts. Each fixture is a complete script of what
 * Anthropic would have streamed back over the wire — no real network calls.
 *
 * Adding a 6th fixture: copy any of the helpers below, edit the events array,
 * and append the fixture to ALL_FIXTURES at the bottom.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { ScriptedResponse, ScriptedStreamEvent } from './mock-anthropic'

// ── Event constructors ───────────────────────────────────────────────────────
//
// These mirror the real SDK event shapes consumed by runner.ts:2687-2789.
// Loose typing on purpose — runner switches on `event.type` strings and reads
// fields via property access, so all we need is the right shape on the wire.

export function messageStart(opts: {
  id?: string
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}): ScriptedStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: opts.id ?? 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: 0,
        cache_creation_input_tokens: opts.cacheCreationTokens ?? 0,
        cache_read_input_tokens: opts.cacheReadTokens ?? 0,
      },
    },
  }
}

export function textBlockStart(index = 0): ScriptedStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  }
}

export function textDelta(text: string, index = 0): ScriptedStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  }
}

export function toolUseBlockStart(opts: { id: string; name: string; index?: number }): ScriptedStreamEvent {
  return {
    type: 'content_block_start',
    index: opts.index ?? 0,
    content_block: { type: 'tool_use', id: opts.id, name: opts.name, input: {} },
  }
}

export function toolUseInputDelta(partialJson: string, index = 0): ScriptedStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  }
}

export function blockStop(index = 0): ScriptedStreamEvent {
  return { type: 'content_block_stop', index }
}

export function messageDelta(opts: {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  outputTokens?: number
}): ScriptedStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: opts.stopReason, stop_sequence: null },
    usage: { output_tokens: opts.outputTokens ?? 50 },
  }
}

export function messageStop(): ScriptedStreamEvent {
  return { type: 'message_stop' }
}

// ── Final message helpers ────────────────────────────────────────────────────

export function finalTextMessage(opts: {
  id?: string
  text: string
  stopReason?: 'end_turn' | 'tool_use'
}): Anthropic.Message {
  return {
    id: opts.id ?? 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: opts.text, citations: null }],
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message
}

export function finalToolUseMessage(opts: {
  id?: string
  text?: string
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = []
  if (opts.text) content.push({ type: 'text', text: opts.text, citations: null })
  for (const t of opts.toolUses) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input })
  }
  return {
    id: opts.id ?? 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message
}

// ── Fixture descriptor ───────────────────────────────────────────────────────

export interface Fixture {
  name: string
  description: string
  responses: ScriptedResponse[]
  expected: {
    /** How many LLM iterations should run before stop. */
    iterations: number
    /** Final accumulated assistant text. */
    finalText: string
    /** Tool names expected to fire, in order. */
    toolCalls: string[]
    /** Whether the run should resolve (true) or reject. */
    success: boolean
  }
}

// ── Fixture 1: happy path — text only, no tools ──────────────────────────────

const HAPPY_PATH: Fixture = {
  name: 'happy-path',
  description: 'User prompt → single text response → end_turn. No tools.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_happy_01' }),
        textBlockStart(0),
        textDelta('Hello! ', 0),
        textDelta('How can I help?', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn', outputTokens: 8 }),
        messageStop(),
      ],
      finalMessage: finalTextMessage({
        id: 'msg_happy_01',
        text: 'Hello! How can I help?',
        stopReason: 'end_turn',
      }),
    },
  ],
  expected: {
    iterations: 1,
    finalText: 'Hello! How can I help?',
    toolCalls: [],
    success: true,
  },
}

// ── Fixture 2: single tool — text + tool_use → tool_result → text → done ─────
//
// Uses a deliberately bogus tool name so we don't depend on real tool handlers
// or DB-backed side effects. Schema validation skips bogus tools (no toolDef
// found at runner.ts:2884), execution fails, and the loop continues with the
// failure surfaced as a tool_result. That's exactly the loop behavior we want
// to lock in: tool_use stop_reason → execute → feed result back → next call.

const SINGLE_TOOL: Fixture = {
  name: 'single-tool',
  description: 'Iteration 1: text + tool_use. Iteration 2: text response after tool result.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_tool_01' }),
        textBlockStart(0),
        textDelta('Calling tool now.', 0),
        blockStop(0),
        toolUseBlockStart({ id: 'toolu_a', name: '__test_tool_a__', index: 1 }),
        toolUseInputDelta('{"x":1}', 1),
        blockStop(1),
        messageDelta({ stopReason: 'tool_use', outputTokens: 30 }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_tool_01',
        text: 'Calling tool now.',
        toolUses: [{ id: 'toolu_a', name: '__test_tool_a__', input: { x: 1 } }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_tool_02' }),
        textBlockStart(0),
        textDelta('Done.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn', outputTokens: 5 }),
      ],
      finalMessage: finalTextMessage({
        id: 'msg_tool_02',
        text: 'Done.',
        stopReason: 'end_turn',
      }),
    },
  ],
  expected: {
    iterations: 2,
    finalText: 'Calling tool now.Done.',
    toolCalls: ['__test_tool_a__'],
    success: true,
  },
}

// ── Fixture 3: multi-tool loop — 3 sequential tool calls ─────────────────────
//
// Same rationale as SINGLE_TOOL — bogus tool names keep the test focused on
// loop counter advancement, not tool implementations.

const MULTI_TOOL_LOOP: Fixture = {
  name: 'multi-tool-loop',
  description: '3 tool_use iterations + a final text iteration. Verifies the loop counter advances cleanly.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_loop_01' }),
        toolUseBlockStart({ id: 'toolu_a', name: '__test_tool_a__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_loop_01',
        toolUses: [{ id: 'toolu_a', name: '__test_tool_a__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_loop_02' }),
        toolUseBlockStart({ id: 'toolu_b', name: '__test_tool_b__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_loop_02',
        toolUses: [{ id: 'toolu_b', name: '__test_tool_b__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_loop_03' }),
        toolUseBlockStart({ id: 'toolu_c', name: '__test_tool_c__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_loop_03',
        toolUses: [{ id: 'toolu_c', name: '__test_tool_c__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_loop_04' }),
        textBlockStart(0),
        textDelta('All three tools complete.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
      ],
      finalMessage: finalTextMessage({
        id: 'msg_loop_04',
        text: 'All three tools complete.',
        stopReason: 'end_turn',
      }),
    },
  ],
  expected: {
    iterations: 4,
    finalText: 'All three tools complete.',
    toolCalls: ['__test_tool_a__', '__test_tool_b__', '__test_tool_c__'],
    success: true,
  },
}

// ── Fixture 4: tool failure → rollback ───────────────────────────────────────
//
// The tool itself will throw inside executeTool because the input doesn't match
// the registered handler's schema (or the snapshot rollback path fires). We
// verify the runner does NOT crash — it surfaces the failure as a tool_complete
// event with success:false and continues to the next iteration.

const TOOL_FAILURE_ROLLBACK: Fixture = {
  name: 'tool-failure-rollback',
  description: 'Tool call fails (bogus tool name). Runner emits failure event and continues.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_fail_01' }),
        toolUseBlockStart({ id: 'toolu_bad', name: '__nonexistent_tool__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_fail_01',
        toolUses: [{ id: 'toolu_bad', name: '__nonexistent_tool__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_fail_02' }),
        textBlockStart(0),
        textDelta('Sorry, that tool failed.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
      ],
      finalMessage: finalTextMessage({
        id: 'msg_fail_02',
        text: 'Sorry, that tool failed.',
        stopReason: 'end_turn',
      }),
    },
  ],
  expected: {
    iterations: 2,
    finalText: 'Sorry, that tool failed.',
    toolCalls: ['__nonexistent_tool__'],
    success: true,
  },
}

// ── Fixture 5: compaction trigger ────────────────────────────────────────────
//
// We can't directly assert "compaction ran" without instrumenting the runner,
// but we CAN assert that with a long history + small compactionMaxTokens, the
// loop completes successfully and the second request has fewer messages than
// the raw history.length would imply.

const COMPACTION_TRIGGER: Fixture = {
  name: 'compaction-trigger',
  description: 'Long history + low compaction threshold → loop completes + second request shows compacted history.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_compact_01' }),
        toolUseBlockStart({ id: 'toolu_x', name: '__test_tool_a__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_compact_01',
        toolUses: [{ id: 'toolu_x', name: '__test_tool_a__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_compact_02' }),
        textBlockStart(0),
        textDelta('History compacted; continuing.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
      ],
      finalMessage: finalTextMessage({
        id: 'msg_compact_02',
        text: 'History compacted; continuing.',
        stopReason: 'end_turn',
      }),
    },
  ],
  expected: {
    iterations: 2,
    finalText: 'History compacted; continuing.',
    toolCalls: ['__test_tool_a__'],
    success: true,
  },
}

// ── Fixture 6: invalid-args recovery (regression for B1) ─────────────────────
//
// Iteration 1 streams MALFORMED JSON for the tool input (missing closing brace),
// so the runner's parse fails and sets inputError. Pre-fix, this terminated the
// whole run. Post-fix, the validation error is returned as a tool_result and the
// loop CONTINUES — iteration 2 sends well-formed args (streak resets), iteration
// 3 ends the turn. The model got to self-correct instead of the run dying.

const INVALID_ARGS_RECOVERY: Fixture = {
  name: 'invalid-args-recovery',
  description: 'Iter 1: malformed tool args → error fed back. Iter 2: valid args. Iter 3: end_turn. Run survives.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_badargs_01' }),
        toolUseBlockStart({ id: 'toolu_bad', name: '__test_bad_args__', index: 0 }),
        toolUseInputDelta('{"sceneId": "s1"', 0), // missing closing brace → JSON.parse throws
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_badargs_01',
        toolUses: [{ id: 'toolu_bad', name: '__test_bad_args__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_badargs_02' }),
        toolUseBlockStart({ id: 'toolu_ok', name: '__test_tool_b__', index: 0 }),
        toolUseInputDelta('{}', 0), // well-formed → no inputError → streak resets
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_badargs_02',
        toolUses: [{ id: 'toolu_ok', name: '__test_tool_b__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_badargs_03' }),
        textBlockStart(0),
        textDelta('Recovered.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
      ],
      finalMessage: finalTextMessage({ id: 'msg_badargs_03', text: 'Recovered.', stopReason: 'end_turn' }),
    },
  ],
  expected: {
    iterations: 3,
    finalText: 'Recovered.',
    toolCalls: ['__test_bad_args__', '__test_tool_b__'],
    success: true,
  },
}

// ── Fixture 7: invalid-args guard (regression for B1) ────────────────────────
//
// The model sends malformed args every turn and never makes progress. The
// consecutive-invalid-args guard must stop the run after
// MAX_CONSECUTIVE_INVALID_ARGS_ITERS (3) iterations — gracefully, not by
// thrashing to the iteration/cost cap. Exactly 3 responses are scripted; if the
// guard failed to fire, the runner would request a 4th and the mock would throw.

const INVALID_ARGS_GUARD: Fixture = {
  name: 'invalid-args-guard',
  description: 'Malformed args 3x in a row → guard stops the run gracefully (no 4th request).',
  responses: Array.from({ length: 3 }, (_, i) => ({
    events: [
      messageStart({ id: `msg_guard_0${i + 1}` }),
      toolUseBlockStart({ id: `toolu_bad_${i}`, name: '__test_bad_args__', index: 0 }),
      toolUseInputDelta('{"sceneId":', 0), // malformed every time
      blockStop(0),
      messageDelta({ stopReason: 'tool_use' }),
    ],
    finalMessage: finalToolUseMessage({
      id: `msg_guard_0${i + 1}`,
      toolUses: [{ id: `toolu_bad_${i}`, name: '__test_bad_args__', input: {} }],
    }),
  })),
  expected: {
    iterations: 3,
    finalText: '', // a stop notice is appended; asserted in the test, not matched here
    toolCalls: ['__test_bad_args__', '__test_bad_args__', '__test_bad_args__'],
    success: true,
  },
}

// ── Fixture 8: context-pressure compaction (regression for B2) ───────────────
//
// Iteration 1 reports a HUGE prompt size (195k input tokens) via message_start
// usage — above the usable window of a 200k model. This must force a compaction
// driven by the provider-reported count, not the chars/4 estimate. Paired with a
// long synthetic history in the test so there's something to compact.

const CONTEXT_PRESSURE: Fixture = {
  name: 'context-pressure',
  description: 'Provider reports 195k prompt tokens → forces real-token-driven compaction.',
  responses: [
    {
      events: [
        messageStart({ id: 'msg_pressure_01', inputTokens: 195_000 }),
        toolUseBlockStart({ id: 'toolu_p', name: '__test_tool_a__', index: 0 }),
        toolUseInputDelta('{}', 0),
        blockStop(0),
        messageDelta({ stopReason: 'tool_use' }),
      ],
      finalMessage: finalToolUseMessage({
        id: 'msg_pressure_01',
        toolUses: [{ id: 'toolu_p', name: '__test_tool_a__', input: {} }],
      }),
    },
    {
      events: [
        messageStart({ id: 'msg_pressure_02', inputTokens: 20_000 }),
        textBlockStart(0),
        textDelta('Done.', 0),
        blockStop(0),
        messageDelta({ stopReason: 'end_turn' }),
      ],
      finalMessage: finalTextMessage({ id: 'msg_pressure_02', text: 'Done.', stopReason: 'end_turn' }),
    },
  ],
  expected: {
    iterations: 2,
    finalText: 'Done.',
    toolCalls: ['__test_tool_a__'],
    success: true,
  },
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const ALL_FIXTURES: Fixture[] = [
  HAPPY_PATH,
  SINGLE_TOOL,
  MULTI_TOOL_LOOP,
  TOOL_FAILURE_ROLLBACK,
  COMPACTION_TRIGGER,
  INVALID_ARGS_RECOVERY,
  INVALID_ARGS_GUARD,
  CONTEXT_PRESSURE,
]

export const FIXTURES_BY_NAME: Record<string, Fixture> = Object.fromEntries(ALL_FIXTURES.map((f) => [f.name, f]))
