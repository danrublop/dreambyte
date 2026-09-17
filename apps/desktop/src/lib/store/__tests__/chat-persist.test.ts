// @vitest-environment node
//
// Unit tests for the incremental streaming chat persister (T1 / D5). Pure /
// React-free — drives the StreamingChatPersister with fake timers and a stub
// persistFn. Proves: debounce coalesces a token burst into one write; the
// persistFn carries a monotonic seq + the live runId; and a throwing persistFn
// is retried once and NEVER propagates into the caller (the stream loop).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamingChatPersister, STREAMING_PERSIST_DEBOUNCE_MS } from '../chat-persist'

describe('StreamingChatPersister', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounce coalesces a burst of schedule() calls into a single write', async () => {
    const calls: Array<{ seq: number; content: string }> = []
    const persistFn = vi.fn(async (a: { seq: number; snapshot: { content: string } }) => {
      calls.push({ seq: a.seq, content: a.snapshot.content })
      return { applied: true }
    })
    let content = ''
    const p = new StreamingChatPersister({
      messageId: 'm1',
      runId: 'run-1',
      persistFn: persistFn as never,
      getSnapshot: () => ({ content }),
    })

    // Five rapid token arrivals within one debounce window.
    for (let i = 0; i < 5; i++) {
      content += 'x'
      p.schedule()
    }
    expect(persistFn).not.toHaveBeenCalled() // still debouncing

    await vi.advanceTimersByTimeAsync(STREAMING_PERSIST_DEBOUNCE_MS)
    expect(persistFn).toHaveBeenCalledTimes(1) // coalesced
    expect(calls[0]).toEqual({ seq: 1, content: 'xxxxx' }) // latest snapshot
  })

  it('emits a monotonic seq and carries the live runId set after construction', async () => {
    const seen: Array<{ seq: number; runId: string | null }> = []
    const persistFn = vi.fn(async (a: { seq: number; runId: string | null }) => {
      seen.push({ seq: a.seq, runId: a.runId })
      return { applied: true }
    })
    const p = new StreamingChatPersister({
      messageId: 'm1',
      runId: null,
      persistFn: persistFn as never,
      getSnapshot: () => ({ content: 'hi' }),
    })

    await p.flush() // seq 1, runId null (before run_start)
    p.setRunId('run-9')
    await p.flush() // seq 2, runId run-9
    await p.flush() // seq 3

    expect(seen.map((s) => s.seq)).toEqual([1, 2, 3])
    expect(seen[0].runId).toBeNull()
    expect(seen[1].runId).toBe('run-9')
    expect(seen[2].runId).toBe('run-9')
  })

  it('retries once on failure and never throws into the caller', async () => {
    let attempts = 0
    const persistFn = vi.fn(async () => {
      attempts++
      throw new Error('transient IPC failure')
    })
    const p = new StreamingChatPersister({
      messageId: 'm1',
      runId: 'run-1',
      persistFn: persistFn as never,
      getSnapshot: () => ({ content: 'hi' }),
    })

    // flush() resolves (does not reject) even though the persistFn always throws.
    const flushed = p.flush()
    await vi.advanceTimersByTimeAsync(500) // let the 250ms retry delay elapse
    await expect(flushed).resolves.toBeUndefined()
    expect(attempts).toBe(2) // original + one retry, then swallowed
  })

  it('a successful flush after a failing one still advances seq and applies', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const applied: number[] = []
    const persistFn = vi.fn(async (a: { seq: number }) => {
      if (mode === 'fail') throw new Error('boom')
      applied.push(a.seq)
      return { applied: true }
    })
    const p = new StreamingChatPersister({
      messageId: 'm1',
      runId: 'r',
      persistFn: persistFn as never,
      getSnapshot: () => ({ content: 'hi' }),
    })

    const f1 = p.flush() // seq 1 fails (+ retry)
    await vi.advanceTimersByTimeAsync(500)
    await f1
    mode = 'ok'
    await p.flush() // seq 2 ok
    expect(applied).toEqual([2])
  })

  it('dispose cancels a pending debounce so no write fires after the run ends', async () => {
    const persistFn = vi.fn(async () => ({ applied: true }))
    const p = new StreamingChatPersister({
      messageId: 'm1',
      runId: 'r',
      persistFn: persistFn as never,
      getSnapshot: () => ({ content: 'hi' }),
    })
    p.schedule()
    await p.dispose()
    await vi.advanceTimersByTimeAsync(STREAMING_PERSIST_DEBOUNCE_MS * 2)
    expect(persistFn).not.toHaveBeenCalled()
    // schedule() after dispose is a no-op too.
    p.schedule()
    await vi.advanceTimersByTimeAsync(STREAMING_PERSIST_DEBOUNCE_MS * 2)
    expect(persistFn).not.toHaveBeenCalled()
  })
})
