// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

import { createSnapshotScheduler } from './snapshot-scheduler'

describe('createSnapshotScheduler', () => {
  it('fires onTrigger only when the threshold is hit', () => {
    const onTrigger = vi.fn()
    const sched = createSnapshotScheduler({ threshold: 3, onTrigger })
    sched.recordAction({ projectId: 'p1', actionId: 'a1' })
    sched.recordAction({ projectId: 'p1', actionId: 'a2' })
    expect(onTrigger).not.toHaveBeenCalled()
    sched.recordAction({ projectId: 'p1', actionId: 'a3' })
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger).toHaveBeenCalledWith({
      projectId: 'p1',
      branchId: null,
      actionId: 'a3',
      count: 3,
    })
  })

  it('resets the counter after firing so the next epoch starts at 0', () => {
    const onTrigger = vi.fn()
    const sched = createSnapshotScheduler({ threshold: 2, onTrigger })
    sched.recordAction({ projectId: 'p1', actionId: 'a1' })
    sched.recordAction({ projectId: 'p1', actionId: 'a2' }) // fires
    expect(sched.getCount('p1')).toBe(0)
    sched.recordAction({ projectId: 'p1', actionId: 'a3' })
    expect(sched.getCount('p1')).toBe(1)
    expect(onTrigger).toHaveBeenCalledTimes(1)
    sched.recordAction({ projectId: 'p1', actionId: 'a4' }) // fires
    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  it('tracks (project, branch) tuples independently', () => {
    const onTrigger = vi.fn()
    const sched = createSnapshotScheduler({ threshold: 2, onTrigger })
    sched.recordAction({ projectId: 'p1', actionId: 'a1' })
    sched.recordAction({ projectId: 'p1', branchId: 'feat', actionId: 'a2' })
    sched.recordAction({ projectId: 'p1', actionId: 'a3' }) // main now at 2 → fires
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger.mock.calls[0][0].branchId).toBeNull()
    sched.recordAction({ projectId: 'p1', branchId: 'feat', actionId: 'a4' }) // feat now at 2 → fires
    expect(onTrigger).toHaveBeenCalledTimes(2)
    expect(onTrigger.mock.calls[1][0].branchId).toBe('feat')
  })

  it('reset() zeros the counter for that (project, branch) only', () => {
    const onTrigger = vi.fn()
    const sched = createSnapshotScheduler({ threshold: 3, onTrigger })
    sched.recordAction({ projectId: 'p1', actionId: 'a' })
    sched.recordAction({ projectId: 'p1', actionId: 'b' })
    sched.recordAction({ projectId: 'p2', actionId: 'c' })
    sched.reset('p1')
    expect(sched.getCount('p1')).toBe(0)
    expect(sched.getCount('p2')).toBe(1)
  })

  it('swallows onTrigger errors and still resets the counter', () => {
    const onTrigger = vi.fn(() => {
      throw new Error('downstream boom')
    })
    const sched = createSnapshotScheduler({ threshold: 1, onTrigger })
    expect(() => sched.recordAction({ projectId: 'p1', actionId: 'a' })).not.toThrow()
    expect(sched.getCount('p1')).toBe(0) // still reset despite the throw
  })

  it('rejects non-positive thresholds', () => {
    expect(() => createSnapshotScheduler({ threshold: 0, onTrigger: () => undefined })).toThrow(/positive/)
    expect(() => createSnapshotScheduler({ threshold: -1, onTrigger: () => undefined })).toThrow(/positive/)
  })

  it('uses the default threshold of 500 when unspecified', () => {
    const onTrigger = vi.fn()
    const sched = createSnapshotScheduler({ onTrigger })
    for (let i = 0; i < 499; i++) sched.recordAction({ projectId: 'p1', actionId: `a${i}` })
    expect(onTrigger).not.toHaveBeenCalled()
    sched.recordAction({ projectId: 'p1', actionId: 'a500' })
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })
})
