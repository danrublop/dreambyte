import { randomUUID } from 'node:crypto'
import { db } from '../index'
import { branchLocks } from '../schema'
import { and, eq, sql } from 'drizzle-orm'
import { createLogger } from '@/lib/logger'

const log = createLogger('db.branch-locks')

export type BranchLock = typeof branchLocks.$inferSelect
export type BranchLockOperation = BranchLock['operation']

/**
 * Cross-process advisory lock for branch-mutating operations (delete, fork,
 * restore, promote). Agents run in separate Electron app instances / git
 * worktrees against the SAME dreambyte.db, so an in-memory flag can't
 * coordinate them — the lock has to live in the DB.
 *
 * Liveness is heartbeat + TTL, not process-exit cleanup: a holder refreshes
 * heartbeat_at while it works; a crashed holder's lock is reclaimable once its
 * heartbeat passes the TTL. This is why a fork copying GBs of video must keep
 * heartbeating (see withBranchLock).
 *
 * Two layers of mutual exclusion:
 *   1. Cross-process: the DB row (this module's acquire/heartbeat/release).
 *      Each acquire mints a fresh per-acquisition owner token so two ops in the
 *      SAME process can never alias each other's lock and "steal" it mid-run.
 *   2. In-process: a per-branch keyed promise-chain mutex (see withBranchLock).
 *      Same-process ops on one branch QUEUE in arrival order instead of racing
 *      the DB row. A max-hold timeout on that mutex fails the CALLER loud after
 *      MAX_HOLD_MS. The hung op itself is not cancellable (no thread to abort) so
 *      it keeps running as a "zombie" — but the watchdog STOPS its heartbeat the
 *      instant it fires, so the zombie no longer refreshes the DB row and the DB
 *      lock's TTL is what reclaims the cross-process lock. The in-process mutex
 *      slot is still held until the zombie truly settles, so a queued same-process
 *      waiter never starts mid-zombie. One liveness story: the DB TTL.
 */
const DEFAULT_TTL_SECONDS = 30
const HEARTBEAT_MS = 10_000
/** Max time a single op may hold the in-process mutex before it fails loud.
 *  ~2× the DB TTL so the DB lock's own TTL is the single liveness backstop. */
const MAX_HOLD_MS = 60_000

/** Raised when a branch op can't get the lock because another op holds it. */
export class BranchLockedError extends Error {
  constructor(public readonly operation: string) {
    super(`Branch is busy: a ${operation} operation is already in progress`)
    this.name = 'BranchLockedError'
  }
}

/** Raised when an op held the in-process mutex past MAX_HOLD_MS. Fails loud so a
 *  wedged operation surfaces instead of silently blocking the branch queue. */
export class BranchLockTimeoutError extends Error {
  constructor(public readonly operation: string) {
    super(`Branch ${operation} operation exceeded the ${MAX_HOLD_MS}ms max-hold timeout`)
    this.name = 'BranchLockTimeoutError'
  }
}

/**
 * Atomically acquire the lock for a branch. Succeeds when no lock exists, when
 * the existing lock is stale (heartbeat older than the TTL), or when the SAME
 * owner token already holds it (idempotent re-acquire by the same acquisition).
 * Fails when a different live owner holds it.
 *
 * `ownerId` is a per-ACQUISITION token (default: a fresh randomUUID), NOT a
 * per-process id. The same token must be threaded through heartbeat/release for
 * this acquisition; two distinct ops in one process get distinct tokens and so
 * cannot take over each other's live lock.
 */
export async function acquireBranchLock(args: {
  branchId: string
  projectId: string
  operation: BranchLockOperation
  ownerId?: string
  ttlSeconds?: number
}): Promise<{ acquired: boolean; ownerId: string; holder?: BranchLock }> {
  const ownerId = args.ownerId ?? randomUUID()
  const ttl = args.ttlSeconds ?? DEFAULT_TTL_SECONDS

  // INSERT, or take over on conflict only when the current lock is stale or
  // already ours (same owner token). SQLite evaluates the WHERE against the
  // existing row; if false, nothing is written and RETURNING yields no row.
  const rows = await db
    .insert(branchLocks)
    .values({ branchId: args.branchId, projectId: args.projectId, ownerId, operation: args.operation })
    .onConflictDoUpdate({
      target: branchLocks.branchId,
      set: { ownerId, operation: args.operation, heartbeatAt: new Date(), createdAt: new Date() },
      where: sql`${branchLocks.heartbeatAt} < (unixepoch() - ${ttl}) OR ${branchLocks.ownerId} = ${ownerId}`,
    })
    .returning()

  if (rows[0] && rows[0].ownerId === ownerId) return { acquired: true, ownerId, holder: rows[0] }

  // Conflict with a live lock held by someone else — report the current holder.
  const [holder] = await db.select().from(branchLocks).where(eq(branchLocks.branchId, args.branchId)).limit(1)
  return { acquired: false, ownerId, holder: holder ?? undefined }
}

/** Refresh the lock's heartbeat. Returns false if this owner no longer holds it. */
export async function heartbeatBranchLock(branchId: string, ownerId: string): Promise<boolean> {
  const rows = await db
    .update(branchLocks)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(branchLocks.branchId, branchId), eq(branchLocks.ownerId, ownerId)))
    .returning({ branchId: branchLocks.branchId })
  return rows.length > 0
}

/** Release the lock (only the owning acquisition can). */
export async function releaseBranchLock(branchId: string, ownerId: string): Promise<void> {
  await db.delete(branchLocks).where(and(eq(branchLocks.branchId, branchId), eq(branchLocks.ownerId, ownerId)))
}

/** The live lock on a branch (heartbeat within TTL), or null if free/stale. */
export async function getActiveBranchLock(
  branchId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<BranchLock | null> {
  const [row] = await db
    .select()
    .from(branchLocks)
    .where(and(eq(branchLocks.branchId, branchId), sql`${branchLocks.heartbeatAt} >= (unixepoch() - ${ttlSeconds})`))
    .limit(1)
  return row ?? null
}

/** TRUE when any lock row for `operation` has a live (within-TTL) heartbeat.
 *  Used by the orphan-fork sweep: a live 'fork' lock anywhere means some fork
 *  is mid-copy, and since dest 'forking' rows carry no lineage to the source
 *  lock, the sweep defers the whole cycle rather than risk reclaiming the live
 *  fork's dest. */
export async function anyLiveLockForOperation(
  operation: BranchLockOperation,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<boolean> {
  const [row] = await db
    .select({ branchId: branchLocks.branchId })
    .from(branchLocks)
    .where(and(eq(branchLocks.operation, operation), sql`${branchLocks.heartbeatAt} >= (unixepoch() - ${ttlSeconds})`))
    .limit(1)
  return row !== undefined
}

// ── In-process per-key mutex ──────────────────────────────────────────────────
// Same-process ops on the same lock key must QUEUE (not race the DB row), so two
// operations in one window serialize cleanly. The chain is a promise per key:
// each waiter awaits the previous tail before running, and replaces the tail with
// its own completion. Cleaned up when the last waiter drains so the map can't
// grow unbounded across many branches.

const mutexChains = new Map<string, Promise<void>>()

/** Reserve a slot on one key's chain. Returns the predecessor to await and a
 *  release fn that drops the key when no later waiter queued behind us. */
function reserveChainSlot(key: string): { prev: Promise<void>; release: () => void } {
  const prev = mutexChains.get(key) ?? Promise.resolve()
  let resolveTail!: () => void
  const tail = new Promise<void>((resolve) => {
    resolveTail = resolve
  })
  mutexChains.set(key, tail)
  const release = () => {
    resolveTail()
    // If no later waiter replaced the tail, this op was last in line — drop the
    // key so the map doesn't leak an entry per key touched. Identity check means
    // we never delete a chain another waiter is queued on.
    if (mutexChains.get(key) === tail) mutexChains.delete(key)
  }
  return { prev, release }
}

/**
 * Run `fn` with exclusive in-process access to EVERY key in `keys` (deduped,
 * sorted so two ops requesting the same pair can't deadlock), queuing behind any
 * other op on a shared key. A MAX_HOLD_MS watchdog fails the CALLER loud (the DB
 * TTL then reclaims the cross-process row) so a hung op can't wedge the queue
 * forever.
 *
 * When the watchdog fires, `fn()` is NOT cancelled — JS has no thread to abort —
 * so the zombie op runs to completion in the background. To let the DB TTL
 * actually reclaim the lock, the watchdog must stop the zombie from heartbeating:
 * `onTimeout` is invoked exactly once at the moment the watchdog trips (before
 * the caller's reject propagates), so the caller (withBranchLock) can clearInterval
 * its heartbeat there. The mutex slot is only released once `fn()` truly settles,
 * so the in-process queue still serializes correctly — but the cross-process DB
 * lock is freed by TTL, not by the zombie, which is the intended single liveness
 * story.
 *
 * Acquiring multiple keys lets a project-scoped op (delete/promote/create) and a
 * branch-scoped op (fork/restore) on the same branch still serialize in one
 * process: every branch op also takes its branch's project key, so they share at
 * least the project chain and queue instead of racing the DB row.
 */
async function withInProcessMutex<T>(
  keys: string[],
  operation: string,
  fn: () => Promise<T>,
  onTimeout?: () => void,
  maxHoldMs: number = MAX_HOLD_MS,
): Promise<T> {
  // Stable global order (sorted) prevents A→B vs B→A deadlocks across ops.
  const ordered = [...new Set(keys)].sort()
  const slots = ordered.map(reserveChainSlot)

  // Wait our turn on each chain in order. prev never rejects (we always release
  // in finally), but guard anyway so one op's failure can't poison the chain.
  for (const slot of slots) await slot.prev.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  // The op's own promise. We must let it settle before releasing the mutex slot
  // (even after a watchdog timeout) so the queue stays serialized and a later
  // waiter never starts while the zombie is still mutating shared state.
  const run = fn()
  // Swallow late rejection of the zombie so it doesn't become an unhandled
  // rejection after the caller already saw the timeout error.
  run.catch(() => {})
  try {
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        // Stop the heartbeat NOW so the DB TTL can reclaim the cross-process lock
        // while the zombie op keeps running. Guarded so a throwing callback can't
        // swallow the timeout rejection.
        try {
          onTimeout?.()
        } catch (cbErr) {
          log.warn('branch lock watchdog onTimeout callback threw', {
            extra: { operation },
            error: cbErr,
          })
        }
        reject(new BranchLockTimeoutError(operation))
      }, maxHoldMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    return await Promise.race([run, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut) {
      // Zombie still running: release the mutex slot only after it settles so a
      // queued waiter can't start mid-zombie. Done async (don't block the caller,
      // who already got the timeout error). Slot release is idempotent-safe here.
      void run.finally(() => {
        for (const slot of slots) slot.release()
      })
    } else {
      for (const slot of slots) slot.release()
    }
  }
}

/**
 * Run `fn` while holding the branch lock, keeping the heartbeat alive for the
 * duration and always releasing at the end. Throws BranchLockedError if another
 * live process holds the lock; throws BranchLockTimeoutError if the op runs past
 * the in-process max-hold. This is the one entry point branch-mutating IPC
 * handlers should use.
 *
 * In-process queueing always covers the branch key AND the project key, so a
 * project-scoped op (delete/promote/create) and a branch-scoped op
 * (fork/restore) on the same branch serialize cleanly in one process. Pass
 * `lockKey: projectLockKey(projectId)` to additionally serialize cross-branch
 * ops (default-branch swaps, branch creation) where a per-branch DB row cannot
 * coordinate two different branches mutating the same project's default pointer.
 *
 * `maxHoldMs` overrides the in-process watchdog timeout (default MAX_HOLD_MS),
 * `heartbeatMs` overrides the DB-heartbeat interval (default HEARTBEAT_MS), and
 * `onHeartbeat` fires on every heartbeat tick. All three are exposed mainly so
 * tests can trip the watchdog and observe that the heartbeat stops once it does;
 * production callers should leave them unset.
 */
export async function withBranchLock<T>(
  args: {
    branchId: string
    projectId: string
    operation: BranchLockOperation
    lockKey?: string
    maxHoldMs?: number
    heartbeatMs?: number
    onHeartbeat?: () => void
  },
  fn: () => Promise<T>,
): Promise<T> {
  // Always queue on both the branch chain and the project chain (+ any explicit
  // lockKey) so every op on a branch within a project serializes in-process,
  // regardless of which scope it nominally requested.
  const keys = [args.branchId, projectLockKey(args.projectId)]
  if (args.lockKey) keys.push(args.lockKey)

  // Heartbeat handle lives in this scope (not inside the inner fn's finally) so
  // the watchdog's onTimeout can stop it. `stopHeartbeat` is idempotent (clearing
  // a cleared interval is a no-op AND the null guard prevents a stale-handle
  // clear), so the normal finally path and the timeout path can both call it
  // without a double-clear bug.
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let heartbeatStopped = false
  const stopHeartbeat = () => {
    if (heartbeatStopped) return
    heartbeatStopped = true
    if (heartbeat) clearInterval(heartbeat)
  }

  return withInProcessMutex(
    keys,
    args.operation,
    async () => {
      const { acquired, ownerId, holder } = await acquireBranchLock({
        branchId: args.branchId,
        projectId: args.projectId,
        operation: args.operation,
      })
      if (!acquired) throw new BranchLockedError(holder?.operation ?? 'another')

      heartbeat = setInterval(() => {
        args.onHeartbeat?.()
        void heartbeatBranchLock(args.branchId, ownerId).catch((err) =>
          log.warn('branch lock heartbeat failed', { extra: { branchId: args.branchId }, error: err }),
        )
      }, args.heartbeatMs ?? HEARTBEAT_MS)
      // Node timers keep the event loop alive; unref so a hung op can't block exit.
      if (typeof heartbeat.unref === 'function') heartbeat.unref()

      try {
        return await fn()
      } finally {
        // Normal completion (including a zombie that eventually finishes): stop
        // the heartbeat (idempotent if the watchdog already did) and release the
        // DB lock. release is token-scoped (ownerId), so if the watchdog already
        // tripped and the DB TTL reclaimed this token's row — possibly re-granting
        // a NEW lock under a fresh token to another op — this delete matches only
        // our own token and can never release someone else's new lock.
        stopHeartbeat()
        await releaseBranchLock(args.branchId, ownerId).catch((err) =>
          log.warn('branch lock release failed', { extra: { branchId: args.branchId }, error: err }),
        )
      }
    },
    // Watchdog tripped: stop heartbeating immediately so the zombie op runs to
    // completion WITHOUT refreshing the DB lock, letting the TTL reclaim it.
    stopHeartbeat,
    args.maxHoldMs,
  )
}

/** Project-scoped lock key for cross-branch operations on one project. */
export function projectLockKey(projectId: string): string {
  return `project:${projectId}`
}

/** Raised when a writer couldn't run because a destructive op held the branch
 *  past the bounded wait. Fails LOUD so the save surfaces instead of silently
 *  racing the fork/restore/delete it was supposed to wait behind. */
export class BranchWriterBlockedError extends Error {
  constructor(public readonly operation: string) {
    super(`Save blocked: a ${operation} operation is in progress on this branch`)
    this.name = 'BranchWriterBlockedError'
  }
}

/** Default bounded wait for a writer to queue behind a destructive op. */
const WRITER_WAIT_MS = 15_000
const WRITER_POLL_MS = 250

/**
 * Run a (non-destructive) WRITER — user autosave, agent persist, scene HTML
 * write — so it never interleaves with a destructive branch op (fork / restore /
 * delete / promote). Two guards:
 *
 *   1. In-process: queues on the same branch + project mutex chains the
 *      destructive ops use, so a same-process fork/restore and a save serialize
 *      in arrival order (no interleave) WITHOUT either failing.
 *   2. Cross-process: before running `fn`, waits (bounded) for any LIVE
 *      destructive DB lock on the branch to clear. If it's still held after the
 *      bound, fails loud with BranchWriterBlockedError rather than writing into
 *      the middle of another window's multi-scene revert/copy.
 *
 * The writer does NOT take the destructive DB lock itself (writers don't exclude
 * each other), it only DEFERS to it.
 */
export async function withWriterGate<T>(
  args: { branchId: string; projectId: string; waitMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const waitMs = args.waitMs ?? WRITER_WAIT_MS
  const keys = [args.branchId, projectLockKey(args.projectId)]
  return withInProcessMutex(keys, 'save', async () => {
    // Defer to a live cross-process destructive lock: poll until it clears or we
    // hit the bound. (Same-process destructive ops are already excluded by the
    // mutex above, so any live lock seen here is another window's.)
    const deadline = Date.now() + waitMs
    for (;;) {
      const live = await getActiveBranchLock(args.branchId)
      if (!live) break
      if (Date.now() >= deadline) throw new BranchWriterBlockedError(live.operation)
      await new Promise((r) => setTimeout(r, WRITER_POLL_MS))
    }
    return fn()
  })
}
