import { randomUUID } from 'node:crypto'
import { db } from '../index'
import { agentRunLeases } from '../schema'
import { and, eq, sql } from 'drizzle-orm'

export type AgentRunLease = typeof agentRunLeases.$inferSelect

/**
 * Cross-process advisory lease for AGENT RUNS.
 *
 * `reserveRunSlot` (src/lib/services/agent-runner.ts) is an IN-MEMORY guard: it only
 * serializes runs within ONE Electron window. But the worktree-per-agent
 * workflow runs MULTIPLE app windows / git worktrees against the SAME
 * ~/.dreambyte/studio.db, so two windows can each pass their own in-memory check
 * and start an agent run concurrently on the same (projectId, branchId),
 * double-mutating that branch's action_log. The authoritative exclusion has to
 * live in the DB.
 *
 * This is a deliberate clone of the proven branch_locks lease pattern
 * (src/lib/db/queries/branch-locks.ts): atomic upsert-acquire, heartbeat + TTL
 * liveness (a crashed window's lease is reclaimable once its heartbeat passes
 * the TTL — NOT process-exit cleanup, since a crashed window runs no cleanup),
 * and self-only release. The lease key is composite (projectId, branchId) so
 * runs on different branches of one project may proceed in parallel while
 * same-branch runs across windows are mutually excluded.
 *
 * `ownerToken` is a per-ACQUISITION token (a fresh randomUUID per run), NOT a
 * per-window id, so two runs in the same window can never alias each other's
 * lease and steal it mid-run. The same token must be threaded through
 * heartbeat/release.
 *
 * A clean stop releases the lease (releaseRunLease), so a resume — which goes
 * through the SAME run-start handler — is NOT falsely refused: the lease is gone
 * and immediately re-acquirable (Lane E regression).
 */
// Inherited verbatim from branch_locks (the proven sibling). TTL=30s with a 10s
// heartbeat gives 3 missed ticks of slack before a lease is reclaimable. Tradeoff
// for LONG runs: if the main event loop were blocked >30s (rare — runAgent's loop
// is fully async/awaited, so only a pathological sync spike like a huge
// worldSnapshot serialize could stall the wall-clock heartbeat), another window
// could steal a still-live run's lease and both would write the same
// (projectId, branchId). The lease is the only cross-process guard, so that's the
// blast radius; a longer TTL would trade faster-clobber-protection for slower
// crash recovery.
const TTL_SECONDS = 30
export const HEARTBEAT_MS = 10_000

/** Normalize a null/empty branchId to '' so it maps to one stable PK value.
 *  (SQLite treats NULL as distinct in a composite PK, which would defeat the
 *  per-branch exclusion — every null-branch run would get its own row.)
 *
 *  NOTE: this lease key (null→'') intentionally DIFFERS from the checkpoint key,
 *  which resolves null→the real default-branch UUID (branch-proposals.ts). That's
 *  fine: the lease only needs two runs that would collide on the same checkpoint
 *  to ALSO collide on the lease, and they do — both windows share this identical
 *  null→'' mapping. The lease key need not equal the checkpoint key; do not
 *  "align" them. */
function normalizeBranchId(branchId: string | null | undefined): string {
  return branchId ?? ''
}

export interface AcquireRunLeaseOptions {
  ownerToken: string
  instanceId?: string | null
  pid?: number | null
  runId?: string | null
  /** TTL override (seconds). Mainly for tests to simulate a stale lease. */
  ttlSeconds?: number
}

export interface RunLeaseHolder {
  instanceId: string | null
  pid: number | null
  /** Milliseconds since the holder last heartbeat (for the refuse message). */
  ageMs: number
}

export type AcquireRunLeaseResult = { acquired: true } | { acquired: false; heldBy: RunLeaseHolder }

/**
 * Atomically acquire the run lease for (projectId, branchId). Succeeds when no
 * lease exists, when the existing lease is stale (heartbeat older than the TTL —
 * a crashed/abandoned window), or when the SAME owner token already holds it
 * (idempotent re-acquire). Fails when a DIFFERENT live window holds it, returning
 * that holder's identity for an honest refuse message.
 */
export async function acquireRunLease(
  projectId: string | undefined,
  branchId: string | null | undefined,
  opts: AcquireRunLeaseOptions,
): Promise<AcquireRunLeaseResult> {
  // No project to scope the lease to (mirrors reserveRunSlot's no-project pass).
  // Nothing to coordinate across windows, so treat as acquired without a DB row.
  if (!projectId) return { acquired: true }
  const bid = normalizeBranchId(branchId)
  const ttl = opts.ttlSeconds ?? TTL_SECONDS
  const ownerToken = opts.ownerToken

  // INSERT, or take over on conflict only when the current lease is stale or
  // already ours (same owner token). SQLite evaluates the WHERE against the
  // existing row; if false, nothing is written and RETURNING yields no row.
  const rows = await db
    .insert(agentRunLeases)
    .values({
      projectId,
      branchId: bid,
      ownerToken,
      ownerInstanceId: opts.instanceId ?? null,
      ownerPid: opts.pid ?? null,
      runId: opts.runId ?? null,
    })
    .onConflictDoUpdate({
      target: [agentRunLeases.projectId, agentRunLeases.branchId],
      set: {
        ownerToken,
        ownerInstanceId: opts.instanceId ?? null,
        ownerPid: opts.pid ?? null,
        runId: opts.runId ?? null,
        heartbeatAt: new Date(),
        createdAt: new Date(),
      },
      where: sql`${agentRunLeases.heartbeatAt} < (unixepoch() - ${ttl}) OR ${agentRunLeases.ownerToken} = ${ownerToken}`,
    })
    .returning()

  if (rows[0] && rows[0].ownerToken === ownerToken) return { acquired: true }

  // Conflict with a live lease held by someone else — report the current holder.
  const [holder] = await db
    .select()
    .from(agentRunLeases)
    .where(and(eq(agentRunLeases.projectId, projectId), eq(agentRunLeases.branchId, bid)))
    .limit(1)

  const heartbeatMs = holder?.heartbeatAt ? holder.heartbeatAt.getTime() : Date.now()
  return {
    acquired: false,
    heldBy: {
      instanceId: holder?.ownerInstanceId ?? null,
      pid: holder?.ownerPid ?? null,
      ageMs: Math.max(0, Date.now() - heartbeatMs),
    },
  }
}

/** Write attempts per heartbeat tick, and the linear backoff between them.
 *  Worst case 750ms — far inside the 10s tick, so a retry can never overlap
 *  the next one. */
const HEARTBEAT_ATTEMPTS = 3
const HEARTBEAT_RETRY_MS = 250

/** Refresh the lease's heartbeat. Returns false if this owner no longer holds it. */
export async function heartbeatRunLease(
  projectId: string | undefined,
  branchId: string | null | undefined,
  ownerToken: string,
): Promise<boolean> {
  if (!projectId) return false
  const bid = normalizeBranchId(branchId)
  // A single transient write error must not cost a heartbeat. Every caller
  // swallows the rejection with a warn, three missed ticks expire the 30s
  // lease, ANOTHER WINDOW STEALS IT MID-RUN, and the loser then loses the
  // optimistic-lock race in persistScenesFromAgentRun — every scene the run
  // built is gone. The usual trigger was SQLITE_BUSY (see src/lib/db/index.ts:
  // libsql silently reset busy_timeout to 0 on the first transaction); this
  // retry is the second line of defence for any other transient failure.
  // A `false` RESULT is deliberately not retried — that means someone else
  // legitimately owns the lease, and retrying would not change it.
  let lastError: unknown
  for (let attempt = 0; attempt < HEARTBEAT_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_RETRY_MS * attempt))
    try {
      const rows = await db
        .update(agentRunLeases)
        .set({ heartbeatAt: new Date() })
        .where(
          and(
            eq(agentRunLeases.projectId, projectId),
            eq(agentRunLeases.branchId, bid),
            eq(agentRunLeases.ownerToken, ownerToken),
          ),
        )
        .returning({ projectId: agentRunLeases.projectId })
      return rows.length > 0
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

/** Release the lease (only the owning acquisition can — self-only DELETE). */
export async function releaseRunLease(
  projectId: string | undefined,
  branchId: string | null | undefined,
  ownerToken: string,
): Promise<void> {
  if (!projectId) return
  const bid = normalizeBranchId(branchId)
  await db
    .delete(agentRunLeases)
    .where(
      and(
        eq(agentRunLeases.projectId, projectId),
        eq(agentRunLeases.branchId, bid),
        eq(agentRunLeases.ownerToken, ownerToken),
      ),
    )
}

/** The live lease on (projectId, branchId) — heartbeat within TTL — or null if
 *  free/stale. */
export async function getActiveRunLease(
  projectId: string | undefined,
  branchId: string | null | undefined,
  ttlSeconds = TTL_SECONDS,
): Promise<AgentRunLease | null> {
  if (!projectId) return null
  const bid = normalizeBranchId(branchId)
  const [row] = await db
    .select()
    .from(agentRunLeases)
    .where(
      and(
        eq(agentRunLeases.projectId, projectId),
        eq(agentRunLeases.branchId, bid),
        sql`${agentRunLeases.heartbeatAt} >= (unixepoch() - ${ttlSeconds})`,
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Convenience: mint a fresh owner token. Callers (the run-start IPC handler)
 * own the token for the duration of the run and thread it through
 * heartbeat/release. Kept here so token minting lives next to the lease logic.
 */
export function mintRunLeaseToken(): string {
  return randomUUID()
}
