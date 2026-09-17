// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { diffActionLogs } from './action-diff'
import type { Action } from '@/lib/actions'

function act<T extends Action['type']>(
  type: T,
  params: Record<string, unknown>,
  overrides: Partial<Action> = {},
): Action {
  return {
    id: overrides.id ?? `act-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    source: overrides.source ?? 'user',
    runId: overrides.runId ?? null,
    version: 1,
    type,
    params,
    inverse: { type, params },
  } as unknown as Action
}

describe('diffActionLogs', () => {
  it('returns empty when both logs are identical', () => {
    const a = act('clip/add', { clipId: 'c1' }, { id: 'a1' })
    const b = act('clip/move', { clipId: 'c1' }, { id: 'a2' })
    const diff = diffActionLogs([a, b], [a, b])
    expect(diff.entries).toEqual([])
    expect(diff.summary).toEqual([])
  })

  it('detects appended actions as "added" in order', () => {
    const a = act('clip/add', { clipId: 'c1' }, { id: 'a1' })
    const b = act('clip/move', { clipId: 'c1' }, { id: 'a2' })
    const c = act('clip/trim', { clipId: 'c1' }, { id: 'a3' })
    const diff = diffActionLogs([a], [a, b, c])
    expect(diff.entries.map((e) => e.kind)).toEqual(['added', 'added'])
    expect(diff.entries.map((e) => e.action.id)).toEqual(['a2', 'a3'])
    expect(diff.entries[0].label).toMatch(/\+ clip\/move/)
  })

  it('detects removed actions and labels them with `-`', () => {
    const a = act('clip/add', { clipId: 'c1' }, { id: 'a1' })
    const b = act('clip/move', { clipId: 'c1' }, { id: 'a2' })
    const diff = diffActionLogs([a, b], [a])
    expect(diff.entries.length).toBe(1)
    expect(diff.entries[0].kind).toBe('removed')
    expect(diff.entries[0].action.id).toBe('a2')
    expect(diff.entries[0].label).toMatch(/^- clip\/move/)
  })

  it('detects "changed" when params drift on the same id', () => {
    const before = act('clip/move', { clipId: 'c1', toTime: 1 }, { id: 'a1' })
    const after = act('clip/move', { clipId: 'c1', toTime: 5 }, { id: 'a1' })
    const diff = diffActionLogs([before], [after])
    expect(diff.entries.length).toBe(1)
    expect(diff.entries[0].kind).toBe('changed')
    expect(diff.entries[0].prior).toBe(before)
    expect(diff.entries[0].action).toBe(after)
  })

  it('ignores timestamp / source drift by default', () => {
    const a = act('clip/add', { clipId: 'c1' }, { id: 'a1', timestamp: 1, source: 'user' })
    const b = act('clip/add', { clipId: 'c1' }, { id: 'a1', timestamp: 99, source: 'agent' })
    const diff = diffActionLogs([a], [b])
    expect(diff.entries).toEqual([])
  })

  it('respects ignoreNonParamChanges=false', () => {
    const a = act('clip/add', { clipId: 'c1' }, { id: 'a1', timestamp: 1, source: 'user' })
    const b = act('clip/add', { clipId: 'c1' }, { id: 'a1', timestamp: 99, source: 'agent' })
    const diff = diffActionLogs([a], [b], { ignoreNonParamChanges: false })
    expect(diff.entries.length).toBe(1)
    expect(diff.entries[0].kind).toBe('changed')
  })

  it('summarises added actions by runId + source', () => {
    const u = act('clip/add', { clipId: 'c1' }, { id: 'u1', source: 'user', timestamp: 10 })
    const a1 = act('clip/add', { clipId: 'c2' }, { id: 'a1', source: 'agent', runId: 'run-abc12345xyz', timestamp: 20 })
    const a2 = act(
      'clip/move',
      { clipId: 'c2' },
      { id: 'a2', source: 'agent', runId: 'run-abc12345xyz', timestamp: 21 },
    )
    const a3 = act(
      'clip/trim',
      { clipId: 'c2' },
      { id: 'a3', source: 'agent', runId: 'run-abc12345xyz', timestamp: 22 },
    )
    const diff = diffActionLogs([], [u, a1, a2, a3])

    expect(diff.summary.length).toBe(2)
    const userBucket = diff.summary.find((s) => s.source === 'user')!
    const agentBucket = diff.summary.find((s) => s.source === 'agent')!
    expect(userBucket.added).toBe(1)
    expect(agentBucket.added).toBe(3)
    expect(agentBucket.runId).toBe('run-abc12345xyz')
    expect(agentBucket.label).toMatch(/^agent run-abc1/)
    expect(agentBucket.label).toMatch(/\(\+3\)/)
  })

  it('summary truncates the type list past MAX_LABELED_TYPES', () => {
    const types = ['clip/add', 'clip/move', 'clip/trim', 'clip/split', 'clip/rippleDelete']
    const actions = types.map((t, i) =>
      act(t as Action['type'], {}, { id: `x${i}`, runId: 'r1', source: 'agent', timestamp: i }),
    )
    const diff = diffActionLogs([], actions)
    expect(diff.summary.length).toBe(1)
    expect(diff.summary[0].label).toMatch(/…/)
  })

  it('summary reports +N -M when both added and removed sit in the same bucket', () => {
    const removed = act('clip/add', { clipId: 'c1' }, { id: 'r1', runId: 'run-1', source: 'agent', timestamp: 1 })
    const added = act('clip/move', { clipId: 'c1' }, { id: 'a1', runId: 'run-1', source: 'agent', timestamp: 2 })
    const diff = diffActionLogs([removed], [added])
    expect(diff.summary.length).toBe(1)
    expect(diff.summary[0].added).toBe(1)
    expect(diff.summary[0].removed).toBe(1)
    expect(diff.summary[0].label).toMatch(/\+1 -1/)
  })
})
