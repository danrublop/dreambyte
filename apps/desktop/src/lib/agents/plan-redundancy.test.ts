// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { scanScenePlanForRedundancy } from './cross-scene-continuity'
import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'

/**
 * Phase C plan-time gate. "Duplicate scenes" was an original top failure mode —
 * the agent plans the same beat twice. These prove the scan catches it (high
 * precision: no false positives on genuinely distinct beats) and that the
 * plan_scenes tool actually surfaces the warning to the agent.
 */
describe('scanScenePlanForRedundancy (#okf-plan-guard)', () => {
  it('distinct scenes produce no warning', () => {
    const r = scanScenePlanForRedundancy([
      { name: 'Hook', purpose: 'grab attention with a bold question' },
      { name: 'Mechanism', purpose: 'explain how the engine works step by step' },
      { name: 'Payoff', purpose: 'show the final result and call to action' },
    ])
    expect(r.warnings).toEqual([])
    expect(r.duplicatePairs).toEqual([])
  })

  it('flags two scenes with an identical name', () => {
    const r = scanScenePlanForRedundancy([
      { name: 'Intro', purpose: 'welcome the viewer' },
      { name: 'Body', purpose: 'the main content here' },
      { name: 'Intro', purpose: 'a totally different second intro' },
    ])
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toMatch(/REDUNDANCY/)
    expect(r.duplicatePairs).toContainEqual([0, 2])
  })

  it('flags two scenes with near-identical purpose (high token overlap)', () => {
    const r = scanScenePlanForRedundancy([
      { name: 'A', purpose: 'explain how photosynthesis converts sunlight into energy' },
      { name: 'B', purpose: 'explain how photosynthesis converts sunlight into chemical energy' },
    ])
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toMatch(/overlap/)
  })

  it('does NOT false-flag distinct purposes that share a few words (high precision)', () => {
    const r = scanScenePlanForRedundancy([
      { name: 'A', purpose: 'introduce the solar system and its eight planets' },
      { name: 'B', purpose: 'dive deep into the rings and moons of Saturn specifically' },
    ])
    expect(r.warnings).toEqual([])
  })

  it('is a no-op for a single scene', () => {
    expect(scanScenePlanForRedundancy([{ name: 'Only', purpose: 'the only beat' }]).warnings).toEqual([])
  })

  it('bounds output at 3 warnings even for an all-duplicate plan', () => {
    const dup = { name: 'Same', purpose: 'identical beat over and over' }
    const r = scanScenePlanForRedundancy([dup, dup, dup, dup, dup]) // C(5,2)=10 pairs
    expect(r.warnings.length).toBe(3)
  })
})

describe('plan_scenes surfaces redundancy warnings through executeTool (#okf-plan-guard)', () => {
  const makeWorld = (): WorldStateMutable =>
    ({
      scenes: [],
      globalStyle: { presetId: null },
      projectName: 'p',
      projectId: 'proj',
      currentRunId: 'r',
      outputMode: 'mp4',
    }) as unknown as WorldStateMutable

  it('a duplicate-beat plan returns a REDUNDANCY warning in the tool result', async () => {
    const res = await executeTool(
      'plan_scenes',
      {
        title: 'T',
        totalDuration: 12,
        scenes: [
          { name: 'Intro', purpose: 'welcome and set up the topic clearly', sceneType: 'react', duration: 6 },
          { name: 'Intro', purpose: 'welcome and set up the topic clearly', sceneType: 'react', duration: 6 },
        ],
      },
      makeWorld(),
    )
    expect(res.success).toBe(true)
    const warnings = (res.data as { warnings?: string[] }).warnings ?? []
    expect(warnings.some((w) => /REDUNDANCY/.test(w))).toBe(true)
  })

  it('a clean plan returns no warnings field', async () => {
    const res = await executeTool(
      'plan_scenes',
      {
        title: 'T',
        totalDuration: 12,
        scenes: [
          { name: 'Hook', purpose: 'open with a striking visual question', sceneType: 'react', duration: 6 },
          { name: 'Payoff', purpose: 'resolve with the answer and a call to action', sceneType: 'react', duration: 6 },
        ],
      },
      makeWorld(),
    )
    expect(res.success).toBe(true)
    expect((res.data as { warnings?: string[] }).warnings).toBeUndefined()
  })
})
