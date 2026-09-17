// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { createRecordingToolHandler } from './recording-tools'

/**
 * Pin tests for the recording family's honesty contract (v5 T8/E3).
 *
 * Recording state NEVER flows back into the agent world (there are zero
 * writers of `world.recordingState`), so the old stop / pause / resume /
 * cancel / get_recording_status / list_recording_sources stubs could only
 * ever report on a recording the agent could not see. They were removed
 * (not advertised as refusing tools); only `start_recording` remains.
 *
 * start_recording STAYS functional (its recordingCommand IS consumed by
 * use-agent-run.ts from the final state_change) but its success message must
 * tell the truth about that lifecycle.
 */

const handler = createRecordingToolHandler()

// `orchestratorAvailable` marks the top-level in-app run — the ONLY path whose
// final state_change reaches use-agent-run.ts, the sole consumer of
// recordingCommand.
function makeWorld(): Record<string, unknown> {
  return { scenes: [], projectId: 'p', currentRunId: 'r', orchestratorAvailable: true }
}

describe('start_recording stays functional but tells the truth (v5 T8/E3)', () => {
  it('sets the recording command on the world and says the recording starts AFTER the run', async () => {
    const world = makeWorld() as Record<string, unknown>
    const res = await handler('start_recording', { sceneId: 'scene-1' }, world)
    expect(res.success).toBe(true)
    // The command IS consumed (use-agent-run.ts applies it from the final
    // state_change) — so the mutation must stay.
    expect(world.recordingCommand).toBe('start')
    expect(world.recordingCommandNonce).toBe(1)
    expect(world.recordingAttachSceneId).toBe('scene-1')
    // The truthful message: begins when the run completes; agent can't stop/monitor.
    const desc = (res.changes?.[0] as { description: string }).description
    expect(desc).toContain('Recording will begin when this run completes')
    expect(desc).toContain('the agent cannot stop or monitor it')
    expect(desc).toContain('scene-1')
  })
})

/**
 * E2 — the guaranteed false success.
 *
 * `world.recordingCommand` has exactly one consumer: use-agent-run.ts, a
 * RENDERER hook fed by the in-app run's final state_change. The MCP path
 * (src/lib/agents/mcp-handler.ts) builds its own throwaway world and never emits a
 * state_change — yet MCP is the ONLY reason this tool is offered at all
 * (MCP_TOOLS adds START_RECORDING explicitly). So over MCP the tool set a field
 * nobody reads and returned "Recording will begin…" every single time.
 */
describe('start_recording honest-fails where nothing consumes the command (E2)', () => {
  it('fails on the MCP / sub-agent path instead of promising a recording', async () => {
    const world: Record<string, unknown> = { scenes: [], projectId: 'p', currentRunId: 'mcp', mcpSession: true }
    const res = await handler('start_recording', { sceneId: 'scene-1' }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/only works from the in-app agent/i)
    expect(res.error).toMatch(/nothing would be recorded/i)
    // No half-written command left behind for a consumer that will never look.
    expect(world.recordingCommand).toBeUndefined()
    expect(world.recordingConfig).toBeUndefined()
  })
})
