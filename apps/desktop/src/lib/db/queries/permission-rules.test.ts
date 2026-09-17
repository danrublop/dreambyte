// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-permrules-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { users, workspaces, projects, conversations } from '../schema'
import { createRule, findMatchingRules, purgeExpiredRules } from './permission-rules'

const migrationsFolder = path.resolve(__dirname, '../migrations')

// Shared fixtures: one user, two workspaces, a project inside WS_A and one
// outside any workspace. Seeded once; the rule round-trip tests below assert
// the WORKSPACES-PAGE.md scoping contract against this fixed topology.
let userId = ''
let wsA = ''
let wsB = ''
let projInA = ''
let projOutside = ''

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })

  userId = crypto.randomUUID()
  await db.insert(users).values({ id: userId, email: `perm-${userId.slice(0, 8)}@test.dev` })

  wsA = crypto.randomUUID()
  wsB = crypto.randomUUID()
  await db.insert(workspaces).values([
    { id: wsA, userId, name: 'Workspace A' },
    { id: wsB, userId, name: 'Workspace B' },
  ])

  projInA = crypto.randomUUID()
  projOutside = crypto.randomUUID()
  await db.insert(projects).values([
    { id: projInA, name: 'Project in A', workspaceId: wsA },
    { id: projOutside, name: 'Project outside' },
  ])
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('workspace-scoped rules (T3 fix round-trip)', () => {
  it('a workspace rule resolves for a project inside that workspace', async () => {
    const rule = await createRule({
      userId,
      scope: 'workspace',
      workspaceId: wsA,
      decision: 'deny',
      api: 'heygen',
    })
    expect(rule.scope).toBe('workspace')
    expect(rule.workspaceId).toBe(wsA)

    // Resolver is invoked with the resolved workspaceId of the project (this is
    // what agent-runner.ts passes after reading project.workspaceId).
    const matched = await findMatchingRules({
      userId,
      workspaceId: wsA,
      projectId: projInA,
      conversationId: null,
    })
    expect(matched.some((r) => r.id === rule.id)).toBe(true)
  })

  it('a workspace rule does NOT resolve for a different workspace', async () => {
    const rule = await createRule({
      userId,
      scope: 'workspace',
      workspaceId: wsA,
      decision: 'deny',
      api: 'veo3',
    })
    const matched = await findMatchingRules({
      userId,
      workspaceId: wsB,
      projectId: projInA,
      conversationId: null,
    })
    expect(matched.some((r) => r.id === rule.id)).toBe(false)
  })

  it('a workspace rule does NOT resolve for a project outside any workspace', async () => {
    const rule = await createRule({
      userId,
      scope: 'workspace',
      workspaceId: wsA,
      decision: 'deny',
      api: 'kling',
    })
    const matched = await findMatchingRules({
      userId,
      workspaceId: null,
      projectId: projOutside,
      conversationId: null,
    })
    expect(matched.some((r) => r.id === rule.id)).toBe(false)
  })

  it('rejects a workspace-scope rule with no workspaceId (the old null bug)', async () => {
    await expect(
      createRule({ userId, scope: 'workspace', workspaceId: null, decision: 'deny', api: 'runway' }),
    ).rejects.toThrow(/workspaceId/)
  })
})

describe('user- and project-scope regression (unchanged by T3)', () => {
  it('a user rule resolves regardless of workspace or project', async () => {
    const rule = await createRule({ userId, scope: 'user', decision: 'allow', api: '*' })

    const inWorkspace = await findMatchingRules({
      userId,
      workspaceId: wsA,
      projectId: projInA,
      conversationId: null,
    })
    const bare = await findMatchingRules({
      userId,
      workspaceId: null,
      projectId: null,
      conversationId: null,
    })
    expect(inWorkspace.some((r) => r.id === rule.id)).toBe(true)
    expect(bare.some((r) => r.id === rule.id)).toBe(true)
  })

  it('a project rule resolves only for its own project', async () => {
    const rule = await createRule({
      userId,
      scope: 'project',
      projectId: projInA,
      decision: 'ask',
      api: 'elevenLabs',
    })

    const ownProject = await findMatchingRules({
      userId,
      workspaceId: wsA,
      projectId: projInA,
      conversationId: null,
    })
    const otherProject = await findMatchingRules({
      userId,
      workspaceId: null,
      projectId: projOutside,
      conversationId: null,
    })
    expect(ownProject.some((r) => r.id === rule.id)).toBe(true)
    expect(otherProject.some((r) => r.id === rule.id)).toBe(false)
  })

  it('rejects a project-scope rule with no projectId', async () => {
    await expect(
      createRule({ userId, scope: 'project', projectId: null, decision: 'deny', api: 'imageGen' }),
    ).rejects.toThrow(/projectId/)
  })
})

// Security review F6: purgeExpiredRules used Postgres NOW(), which throws
// "no such function: NOW" on the SQLite/libsql backend. This exercises it
// against the real SQLite test DB — it must run and delete only expired rules.
describe('purgeExpiredRules (F6 — runs on SQLite)', () => {
  it('deletes expired session rules and leaves live ones', async () => {
    const convo = crypto.randomUUID()
    // conversationId is FK-constrained to conversations (now enforced by F5),
    // so seed a real conversation row first.
    await db.insert(conversations).values({ id: convo, projectId: projInA, title: 'purge-test' })
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60 * 60_000)
    const expired = await createRule({
      userId,
      scope: 'session',
      conversationId: convo,
      decision: 'allow',
      api: 'heygen',
      expiresAt: past,
    })
    const live = await createRule({
      userId,
      scope: 'session',
      conversationId: convo,
      decision: 'allow',
      api: 'veo3',
      expiresAt: future,
    })

    const deleted = await purgeExpiredRules()
    expect(deleted).toBeGreaterThanOrEqual(1)

    const remaining = await findMatchingRules({ userId, workspaceId: null, projectId: null, conversationId: convo })
    expect(remaining.some((r) => r.id === expired.id)).toBe(false)
    expect(remaining.some((r) => r.id === live.id)).toBe(true)
  })
})
