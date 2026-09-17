import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPendingExport, resolvePendingExport, rejectPendingExport } from './pending-exports'

afterEach(() => {
  vi.useRealTimers()
})

describe('pending-exports', () => {
  it('resolves the pending promise with the output path when the client responds', async () => {
    const { exportId, promise } = createPendingExport(5000)
    const ok = resolvePendingExport(exportId, '/Users/me/Downloads/video.mp4')
    expect(ok).toBe(true)
    await expect(promise).resolves.toEqual({ outputPath: '/Users/me/Downloads/video.mp4' })
  })

  it('rejects the pending promise when the client reports an error', async () => {
    const { exportId, promise } = createPendingExport(5000)
    const ok = rejectPendingExport(exportId, 'render crashed')
    expect(ok).toBe(true)
    await expect(promise).rejects.toThrow('render crashed')
  })

  it('returns false when resolving/rejecting an unknown exportId', () => {
    expect(resolvePendingExport('does-not-exist', '/x.mp4')).toBe(false)
    expect(rejectPendingExport('does-not-exist', 'nope')).toBe(false)
  })

  it('times out and rejects if no response arrives, and is no longer resolvable', async () => {
    vi.useFakeTimers()
    const { exportId, promise } = createPendingExport(1000)
    const assertion = expect(promise).rejects.toThrow(/export timeout after 1000ms/)
    vi.advanceTimersByTime(1000)
    await assertion
    // slot was deleted on timeout — a late response is a no-op
    expect(resolvePendingExport(exportId, '/late.mp4')).toBe(false)
  })

  it('generates unique exportIds per pending export', () => {
    const a = createPendingExport(5000)
    const b = createPendingExport(5000)
    expect(a.exportId).not.toBe(b.exportId)
    // clean up so the timers don't leak into other tests
    rejectPendingExport(a.exportId, 'cleanup')
    rejectPendingExport(b.exportId, 'cleanup')
    void a.promise.catch(() => {})
    void b.promise.catch(() => {})
  })
})
