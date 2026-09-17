// @vitest-environment node

/**
 * getProjectScenesLight: the light scene read the agent path uses (no
 * layers/media/interactions/sceneEdges joins — neither agent consumer reads them).
 *
 * The load-bearing contract: the returned object is the sceneBlob with `id`
 * and `branchId` stamped from the TABLE columns. mergeServerScenes' branch
 * scoping reads `scene.branchId`; the blob is the renderer's Scene object and
 * may predate branch stamping or carry a stale copy — if the table column
 * didn't win, every row would read as null-branch and the merge would
 * silently degrade to "all → default", leaking scenes into non-default runs.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-scenes-light-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, scenes } from '../schema'
import { getProjectScenesLight } from './projects'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedProject(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `Light Test ${id.slice(0, 6)}` })
  return id
}

describe('getProjectScenesLight', () => {
  it('returns [] for a project with no scenes (and for an unknown project)', async () => {
    const projectId = await seedProject()
    expect(await getProjectScenesLight(projectId)).toEqual([])
    expect(await getProjectScenesLight('no-such-project')).toEqual([])
  })

  it('returns blob contents ordered by position, all branches', async () => {
    const projectId = await seedProject()
    const b1 = crypto.randomUUID()
    const b2 = crypto.randomUUID()
    await db.insert(scenes).values([
      {
        id: b2,
        projectId,
        branchId: 'branch-x',
        position: 1,
        duration: 8,
        sceneBlob: { id: b2, name: 'second', sceneCode: 'code-2' },
      },
      {
        id: b1,
        projectId,
        branchId: 'branch-default',
        position: 0,
        duration: 8,
        sceneBlob: { id: b1, name: 'first', sceneCode: 'code-1' },
      },
    ])
    const out = await getProjectScenesLight(projectId)
    expect(out.map((s) => s.name)).toEqual(['first', 'second']) // position order
    expect(out.map((s) => s.branchId)).toEqual(['branch-default', 'branch-x']) // both branches
    expect(out[0].sceneCode).toBe('code-1') // code fields ride along from the blob
  })

  it("stamps the TABLE's id/branchId over the blob's (stale blob copies must not win)", async () => {
    const projectId = await seedProject()
    const rowId = crypto.randomUUID()
    await db.insert(scenes).values({
      id: rowId,
      projectId,
      branchId: 'branch-current',
      position: 0,
      duration: 8,
      // Blob carries a STALE branchId (renderer snapshot from before a branch
      // move) and a mismatched id — the table columns are authoritative.
      sceneBlob: { id: 'stale-id', branchId: 'branch-stale', name: 'scene' },
    })
    const [out] = await getProjectScenesLight(projectId)
    expect(out.id).toBe(rowId)
    expect(out.branchId).toBe('branch-current')
  })

  it('a row with no blob still yields id + branchId (null branch stays null)', async () => {
    const projectId = await seedProject()
    const rowId = crypto.randomUUID()
    await db.insert(scenes).values({ id: rowId, projectId, position: 0, duration: 8 })
    const [out] = await getProjectScenesLight(projectId)
    expect(out.id).toBe(rowId)
    expect(out.branchId).toBeNull()
  })

  it('a NON-object blob (legacy string/number JSON) degrades to id + branchId, not spread characters', async () => {
    const projectId = await seedProject()
    const rowId = crypto.randomUUID()
    // mode:'json' columns JSON.parse on read — a legacy/hand-written row can
    // hold a bare JSON string, which parses to a non-object.
    await db.insert(scenes).values({
      id: rowId,
      projectId,
      position: 0,
      duration: 8,
      sceneBlob: 'not-an-object' as unknown as Record<string, unknown>,
    })
    const [out] = await getProjectScenesLight(projectId)
    expect(out).toEqual({ id: rowId, branchId: null })
  })

  it('drops an own __proto__ key a hostile blob smuggled in (defense-in-depth)', async () => {
    const projectId = await seedProject()
    const rowId = crypto.randomUUID()
    // Insert raw JSON text so the stored blob carries a literal "__proto__"
    // key (JSON.parse yields it as an OWN property, never chain pollution).
    await db.run(
      `INSERT INTO scenes (id, project_id, position, duration, scene_blob) VALUES ('${rowId}', '${projectId}', 0, 8, '{"__proto__":{"polluted":1},"name":"x"}')`,
    )
    const [out] = await getProjectScenesLight(projectId)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false)
    expect(out.name).toBe('x')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
