// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { AgentLogger } from './logger'

// Regression guard for the D1 P0 fix: mid-run steering requires the runner's
// logger.runId to EQUAL the transport-supplied run id (the one that keys
// activeControllers + the event channel). agent-runner.ts threads the IPC runId
// into `new AgentLogger(runId)` — if AgentLogger ever stops honoring the param,
// the steer active-check and the drain key diverge and steering silently breaks.
describe('AgentLogger run-id adoption (D1 steering depends on this)', () => {
  it('adopts a provided run id verbatim', () => {
    expect(new AgentLogger('ipc-run-123').runId).toBe('ipc-run-123')
  })

  it('mints a fresh uuid when none is provided', () => {
    const a = new AgentLogger().runId
    const b = new AgentLogger().runId
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})
