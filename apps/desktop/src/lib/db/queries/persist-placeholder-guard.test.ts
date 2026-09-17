// @vitest-environment node
//
// A0 (T1) persist-side hard guard: persistScenesFromAgentRun must refuse to
// overwrite a scene's real DB code with a `[<n> chars]` placeholder.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-persist-guard-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db/index'
import { projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { persistScenesFromAgentRun } from './projects'
import { getOrCreateDefaultBranch } from './branches'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'

const migrationsFolder = path.resolve(__dirname, '../migrations')
const emptyGraph = { nodes: [], edges: [] } as any
const style = { palette: ['#000', '#111', '#f00', '#222', '#fff'] } as any

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedWithScene(scene: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({
    id,
    name: `P ${id.slice(0, 6)}`,
    description: writeProjectSceneBlob(null, { scenes: [scene], sceneGraph: emptyGraph }),
  })
  return id
}
async function readScenes(id: string) {
  const [row] = await db
    .select({ description: projects.description })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  return readProjectSceneBlob(row!.description).scenes
}

describe('persistScenesFromAgentRun — placeholder overwrite guard (A0/T1)', () => {
  it('refuses to overwrite real DB code with a placeholder (keeps the DB value)', async () => {
    const id = await seedWithScene({ id: 's1', sceneType: 'react', reactCode: 'export default () => REAL_CODE' })
    const ok = await persistScenesFromAgentRun(
      id,
      {
        scenes: [{ id: 's1', sceneType: 'react', reactCode: '[8243 chars]' } as any],
        sceneGraph: emptyGraph,
        globalStyle: style,
      },
      null,
    )
    expect(ok).toBe(true)
    const scenes = await readScenes(id)
    expect((scenes[0] as any).reactCode).toBe('export default () => REAL_CODE') // NOT the placeholder
  })

  it('allows real incoming code to win (including legitimately blanking)', async () => {
    const id = await seedWithScene({ id: 's1', sceneType: 'react', reactCode: 'OLD' })
    await persistScenesFromAgentRun(
      id,
      {
        scenes: [{ id: 's1', sceneType: 'react', reactCode: 'NEW_REAL_CODE' } as any],
        sceneGraph: emptyGraph,
        globalStyle: style,
      },
      null,
    )
    expect((await readScenes(id))[0]).toMatchObject({ reactCode: 'NEW_REAL_CODE' })
  })

  it('does not protect a DB value that is itself a placeholder', async () => {
    const id = await seedWithScene({ id: 's1', sceneType: 'react', reactCode: '[5 chars]' })
    await persistScenesFromAgentRun(
      id,
      {
        scenes: [{ id: 's1', sceneType: 'react', reactCode: '[8243 chars]' } as any],
        sceneGraph: emptyGraph,
        globalStyle: style,
      },
      null,
    )
    // DB had a placeholder too — nothing real to protect; incoming placeholder
    // passes through (the merge/clean steps are the upstream defense).
    expect((await readScenes(id))[0]).toMatchObject({ reactCode: '[8243 chars]' })
  })

  it('[REGRESSION] a brand-new scene (no prior DB row) persists its real code untouched', async () => {
    const id = await seedWithScene({ id: 's1', sceneType: 'react', reactCode: 'EXISTING' })
    await persistScenesFromAgentRun(
      id,
      {
        scenes: [
          { id: 's1', sceneType: 'react', reactCode: 'EXISTING' } as any,
          { id: 's2', sceneType: 'react', reactCode: 'BRAND_NEW' } as any,
        ],
        sceneGraph: emptyGraph,
        globalStyle: style,
      },
      null,
    )
    const scenes = await readScenes(id)
    expect((scenes.find((s: any) => s.id === 's2') as any).reactCode).toBe('BRAND_NEW')
  })
})

describe('persistScenesFromAgentRun — timeline-blob reconcile guards', () => {
  it('empty scene set does NOT clobber the existing blob scenes (interrupted-run guard)', async () => {
    const id = await seedWithScene({ id: 's1', sceneType: 'react', reactCode: 'REAL_ONE' })
    // An interrupted / iteration-cap run reaches persist with an empty set (a
    // filter artifact). The blob must keep its scenes, symmetric to the table.
    await persistScenesFromAgentRun(
      id,
      { scenes: [], sceneGraph: emptyGraph, globalStyle: style },
      null,
    )
    const scenes = await readScenes(id)
    expect(scenes).toHaveLength(1)
    expect((scenes[0] as any).reactCode).toBe('REAL_ONE')
  })

  it('a callerBranchId from a FOREIGN project is ignored — scenes land on this project default branch', async () => {
    // The killer bug: a stale active-branch id from a previously-open project
    // rode the run request and marooned scenes on a branch this project's
    // read never looks at. The persist must validate ownership and fall back.
    const foreign = await seedWithScene({ id: 'fx', sceneType: 'react', reactCode: 'OTHER' })
    const foreignBranch = await getOrCreateDefaultBranch(foreign)

    const sceneId = crypto.randomUUID() // real scenes use UUIDs (table writes filter non-UUID ids)
    const id = await seedWithScene({ id: sceneId, sceneType: 'react', reactCode: 'MINE' })
    const myBranch = await getOrCreateDefaultBranch(id)
    expect(foreignBranch.id).not.toBe(myBranch.id)

    await persistScenesFromAgentRun(
      id,
      { scenes: [{ id: sceneId, sceneType: 'react', reactCode: 'MINE_V2' } as any], sceneGraph: emptyGraph, globalStyle: style },
      foreignBranch.id, // stale/foreign — must be rejected
    )

    // The scene must be readable on THIS project's default branch (not marooned).
    const onMine = await readProjectScenesFromTables(id, myBranch.id)
    expect(onMine?.scenes ?? []).toHaveLength(1)
    expect((onMine!.scenes[0] as any).id).toBe(sceneId)
  })
})
