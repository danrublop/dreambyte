// @vitest-environment node
//
// T1 — memory scope + precedence (PR-B). Proves:
//   - projectId column + scoped unique index migration applies
//   - project memory overrides user-global on the same key
//   - workspace.brandKit/globalStyle slots BETWEEN project and user
//   - narrowest layer wins across all three layers
//   - a project-scoped row and a user-global row with the same (category,key)
//     coexist (scoped uniqueness), and each upserts independently

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-user-memory-scope-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { users, workspaces, projects } from '../schema'
import { getMemoriesScoped, getMemoriesForUser, upsertMemory } from './user-memory'

const migrationsFolder = path.resolve(__dirname, '../migrations')

const USER = '00000000-0000-4000-8000-000000000099'
let WORKSPACE_ID = ''
let PROJECT_ID = ''
let PROJECT_NO_WS = ''

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  await db.insert(users).values({ id: USER, email: 'scope-test@dreambyte.local', name: 'Scope Test' })

  WORKSPACE_ID = crypto.randomUUID()
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    userId: USER,
    name: 'WS',
    brandKit: {
      brandName: 'Acme',
      logoAssetIds: [],
      palette: ['#111111', '#222222'],
      fontPrimary: 'Inter',
      fontSecondary: null,
      guidelines: null,
    },
    globalStyle: null,
  })

  PROJECT_ID = crypto.randomUUID()
  await db.insert(projects).values({ id: PROJECT_ID, userId: USER, workspaceId: WORKSPACE_ID, name: 'Scoped Proj' })

  PROJECT_NO_WS = crypto.randomUUID()
  await db.insert(projects).values({ id: PROJECT_NO_WS, userId: USER, name: 'No-WS Proj' })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('getMemoriesScoped precedence (T1)', () => {
  it('project memory overrides user-global on the same key', async () => {
    // Same (category, key) at two scopes: a LOWER-confidence project row must
    // still beat a HIGHER-confidence user-global row (precedence by layer).
    await upsertMemory(USER, 'style', 'bg', 'dark', 0.9 /* global */, undefined, null)
    await upsertMemory(USER, 'style', 'bg', 'light', 0.4 /* project */, undefined, PROJECT_ID)

    const scoped = await getMemoriesScoped(USER, PROJECT_ID, { workspaceId: WORKSPACE_ID })
    const bg = scoped.find((m) => m.category === 'style' && m.key === 'bg')
    expect(bg?.value).toBe('light')
    expect(bg?.layer).toBe('project')

    // Both rows still exist independently: the user-global slot is untouched.
    const global = await getMemoriesForUser(USER)
    expect(global.find((m) => m.key === 'bg')?.value).toBe('dark')
  })

  it('workspace.brandKit slots BETWEEN project and user', async () => {
    // No project row for brand_name → workspace layer should win over any
    // user-global with the same key.
    await upsertMemory(USER, 'style', 'brand_name', 'OldUserName', 0.95, undefined, null)
    const scoped = await getMemoriesScoped(USER, PROJECT_ID, { workspaceId: WORKSPACE_ID })
    const brand = scoped.find((m) => m.key === 'brand_name')
    expect(brand?.value).toBe('Acme') // from workspace.brandKit, not the user row
    expect(brand?.layer).toBe('workspace')
  })

  it('narrowest layer wins across all three layers on one key', async () => {
    // user-global, workspace, and project all assert brand_name; project wins.
    await upsertMemory(USER, 'style', 'brand_name', 'ProjectBrand', 0.3, undefined, PROJECT_ID)
    const scoped = await getMemoriesScoped(USER, PROJECT_ID, { workspaceId: WORKSPACE_ID })
    const brand = scoped.find((m) => m.key === 'brand_name')
    expect(brand?.value).toBe('ProjectBrand')
    expect(brand?.layer).toBe('project')
  })

  it('derives the workspace layer from the project when no workspaceId passed', async () => {
    const scoped = await getMemoriesScoped(USER, PROJECT_ID) // resolves WS via project
    expect(scoped.some((m) => m.key === 'brand_palette' && m.layer === 'workspace')).toBe(true)
  })

  it('a project with no workspace yields only project+user layers', async () => {
    await upsertMemory(USER, 'content', 'audience', 'students', 0.6, undefined, PROJECT_NO_WS)
    const scoped = await getMemoriesScoped(USER, PROJECT_NO_WS)
    expect(scoped.some((m) => m.key === 'audience' && m.layer === 'project')).toBe(true)
    expect(scoped.some((m) => m.layer === 'workspace')).toBe(false)
  })

  it('projectId null behaves like user-global only', async () => {
    const scoped = await getMemoriesScoped(USER, null)
    // bg=dark is the global row; the project "light" row must NOT leak in.
    const bg = scoped.find((m) => m.key === 'bg')
    expect(bg?.value).toBe('dark')
    expect(bg?.layer).toBe('user')
  })

  it('scoped uniqueness: project + global rows on same key upsert independently', async () => {
    await upsertMemory(USER, 'workflow', 'tempo', 'fast', 0.5, undefined, null)
    await upsertMemory(USER, 'workflow', 'tempo', 'slow', 0.5, undefined, PROJECT_ID)
    // Update only the project row.
    await upsertMemory(USER, 'workflow', 'tempo', 'medium', 0.7, undefined, PROJECT_ID)

    const scopedProj = await getMemoriesScoped(USER, PROJECT_ID, { workspaceId: WORKSPACE_ID })
    expect(scopedProj.find((m) => m.key === 'tempo')?.value).toBe('medium')

    const scopedGlobal = await getMemoriesScoped(USER, null)
    expect(scopedGlobal.find((m) => m.key === 'tempo')?.value).toBe('fast') // global untouched
  })
})
