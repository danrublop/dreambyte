/**
 * Snapshot orchestrator (dispatch-site wiring).
 *
 * The scheduler (`createSnapshotScheduler`) and the persistence layer
 * (`writeSnapshot` / `readLatestSnapshot`) are pure modules; this file is
 * the main-process glue that:
 *
 *   1. Holds the singleton scheduler so every dispatch site shares the same
 *      counter (renderer-IPC append + agent emitter).
 *   2. Computes a new snapshot on threshold by loading the prior snapshot
 *      state, replaying `action_log` rows newer than it, and writing the
 *      result back.
 *
 * Best-effort. Compute errors are logged but never thrown — the snapshot is
 * an optimisation. Replay-from-WAL + reducer remain authoritative on cold
 * boot if no snapshot exists or it is stale.
 */

import type { Action, ProjectState } from './types'
import { createSnapshotScheduler, type SnapshotScheduler } from './snapshot-scheduler'
import { runReducer } from './reducers'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/snapshot-orchestrator')

let scheduler: SnapshotScheduler | null = null
let computing: Promise<void> | null = null

/**
 * Returns a starting `ProjectState` to seed reduction when no prior
 * snapshot exists. The fields are intentionally empty — the action_log is
 * the only feed; pre-action-log scene data is not surfaced here. This is
 * acceptable because (a) the snapshot is an optimisation, not the source
 * of truth, and (b) future tools that emit `scene/create` will populate
 * the snapshot once replay catches up.
 */
function emptyState(): ProjectState {
  return {
    scenes: [],
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    } as ProjectState['globalStyle'],
    project: {
      id: '',
      name: '',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as unknown as ProjectState['project'],
    selectedSceneId: null,
    uiEditingLayerId: null,
  }
}

async function computeAndWriteSnapshot(args: {
  projectId: string
  branchId: string | null
  actionId: string
}): Promise<void> {
  // Lazy-load DB modules so this file can be imported in tests that don't
  // touch Drizzle. Both calls hit `node:electron` paths transitively.
  const { readLatestSnapshot, writeSnapshot } = await import('@/lib/db/queries/materialized-state')
  const { listActions, getActionTimestamp } = await import('@/lib/db/queries/action-log')

  const prior = await readLatestSnapshot(args.projectId, args.branchId).catch((err: unknown) => {
    log.warn('readLatestSnapshot failed; assuming none', { error: err })
    return null
  })

  let state: ProjectState = prior ? (prior.state as unknown as ProjectState) : emptyState()
  // listActions is ordered by timestamp asc. The correct `sinceTimestamp`
  // is the prior snapshot's last-applied action timestamp — NOT
  // prior.createdAt. Reason: actions can be inserted into action_log
  // AFTER the prior snapshot was computed but with timestamps EARLIER
  // than the snapshot's createdAt (the write happens at dispatch time,
  // the timestamp captures dispatch time, the DB INSERT is async). Using
  // createdAt would permanently skip those actions from future snapshots.
  //
  // Falls back to prior.createdAt if the lastActionId lookup fails (the
  // boundary action might have been pruned, though we don't prune
  // today). Reducer is idempotent on already-applied actions via
  // result.success === false → continue, so re-applying the boundary
  // action is a safe no-op.
  let sinceTimestamp = 0
  if (prior) {
    if (prior.lastActionId) {
      const ts = await getActionTimestamp(args.projectId, prior.lastActionId).catch(() => null)
      sinceTimestamp = ts ?? prior.createdAt
    } else {
      sinceTimestamp = prior.createdAt
    }
  }
  let actions: Action[] = []
  try {
    actions = await listActions(args.projectId, {
      branchId: args.branchId,
      sinceTimestamp,
    })
  } catch (err) {
    log.warn('listActions failed; skipping snapshot', { error: err })
    return
  }

  let lastActionId = prior?.lastActionId ?? null
  for (const action of actions) {
    const result = runReducer(state, action)
    if (result.success && result.state) {
      state = result.state
      lastActionId = action.id
    } else if (!result.success) {
      // A reducer returning failure during snapshot replay usually means
      // the action references state the snapshot doesn't have (e.g. a
      // scene/update for a scene that was created pre-action-log). Skip
      // silently — the snapshot stays partial, but the WAL replay path on
      // cold boot is still authoritative.
      continue
    }
  }

  try {
    await writeSnapshot({
      projectId: args.projectId,
      branchId: args.branchId,
      lastActionId,
      state: state as unknown as Record<string, unknown>,
    })
  } catch (err) {
    log.warn('writeSnapshot failed', { error: err })
  }
}

function ensureScheduler(): SnapshotScheduler {
  if (scheduler) return scheduler
  scheduler = createSnapshotScheduler({
    onTrigger: ({ projectId, branchId, actionId, count }) => {
      // Compute is async; serialize so two near-simultaneous triggers
      // (renderer + agent) don't double-read/write. The scheduler counter
      // is already debounced by the threshold, so this serialization is
      // belt-and-braces.
      const next = (computing ?? Promise.resolve()).then(() =>
        computeAndWriteSnapshot({ projectId, branchId, actionId }).catch((err) =>
          log.warn('snapshot compute failed', { extra: { projectId, branchId, count }, error: err }),
        ),
      )
      computing = next.finally(() => {
        if (computing === next) computing = null
      })
    },
  })
  return scheduler
}

/**
 * Record one dispatched action with the singleton scheduler. Both the
 * renderer-IPC append path and the agent emitter call this; on the 500th
 * action per (project, branch), a snapshot is computed in the background.
 */
export function recordDispatchedAction(args: { projectId: string; branchId?: string | null; actionId: string }): void {
  if (!args.projectId || !args.actionId) return
  ensureScheduler().recordAction(args)
}

/** Test-only — reset the singleton scheduler between runs. */
export function _resetForTests(): void {
  scheduler = null
  computing = null
}

/**
 * Test-only — directly run the onTrigger compute+write path without
 * needing to hit the 500-action threshold. Production code must go
 * through `recordDispatchedAction` so the counter stays authoritative.
 */
export async function _computeSnapshotNow(args: { projectId: string; branchId?: string | null }): Promise<void> {
  await computeAndWriteSnapshot({
    projectId: args.projectId,
    branchId: args.branchId ?? null,
    actionId: 'test-trigger',
  })
}
