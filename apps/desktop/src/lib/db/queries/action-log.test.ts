// @vitest-environment node

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

import { runMigrations } from '@/lib/db/migrate'
import { fillBaseFields } from '@/lib/actions/executor'
import type { Action, ActionInput } from '@/lib/actions'

/**
 * Round-trip test for the action_log table (P1b).
 *
 * Strategy: spin up an isolated SQLite file per suite, run the project's
 * migrations against it, point the queries module at that DB, and assert
 * append → list behave correctly.
 */

let dbDir: string
let dbPath: string

async function freshDb() {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-action-log-'))
  dbPath = path.join(dbDir, 'dreambyte.db')
  process.env.DATABASE_URL = `file:${dbPath}`
  await runMigrations({
    url: `file:${dbPath}`,
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  })
}

beforeAll(async () => {
  await freshDb()
})

let queries: typeof import('./action-log')
beforeAll(async () => {
  queries = await import('./action-log')
})

const projectId = '00000000-0000-4000-8000-000000000001'

beforeEach(async () => {
  // Insert a placeholder project row so the FK on action_log.project_id holds.
  // We bypass Drizzle and use the raw client to keep the dependency surface
  // small (no need to import every relation just to satisfy the constraint).
  const client = createClient({ url: `file:${dbPath}` })
  const dbi = drizzle(client)
  await client.execute({
    sql: `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`,
    args: [projectId, 'test'],
  })
  await client.close()
  void dbi
})

function action(input: ActionInput, source: 'user' | 'agent' = 'user'): Action {
  return fillBaseFields(input, source)
}

describe('action_log queries', () => {
  it('appendActionRow + listActions round-trip', async () => {
    const a = action({
      type: 'scene/create',
      params: { sceneId: 'scene-rt-1', scene: { id: 'scene-rt-1' } as never },
    })
    await queries.appendActionRow(projectId, a)

    const rows = await queries.listActions(projectId)
    const found = rows.find((r) => r.id === a.id)
    expect(found).toBeDefined()
    expect(found!.type).toBe('scene/create')
    expect(found!.source).toBe('user')
    expect(found!.params).toMatchObject({ sceneId: 'scene-rt-1' })
  })

  it('appendActionRow is idempotent on duplicate id', async () => {
    const a = action({ type: 'scene/update', params: { sceneId: 's', patch: { name: 'a' } } })
    await queries.appendActionRow(projectId, a)
    await queries.appendActionRow(projectId, a)
    const rows = await queries.listActions(projectId)
    expect(rows.filter((r) => r.id === a.id).length).toBe(1)
  })

  it('appendActionRows skips already-existing ids and inserts the rest', async () => {
    const existing = action({ type: 'scene/update', params: { sceneId: 's2', patch: { name: 'pre' } } })
    await queries.appendActionRow(projectId, existing)

    const fresh = action({ type: 'scene/update', params: { sceneId: 's2', patch: { name: 'new' } } })
    await queries.appendActionRows(projectId, [existing, fresh])

    const rows = await queries.listActions(projectId)
    expect(rows.filter((r) => r.id === existing.id).length).toBe(1)
    expect(rows.find((r) => r.id === fresh.id)).toBeDefined()
  })

  it('listActions branchId semantics: null = main only, named = that branch, undefined = all', async () => {
    const mainAction = action({ type: 'scene/update', params: { sceneId: 'BR-main', patch: { name: 'm' } } })
    const featAction = action({ type: 'scene/update', params: { sceneId: 'BR-feat', patch: { name: 'f' } } })
    await queries.appendActionRow(projectId, mainAction, null)
    await queries.appendActionRow(projectId, featAction, 'branch-x')

    const onlyMain = await queries.listActions(projectId, { branchId: null })
    expect(onlyMain.find((r) => r.id === mainAction.id)).toBeDefined()
    expect(onlyMain.find((r) => r.id === featAction.id)).toBeUndefined()

    const onlyFeat = await queries.listActions(projectId, { branchId: 'branch-x' })
    expect(onlyFeat.find((r) => r.id === featAction.id)).toBeDefined()
    expect(onlyFeat.find((r) => r.id === mainAction.id)).toBeUndefined()

    const all = await queries.listActions(projectId)
    expect(all.find((r) => r.id === mainAction.id)).toBeDefined()
    expect(all.find((r) => r.id === featAction.id)).toBeDefined()
  })
})

describe('commit-SHA plumbing (P5-bridge)', () => {
  const sha1 = 'a'.repeat(40)
  const sha2 = 'b'.repeat(40)

  it('markPendingActionsWithCommit stamps only pending rows + returns the count', async () => {
    const a = action({ type: 'scene/update', params: { sceneId: 'p5-a', patch: { name: 'a' } } })
    const b = action({ type: 'scene/update', params: { sceneId: 'p5-a', patch: { name: 'b' } } })
    await queries.appendActionRow(projectId, a)
    await queries.appendActionRow(projectId, b)

    const stamped = await queries.markPendingActionsWithCommit(projectId, sha1)
    expect(stamped).toBeGreaterThanOrEqual(2)

    // Add a third post-stamp; only this one should be pending.
    const c = action({ type: 'scene/update', params: { sceneId: 'p5-a', patch: { name: 'c' } } })
    await queries.appendActionRow(projectId, c)

    const stampedAgain = await queries.markPendingActionsWithCommit(projectId, sha2)
    expect(stampedAgain).toBe(1)
  })

  it('listActionsByCommitShas filters to the listed commits', async () => {
    const justSha1 = await queries.listActionsByCommitShas(projectId, [sha1])
    const both = await queries.listActionsByCommitShas(projectId, [sha1, sha2])
    expect(both.length).toBeGreaterThanOrEqual(justSha1.length)
    // No overlap of ids when filtering by sha1 vs sha2 alone.
    const idsSha1 = new Set(justSha1.map((r) => r.id))
    const justSha2 = await queries.listActionsByCommitShas(projectId, [sha2])
    for (const r of justSha2) expect(idsSha1.has(r.id)).toBe(false)
  })

  it('listActionsByCommitShas with [null] returns the still-pending rows', async () => {
    // Drop a fresh pending action — un-stamped.
    const fresh = action({ type: 'scene/update', params: { sceneId: 'p5-pending', patch: { name: 'p' } } })
    await queries.appendActionRow(projectId, fresh)

    const pending = await queries.listActionsByCommitShas(projectId, [null])
    expect(pending.find((r) => r.id === fresh.id)).toBeDefined()
  })

  it('listActionsByCommitShas with a sha + null merges committed + pending in timestamp order', async () => {
    const mixed = await queries.listActionsByCommitShas(projectId, [sha1, null])
    expect(mixed.length).toBeGreaterThan(0)
    for (let i = 1; i < mixed.length; i++) {
      expect(mixed[i].timestamp).toBeGreaterThanOrEqual(mixed[i - 1].timestamp)
    }
  })

  it('listActionsByCommitShas with an empty array returns []', async () => {
    expect(await queries.listActionsByCommitShas(projectId, [])).toEqual([])
  })
})
