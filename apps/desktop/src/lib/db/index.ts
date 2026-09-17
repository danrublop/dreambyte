import { drizzle } from 'drizzle-orm/libsql'
import { createClient, type Client } from '@libsql/client'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as schema from './schema'
import { eq, and, gte, sql } from 'drizzle-orm'
import { createLogger } from '../logger'

const log = createLogger('db')

/** Wait, in ms, for a competing writer before SQLITE_BUSY. See the PRAGMA below. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000

/**
 * Set for the duration of a `db.transaction()` callback so a transaction opened
 * from INSIDE one is recognised as nested (→ SAVEPOINT) instead of queueing
 * behind the very transaction that is waiting for it (→ deadlock).
 * See installSingleConnectionTransactions.
 */
const txContext = new AsyncLocalStorage<true>()

/**
 * Replace libsql's local-file `transaction()` with BEGIN/COMMIT on the one
 * pragma'd connection.
 *
 * WHY: `Sqlite3Client.transaction()` (@libsql/client/lib-cjs/sqlite3.js) does
 * `this.#db = null` — "a new connection will be lazily created on next use" —
 * and `Sqlite3Transaction.close()` only issues ROLLBACK, never closing the
 * handle it was given. Measured on this repo's pinned @libsql/client:
 *   - `busy_timeout` 5000 → 0 after the FIRST transaction anywhere in the
 *     process (`#getDb()` is a bare `new Database(path)` with NO pragmas)
 *   - +2 open fds per transaction, strictly linear, no GC reclaim
 *     (600 transactions → 1202 open fds on the same .db file)
 * `journal_mode` survives (it lives in the file header) and `foreign_keys`
 * survives (native default), so `busy_timeout` is the only pragma actually
 * lost — and it is the one that matters. `getOrCreateDefaultBranch()` opens a
 * transaction on essentially every project open, so within seconds of launch
 * the timeout is 0; `heartbeatRunLease` (every 10s, 30s TTL) then takes
 * SQLITE_BUSY on the first contended tick, its `.catch()` only warns, three
 * misses expire the lease, ANOTHER WINDOW STEALS IT MID-RUN, and the loser
 * loses the optimistic-lock race in `persistScenesFromAgentRun` — the entire
 * run's scenes are gone.
 *
 * Running the transaction on the client's own connection fixes both halves at
 * once: no handle is ever discarded, so nothing leaks and the pragmas hold for
 * the connection's (i.e. the process's) lifetime.
 *
 * Local `file:` URLs only — remote/embedded-replica libsql runs transactions
 * server-side over a real session and has neither problem.
 */
function installSingleConnectionTransactions(client: Client): void {
  // Single in-process writer, enforced by a promise chain rather than a lock
  // library: a SQLite file has one write lock anyway, so serialising here means
  // concurrent writers queue instead of racing each other to SQLITE_BUSY.
  // Promise chain, not a fair/priority queue — swap only if a writer
  // is measurably starved.
  let queue: Promise<unknown> = Promise.resolve()
  let savepointSeq = 0

  /** Minimal libsql Transaction: drizzle-orm/libsql only calls execute/commit/rollback. */
  const makeTx = (commitSql: string, rollbackSql: string, onSettled: () => void) => {
    let settled = false
    const settle = async (sql: string) => {
      if (settled) return
      settled = true
      try {
        await client.execute(sql)
      } finally {
        // Release the queue even when COMMIT/ROLLBACK throws — otherwise one
        // failed transaction wedges every later writer in the process.
        onSettled()
      }
    }
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (stmt: any, args?: any) => (args === undefined ? client.execute(stmt) : client.execute(stmt, args)),
      // NOT client.batch(): that opens its own transaction, which fails inside
      // an open one. Sequential execute has the same effect under our BEGIN.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      batch: async (stmts: any[]) => {
        const out = []
        for (const s of stmts) out.push(await client.execute(Array.isArray(s) ? { sql: s[0], args: s[1] ?? [] } : s))
        return out
      },
      executeMultiple: (sql: string) => client.executeMultiple(sql),
      commit: () => settle(commitSql),
      rollback: () => settle(rollbackSql),
      close: () => {
        void settle(rollbackSql)
      },
      get closed() {
        return settled
      },
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).transaction = async (mode: string = 'write') => {
    if (txContext.getStore()) {
      // Nested call from inside a running transaction's callback. Queueing here
      // would deadlock (the holder is awaiting us), so compose with a SAVEPOINT
      // on the same connection instead.
      const name = `db_sp_${++savepointSeq}`
      await client.execute(`SAVEPOINT ${name}`)
      return makeTx(`RELEASE SAVEPOINT ${name}`, `ROLLBACK TO SAVEPOINT ${name}`, () => {})
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const prior = queue
    queue = held
    await prior.catch(() => {})
    try {
      await client.execute(mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE')
    } catch (e) {
      release()
      throw e
    }
    return makeTx('COMMIT', 'ROLLBACK', release)
  }
}

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>

let _client: Client | null = null
let _db: DrizzleDB | null = null

/**
 * Single-flight guard: `initDb()` is called from every property access on
 * the exported `db` Proxy. Without this, two concurrent IPC calls in the
 * Electron main process could each construct a Client; the loser would
 * leak its file handle.
 *
 * The libsql client opens lazily — connecting to the underlying SQLite
 * file (or remote libsql server) happens on first query, not at
 * construction. So `new Client()` itself is cheap; the race window is
 * narrow but real.
 */
function initDb(): DrizzleDB {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
        'For desktop: Electron sets this automatically to file:<userData>/dreambyte.db.\n' +
        'For local web dev: copy .env.example to .env.local and use file:./dev.db.\n' +
        'For cloud sync: use a libsql:// URL from a Turso database.',
    )
  }

  // Accept bare paths like `./dev.db` for ergonomics — libsql requires
  // an explicit scheme. Anything else (file:, libsql:, https:) is passed
  // through untouched.
  const normalized = /^[a-z]+:/i.test(url) ? url : `file:${url}`

  const client = createClient({
    url: normalized,
    authToken: process.env.DATABASE_AUTH_TOKEN,
    // For libsql local files, default sync settings are fine. Remote/embedded
    // replica configuration is layered later via DATABASE_SYNC_URL.
    ...(process.env.DATABASE_SYNC_URL
      ? {
          syncUrl: process.env.DATABASE_SYNC_URL,
        }
      : {}),
  })

  // SQLite leaves foreign-key enforcement OFF per connection, so without this
  // every ON DELETE CASCADE / SET NULL in the schema is inert — orphaned rows
  // accumulate and "delete project cascades its scenes" silently no-ops.
  // libsql keeps a persistent connection for file: URLs, and this is queued
  // before any subsequent query, so it sticks for the connection's lifetime.
  void client
    .execute('PRAGMA foreign_keys = ON')
    .catch((e) => log.warn('failed to enable SQLite foreign_keys', { error: e }))

  // Multiple Electron instances / worktrees share one dreambyte.db — the whole
  // premise of branch_locks. With the default busy_timeout=0 + rollback
  // journaling, concurrent writers throw SQLITE_BUSY instead of serializing:
  // a few swallowed busy heartbeats during another process's long restore let
  // the lock TTL lapse and a third process steals it mid-operation. WAL lets
  // readers proceed during writes (note: creates -wal/-shm sidecars), and a
  // 5s busy_timeout makes short write contention wait instead of throw.
  // Local files only — remote/libsql URLs manage journaling server-side.
  //
  // These stick for the connection's lifetime ONLY because
  // installSingleConnectionTransactions() below stops libsql from throwing the
  // connection away on every transaction. Without it busy_timeout silently
  // reverts to 0 after the first transaction — see that function's comment.
  if (normalized.startsWith('file:')) {
    installSingleConnectionTransactions(client)
    void client
      .execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
      .catch((e) => log.warn('failed to set SQLite busy_timeout', { error: e }))
    void client
      .execute('PRAGMA journal_mode = WAL')
      .then((res) => {
        // WAL can silently no-op on network/cloud-synced filesystems
        // (NFS/SMB, Dropbox/iCloud dirs) — and the branch_locks multi-window
        // concurrency design now assumes it engaged. The PRAGMA returns the
        // RESULTING mode, so verify from the same statement and log loudly
        // on fallback instead of letting the assumption fail silently.
        const mode = String(res.rows?.[0]?.journal_mode ?? '').toLowerCase()
        if (mode !== 'wal') {
          log.warn(
            `SQLite WAL did NOT engage (journal_mode=${mode || 'unknown'}) — ` +
              'concurrent multi-window writes fall back to rollback-journal locking; ' +
              'is the data directory on a network/cloud-synced filesystem?',
          )
        }
      })
      .catch((e) => log.warn('failed to enable SQLite WAL', { error: e }))
  }

  const database = drizzle(client, {
    schema,
    logger: process.env.NODE_ENV === 'development',
  })

  // Another tick's initDb() may have won. If so, drop ours to avoid the leak.
  if (_db) {
    void client.close()
    return _db
  }

  _client = client
  _db = database
  return _db
}

/**
 * Drizzle database handle. The client is created lazily on first property
 * access so importing modules that reference `db` does not require
 * DATABASE_URL at startup (matters for tests and for type-only tooling).
 */
export const db = new Proxy({} as DrizzleDB, {
  get(_target, prop, receiver) {
    const database = initDb()
    // Run the callback inside txContext so a `db.transaction()` opened from
    // within it is treated as nested (SAVEPOINT) instead of deadlocking on the
    // single-writer queue. See installSingleConnectionTransactions.
    if (prop === 'transaction') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (cb: (tx: any) => unknown, config?: unknown) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (database.transaction as any)((tx: any) => txContext.run(true, () => cb(tx)), config)
    }
    return Reflect.get(database as object, prop, receiver)
  },
  // Required so any adapter that does `is(db, SomeDrizzleClass)` — which
  // walks the prototype chain via Object.getPrototypeOf — sees the real
  // libsql Drizzle prototype instead of the empty Proxy target's
  // Object.prototype. Same pattern as the Auth.js fix in the PG version.
  getPrototypeOf() {
    return Reflect.getPrototypeOf(initDb() as object)
  },
  has(_target, prop) {
    return Reflect.has(initDb() as object, prop)
  },
})

export type DB = DrizzleDB

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
    _db = null
  }
}

// ── Spend tracking ─────────────────────────────────────────────────────────
// SQLite has no `interval` or `date_trunc` — substitute epoch arithmetic.
// Stored timestamps are Unix seconds; `unixepoch()` is SQLite's `now()`.

const ONE_DAY_SECONDS = 24 * 60 * 60

export async function logSpend(
  projectId: string,
  api: string,
  costUsd: number,
  description: string,
  reservationId?: string,
): Promise<void> {
  await db.insert(schema.apiSpend).values({
    projectId,
    api,
    costUsd,
    description,
  })
  // Mirror into the in-memory budget tracker so live budget queries see the
  // cost even before the DB row is read back. When a reservation exists,
  // reconcile it (replacing the estimate with the actual); otherwise just
  // record the raw spend.
  try {
    const tracker = await import('../agents/budget-tracker')
    if (reservationId) {
      const reconciled = tracker.reconcileSpend(projectId, reservationId, costUsd)
      if (!reconciled) tracker.recordActualSpend(projectId, costUsd)
    } else {
      tracker.recordActualSpend(projectId, costUsd)
    }
  } catch (trackerErr) {
    log.warn('logSpend: budget tracker update failed', { extra: { projectId, api }, error: trackerErr })
  }
}

export async function getSessionSpend(api: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.apiSpend.costUsd}), 0)` })
    .from(schema.apiSpend)
    .where(sql`${schema.apiSpend.api} = ${api} AND ${schema.apiSpend.createdAt} > unixepoch() - ${ONE_DAY_SECONDS}`)
  return Number(row?.total ?? 0)
}

export async function getMonthlySpend(api: string): Promise<number> {
  // Compute "first second of current month" in JS rather than SQL — SQLite's
  // `strftime` would also work but produces a string, not an epoch, so the
  // comparison with the integer `created_at` column would silently coerce.
  const now = new Date()
  const monthStart = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000)
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.apiSpend.costUsd}), 0)` })
    .from(schema.apiSpend)
    .where(sql`${schema.apiSpend.api} = ${api} AND ${schema.apiSpend.createdAt} > ${monthStart}`)
  return Number(row?.total ?? 0)
}

/**
 * Live PER-PROJECT spend for one api, from the apiSpend ledger — `{ session, monthly }` in USD.
 * The per-project counterpart of getSessionSpend/getMonthlySpend (which are global-per-api, used
 * only for the Settings display). This feeds spendCapExceeded so the project's session/monthly
 * dollar caps actually fire on accumulated spend (the apiPermissions.sessionSpend/monthlySpend
 * fields are never written by logSpend, so without this the caps read a stale zero). Session =
 * trailing 24h (same window as getSessionSpend); monthly = since the first of the calendar month.
 */
export async function getProjectApiSpend(
  projectId: string,
  api: string,
): Promise<{ session: number; monthly: number }> {
  const now = new Date()
  const monthStart = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000)
  const [sessionRow] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.apiSpend.costUsd}), 0)` })
    .from(schema.apiSpend)
    .where(
      sql`${schema.apiSpend.projectId} = ${projectId} AND ${schema.apiSpend.api} = ${api} AND ${schema.apiSpend.createdAt} > unixepoch() - ${ONE_DAY_SECONDS}`,
    )
  const [monthlyRow] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.apiSpend.costUsd}), 0)` })
    .from(schema.apiSpend)
    .where(
      sql`${schema.apiSpend.projectId} = ${projectId} AND ${schema.apiSpend.api} = ${api} AND ${schema.apiSpend.createdAt} > ${monthStart}`,
    )
  return { session: Number(sessionRow?.total ?? 0), monthly: Number(monthlyRow?.total ?? 0) }
}

// ── Media cache ─────────────────────────────────────────────────────────────

export async function getCachedMedia(hash: string): Promise<{ filePath: string; config: string | null } | null> {
  const row = await db.query.mediaCache.findFirst({
    where: eq(schema.mediaCache.hash, hash),
    columns: { filePath: true, config: true },
  })
  if (!row) return null
  return { filePath: row.filePath, config: row.config }
}

export async function setCachedMedia(
  hash: string,
  api: string,
  filePath: string,
  prompt: string,
  model: string,
  config: string,
): Promise<void> {
  await db.insert(schema.mediaCache).values({ hash, api, filePath, prompt, model, config }).onConflictDoUpdate({
    target: schema.mediaCache.hash,
    set: { api, filePath, prompt, model, config },
  })
}

// ── Session permissions ─────────────────────────────────────────────────────

export async function getSessionPermission(api: string): Promise<string | null> {
  const row = await db.query.permissionSessions.findFirst({
    where: eq(schema.permissionSessions.api, api),
    columns: { decision: true },
  })
  return row?.decision ?? null
}

export async function setSessionPermission(api: string, decision: string): Promise<void> {
  await db.insert(schema.permissionSessions).values({ api, decision }).onConflictDoUpdate({
    target: schema.permissionSessions.api,
    set: { decision },
  })
}

// ── Agent usage tracking ──────────────────────────────────────────────────

export interface AgentUsageRecord {
  projectId: string
  agentType: string
  modelId: string
  inputTokens: number
  outputTokens: number
  /** Prompt-cache WRITE tokens for the run. Omit when the provider reports none. */
  cacheCreationTokens?: number
  /** Prompt-cache READ tokens for the run — the hit side of the ratio. */
  cacheReadTokens?: number
  apiCalls: number
  toolCalls: number
  costUsd: number
  durationMs: number
  /** Resolved provider, e.g. 'anthropic' | 'openai' | 'google' | 'local' | 'claude-code'. */
  provider?: string
  /** Run terminal state. */
  outcome?: 'success' | 'error'
  /** This run's own id (logger.runId). */
  runId?: string
  /** Parent run id when this is a sub-agent; undefined for top-level runs. */
  parentRunId?: string
}

export async function logAgentUsage(record: AgentUsageRecord): Promise<void> {
  await db.insert(schema.agentUsage).values({
    projectId: record.projectId,
    agentType: record.agentType,
    modelId: record.modelId,
    provider: record.provider ?? null,
    outcome: record.outcome ?? null,
    runId: record.runId ?? null,
    parentRunId: record.parentRunId ?? null,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    // ?? null, not ?? 0 — see the column comment. A provider that reports nothing
    // must not be recorded as a run that got zero cache hits.
    cacheCreationTokens: record.cacheCreationTokens ?? null,
    cacheReadTokens: record.cacheReadTokens ?? null,
    apiCalls: record.apiCalls,
    toolCalls: record.toolCalls,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
  })
}

interface UsageBreakdown {
  inputTokens: number
  outputTokens: number
  costUsd: number
  count: number
}

/** A single run row for the sub-agent drill-down (newest first). */
export interface UsageRun {
  runId: string
  parentRunId: string | null
  agentType: string
  costUsd: number
  outcome: string | null
  durationMs: number
}

/** Date-range filter. `undefined` = all time. `{ days }` = rows newer than now - days. */
export type UsageRange = { days: number } | undefined

export interface AgentUsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalApiCalls: number
  totalToolCalls: number
  /** Prompt-cache WRITE tokens across the range. */
  totalCacheCreationTokens: number
  /** Prompt-cache READ tokens across the range — the hit side of the ratio. */
  totalCacheReadTokens: number
  /**
   * Runs that actually REPORTED cache figures. The columns are nullable and an
   * unreported write is NULL, never 0, so a run on a provider that says
   * nothing about caching must not be averaged in as a 0% hit rate. Use this as
   * the denominator when describing coverage; 0 here means "no data", not "no hits".
   */
  cacheReportingRuns: number
  /** Total run rows (top-level + sub-agent). */
  totalRuns: number
  /** Run rows whose outcome was 'error'. */
  errorRuns: number
  byAgent: Record<string, UsageBreakdown>
  byProvider: Record<string, UsageBreakdown>
  byModel: Record<string, UsageBreakdown>
  /** Newest month first. `month` is 'YYYY-MM' (UTC). */
  byMonth: Array<UsageBreakdown & { month: string }>
  /** Newest runs first, capped at 100, only rows with a runId. */
  runs: UsageRun[]
}

export async function getAgentUsageSummary(projectId?: string, range?: UsageRange): Promise<AgentUsageSummary> {
  const empty: AgentUsageSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    totalApiCalls: 0,
    totalToolCalls: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    cacheReportingRuns: 0,
    totalRuns: 0,
    errorRuns: 0,
    byAgent: {},
    byProvider: {},
    byModel: {},
    byMonth: [],
    runs: [],
  }

  // created_at is stored as unixepoch() seconds, so the range floor is in seconds too.
  const conds = []
  if (projectId) conds.push(eq(schema.agentUsage.projectId, projectId))
  if (range) {
    const fromEpoch = Math.floor(Date.now() / 1000) - range.days * 86400
    conds.push(gte(schema.agentUsage.createdAt, new Date(fromEpoch * 1000)))
  }
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds)

  const toRecord = (rows: Array<{ key: string } & UsageBreakdown>): Record<string, UsageBreakdown> => {
    const out: Record<string, UsageBreakdown> = {}
    for (const row of rows) {
      out[row.key] = {
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costUsd: Number(row.costUsd),
        count: Number(row.count),
      }
    }
    return out
  }

  const breakdownCols = {
    inputTokens: sql<number>`sum(${schema.agentUsage.inputTokens})`,
    outputTokens: sql<number>`sum(${schema.agentUsage.outputTokens})`,
    costUsd: sql<number>`sum(${schema.agentUsage.costUsd})`,
    count: sql<number>`count(*)`,
  }
  // Older rows (pre-0013) have a null provider — bucket them as 'unknown'.
  const providerExpr = sql<string>`coalesce(${schema.agentUsage.provider}, 'unknown')`
  const monthExpr = sql<string>`strftime('%Y-%m', ${schema.agentUsage.createdAt}, 'unixepoch')`

  try {
    // All six aggregates are independent scans of the same table — run concurrently.
    const [totalsRow, byAgentRows, byProviderRows, byModelRows, byMonthRows, runRows] = await Promise.all([
      db
        .select({
          totalInputTokens: sql<number>`coalesce(sum(${schema.agentUsage.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`coalesce(sum(${schema.agentUsage.outputTokens}), 0)`,
          totalCostUsd: sql<number>`coalesce(sum(${schema.agentUsage.costUsd}), 0)`,
          totalApiCalls: sql<number>`coalesce(sum(${schema.agentUsage.apiCalls}), 0)`,
          totalToolCalls: sql<number>`coalesce(sum(${schema.agentUsage.toolCalls}), 0)`,
          // sum() skips NULLs, so an unreported cache column contributes nothing
          // rather than a fabricated 0 (#407 writes NULL, never 0). count(col)
          // likewise counts only NON-NULL rows — that is the honest denominator.
          totalCacheCreationTokens: sql<number>`coalesce(sum(${schema.agentUsage.cacheCreationTokens}), 0)`,
          totalCacheReadTokens: sql<number>`coalesce(sum(${schema.agentUsage.cacheReadTokens}), 0)`,
          cacheReportingRuns: sql<number>`count(${schema.agentUsage.cacheReadTokens})`,
          totalRuns: sql<number>`count(*)`,
          errorRuns: sql<number>`coalesce(sum(case when ${schema.agentUsage.outcome} = 'error' then 1 else 0 end), 0)`,
        })
        .from(schema.agentUsage)
        .where(where),
      db
        .select({ key: schema.agentUsage.agentType, ...breakdownCols })
        .from(schema.agentUsage)
        .where(where)
        .groupBy(schema.agentUsage.agentType),
      db
        .select({ key: providerExpr, ...breakdownCols })
        .from(schema.agentUsage)
        .where(where)
        .groupBy(providerExpr),
      db
        .select({ key: schema.agentUsage.modelId, ...breakdownCols })
        .from(schema.agentUsage)
        .where(where)
        .groupBy(schema.agentUsage.modelId),
      db
        .select({ month: monthExpr, ...breakdownCols })
        .from(schema.agentUsage)
        .where(where)
        .groupBy(monthExpr)
        .orderBy(sql`${monthExpr} desc`),
      db
        .select({
          runId: schema.agentUsage.runId,
          parentRunId: schema.agentUsage.parentRunId,
          agentType: schema.agentUsage.agentType,
          costUsd: sql<number>`sum(${schema.agentUsage.costUsd})`,
          // Error-aware, not lexical max(): if any row in the run errored, the run
          // is 'error' (lexical max would pick 'success' since s > e, masking it).
          outcome: sql<string | null>`case
            when max(case when ${schema.agentUsage.outcome} = 'error' then 1 else 0 end) = 1 then 'error'
            when max(case when ${schema.agentUsage.outcome} = 'success' then 1 else 0 end) = 1 then 'success'
            else null end`,
          durationMs: sql<number>`sum(${schema.agentUsage.durationMs})`,
          lastAt: sql<number>`max(${schema.agentUsage.createdAt})`,
        })
        .from(schema.agentUsage)
        .where(where)
        .groupBy(schema.agentUsage.runId, schema.agentUsage.parentRunId, schema.agentUsage.agentType)
        .orderBy(sql`max(${schema.agentUsage.createdAt}) desc`)
        .limit(100),
    ])

    const t = totalsRow[0] ?? ({} as (typeof totalsRow)[number])

    return {
      totalInputTokens: Number(t.totalInputTokens ?? 0),
      totalOutputTokens: Number(t.totalOutputTokens ?? 0),
      totalCostUsd: Number(t.totalCostUsd ?? 0),
      totalApiCalls: Number(t.totalApiCalls ?? 0),
      totalToolCalls: Number(t.totalToolCalls ?? 0),
      totalCacheCreationTokens: Number(t.totalCacheCreationTokens ?? 0),
      totalCacheReadTokens: Number(t.totalCacheReadTokens ?? 0),
      cacheReportingRuns: Number(t.cacheReportingRuns ?? 0),
      totalRuns: Number(t.totalRuns ?? 0),
      errorRuns: Number(t.errorRuns ?? 0),
      byAgent: toRecord(byAgentRows),
      byProvider: toRecord(byProviderRows),
      byModel: toRecord(byModelRows),
      byMonth: byMonthRows.map((row) => ({
        month: row.month,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costUsd: Number(row.costUsd),
        count: Number(row.count),
      })),
      runs: runRows
        .filter((r) => r.runId)
        .map((r) => ({
          runId: r.runId as string,
          parentRunId: r.parentRunId ?? null,
          agentType: r.agentType,
          costUsd: Number(r.costUsd),
          outcome: r.outcome ?? null,
          durationMs: Number(r.durationMs),
        })),
    }
  } catch (e) {
    log.error('getAgentUsageSummary failed (table may not exist)', { error: e })
    return empty
  }
}
