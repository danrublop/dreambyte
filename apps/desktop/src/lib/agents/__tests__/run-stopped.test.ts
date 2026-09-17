/**
 * run_stopped emission (eng-review T2 + T2-R).
 *
 * The four structural break paths in runner.ts route through emitRunStopped.
 * These tests pin the helper's contract:
 *   - exactly one event, correct type/stopReason
 *   - default message per reason; custom detail overrides
 *   - T2-R: a throwing emit sink (stream already closed at exactly the moment
 *     a run stops) is swallowed — reporting failure must not mask the stop.
 */

import { describe, it, expect, vi } from 'vitest'
import { emitRunStopped, RUN_STOP_MESSAGES } from '../run-stopped'
import type { SSEEvent, RunStopReason } from '../types'

const REASONS: RunStopReason[] = [
  'cost_cap',
  'tool_call_cap',
  'round_cap',
  'stuck_invalid_args',
  'checkpoint_save_failed',
]

describe('emitRunStopped', () => {
  it.each(REASONS)('emits exactly one run_stopped event with stopReason=%s and its default message', (reason) => {
    const emit = vi.fn()
    emitRunStopped(emit, reason)
    expect(emit).toHaveBeenCalledTimes(1)
    const event = emit.mock.calls[0][0] as SSEEvent
    expect(event.type).toBe('run_stopped')
    expect(event.stopReason).toBe(reason)
    expect(event.message).toBe(RUN_STOP_MESSAGES[reason])
  })

  it('a custom detail overrides the default message', () => {
    const emit = vi.fn()
    emitRunStopped(emit, 'cost_cap', 'Cost limit reached ($5.00 / $5.00 cap).')
    expect((emit.mock.calls[0][0] as SSEEvent).message).toBe('Cost limit reached ($5.00 / $5.00 cap).')
  })

  it('T2-R: a throwing emit sink (closed stream) is swallowed, never rethrown', () => {
    const emit = vi.fn(() => {
      throw new Error('IPC channel closed')
    })
    expect(() => emitRunStopped(emit, 'checkpoint_save_failed')).not.toThrow()
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('every RunStopReason has a default message (no silent undefined banner)', () => {
    for (const reason of REASONS) {
      expect(RUN_STOP_MESSAGES[reason]).toBeTruthy()
      expect(RUN_STOP_MESSAGES[reason].length).toBeGreaterThan(10)
    }
  })
})
