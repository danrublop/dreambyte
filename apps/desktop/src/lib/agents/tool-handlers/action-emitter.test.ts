// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { emitAgentAction, emitterDepsForWorld } from './action-emitter'
import type { WorldStateMutable } from '@/lib/agents/world-state'

/**
 * The emitter normally writes to disk + DB. Both writes are wrapped in
 * try/catch and run inside a fire-and-forget IIFE — when there's no
 * Electron context (test env) the dynamic imports throw and we
 * gracefully no-op. The return value is what callers see synchronously,
 * so we assert against that.
 */
describe('emitAgentAction', () => {
  it('always stamps source="agent"', () => {
    const action = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null },
    )
    expect(action.source).toBe('agent')
  })

  it('propagates the supplied runId onto the stamped action', () => {
    const runId = 'run-test-123'
    const action = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null, runId },
    )
    expect(action.runId).toBe(runId)
  })

  it('treats a missing runId as null (ad-hoc tool call)', () => {
    const action = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null },
    )
    expect(action.runId).toBeNull()
  })

  it('two actions emitted with the same runId share the group id', () => {
    const runId = 'group-1'
    const a = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null, runId },
    )
    const b = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'b' } } },
      { projectId: null, runId },
    )
    expect(a.runId).toBe(runId)
    expect(b.runId).toBe(runId)
    expect(a.id).not.toBe(b.id) // distinct action ids
  })

  it('preserves an explicit input.id when one is supplied (replay case)', () => {
    const action = emitAgentAction(
      { id: 'preset-action-1', type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null, runId: 'r1' },
    )
    expect(action.id).toBe('preset-action-1')
  })

  it('emits a finite timestamp', () => {
    const before = Date.now()
    const action = emitAgentAction(
      { type: 'scene/update', params: { sceneId: 'x', patch: { name: 'a' } } },
      { projectId: null },
    )
    expect(Number.isFinite(action.timestamp)).toBe(true)
    expect(action.timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe('emitterDepsForWorld', () => {
  // Cast to the shared shape — the tests only need a handful of fields.
  // Using `as unknown as WorldStateMutable` keeps callers honest without
  // making the test set up a full world.
  function worldWith(fields: Partial<WorldStateMutable>): WorldStateMutable {
    return fields as unknown as WorldStateMutable
  }

  it('extracts projectId and runId from the world', () => {
    const deps = emitterDepsForWorld(worldWith({ projectId: 'p-1', currentRunId: 'r-1' }))
    expect(deps).toEqual({ projectId: 'p-1', runId: 'r-1' })
  })

  it('coerces missing projectId / currentRunId to null', () => {
    const deps = emitterDepsForWorld(worldWith({}))
    expect(deps).toEqual({ projectId: null, runId: null })
  })

  it('coerces undefined runId to null while preserving the project', () => {
    const deps = emitterDepsForWorld(worldWith({ projectId: 'p-2' }))
    expect(deps).toEqual({ projectId: 'p-2', runId: null })
  })
})
