// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'
import type { SceneSpec } from './types'

/**
 * Phase C richer — prove the agent-provided hand-off survives plan_scenes onto
 * world.scenePlan (the handler spreads ...s, so the optional fields ride along)
 * and reaches the SceneSpecs the orchestrator dispatches with.
 */
describe('plan_scenes persists handoffToNext + carriedElements (#okf-handoff)', () => {
  const makeWorld = (): WorldStateMutable =>
    ({
      scenes: [],
      globalStyle: { presetId: null },
      projectName: 'p',
      projectId: 'proj',
      currentRunId: 'r',
      outputMode: 'mp4',
    }) as unknown as WorldStateMutable

  it('round-trips the explicit continuity fields into the stored plan', async () => {
    const world = makeWorld()
    const res = await executeTool(
      'plan_scenes',
      {
        title: 'T',
        totalDuration: 12,
        scenes: [
          {
            name: 'Hook',
            purpose: 'open strong',
            sceneType: 'react',
            duration: 6,
            handoffToNext: { type: 'match-cut', note: 'circle to sun' },
            carriedElements: ['the orange circle'],
          },
          { name: 'Payoff', purpose: 'land it', sceneType: 'react', duration: 6 },
        ],
      },
      world,
    )
    expect(res.success).toBe(true)
    const stored = (world as unknown as { scenePlan?: { scenes: SceneSpec[] } }).scenePlan
    expect(stored).toBeTruthy()
    const hook = stored!.scenes[0]
    expect(hook.handoffToNext).toEqual({ type: 'match-cut', note: 'circle to sun' })
    expect(hook.carriedElements).toEqual(['the orange circle'])
    // A scene without continuity fields stays clean (optional, not defaulted).
    expect(stored!.scenes[1].handoffToNext).toBeUndefined()
  })
})
