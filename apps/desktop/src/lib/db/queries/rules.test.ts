// @vitest-environment node

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createClient } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

import { runMigrations } from '@/lib/db/migrate'

/**
 * Round-trip tests for the `rules` table (behavior-guidance rules).
 *
 * Strategy mirrors action-log.test.ts: isolated SQLite file per suite, run the
 * project's migrations, point the queries module at it, assert CRUD + the
 * scope/enabled filtering that the agent prompt builder relies on.
 */

let dbPath: string
const projectId = '00000000-0000-4000-8000-000000000abc'

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-rules-'))
  dbPath = path.join(dbDir, 'dreambyte.db')
  process.env.DATABASE_URL = `file:${dbPath}`
  await runMigrations({
    url: `file:${dbPath}`,
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  })
})

let q: typeof import('./rules')
beforeAll(async () => {
  q = await import('./rules')
})

beforeEach(async () => {
  // Reset rows + ensure the FK target project exists for project-scope rules.
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute('DELETE FROM rules')
  await client.execute({ sql: `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`, args: [projectId, 'test'] })
  await client.close()
})

describe('rules queries', () => {
  it('creates a user rule and lists it under the user scope only', async () => {
    const created = await q.createRule({ scope: 'user', name: 'Tone', body: 'Be concise.' })
    expect(created.id).toBeTruthy()
    expect(created.scope).toBe('user')
    expect(created.projectId).toBeNull()

    const userRules = await q.listRules({ scope: 'user' })
    expect(userRules.map((r) => r.name)).toContain('Tone')

    const projRules = await q.listRules({ scope: 'project', projectId })
    expect(projRules).toHaveLength(0)
  })

  it('requires a projectId for project-scope rules', async () => {
    await expect(q.createRule({ scope: 'project', name: 'X', body: 'y' })).rejects.toThrow()
  })

  it('listActiveRules returns user + project rules (user first), excluding disabled', async () => {
    await q.createRule({ scope: 'project', projectId, name: 'ProjRule', body: 'project body' })
    await q.createRule({ scope: 'user', name: 'UserRule', body: 'user body' })
    const disabled = await q.createRule({ scope: 'user', name: 'OffRule', body: 'nope' })
    await q.updateRule(disabled.id, { enabled: false })

    const active = await q.listActiveRules(projectId)
    const names = active.map((r) => r.name)
    expect(names).toEqual(['UserRule', 'ProjRule']) // user first, disabled excluded
  })

  it('listActiveRules with no project returns only user rules', async () => {
    await q.createRule({ scope: 'project', projectId, name: 'ProjOnly', body: 'b' })
    await q.createRule({ scope: 'user', name: 'GlobalOnly', body: 'b' })
    const active = await q.listActiveRules(null)
    expect(active.map((r) => r.name)).toEqual(['GlobalOnly'])
  })

  it('updates and deletes a rule', async () => {
    const r = await q.createRule({ scope: 'user', name: 'Edit me', body: 'old' })
    const updated = await q.updateRule(r.id, { body: 'new', applyMode: 'glob', globPattern: 'src/**' })
    expect(updated?.body).toBe('new')
    expect(updated?.applyMode).toBe('glob')

    expect(await q.deleteRule(r.id)).toBe(true)
    expect(await q.listRules({ scope: 'user' })).toHaveLength(0)
    expect(await q.deleteRule(r.id)).toBe(false) // already gone
  })
})
