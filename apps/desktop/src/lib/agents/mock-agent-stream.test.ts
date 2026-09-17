// @vitest-environment node
/**
 * Mock agent stream — R2 regression + new-scenario coverage (eng review T5).
 *
 * R2 (iron rule): the five legacy scenarios must emit the SAME normalized
 * event sequence after the sample-payloads builder swap. Normalization =
 * event-type sequence with consecutive token events collapsed (token counts
 * depend on text chunking; the SEQUENCE is the contract the chat UI renders).
 *
 * One intentional payload change is asserted, not hidden: the storyboard
 * scenario's body was a hand-rolled `as unknown as ScenePlan` cast whose
 * fields (durationSec/summary) didn't match SceneSpec — it now emits
 * the typed builder. The event sequence is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMockAgentStream } from './mock-agent-stream'
import type { SSEEvent } from './types'

async function collect(message: string): Promise<SSEEvent[]> {
  const events: SSEEvent[] = []
  const ctrl = new AbortController()
  const p = runMockAgentStream({
    message,
    selectedSceneId: null,
    emit: (e) => events.push(e),
    signal: ctrl.signal,
  })
  await vi.runAllTimersAsync()
  await p
  return events
}

/** Event-type sequence with consecutive identical types collapsed. */
function collapse(events: SSEEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (out[out.length - 1] !== e.type) out.push(e.type)
  }
  return out
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ── R2: legacy scenarios, normalized sequences unchanged ────────────────────

describe('R2 — legacy scenario event sequences', () => {
  it('default', async () => {
    expect(collapse(await collect('make me a video'))).toEqual([
      'agent_routed',
      'iteration_start',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'done',
    ])
  })

  it('multi', async () => {
    expect(collapse(await collect('multi scene build'))).toEqual([
      'agent_routed',
      'iteration_start',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'done',
    ])
  })

  it('error', async () => {
    const events = await collect('error please')
    expect(collapse(events)).toEqual([
      'agent_routed',
      'iteration_start',
      'token',
      'tool_start',
      'tool_complete',
      'token',
      'done',
    ])
    const fail = events.find((e) => e.type === 'tool_complete')
    expect(fail?.toolResult?.success).toBe(false)
  })

  it('permission (paid_api spend gate)', async () => {
    const events = await collect('permission test')
    expect(collapse(events)).toEqual(['agent_routed', 'iteration_start', 'token', 'tool_start', 'tool_complete', 'done'])
    const gate = events.find((e) => e.type === 'tool_complete')
    const pn = gate?.toolResult?.permissionNeeded
    expect(pn?.kind).toBe('paid_api')
    expect(pn?.estimatedCost).toBeTruthy()
    expect(pn?.availableProviders?.length).toBeGreaterThan(1) // provider dropdown path
  })

  it('T9: "storyboard" is no longer a scenario — falls through to the default flow', async () => {
    const events = await collect('storyboard it')
    // No storyboard_proposed event exists anymore; the keyword hits the
    // default narrate-act-confirm flow like any other message.
    expect(collapse(events)).toEqual([
      'agent_routed',
      'iteration_start',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'tool_start',
      'tool_complete',
      'preview_update',
      'token',
      'done',
    ])
  })
})

// ── New scenarios (T5) ───────────────────────────────────────────────────────

describe('new permission-kind scenarios', () => {
  const cases: Array<[string, string]> = [
    ['mutation preview test', 'mutation_preview'],
    ['websearch approval test', 'web_search'],
    ['biometric consent test', 'biometric_consent'],
  ]

  for (const [message, kind] of cases) {
    it(`"${message}" → ${kind} gate`, async () => {
      const events = await collect(message)
      expect(collapse(events)).toEqual([
        'agent_routed',
        'iteration_start',
        'token',
        'tool_start',
        'tool_complete',
        'done',
      ])
      const pn = events.find((e) => e.type === 'tool_complete')?.toolResult?.permissionNeeded
      expect(pn?.kind).toBe(kind)
    })
  }

  it('biometric carries the consent fields the card renders', async () => {
    const events = await collect('biometric consent test')
    const pn = events.find((e) => e.type === 'tool_complete')?.toolResult?.permissionNeeded
    expect(pn?.destination).toBeTruthy()
    expect(pn?.voiceName).toBeTruthy()
  })
})

describe('plan scenario', () => {
  it('emits write_plan → plan_proposed → two live todo updates', async () => {
    const events = await collect('plan the video first')
    expect(collapse(events)).toEqual([
      'agent_routed',
      'iteration_start',
      'token',
      'tool_start',
      'tool_complete',
      'plan_proposed',
      'todos_updated', // ×2 in reality — collapse() merges consecutive same-type events
      'token',
      'done',
    ])
    const proposed = events.find((e) => e.type === 'plan_proposed')
    expect(proposed?.plan?.title).toBeTruthy()
    expect(proposed?.todos?.every((t) => t.status === 'pending')).toBe(true)
    const updates = events.filter((e) => e.type === 'todos_updated')
    expect(updates).toHaveLength(2)
    expect(updates[0].todos?.[0].status).toBe('in_progress')
    expect(updates[1].todos?.[0].status).toBe('completed')
    expect(updates[1].todos?.[1].status).toBe('in_progress')
  })

  it('"plan" wins when legacy "storyboard" keyword also appears (T9)', async () => {
    const events = await collect('storyboard plan')
    expect(events.some((e) => e.type === 'plan_proposed')).toBe(true)
  })
})

describe('abort', () => {
  it('aborting mid-run ends cleanly without an error event', async () => {
    const events: SSEEvent[] = []
    const ctrl = new AbortController()
    const p = runMockAgentStream({
      message: 'make me a video',
      selectedSceneId: null,
      emit: (e) => events.push(e),
      signal: ctrl.signal,
    })
    await vi.advanceTimersByTimeAsync(100)
    ctrl.abort()
    await vi.runAllTimersAsync()
    await p
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })
})
