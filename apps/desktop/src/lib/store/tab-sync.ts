'use client'

/**
 * Cross-tab agent run synchronization via BroadcastChannel.
 *
 * Prevents two browser tabs from starting agent runs simultaneously
 * on the same project. The server-side `activeRuns` Map is the
 * authoritative lock, but this provides instant client-side UX feedback.
 *
 * Liveness: a remote lock is only honored while its tab keeps
 * heartbeating. A tab that crashes (or is force-killed) mid-run never sends
 * `agent_end` — before the TTL sweep, that left every sibling tab's send
 * button locked until a manual refresh. Now a running tab broadcasts
 * `agent_heartbeat` every HEARTBEAT_MS, receivers stamp lastSeen per remote
 * tab, and a sweep drops remotes silent for longer than REMOTE_TTL_MS
 * (3 missed heartbeats).
 */

import { useVideoStore } from './index'

const CHANNEL_NAME = 'dreambyte-agent-sync'

/** How often a RUNNING tab announces it's still alive. */
export const HEARTBEAT_MS = 5_000
/** How long a remote lock survives without a heartbeat (3 missed beats). */
export const REMOTE_TTL_MS = 15_000

// Unique per-tab identifier (stable for the tab's lifetime)
const tabId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36)

type SyncMessage =
  | { type: 'agent_start'; projectId: string; tabId: string }
  | { type: 'agent_end'; projectId: string; tabId: string }
  | { type: 'agent_heartbeat'; projectId: string; tabId: string }
  | { type: 'agent_query'; projectId: string; tabId: string }
  | { type: 'agent_status'; projectId: string; tabId: string; running: boolean }

let channel: BroadcastChannel | null = null
let currentProjectId: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

// Track which remote tabs are running → last heartbeat/sighting (ms).
const remoteRunning = new Map<string, number>()

/**
 * Drop remotes not seen within `ttlMs`. Returns true when anything was
 * removed. Pure over its inputs (exported for the TTL tests).
 */
export function sweepStaleRemotes(remotes: Map<string, number>, nowMs: number, ttlMs: number): boolean {
  let changed = false
  for (const [id, lastSeen] of remotes) {
    if (nowMs - lastSeen > ttlMs) {
      remotes.delete(id)
      changed = true
    }
  }
  return changed
}

function updateStoreFromRemote() {
  useVideoStore.setState({ isAgentRunningRemote: remoteRunning.size > 0 })
}

function markRemote(remoteTabId: string) {
  remoteRunning.set(remoteTabId, Date.now())
  updateStoreFromRemote()
}

function handleMessage(event: MessageEvent<SyncMessage>) {
  const msg = event.data
  if (!msg || !msg.type || msg.tabId === tabId) return // ignore own messages
  if (msg.projectId !== currentProjectId) return // different project

  switch (msg.type) {
    case 'agent_start':
    case 'agent_heartbeat':
      markRemote(msg.tabId)
      break
    case 'agent_end':
      remoteRunning.delete(msg.tabId)
      updateStoreFromRemote()
      break
    case 'agent_query':
      // Another tab is asking if we're running — respond with our status
      if (useVideoStore.getState().isAgentRunning) {
        channel?.postMessage({
          type: 'agent_status',
          projectId: currentProjectId,
          tabId,
          running: true,
        } satisfies SyncMessage)
      }
      break
    case 'agent_status':
      if (msg.running) {
        markRemote(msg.tabId)
      }
      break
  }
}

/**
 * Initialize cross-tab sync for the given project.
 * Returns a cleanup function to call on unmount.
 */
export function initTabSync(projectId: string): () => void {
  currentProjectId = projectId
  remoteRunning.clear()

  if (typeof BroadcastChannel === 'undefined') {
    // Graceful degradation — server-side 409 is the fallback
    return () => {}
  }

  // Close previous channel if project changed
  channel?.close()
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = handleMessage

  // Periodic TTL sweep — a crashed remote never sends agent_end; this is
  // what unlocks the send button without a refresh.
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    if (sweepStaleRemotes(remoteRunning, Date.now(), REMOTE_TTL_MS)) {
      updateStoreFromRemote()
    }
  }, HEARTBEAT_MS)

  // Query other tabs for running status
  channel.postMessage({
    type: 'agent_query',
    projectId,
    tabId,
  } satisfies SyncMessage)

  return () => {
    remoteRunning.clear()
    updateStoreFromRemote()
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    stopHeartbeat()
    channel?.close()
    channel = null
    currentProjectId = null
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** Broadcast that this tab started an agent run (and keep proving liveness). */
export function broadcastAgentStart(projectId: string) {
  channel?.postMessage({ type: 'agent_start', projectId, tabId } satisfies SyncMessage)
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    channel?.postMessage({ type: 'agent_heartbeat', projectId, tabId } satisfies SyncMessage)
  }, HEARTBEAT_MS)
}

/** Broadcast that this tab finished an agent run. */
export function broadcastAgentEnd(projectId: string) {
  stopHeartbeat()
  channel?.postMessage({ type: 'agent_end', projectId, tabId } satisfies SyncMessage)
}
