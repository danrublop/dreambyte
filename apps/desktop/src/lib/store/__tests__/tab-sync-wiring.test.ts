// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IT6 tab-sync WIRING test (/review testing gap): tab-sync-orphan-hardening
 * covers the pure sweep reducer; this covers the liveness protocol itself —
 * broadcastAgentStart arming the periodic heartbeat, broadcastAgentEnd
 * stopping it, heartbeat receipt refreshing lastSeen so the sweep keeps a
 * live remote, and a silent (crashed) remote being evicted by the sweep.
 * A leaked or never-armed heartbeat interval is the exact failure mode the
 * feature exists to prevent.
 */

type Listener = (event: MessageEvent) => void

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []
  name: string
  onmessage: Listener | null = null
  posted: Array<Record<string, unknown>> = []
  closed = false
  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }
  postMessage(msg: Record<string, unknown>) {
    this.posted.push(msg)
  }
  close() {
    this.closed = true
  }
  // Test hook: deliver a message as if from another tab.
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: msg } as MessageEvent)
  }
}

describe('tab-sync liveness wiring (IT6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tabSync: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any
  let cleanup: (() => void) | null = null

  beforeEach(async () => {
    vi.useFakeTimers()
    MockBroadcastChannel.instances = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).BroadcastChannel = MockBroadcastChannel
    vi.resetModules()
    tabSync = await import('../tab-sync')
    store = (await import('../index')).useVideoStore
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.useRealTimers()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).BroadcastChannel
  })

  function channel(): MockBroadcastChannel {
    return MockBroadcastChannel.instances[MockBroadcastChannel.instances.length - 1]
  }

  it('broadcastAgentStart arms a periodic heartbeat; broadcastAgentEnd stops it', () => {
    cleanup = tabSync.initTabSync('proj-1')
    tabSync.broadcastAgentStart('proj-1')
    const ch = channel()
    const countBeats = () => ch.posted.filter((m) => m.type === 'agent_heartbeat').length

    vi.advanceTimersByTime(tabSync.HEARTBEAT_MS * 3 + 10)
    expect(countBeats()).toBe(3)

    tabSync.broadcastAgentEnd('proj-1')
    const beatsAtEnd = countBeats()
    vi.advanceTimersByTime(tabSync.HEARTBEAT_MS * 3)
    expect(countBeats()).toBe(beatsAtEnd) // no beats after end — interval cleared
    expect(ch.posted.some((m) => m.type === 'agent_end')).toBe(true)
  })

  it('a heartbeating remote stays locked; a silent (crashed) remote is evicted by the sweep', () => {
    cleanup = tabSync.initTabSync('proj-1')
    const ch = channel()

    ch.receive({ type: 'agent_start', projectId: 'proj-1', tabId: 'remote-tab' })
    expect(store.getState().isAgentRunningRemote).toBe(true)

    // Remote keeps heartbeating → stays locked across several sweep ticks.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(tabSync.HEARTBEAT_MS)
      ch.receive({ type: 'agent_heartbeat', projectId: 'proj-1', tabId: 'remote-tab' })
    }
    expect(store.getState().isAgentRunningRemote).toBe(true)

    // Remote crashes (no more beats) → evicted once TTL elapses.
    vi.advanceTimersByTime(tabSync.REMOTE_TTL_MS + tabSync.HEARTBEAT_MS + 10)
    expect(store.getState().isAgentRunningRemote).toBe(false)
  })

  it('agent_end releases the lock immediately without waiting for the TTL', () => {
    cleanup = tabSync.initTabSync('proj-1')
    const ch = channel()
    ch.receive({ type: 'agent_start', projectId: 'proj-1', tabId: 'remote-tab' })
    expect(store.getState().isAgentRunningRemote).toBe(true)
    ch.receive({ type: 'agent_end', projectId: 'proj-1', tabId: 'remote-tab' })
    expect(store.getState().isAgentRunningRemote).toBe(false)
  })

  it('cleanup tears down the sweep and heartbeat timers (no leaked intervals)', () => {
    const teardown = tabSync.initTabSync('proj-1') as () => void
    cleanup = teardown
    tabSync.broadcastAgentStart('proj-1')
    teardown()
    cleanup = null
    expect(vi.getTimerCount()).toBe(0)
  })
})
