// @vitest-environment node
//
// T2 — confidence DB ops + decay (PR-B). Proves:
//   - adjustMemoryKeyConfidence moves ONLY the named key (per-key attribution)
//   - confidence clamps to [0,1]
//   - scope-correct: a project-key adjust leaves the user-global row untouched
//   - decay ×0.95 floors + prunes rows < 0.05, never moving unrelated users

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-user-memory-conf-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { users, projects } from '../schema'
import {
  upsertMemory,
  getMemoriesForUser,
  getMemoriesScoped,
  adjustMemoryKeyConfidence,
  decayMemories,
  shouldRunDailyDecay,
} from './user-memory'

describe('shouldRunDailyDecay (INFO-8 multi-instance guard)', () => {
  it('runs when never decayed before', () => {
    expect(shouldRunDailyDecay(null, '2026-06-17')).toBe(true)
  })
  it('runs on a new day', () => {
    expect(shouldRunDailyDecay('2026-06-16', '2026-06-17')).toBe(true)
  })
  it('skips when already decayed today (2nd window same day)', () => {
    expect(shouldRunDailyDecay('2026-06-17', '2026-06-17')).toBe(false)
  })
})

const migrationsFolder = path.resolve(__dirname, '../migrations')
const USER = '00000000-0000-4000-8000-0000000000a1'
let PROJECT = ''

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  await db.insert(users).values({ id: USER, email: 'conf-test@dreambyte.local', name: 'Conf Test' })
  PROJECT = crypto.randomUUID()
  await db.insert(projects).values({ id: PROJECT, userId: USER, name: 'Conf Proj' })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('adjustMemoryKeyConfidence (T2 per-key)', () => {
  it('moves ONLY the named key, leaving siblings untouched', async () => {
    await upsertMemory(USER, 'style', 'bg', 'dark', 0.5, undefined, null)
    await upsertMemory(USER, 'style', 'palette', 'warm', 0.5, undefined, null)
    await upsertMemory(USER, 'content', 'audience', 'students', 0.5, undefined, null)

    const moved = await adjustMemoryKeyConfidence(USER, 'style', 'bg', -0.1, null)
    expect(moved).toBe(1)

    const rows = await getMemoriesForUser(USER)
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.confidence]))
    expect(byKey['bg']).toBeCloseTo(0.4, 5)
    // unrelated keys NOT moved — the attribution guarantee
    expect(byKey['palette']).toBeCloseTo(0.5, 5)
    expect(byKey['audience']).toBeCloseTo(0.5, 5)
  })

  it('clamps to [0,1]', async () => {
    await upsertMemory(USER, 'style', 'hi', 'x', 0.95, undefined, null)
    await upsertMemory(USER, 'style', 'lo', 'y', 0.07, undefined, null)
    await adjustMemoryKeyConfidence(USER, 'style', 'hi', 0.5, null)
    await adjustMemoryKeyConfidence(USER, 'style', 'lo', -0.5, null)
    const rows = await getMemoriesForUser(USER)
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.confidence]))
    expect(byKey['hi']).toBeCloseTo(1.0, 5)
    // lo clamps to 0 (still a row; only decay prunes < 0.05). getMemoriesForUser
    // filters < 0.1, so the clamped-to-0 row is hidden from this list.
    expect(rows.find((r) => r.key === 'lo')).toBeUndefined()
  })

  it('scope-correct: project-key adjust leaves the user-global row untouched', async () => {
    await upsertMemory(USER, 'workflow', 'tempo', 'fast', 0.5, undefined, null)
    await upsertMemory(USER, 'workflow', 'tempo', 'slow', 0.5, undefined, PROJECT)

    await adjustMemoryKeyConfidence(USER, 'workflow', 'tempo', 0.2, PROJECT)

    const scopedProj = await getMemoriesScoped(USER, PROJECT)
    const scopedGlobal = await getMemoriesScoped(USER, null)
    expect(scopedProj.find((m) => m.key === 'tempo')?.confidence).toBeCloseTo(0.7, 5)
    expect(scopedGlobal.find((m) => m.key === 'tempo')?.confidence).toBeCloseTo(0.5, 5)
  })

  it('returns 0 when the key/scope has no row (honest no-op)', async () => {
    const moved = await adjustMemoryKeyConfidence(USER, 'style', 'does_not_exist', 0.1, null)
    expect(moved).toBe(0)
  })
})

describe('decayMemories (T2)', () => {
  it('multiplies by 0.95 and prunes rows below 0.05', async () => {
    const U2 = '00000000-0000-4000-8000-0000000000a2'
    await db.insert(users).values({ id: U2, email: 'decay@dreambyte.local', name: 'Decay' })
    await upsertMemory(U2, 'style', 'keep', 'v', 0.8, undefined, null)
    await upsertMemory(U2, 'style', 'prune', 'v', 0.05, undefined, null) // 0.05*0.95 = 0.0475 < 0.05

    await decayMemories(U2, 0.95)

    // Read raw (getMemoriesForUser filters < 0.1, so query the table directly).
    const { db: rawDb } = await import('../index')
    const { userMemory } = await import('../schema')
    const { eq } = await import('drizzle-orm')
    const rows = await rawDb.select().from(userMemory).where(eq(userMemory.userId, U2))
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.confidence]))
    expect(byKey['keep']).toBeCloseTo(0.76, 5)
    expect(byKey['prune']).toBeUndefined() // pruned

    // USER's rows are untouched by U2's decay (no cross-user move).
    const userRows = await getMemoriesForUser(USER)
    expect(userRows.length).toBeGreaterThan(0)
  })
})
