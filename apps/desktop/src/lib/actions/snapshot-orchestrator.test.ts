/**
 * Snapshot orchestrator test.
 *
 * Verifies the singleton scheduler shares its counter across both
 * dispatch sites (renderer-IPC append + agent emitter) and fires on the
 * configured threshold. The actual snapshot compute path hits Drizzle in
 * production; here we only assert the wiring/contract that the scheduler
 * is invoked. Compute correctness is covered by the
 * `materialized-state.test.ts` integration test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests, recordDispatchedAction } from './snapshot-orchestrator'

vi.mock('@/lib/db/queries/materialized-state', () => ({
  readLatestSnapshot: vi.fn(async () => null),
  writeSnapshot: vi.fn(async () => undefined),
}))

vi.mock('@/lib/db/queries/action-log', () => ({
  listActions: vi.fn(async () => []),
  getActionTimestamp: vi.fn(async () => null),
}))

describe('snapshot-orchestrator', () => {
  afterEach(() => {
    _resetForTests()
    vi.clearAllMocks()
  })

  it('records actions without throwing for missing project/action ids', () => {
    expect(() => recordDispatchedAction({ projectId: '', actionId: 'a' })).not.toThrow()
    expect(() => recordDispatchedAction({ projectId: 'p', actionId: '' })).not.toThrow()
  })

  it('fires the snapshot writer once after the 500th action', async () => {
    const { writeSnapshot } = await import('@/lib/db/queries/materialized-state')
    const projectId = '00000000-0000-0000-0000-000000000abc'
    for (let i = 0; i < 499; i++) {
      recordDispatchedAction({ projectId, actionId: `a-${i}` })
    }
    expect(writeSnapshot).not.toHaveBeenCalled()
    recordDispatchedAction({ projectId, actionId: 'trigger' })
    // The trigger callback is async; flush the microtask + the awaited
    // writeSnapshot call inside it.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
  })

  it('counter resets per (project, branch) after a trigger', async () => {
    const { writeSnapshot } = await import('@/lib/db/queries/materialized-state')
    const projectId = '00000000-0000-0000-0000-000000000def'
    for (let i = 0; i < 500; i++) {
      recordDispatchedAction({ projectId, actionId: `a-${i}` })
    }
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(writeSnapshot).toHaveBeenCalledTimes(1)

    // Next batch of 499 should not trigger.
    for (let i = 0; i < 499; i++) {
      recordDispatchedAction({ projectId, actionId: `b-${i}` })
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
  })

  it('uses prior.lastActionId timestamp (not prior.createdAt) as the sinceTimestamp', async () => {
    // Repros the race fixed by the action-timestamp lookup. The prior snapshot
    // was written AT createdAt=200 with lastActionId pointing at an action that
    // had timestamp=100. Actions dispatched with timestamp>100 but inserted
    // into action_log after createdAt=200 must still be picked up by the next
    // snapshot — using `prior.createdAt` would skip them.
    const { readLatestSnapshot } = await import('@/lib/db/queries/materialized-state')
    const { listActions, getActionTimestamp } = await import('@/lib/db/queries/action-log')
    ;(readLatestSnapshot as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      projectId: 'p',
      branchId: null,
      lastActionId: 'action-100',
      state: {},
      createdAt: 200,
    })
    ;(getActionTimestamp as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(100)

    const projectId = '00000000-0000-0000-0000-000000000abc'
    for (let i = 0; i < 500; i++) {
      recordDispatchedAction({ projectId, actionId: `a-${i}` })
    }
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // Critical assertion: listActions was called with sinceTimestamp=100,
    // NOT sinceTimestamp=200. This is the race fix.
    expect(listActions).toHaveBeenCalledWith(projectId, expect.objectContaining({ sinceTimestamp: 100 }))
  })

  it('falls back to prior.createdAt when getActionTimestamp lookup fails', async () => {
    // Defense: if the boundary action was pruned or the DB lookup throws,
    // we fall back to the previous behavior (use createdAt). Worst case
    // becomes the existing race, not a hard crash.
    const { readLatestSnapshot } = await import('@/lib/db/queries/materialized-state')
    const { listActions, getActionTimestamp } = await import('@/lib/db/queries/action-log')
    ;(readLatestSnapshot as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      projectId: 'p',
      branchId: null,
      lastActionId: 'gone',
      state: {},
      createdAt: 500,
    })
    ;(getActionTimestamp as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error('db unavailable'),
    )

    const projectId = '00000000-0000-0000-0000-000000000def'
    for (let i = 0; i < 500; i++) {
      recordDispatchedAction({ projectId, actionId: `a-${i}` })
    }
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(listActions).toHaveBeenCalledWith(projectId, expect.objectContaining({ sinceTimestamp: 500 }))
  })
})
