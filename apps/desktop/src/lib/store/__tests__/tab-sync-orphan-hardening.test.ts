// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sweepStaleRemotes, HEARTBEAT_MS, REMOTE_TTL_MS } from '../tab-sync'
import { createAgentActions } from '../agent-actions'

/**
 * IT6 — orphan-detection probe timeout + tab-sync remote-lock TTL.
 *
 * - A hung main process used to block switchConversation forever (the
 *   activeRunIds await had no timeout). Now a 3s race resolves "unknown"
 *   and the switch completes with the grace-period default.
 * - A crashed sibling tab used to lock this tab's send button forever (its
 *   agent_end never arrives). sweepStaleRemotes drops remotes silent past
 *   REMOTE_TTL_MS (3 missed heartbeats).
 */

describe('sweepStaleRemotes (tab-sync TTL)', () => {
  it('drops a remote silent for longer than the TTL and reports the change', () => {
    const now = 100_000
    const remotes = new Map<string, number>([
      ['crashed-tab', now - REMOTE_TTL_MS - 1],
      ['live-tab', now - HEARTBEAT_MS],
    ])
    const changed = sweepStaleRemotes(remotes, now, REMOTE_TTL_MS)
    expect(changed).toBe(true)
    expect([...remotes.keys()]).toEqual(['live-tab'])
  })

  it('keeps a remote exactly AT the TTL boundary (strictly-older eviction)', () => {
    const now = 100_000
    const remotes = new Map<string, number>([['edge-tab', now - REMOTE_TTL_MS]])
    expect(sweepStaleRemotes(remotes, now, REMOTE_TTL_MS)).toBe(false)
    expect(remotes.size).toBe(1)
  })

  it('no-ops (changed=false) on an empty or all-fresh map', () => {
    expect(sweepStaleRemotes(new Map(), Date.now(), REMOTE_TTL_MS)).toBe(false)
    const fresh = new Map([['t', Date.now()]])
    expect(sweepStaleRemotes(fresh, Date.now(), REMOTE_TTL_MS)).toBe(false)
    expect(fresh.size).toBe(1)
  })

  it('TTL outlasts multiple heartbeat intervals (a slow beat never evicts)', () => {
    // 3 missed beats is the contract — one delayed beat must survive.
    expect(REMOTE_TTL_MS).toBeGreaterThanOrEqual(HEARTBEAT_MS * 3)
  })
})

describe('switchConversation orphan probe timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, 'dreambyteApi', { value: undefined, writable: true, configurable: true })
  })

  function makeStore(activeRunIds: () => Promise<{ runIds: string[] }>) {
    Object.defineProperty(window, 'dreambyteApi', {
      value: {
        agent: { activeRunIds },
        conversations: {
          listMessages: vi.fn().mockResolvedValue({ messages: [] }),
          updateMessage: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
      configurable: true,
    })
    let state: Record<string, unknown> = {
      conversations: [{ id: 'conv-1' }],
      activeConversationId: null,
      chatMessages: [],
      _persistedMessageIds: new Set<string>(),
      isAgentRunning: false,
      scenes: [],
      project: { id: 'proj-1' },
      abortAgentRun: vi.fn(),
      // T3/D6: switchConversation flushes pending project edits before reloading
      // messages and blocks on failure. Stub a successful flush so this IT6
      // orphan-probe test exercises the probe path, not the flush block.
      flushSaveProjectToDb: vi.fn().mockResolvedValue({ ok: true }),
    }
    const set = vi.fn((updater: unknown) => {
      const next = typeof updater === 'function' ? (updater as (s: unknown) => Record<string, unknown>)(state) : updater
      state = { ...state, ...(next as Record<string, unknown>) }
    })
    const get = vi.fn(() => state) as unknown as () => never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = createAgentActions(set as any, get as any) as any
    state = { ...state, ...actions }
    return { actions, get: () => state }
  }

  it('a HUNG activeRunIds probe resolves the switch within the 3s timeout', async () => {
    const hung = () => new Promise<{ runIds: string[] }>(() => {}) // never settles
    const { actions, get } = makeStore(hung)

    const switching = actions.switchConversation('conv-1')
    await vi.advanceTimersByTimeAsync(3_100) // past ORPHAN_PROBE_TIMEOUT_MS
    await switching // resolves — previously hung forever

    expect((get() as Record<string, unknown>).activeConversationId).toBe('conv-1')
  })

  it('a fast probe still resolves normally (no behavior change on the happy path)', async () => {
    const fast = vi.fn().mockResolvedValue({ runIds: [] })
    const { actions, get } = makeStore(fast)

    const switching = actions.switchConversation('conv-1')
    await vi.advanceTimersByTimeAsync(10)
    await switching

    expect(fast).toHaveBeenCalledTimes(1)
    expect((get() as Record<string, unknown>).activeConversationId).toBe('conv-1')
  })
})
