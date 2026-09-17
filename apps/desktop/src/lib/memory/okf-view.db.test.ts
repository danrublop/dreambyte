// @vitest-environment node
//
// D3 — memory/ OKF export view, SQLite integration (T10). Proves the END-TO-END
// one-way VIEW: user_memory rows → a valid OKF bundle, and that SQLite stays
// authoritative (generation never writes back to the table).
//
// $HOME → tmp (bundle writes isolated) AND DATABASE_URL → a tmp file DB (set
// BEFORE importing src/lib/db, mirroring user-memory.scope.test.ts).

import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const homeDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-memory-okf-db-home-'))
process.env.HOME = homeDir
process.env.USERPROFILE = homeDir

const dbDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-memory-okf-db-'))
const tmpDb = path.join(dbDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../db/migrate'
import { db, closeDb } from '../db'
import { users, workspaces, projects, userMemory } from '../db/schema'
import { eq } from 'drizzle-orm'
import { upsertMemory } from '../db/queries/user-memory'
import { generateMemoryOkfView, getMemoryBundleDir } from './okf-view'

const migrationsFolder = path.resolve(__dirname, '../db/migrations')

const USER = '00000000-0000-4000-8000-0000000000d3'
const EMPTY_USER = '00000000-0000-4000-8000-0000000000ee'
let WORKSPACE_ID = ''
let PROJECT_ID = ''

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  await db.insert(users).values({ id: USER, email: 'memory-okf@dreambyte.local', name: 'Memory OKF' })
  await db.insert(users).values({ id: EMPTY_USER, email: 'empty-okf@dreambyte.local', name: 'Empty OKF' })

  WORKSPACE_ID = crypto.randomUUID()
  await db.insert(workspaces).values({ id: WORKSPACE_ID, userId: USER, name: 'WS', brandKit: null, globalStyle: null })
  PROJECT_ID = crypto.randomUUID()
  await db.insert(projects).values({ id: PROJECT_ID, userId: USER, workspaceId: WORKSPACE_ID, name: 'Proj' })

  // user-global + project-scoped memory.
  await upsertMemory(USER, 'style', 'bg', 'dark', 0.9, undefined, null)
  await upsertMemory(USER, 'workflow', 'tempo', 'fast', 0.5, undefined, null)
  await upsertMemory(USER, 'style', 'pacing', 'snappy', 0.6, undefined, PROJECT_ID)
})

afterAll(async () => {
  await closeDb()
  rmSync(dbDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

describe('generateMemoryOkfView (SQLite → bundle)', () => {
  it('user-global rows → a valid bundle of concept files + index.md', async () => {
    const res = await generateMemoryOkfView(USER)
    expect(res.dir.startsWith(homeDir)).toBe(true)
    expect(res.conceptCount).toBe(2) // bg + tempo (user-global only, no project row)

    const files = readdirSync(res.dir).sort()
    expect(files).toContain('index.md')
    expect(files).toContain('style__bg.md')
    expect(files).toContain('workflow__tempo.md')
    expect(files).not.toContain('style__pacing.md') // project-scoped, not in user-global view

    const bg = readFileSync(path.join(res.dir, 'style__bg.md'), 'utf-8')
    expect(bg).toContain('dark')
    expect(bg).toContain('type: preference')
    expect(bg).toContain('scope: user')
  })

  it('scoped view (projectId) surfaces the project-scoped row', async () => {
    const res = await generateMemoryOkfView(USER, { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID })
    const files = readdirSync(res.dir)
    expect(files).toContain('style__pacing.md')
    const pacing = readFileSync(path.join(getMemoryBundleDir(), 'style__pacing.md'), 'utf-8')
    expect(pacing).toContain('scope: project')
    expect(pacing).toContain('snappy')
  })

  it('empty memory → valid empty bundle (index.md only, no throw)', async () => {
    const res = await generateMemoryOkfView(EMPTY_USER)
    expect(res.conceptCount).toBe(0)
    expect(readdirSync(res.dir)).toEqual(['index.md'])
  })

  it('is a READ-ONLY view: SQLite is unchanged after generation', async () => {
    const before = await db.select().from(userMemory).where(eq(userMemory.userId, USER))
    await generateMemoryOkfView(USER)
    await generateMemoryOkfView(USER, { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID })
    const after = await db.select().from(userMemory).where(eq(userMemory.userId, USER))
    // Same row count + same (key → value) map: generation never wrote back.
    expect(after.length).toBe(before.length)
    const map = (rows: typeof after) =>
      Object.fromEntries(rows.map((r) => [`${r.category}:${r.key}:${r.projectId ?? ''}`, r.value]))
    expect(map(after)).toEqual(map(before))
  })

  it('regenerate is idempotent (no duplicate files)', async () => {
    await generateMemoryOkfView(USER)
    const first = readdirSync(getMemoryBundleDir()).sort()
    await generateMemoryOkfView(USER)
    const second = readdirSync(getMemoryBundleDir()).sort()
    expect(second).toEqual(first)
  })
})
