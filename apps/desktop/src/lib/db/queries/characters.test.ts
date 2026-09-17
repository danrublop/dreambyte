// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-characters-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { closeDb, db } from '../index'
import { projects } from '../schema'
import {
  createCharacter,
  getCharacter,
  resolveCharacter,
  listCharacters,
  setCharacterReferences,
  adoptReferenceIfEmpty,
} from './characters'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  // characters.project_id has a FK to projects — seed the parent rows (FKs are enforced here).
  await db.insert(projects).values([
    { id: 'p1', name: 'Project 1' },
    { id: 'p2', name: 'Project 2' },
  ])
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('character bundle queries (T12 — confirms 0020 migration + round-trip)', () => {
  it('creates and reads back a character with its identity levers', async () => {
    const c = await createCharacter({
      projectId: 'p1',
      name: 'Aria',
      description: 'red hair, freckles, green jacket',
      referenceAssetIds: ['asset-1'],
      seed: 42,
      model: 'flux-1.1-pro',
      strength: 0.6,
    })
    const fetched = await getCharacter('p1', c.id)
    expect(fetched?.name).toBe('Aria')
    expect(fetched?.seed).toBe(42)
    expect(fetched?.model).toBe('flux-1.1-pro')
    expect(fetched?.strength).toBe(0.6)
    expect(fetched?.referenceAssetIds).toEqual(['asset-1'])
  })

  it('resolves by case-insensitive name as well as id', async () => {
    const c = await createCharacter({ projectId: 'p1', name: 'Bolt' })
    expect((await resolveCharacter('p1', 'bolt'))?.id).toBe(c.id)
    expect((await resolveCharacter('p1', c.id))?.id).toBe(c.id)
    expect(await resolveCharacter('p1', 'nobody')).toBeNull()
  })

  it('scopes lookups to the project (no cross-project leakage)', async () => {
    await createCharacter({ projectId: 'p2', name: 'Aria' })
    const p1 = await listCharacters('p1')
    expect(p1.every((r) => r.projectId === 'p1')).toBe(true)
    // 'Aria' in p2 must not resolve from p1.
    const p1aria = await resolveCharacter('p1', 'Aria')
    expect(p1aria?.projectId).toBe('p1')
  })

  it('adopts a reference set after a first render', async () => {
    const c = await createCharacter({ projectId: 'p1', name: 'Nova' })
    expect(c.referenceAssetIds).toEqual([])
    await setCharacterReferences('p1', c.id, ['render-1'])
    expect((await getCharacter('p1', c.id))?.referenceAssetIds).toEqual(['render-1'])
  })

  it('rejects a duplicate name (case-insensitive) within a project — unique index (Codex P1)', async () => {
    await createCharacter({ projectId: 'p1', name: 'Dup' })
    await expect(createCharacter({ projectId: 'p1', name: 'dup' })).rejects.toThrow()
    // but the same name in a DIFFERENT project is fine
    await expect(createCharacter({ projectId: 'p2', name: 'Dup' })).resolves.toBeTruthy()
  })

  it('adoptReferenceIfEmpty only sets when still empty (concurrent-adopt guard, C2)', async () => {
    const c = await createCharacter({ projectId: 'p1', name: 'Cas' })
    await adoptReferenceIfEmpty('p1', c.id, 'first')
    expect((await getCharacter('p1', c.id))?.referenceAssetIds).toEqual(['first'])
    // second adopt is a no-op — the bundle already has a reference (compare-and-set)
    await adoptReferenceIfEmpty('p1', c.id, 'second')
    expect((await getCharacter('p1', c.id))?.referenceAssetIds).toEqual(['first'])
  })
})
