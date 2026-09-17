// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'

/**
 * Regression gate: dispatch_scene_builder must not return a "Delegating N
 * scenes…" SUCCESS on paths where nothing actually builds it: the MCP / Claude-Code path (no runner
 * loop) and sub-agents (handoff suppressed). It must honest-fail there and
 * tell the caller to build per-scene, so the agent doesn't believe scenes are
 * in progress while the timeline stays empty.
 */

function makeWorld(extra: Partial<WorldStateMutable>): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    },
    projectName: 'p',
    projectId: 'proj-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: null },
    ...extra,
  } as unknown as WorldStateMutable
}

const PLAN = {
  title: 'Plan',
  scenes: [{ id: 'a', name: 'A', sceneType: 'react', duration: 6 }],
  totalDuration: 6,
}

describe('dispatch_scene_builder honesty (#2)', () => {
  it('honest-fails when no orchestrator will consume it (MCP / sub-agent)', async () => {
    const r = await executeTool('dispatch_scene_builder', {}, makeWorld({ scenePlan: PLAN as never }))
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not available')
    expect(String(r.error)).toContain('write_scene_code')
  })

  it('delegates (success) only when orchestratorAvailable AND a plan exists', async () => {
    const r = await executeTool(
      'dispatch_scene_builder',
      {},
      makeWorld({ orchestratorAvailable: true, scenePlan: PLAN as never }),
    )
    expect(r.success).toBe(true)
    expect((r.data as { delegated?: boolean } | undefined)?.delegated).toBe(true)
  })

  it('still requires a scenePlan even with an orchestrator', async () => {
    const r = await executeTool('dispatch_scene_builder', {}, makeWorld({ orchestratorAvailable: true }))
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('No scenePlan')
  })
})

/**
 * E2 — the same class, two tools that never got the guard.
 *
 * dispatch_to_branches / dispatch_to_projects are pure acknowledgements: the
 * REAL work is a `fanout_proposed` / `crossproject_proposed` SSE event the
 * runner emits under `!opts.disableFanout && !opts.isSubAgent`. Off that path
 * (MCP has no runner at all; a dispatched leg runs with disableFanout) the emit
 * never happens — but both handlers still returned "Fanning out 3 alternative
 * takes…". `fanoutAvailable` mirrors the emit's own gate.
 */
describe('fan-out dispatch honesty (E2)', () => {
  it('dispatch_to_branches honest-fails when no fan-out will run', async () => {
    const r = await executeTool('dispatch_to_branches', { count: 3, instruction: 'try 3 looks' }, makeWorld({}))
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not available')
    expect(String(r.error)).toMatch(/inline/i)
  })

  it('dispatch_to_branches succeeds on the top-level in-app run', async () => {
    const r = await executeTool(
      'dispatch_to_branches',
      { count: 3, instruction: 'try 3 looks' },
      makeWorld({ fanoutAvailable: true }),
    )
    expect(r.success).toBe(true)
    expect((r.data as { fanout?: boolean } | undefined)?.fanout).toBe(true)
  })

  it('dispatch_to_projects honest-fails when no cross-project dispatch will run', async () => {
    const r = await executeTool('dispatch_to_projects', { instruction: 'apply the new intro' }, makeWorld({}))
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not available')
  })

  it('dispatch_to_projects succeeds on the top-level in-app run', async () => {
    const r = await executeTool(
      'dispatch_to_projects',
      { instruction: 'apply the new intro' },
      makeWorld({ fanoutAvailable: true }),
    )
    expect(r.success).toBe(true)
    expect((r.data as { crossProject?: boolean } | undefined)?.crossProject).toBe(true)
  })

  // Invalid args must still be reported as invalid args, not as "unavailable".
  it('keeps the argument validation ahead of the availability check', async () => {
    const r = await executeTool('dispatch_to_branches', { count: 3 }, makeWorld({ fanoutAvailable: true }))
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('non-empty instruction')
  })
})
