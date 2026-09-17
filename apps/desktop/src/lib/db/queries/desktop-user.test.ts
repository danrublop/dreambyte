// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cench-desktop-user-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { users, permissionRules } from '../schema'
import { eq } from 'drizzle-orm'
import { getDesktopUserId, DESKTOP_USER_ID } from './desktop-user'
import { createRule, listRulesForUser } from './permission-rules'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('getDesktopUserId', () => {
  it('seeds exactly one desktop user row and is idempotent', async () => {
    const a = await getDesktopUserId()
    const b = await getDesktopUserId()
    expect(a).toBe(DESKTOP_USER_ID)
    expect(b).toBe(DESKTOP_USER_ID)
    const rows = await db.select().from(users).where(eq(users.id, DESKTOP_USER_ID))
    expect(rows).toHaveLength(1) // not duplicated across calls
    expect(rows[0].email).toBeTruthy()
  })

  it('the seeded user satisfies the permission_rules FK (a rule can be created + listed under it)', async () => {
    const userId = await getDesktopUserId()
    const rule = await createRule({ userId, scope: 'user', decision: 'allow', api: 'veo3' })
    expect(rule.userId).toBe(DESKTOP_USER_ID)
    const listed = await listRulesForUser(userId)
    expect(listed.some((r) => r.id === rule.id)).toBe(true)
    // cleanup so the row doesn't leak into other assertions on this shared db
    await db.delete(permissionRules).where(eq(permissionRules.id, rule.id))
  })
})
