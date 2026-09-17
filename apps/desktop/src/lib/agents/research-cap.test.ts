import { describe, it, expect } from 'vitest'
import { researchCapDecision } from './runner'

describe('researchCapDecision (A: run-wide research budget)', () => {
  // subAgentsEnabled:true = the orchestrating run this cap was written for. The
  // single-agent default is covered by its own case below.
  const base = {
    toolName: 'find_media',
    isSubAgent: false,
    researchCap: 24,
    alreadyDispatched: false,
    subAgentsEnabled: true,
  }

  it('allows the parent under the inline cap (INLINE_RESEARCH_CAP=2)', () => {
    expect(researchCapDecision({ ...base, runWideResearchCount: 0 })).toBe('allow')
    expect(researchCapDecision({ ...base, runWideResearchCount: 1 })).toBe('allow')
  })

  it('auto-dispatches the parent past the inline cap when nothing delegated yet', () => {
    expect(researchCapDecision({ ...base, runWideResearchCount: 2 })).toBe('dispatch')
  })

  it('does NOT auto-dispatch on a single-agent run — it blocks and tells the parent to build', () => {
    // "Single-agent" has to mean it, research included: the auto-Explore was the last
    // place a default run could still spawn a sub-agent without being asked. Blocking
    // is strictly cheaper than dispatching, so the cost bound is unaffected.
    expect(researchCapDecision({ ...base, runWideResearchCount: 2, subAgentsEnabled: false })).toBe('block')
    // …and the flag is only consulted PAST the inline cap; short research still runs.
    expect(researchCapDecision({ ...base, runWideResearchCount: 1, subAgentsEnabled: false })).toBe('allow')
  })

  it('blocks the parent once it already auto-dispatched', () => {
    expect(researchCapDecision({ ...base, runWideResearchCount: 5, alreadyDispatched: true })).toBe('block')
  })

  it('lets sub-agents research (they cannot dispatch) UP TO the run-wide ceiling', () => {
    expect(researchCapDecision({ ...base, isSubAgent: true, runWideResearchCount: 10 })).toBe('allow')
  })

  it('blocks EVERY agent once the run-wide ceiling is hit — the real fix', () => {
    // per-agent siloing was the bug: parent 2 + sub-agent's own 2 never summed. Run-wide, 24 ≥ 24 → block.
    expect(researchCapDecision({ ...base, isSubAgent: true, runWideResearchCount: 24 })).toBe('block')
    expect(researchCapDecision({ ...base, isSubAgent: false, runWideResearchCount: 24, alreadyDispatched: true })).toBe(
      'block',
    )
    expect(researchCapDecision({ ...base, isSubAgent: false, runWideResearchCount: 30 })).toBe('block')
  })

  it('ignores non-research tools regardless of count', () => {
    expect(researchCapDecision({ ...base, toolName: 'write_scene_code', runWideResearchCount: 99 })).toBe('allow')
  })
})
