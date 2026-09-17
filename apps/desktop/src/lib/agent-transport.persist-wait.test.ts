// @vitest-environment node
/**
 * A3 (v6 T3) — waitForRunPersist gates the post-run refresh on the durable write.
 *
 * The renderer's post-run `refreshProjectFromServer` used to fire immediately,
 * racing main's persist (which, after T2, runs on error/abort too) and — on
 * abort, where the transport rejects instantly — replacing the store's
 * half-built scenes with the pre-run DB state. waitForRunPersist resolves on the
 * out-of-band persist_done signal, or via a version-poll fallback, or a hard
 * timeout (never freezes the UI).
 */

import { describe, it, expect, vi } from 'vitest'
import { waitForRunPersist } from './agent-transport'

describe('waitForRunPersist (A3)', () => {
  it('no projectId → resolves immediately without touching deps', async () => {
    const onPersistDone = vi.fn()
    const readVersion = vi.fn()
    await waitForRunPersist('run-1', null, 5, { onPersistDone, readVersion })
    expect(onPersistDone).not.toHaveBeenCalled()
    expect(readVersion).not.toHaveBeenCalled()
  })

  it('resolves on the persist_done signal (fast path) and unsubscribes', async () => {
    let fire: ((ok: boolean) => void) | undefined
    const unsub = vi.fn()
    const onPersistDone = vi.fn((_runId: string, handler: (ok: boolean) => void) => {
      fire = handler
      return unsub
    })
    const readVersion = vi.fn(async () => 5) // never advances; would never resolve via poll
    const p = waitForRunPersist('run-1', 'proj-1', 5, {
      onPersistDone,
      readVersion,
      pollIntervalMs: 10_000,
      timeoutMs: 10_000,
    })
    expect(onPersistDone).toHaveBeenCalledWith('run-1', expect.any(Function))
    fire!(true)
    const res = await p // resolves promptly via the signal, not the (10s) poll/timeout
    expect(res.persistOk).toBe(true)
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('fallback: no signal → resolves once the version advances past pre-run', async () => {
    let v = 5
    const readVersion = vi.fn(async () => v)
    const p = waitForRunPersist('run-1', 'proj-1', 5, {
      // no onPersistDone → fallback only
      readVersion,
      pollIntervalMs: 5,
      timeoutMs: 5_000,
    })
    // Persist lands a few ticks later, bumping the version.
    setTimeout(() => {
      v = 6
    }, 20)
    await p
    expect(v).toBe(6)
    expect(readVersion).toHaveBeenCalled()
  })

  it('never freezes: resolves at the hard timeout when neither signal nor version settles', async () => {
    const readVersion = vi.fn(async () => 5) // version never advances
    const start = Date.now()
    const res = await waitForRunPersist('run-1', 'proj-1', 5, {
      readVersion,
      pollIntervalMs: 5,
      timeoutMs: 40,
    })
    expect(Date.now() - start).toBeGreaterThanOrEqual(35)
    // Resolved via the timeout fallback → outcome unknown, never a false "ok".
    expect(res.persistOk).toBeNull()
  })

  it('no deps at all (no signal, no version reader) → resolves without hanging', async () => {
    await waitForRunPersist('run-1', 'proj-1', 5, { onPersistDone: undefined, readVersion: undefined })
    // (resolving is the assertion — a hang would time the test out)
    expect(true).toBe(true)
  })

  it('signal path still works when preRunVersion is null (no fallback available)', async () => {
    let fire: ((ok: boolean) => void) | undefined
    const onPersistDone = vi.fn((_r: string, h: (ok: boolean) => void) => {
      fire = h
      return () => {}
    })
    const p = waitForRunPersist('run-1', 'proj-1', null, { onPersistDone, timeoutMs: 5_000 })
    fire!(false)
    const res = await p
    expect(onPersistDone).toHaveBeenCalled()
    // persistOk:false is the signal that routes the renderer to push its scenes.
    expect(res.persistOk).toBe(false)
  })
})
