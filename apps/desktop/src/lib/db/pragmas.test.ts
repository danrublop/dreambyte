// @vitest-environment node

// Pins the SQLite connection pragmas the multi-process branch_locks design
// depends on: WAL journaling + a 5s busy_timeout on local file: DBs. Without
// these, concurrent lock acquire/heartbeat/restore across two Electron
// instances throw SQLITE_BUSY instead of serializing (branch-card finding #3),
// and a regression here would be silent — the init path swallows pragma
// failures with log.warn.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-pragmas-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, describe, expect, it } from 'vitest'
import { db, closeDb } from './index'

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SQLite init pragmas (file: URLs)', () => {
  it('enables WAL + 5s busy_timeout on the persistent connection', async () => {
    // The init pragmas are queued fire-and-forget on the persistent libsql
    // connection; statements serialize, so querying the pragmas here lands
    // strictly after the init statements — no sleep needed.
    const client = (db as unknown as { $client: { execute(sql: string): Promise<{ rows: Record<string, unknown>[] }> } })
      .$client

    const jm = await client.execute('PRAGMA journal_mode')
    expect(String(jm.rows[0]?.journal_mode).toLowerCase()).toBe('wal')

    const bt = await client.execute('PRAGMA busy_timeout')
    expect(Number(bt.rows[0]?.timeout ?? bt.rows[0]?.busy_timeout)).toBe(5000)
  })
})
