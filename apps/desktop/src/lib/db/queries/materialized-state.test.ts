// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { createClient } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

import { runMigrations } from '@/lib/db/migrate'

let dbDir: string
let dbPath: string

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-mat-state-'))
  dbPath = path.join(dbDir, 'dreambyte.db')
  process.env.DATABASE_URL = `file:${dbPath}`
  await runMigrations({
    url: `file:${dbPath}`,
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  })
})

let queries: typeof import('./materialized-state')
beforeAll(async () => {
  queries = await import('./materialized-state')
})

const projectId = '00000000-0000-4000-8000-000000000077'

beforeEach(async () => {
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute({
    sql: `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`,
    args: [projectId, 'mat-test'],
  })
  // Wipe snapshots between tests so each one starts clean.
  await client.execute({ sql: `DELETE FROM materialized_state WHERE project_id = ?`, args: [projectId] })
  await client.close()
})
afterEach(async () => {})

describe('materialized_state queries', () => {
  it('returns null when no snapshot exists for (project, branch)', async () => {
    expect(await queries.readLatestSnapshot(projectId)).toBeNull()
    expect(await queries.readLatestSnapshot(projectId, 'branch-x')).toBeNull()
  })

  it('writeSnapshot → readLatestSnapshot round-trip', async () => {
    await queries.writeSnapshot({
      projectId,
      lastActionId: 'a-100',
      state: { scenes: [], counter: 1 },
      createdAt: 1000,
    })
    const snap = await queries.readLatestSnapshot(projectId)
    expect(snap).not.toBeNull()
    expect(snap!.lastActionId).toBe('a-100')
    expect(snap!.state).toEqual({ scenes: [], counter: 1 })
    expect(snap!.createdAt).toBe(1000)
    expect(snap!.branchId).toBeNull()
  })

  it('upserts when the same (project, branch) is written twice', async () => {
    await queries.writeSnapshot({ projectId, lastActionId: 'a-1', state: { v: 1 }, createdAt: 1 })
    await queries.writeSnapshot({ projectId, lastActionId: 'a-2', state: { v: 2 }, createdAt: 2 })
    const snap = await queries.readLatestSnapshot(projectId)
    expect(snap!.lastActionId).toBe('a-2')
    expect(snap!.state).toEqual({ v: 2 })
    expect(snap!.createdAt).toBe(2)
  })

  it('isolates branches: null branch + named branch are distinct rows', async () => {
    await queries.writeSnapshot({ projectId, branchId: null, lastActionId: 'main-1', state: { branch: 'main' } })
    await queries.writeSnapshot({ projectId, branchId: 'feat-1', lastActionId: 'feat-99', state: { branch: 'feat' } })
    const main = await queries.readLatestSnapshot(projectId)
    const feat = await queries.readLatestSnapshot(projectId, 'feat-1')
    expect(main!.state).toEqual({ branch: 'main' })
    expect(feat!.state).toEqual({ branch: 'feat' })
    expect(main!.branchId).toBeNull()
    expect(feat!.branchId).toBe('feat-1')
  })

  it('null lastActionId is allowed (e.g. seed snapshot before any actions)', async () => {
    await queries.writeSnapshot({ projectId, lastActionId: null, state: { seed: true } })
    const snap = await queries.readLatestSnapshot(projectId)
    expect(snap!.lastActionId).toBeNull()
    expect(snap!.state).toEqual({ seed: true })
  })
})
