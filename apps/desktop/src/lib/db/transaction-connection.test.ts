import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'

/**
 * The check behind src/lib/db/index.ts installSingleConnectionTransactions().
 *
 * Unfixed, @libsql/client's local-file `transaction()` does `this.#db = null`
 * and never closes the handle it gave the transaction. Measured on the pinned
 * version: `busy_timeout` 5000 → 0 after the FIRST transaction, and +2 open fds
 * per transaction, strictly linear with no GC reclaim (600 tx → 1202 fds).
 * busy_timeout is the one that causes damage — heartbeatRunLease then takes
 * SQLITE_BUSY, the run lease is stolen mid-run, and the run's scenes are lost.
 *
 * Both assertions below fail if that regression comes back.
 */
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-tx-')), 'test.db')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${dbFile}`
  db = (await import('./index')).db
  await db.run(sql`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
})

afterAll(async () => {
  const { closeDb } = await import('./index')
  await closeDb()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
})

/** Open fds for this process. /dev/fd exists on macOS and Linux alike. */
function openFdCount(): number {
  return fs.readdirSync('/dev/fd').length
}

describe('db.transaction keeps one pragma-configured connection', () => {
  it('busy_timeout survives a transaction', async () => {
    const before = await db.get(sql`PRAGMA busy_timeout`)
    expect(Number(before.timeout)).toBe(5000)

    await db.transaction(async (tx: typeof db) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('a')`)
    })

    // This is the assertion that matters: unfixed, it reads 0 here.
    const after = await db.get(sql`PRAGMA busy_timeout`)
    expect(Number(after.timeout)).toBe(5000)
  })

  it('does not leak a file handle per transaction', async () => {
    // Warm up so lazily-opened fds (wal/shm sidecars) are not counted as growth.
    await db.transaction(async (tx: typeof db) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('warmup')`)
    })
    const before = openFdCount()
    for (let i = 0; i < 50; i++) {
      await db.transaction(async (tx: typeof db) => {
        await tx.run(sql`INSERT INTO t (v) VALUES ('x')`)
      })
    }
    // Unfixed this is +100 (2 per transaction, no GC reclaim). Allow a small
    // slack for unrelated fds the test runner may open concurrently.
    expect(openFdCount() - before).toBeLessThan(10)
  })

  it('commits and rolls back correctly, including a transaction opened inside one', async () => {
    await db.run(sql`DELETE FROM t`)

    await db.transaction(async (tx: typeof db) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('outer')`)
      // Nested via the GLOBAL db handle — the deadlock case the AsyncLocalStorage
      // context turns into a SAVEPOINT.
      await db.transaction(async (inner: typeof db) => {
        await inner.run(sql`INSERT INTO t (v) VALUES ('inner')`)
      })
    })
    expect(Number((await db.get(sql`SELECT count(*) AS n FROM t`)).n)).toBe(2)

    await expect(
      db.transaction(async (tx: typeof db) => {
        await tx.run(sql`INSERT INTO t (v) VALUES ('doomed')`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(Number((await db.get(sql`SELECT count(*) AS n FROM t`)).n)).toBe(2)
  })

  it('serializes concurrent transactions instead of racing to SQLITE_BUSY', async () => {
    await db.run(sql`DELETE FROM t`)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.transaction(async (tx: typeof db) => {
          await tx.run(sql`INSERT INTO t (v) VALUES (${`c${i}`})`)
        }),
      ),
    )
    expect(Number((await db.get(sql`SELECT count(*) AS n FROM t`)).n)).toBe(20)
  })
})
