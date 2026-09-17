/**
 * Apply Drizzle SQLite migrations to the configured database.
 *
 * Used in two places:
 *   - `npm run db:migrate` (CLI, ad-hoc) — for dev / one-shot test runs.
 *   - `src/electron/main.ts` first-launch path — runs against
 *     `file:<userData>/dreambyte.db` so a fresh install boots with the full
 *     schema in place (no manual `drizzle-kit` step).
 *
 * Idempotent: Drizzle tracks applied migrations in `__drizzle_migrations`.
 * Safe to call on every launch.
 */
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { createClient, type Client } from '@libsql/client'

export interface RunMigrationsOptions {
  /** Connection URL. Falls back to process.env.DATABASE_URL. */
  url?: string
  /** Filesystem path to the migrations dir. Defaults to `<repoRoot>/drizzle/sqlite`. */
  migrationsFolder?: string
}

/**
 * libsql 0.5.x bug: the native binding's error callback fires with SQLITE_OK
 * (rawCode=0) for certain DDL statements even when the statement succeeds.
 * The @libsql/client wrapper treats this as an error (SQLITE_UNKNOWN_0).
 * We detect this pattern and treat it as success.
 */
function isSqliteOkFalsePositive(err: unknown): boolean {
  const e = err as Record<string, unknown>
  return e?.rawCode === 0 || (e?.cause as Record<string, unknown>)?.rawCode === 0
}

/** Execute a single SQL string, ignoring the libsql SQLITE_OK false positive. */
async function execIgnoreFalsePositive(client: Client, sql: string): Promise<void> {
  try {
    await client.execute(sql)
  } catch (err) {
    if (isSqliteOkFalsePositive(err)) return
    throw err
  }
}

/**
 * Re-running a partially-applied migration is only possible on THIS non-atomic
 * sequential fallback (the primary drizzle migrate() batches every migration into
 * one transaction, so a failure rolls back cleanly). On that re-run, DDL that
 * already took effect is re-issued. Swallow ONLY the matching "already in target
 * state" error, scoped to the statement kind, so a genuinely malformed migration
 * (e.g. a typo'd column in a CREATE/INSERT) is NOT masked:
 *   - ALTER ... DROP COLUMN  → "no such column"        (already dropped)
 *   - ALTER ... ADD COLUMN   → "duplicate column name" (already added)
 * This makes destructive migrations (e.g. 0015's column drops) re-runnable on the
 * fallback path instead of bricking on the second attempt.
 */
function isIdempotentDdlReapply(err: unknown, stmt: string): boolean {
  const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase()
  const s = stmt.toLowerCase()
  if (/alter\s+table[\s\S]*drop\s+column/.test(s) && msg.includes('no such column')) return true
  if (/alter\s+table[\s\S]*add\s+column/.test(s) && msg.includes('duplicate column name')) return true
  return false
}

/** Execute one statement in the sequential fallback, tolerating the libsql
 *  SQLITE_OK false positive AND idempotent DDL re-application on re-run. */
async function execSequentialStmt(client: Client, stmt: string): Promise<void> {
  try {
    await client.execute(stmt)
  } catch (err) {
    if (isSqliteOkFalsePositive(err) || isIdempotentDdlReapply(err, stmt)) return
    throw err
  }
}

/**
 * Sequential fallback for when Drizzle's batch migrator triggers the libsql
 * false-positive bug. Reads the journal and runs statements one at a time so
 * each can be individually swallowed if it returns SQLITE_OK via error path.
 */
async function runMigrationsSequential(client: Client, folder: string): Promise<void> {
  await execIgnoreFalsePositive(
    client,
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL,
       created_at NUMERIC
     )`,
  )

  let lastApplied = 0
  try {
    const result = await client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    const row = result.rows[0]
    if (row) lastApplied = Number((row as Record<string, unknown>).created_at ?? row[0] ?? 0)
  } catch {
    // Table was just created — no rows.
  }

  const journalPath = path.join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>
  }

  for (const entry of journal.entries) {
    if (entry.when <= lastApplied) continue

    const content = fs.readFileSync(path.join(folder, `${entry.tag}.sql`), 'utf-8')
    const statements = content
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    for (const stmt of statements) {
      await execSequentialStmt(client, stmt)
    }

    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const when = Number(entry.when)
    if (!Number.isFinite(when)) throw new Error(`Invalid migration timestamp for ${entry.tag}`)
    await execIgnoreFalsePositive(
      client,
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${when})`,
    )
  }
}

export async function runMigrations(opts: RunMigrationsOptions = {}): Promise<void> {
  const url = opts.url ?? process.env.DATABASE_URL
  if (!url) throw new Error('runMigrations: DATABASE_URL not set')
  const normalized = /^[a-z]+:/i.test(url) ? url : `file:${url}`

  // Resolve relative to this file. The CLI path (`tsx src/lib/db/migrate.ts`)
  // and the dev `npm run db:migrate` path both land here with a real
  // `__dirname`. The packaged Electron caller passes `migrationsFolder`
  // explicitly (it's bundled with esbuild, where __dirname is the
  // dist-electron output dir, not this file).
  const folder = opts.migrationsFolder ?? path.resolve(__dirname, 'migrations')

  const client = createClient({ url: normalized, authToken: process.env.DATABASE_AUTH_TOKEN })
  const db = drizzle(client)
  try {
    try {
      await migrate(db, { migrationsFolder: folder })
    } catch (err) {
      if (!isSqliteOkFalsePositive(err)) throw err
      // libsql 0.5.x false positive — fall back to sequential per-statement runner
      await runMigrationsSequential(client, folder)
    }
  } finally {
    await client.close()
  }
}

// Note: the CLI entry point lives in `scripts/db/migrate.ts`. We deliberately do
// NOT run a `if (require.main === module)` IIFE here, because esbuild hoists
// import side-effects to the top of the bundled output. When `src/electron/main.ts`
// imports this file, that IIFE would fire BEFORE main.ts's `DATABASE_URL`
// default kicks in, and the migration would crash with "DATABASE_URL not set".
// Keep this file pure — exports only.
