// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { buildContinuityContext } from './cross-scene-continuity'
import { assembleScenePrompt, buildTaskPacket } from './orchestrator'
import type { SceneSpec } from './types'

const spec = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'Scene',
  purpose: 'a purpose',
  sceneType: 'react',
  duration: 6,
  ...over,
})

/**
 * Phase C — neighbor-aware dispatch. The disconnected-slideshow root cause is that
 * each scene's sub-agent builds blind to its neighbors. These prove the neighbor
 * context is (a) correctly shaped and (b) actually reaches the builder prompt.
 */
describe('buildContinuityContext (#okf-phase-c)', () => {
  it('a lone scene (no neighbors) injects nothing', () => {
    expect(buildContinuityContext(null, null)).toBe('')
  })

  it('a middle scene references BOTH the previous and next beat by name + purpose', () => {
    const out = buildContinuityContext(
      spec({ name: 'Hook', purpose: 'grab attention', cameraMovement: 'cinematicPush' }),
      spec({ name: 'Payoff', purpose: 'reveal the result' }),
    )
    expect(out).toContain('Hook')
    expect(out).toContain('grab attention')
    expect(out).toContain('cinematicPush') // prev camera move carried as a continuity cue
    expect(out).toContain('Payoff')
    expect(out).toContain('reveal the result')
    expect(out).toMatch(/FROM the previous/)
    expect(out).toMatch(/INTO the next/)
  })

  it('the opening scene (no prev) is told to ESTABLISH, not continue', () => {
    const out = buildContinuityContext(null, spec({ name: 'Body' }))
    expect(out).toMatch(/OPENING scene/)
    expect(out).toContain('Body')
    expect(out).not.toMatch(/FROM the previous/)
  })

  it('the final scene (no next) is told to RESOLVE, with no hand-off', () => {
    const out = buildContinuityContext(spec({ name: 'Body' }), null)
    expect(out).toMatch(/FINAL scene/)
    expect(out).toContain('Body')
    expect(out).not.toMatch(/INTO the next/)
  })
})

describe('assembleScenePrompt wires neighbor context into the builder prompt (#okf-phase-c)', () => {
  const planned = spec({ name: 'Middle', purpose: 'the middle beat' })

  it('WITHOUT neighbors → no continuity block (backwards compatible)', () => {
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned)
    expect(prompt).not.toMatch(/## Continuity/)
  })

  it('WITH neighbors → the continuity block + the neighbor names reach the sub-agent', () => {
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned, null, {
      prev: spec({ name: 'Opener', purpose: 'set the scene' }),
      next: spec({ name: 'Closer', purpose: 'wrap up' }),
    })
    expect(prompt).toMatch(/## Continuity/)
    expect(prompt).toContain('Opener')
    expect(prompt).toContain('Closer')
  })
})

/**
 * Phase C RICHER — explicit hand-off types + carried elements. The planner can
 * now declare how each beat passes the baton; buildContinuityContext uses it
 * when present and falls back to positional inference when absent.
 */
describe('buildContinuityContext — explicit hand-off (#okf-handoff)', () => {
  it('uses the previous scene’s hand-off TYPE + note to tell this scene how to OPEN', () => {
    const out = buildContinuityContext(
      spec({ name: 'Hook', handoffToNext: { type: 'match-cut', note: 'the circle becomes the sun' } }),
      null,
    )
    expect(out).toMatch(/match cut/i) // OPEN_FROM phrasing for a match-cut hand-off
    expect(out).toContain('the circle becomes the sun')
  })

  it('uses THIS scene’s hand-off to tell it how to END into the next', () => {
    const self = spec({ name: 'Body', handoffToNext: { type: 'zoom-into' } })
    const out = buildContinuityContext(null, spec({ name: 'Detail' }), self)
    expect(out).toMatch(/INTO "Detail"/)
    expect(out).toMatch(/pushed into the detail/i)
  })

  it('lists carriedElements: CARRY IN from prev, PASS FORWARD from self', () => {
    const out = buildContinuityContext(
      spec({ name: 'A', carriedElements: ['the orange arrow', 'the grid'] }),
      spec({ name: 'C' }),
      spec({ name: 'B', carriedElements: ['the timeline'] }),
    )
    expect(out).toMatch(/CARRY IN[^\n]*the orange arrow, the grid/)
    expect(out).toMatch(/PASS FORWARD[^\n]*the timeline/)
  })

  it('an invalid/malformed hand-off type falls back to positional (never throws)', () => {
    const out = buildContinuityContext(
      spec({ name: 'A', purpose: 'do a thing', handoffToNext: { type: 'nonsense' as never } }),
      null,
    )
    expect(out).toMatch(/FROM the previous scene "A"/) // positional fallback path
  })

  it('empty carriedElements arrays produce no carry line', () => {
    const out = buildContinuityContext(
      spec({ name: 'A', carriedElements: [] }),
      spec({ name: 'C' }),
      spec({ name: 'B', carriedElements: ['  '] }),
    )
    expect(out).not.toMatch(/CARRY IN/)
    expect(out).not.toMatch(/PASS FORWARD/)
  })

  it('still works with the 2-arg call (backwards compatible)', () => {
    const out = buildContinuityContext(spec({ name: 'A' }), spec({ name: 'C' }))
    expect(out).toMatch(/## Continuity/)
  })
})

/**
 * Director plan, Phase 1 — the builder sees its predecessor's REAL built code, not
 * just the prose hand-off. Sequential dispatch guarantees scene i-1 is finished and
 * merged before scene i starts, so the actual palette/type/motion is available to
 * MATCH instead of imagine. This closes the "film vs slideshow" gap where every
 * scene re-invented the visual language from scratch.
 */
describe('buildContinuityContext — predecessor built-code injection (#director-phase1)', () => {
  const CODE = 'export function Scene(){ const teal = "#14b8a6"; return <Motif color={teal}/> }'

  it('injects the actual code + a MATCH-it instruction when present', () => {
    const out = buildContinuityContext(spec({ name: 'Hook' }), spec({ name: 'Payoff' }), null, CODE)
    expect(out).toMatch(/ACTUAL built code/)
    expect(out).toContain('#14b8a6') // the real palette value, verbatim
    expect(out).toContain('```tsx')
    expect(out).toMatch(/same film/)
  })

  it('injects even when there are no plan neighbors (code alone is enough to bridge)', () => {
    const out = buildContinuityContext(null, null, null, CODE)
    expect(out).not.toBe('') // the old guard returned '' here — prevBuiltCode now keeps it alive
    expect(out).toContain('#14b8a6')
  })

  it('truncates over-long predecessor code and flags the cut (prompt-budget guard)', () => {
    const huge = 'A'.repeat(30_000)
    const out = buildContinuityContext(spec({ name: 'Hook' }), null, null, huge)
    expect(out).toMatch(/…truncated/)
    expect(out.length).toBeLessThan(huge.length + 2_000) // head-clipped, not the full 30K
  })

  it('null / empty / whitespace-only code injects nothing (falls back to prose)', () => {
    expect(buildContinuityContext(spec({ name: 'A' }), null, null, null)).not.toMatch(/ACTUAL built code/)
    expect(buildContinuityContext(spec({ name: 'A' }), null, null, '')).not.toMatch(/ACTUAL built code/)
    expect(buildContinuityContext(spec({ name: 'A' }), null, null, '   \n  ')).not.toMatch(/ACTUAL built code/)
  })

  it('reaches the builder prompt through assembleScenePrompt neighbors.prevBuiltCode', () => {
    const planned = spec({ name: 'Middle', purpose: 'the middle beat' })
    const prompt = assembleScenePrompt(buildTaskPacket(planned, undefined), planned, null, {
      prev: spec({ name: 'Opener' }),
      next: spec({ name: 'Closer' }),
      prevBuiltCode: CODE,
    })
    expect(prompt).toMatch(/ACTUAL built code/)
    expect(prompt).toContain('#14b8a6')
  })
})
