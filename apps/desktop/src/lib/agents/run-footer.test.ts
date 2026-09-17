import { describe, it, expect } from 'vitest'
import {
  deriveRunFooterFacts,
  formatRunFooter,
  buildRunFooter,
  resolveRunOutcome,
  outcomeToPersistStatus,
} from './run-footer'
import type { ToolCallRecord } from './types'

function tc(toolName: string, success: boolean, affectedSceneId?: string): ToolCallRecord {
  return {
    id: Math.random().toString(36).slice(2),
    toolName,
    input: {},
    output: { success, affectedSceneId } as any,
  }
}

describe('deriveRunFooterFacts', () => {
  it('counts created, edited, and failed from the tool calls + spend from usage', () => {
    const facts = deriveRunFooterFacts({
      outcome: 'completed',
      toolCalls: [
        tc('create_scene', true, 's1'),
        tc('create_scene', true, 's2'),
        tc('write_scene_code', true, 's3'), // edit of a scene not created this run
        tc('patch_layer_code', true, 's3'), // same scene → still one edit
        tc('generate_video', false), // failed
      ],
      usage: { costUsd: 0.1234 } as any,
    })
    expect(facts.created).toBe(2)
    expect(facts.edited).toBe(1)
    expect(facts.toolsFailed).toBe(1)
    expect(facts.spendUsd).toBeCloseTo(0.1234)
  })

  it('a scene created then edited this run stays a CREATE (not double-counted)', () => {
    const facts = deriveRunFooterFacts({
      outcome: 'completed',
      toolCalls: [tc('create_scene', true, 's1'), tc('write_scene_code', true, 's1')],
    })
    expect(facts.created).toBe(1)
    expect(facts.edited).toBe(0)
  })

  it('a failed create does not count as created (and counts as a failed tool)', () => {
    const facts = deriveRunFooterFacts({
      outcome: 'error',
      toolCalls: [tc('create_scene', false, 's1')],
    })
    expect(facts.created).toBe(0)
    expect(facts.edited).toBe(0)
    expect(facts.toolsFailed).toBe(1)
  })

  it('carries errored scenes through (E4)', () => {
    const facts = deriveRunFooterFacts({
      outcome: 'completed',
      toolCalls: [],
      erroredScenes: ['Intro', 'Outro'],
    })
    expect(facts.erroredScenes).toEqual(['Intro', 'Outro'])
  })
})

describe('formatRunFooter', () => {
  it('renders outcome · created · edited · failed · spend', () => {
    const line = formatRunFooter({
      outcome: 'completed',
      created: 3,
      edited: 1,
      toolsFailed: 0,
      spendUsd: 0.05,
      erroredScenes: [],
    })
    // Cost is intentionally NOT in the footer (it lives in the live session
    // usage counter under the composer).
    expect(line).toBe('Done · 3 created · 1 edited · 0 tools failed')
  })

  it('labels error and aborted outcomes', () => {
    expect(
      formatRunFooter({ outcome: 'error', created: 0, edited: 0, toolsFailed: 2, spendUsd: 0, erroredScenes: [] }),
    ).toMatch(/^Failed ·/)
    expect(
      formatRunFooter({ outcome: 'aborted', created: 1, edited: 0, toolsFailed: 0, spendUsd: 0, erroredScenes: [] }),
    ).toMatch(/^Stopped ·/)
  })

  it('names broken scenes when present (E4)', () => {
    const line = formatRunFooter({
      outcome: 'completed',
      created: 2,
      edited: 0,
      toolsFailed: 0,
      spendUsd: 0,
      erroredScenes: ['Scene 2'],
    })
    expect(line).toContain('broken scene: Scene 2')
  })

  it('does NOT render cost in the footer (cost lives in the session counter)', () => {
    const line = formatRunFooter({
      outcome: 'completed',
      created: 0,
      edited: 0,
      toolsFailed: 0,
      spendUsd: 0.0012,
      erroredScenes: [],
    })
    expect(line).not.toContain('$')
  })
})

describe('resolveRunOutcome (A5/A6 finalize ordering)', () => {
  it('errored wins over aborted (a failure mid-Stop is still a failure)', () => {
    expect(resolveRunOutcome({ errored: true, aborted: true })).toBe('error')
    expect(resolveRunOutcome({ errored: true, aborted: false })).toBe('error')
  })
  it('a clean user Stop is aborted', () => {
    expect(resolveRunOutcome({ errored: false, aborted: true })).toBe('aborted')
  })
  it('neither → completed', () => {
    expect(resolveRunOutcome({ errored: false, aborted: false })).toBe('completed')
  })
})

describe('outcomeToPersistStatus', () => {
  it('maps each outcome to its persisted status', () => {
    expect(outcomeToPersistStatus('error')).toBe('error')
    expect(outcomeToPersistStatus('aborted')).toBe('aborted')
    expect(outcomeToPersistStatus('completed')).toBe('complete')
  })
})

describe('buildRunFooter (derive + format)', () => {
  it('produces the honest one-liner end to end', () => {
    const line = buildRunFooter({
      outcome: 'error',
      toolCalls: [tc('create_scene', true, 's1'), tc('generate_avatar', false)],
      usage: { costUsd: 0.02 } as any,
      erroredScenes: ['Hero'],
    })
    expect(line).toBe('Failed · 1 created · 0 edited · 1 tools failed — broken scene: Hero')
  })
})
