// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { StreamingChatPersister } from './chat-persist'

/** A fake timer + clock harness: setTimeout callbacks are captured (never
 *  auto-fired) so a test can simulate "the debounce never elapses" while the
 *  injected clock advances independently. */
function harness() {
  let now = 1_000
  let nextId = 1
  const timers = new Map<number, () => void>()
  const setTimeoutFn = ((fn: () => void) => {
    const id = nextId++
    timers.set(id, fn)
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const clearTimeoutFn = ((id: number) => timers.delete(id)) as typeof clearTimeout
  const persistFn = vi.fn(async () => ({ applied: true }))
  const make = (opts?: { debounceMs?: number; maxWaitMs?: number }) =>
    new StreamingChatPersister({
      messageId: 'm1',
      runId: 'r1',
      persistFn,
      getSnapshot: () => ({ content: 'partial' }),
      debounceMs: opts?.debounceMs ?? 2_000,
      maxWaitMs: opts?.maxWaitMs ?? 10_000,
      setTimeoutFn,
      clearTimeoutFn,
      nowFn: () => now,
    })
  return {
    persistFn,
    make,
    advance: (ms: number) => {
      now += ms
    },
    fireTimers: () => {
      const fns = [...timers.values()]
      timers.clear()
      fns.forEach((fn) => fn())
    },
  }
}

describe('StreamingChatPersister max-wait', () => {
  it('force-flushes under continuous activity even though the debounce never fires', async () => {
    const h = harness()
    const p = h.make()

    // Continuous scheduling: every 1s, WITHOUT ever firing the debounce timer.
    for (let i = 0; i < 8; i++) {
      h.advance(1_000)
      p.schedule()
    }
    // 8s elapsed since construction (< 10s max-wait) — nothing durable yet.
    expect(h.persistFn).not.toHaveBeenCalled()

    // Cross the max-wait threshold on the next schedule → forced immediate flush.
    h.advance(2_000)
    p.schedule()
    await (p as unknown as { inFlight: Promise<void> }).inFlight
    expect(h.persistFn).toHaveBeenCalledTimes(1)
    expect((h.persistFn.mock.calls[0] as unknown[])[0]).toMatchObject({ status: 'streaming', seq: 1 })

    // After a forced flush the window resets — another short burst must NOT flush.
    for (let i = 0; i < 3; i++) {
      h.advance(1_000)
      p.schedule()
    }
    await (p as unknown as { inFlight: Promise<void> }).inFlight
    expect(h.persistFn).toHaveBeenCalledTimes(1)
  })

  it('still honors the normal debounce when activity is idle enough for it to fire', async () => {
    const h = harness()
    const p = h.make()
    h.advance(500)
    p.schedule() // within max-wait → schedules a debounce timer
    expect(h.persistFn).not.toHaveBeenCalled()
    h.fireTimers() // debounce elapses
    await (p as unknown as { inFlight: Promise<void> }).inFlight
    expect(h.persistFn).toHaveBeenCalledTimes(1)
  })
})
