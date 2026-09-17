// @vitest-environment node

/**
 * Snapshot orchestrator integration test.
 *
 * The unit test in `snapshot-orchestrator.test.ts` mocks Drizzle to verify
 * the singleton scheduler + threshold counter wiring. This file is the
 * matching integration test: real SQLite, real `appendActionRow`, real
 * `runReducer`, real `writeSnapshot` — and asserts that the snapshot
 * row reflects every action that flowed through `action_log`.
 *
 * Strategy: spin up a temp SQLite file, run migrations, seed a project,
 * write a small action sequence directly to action_log (so we avoid
 * needing to bring up the IPC layer), then call `_computeSnapshotNow` and
 * read the row back. The reducer for the seeded sequence must produce
 * a state with the expected scenes.
 */

import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { createClient } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

import { runMigrations } from '@/lib/db/migrate'
import { fillBaseFields } from '@/lib/actions/executor'
import type { Action, ProjectState } from '@/lib/actions'

let dbDir: string
let dbPath: string

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-snap-orch-'))
  dbPath = path.join(dbDir, 'dreambyte.db')
  process.env.DATABASE_URL = `file:${dbPath}`
  await runMigrations({
    url: `file:${dbPath}`,
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  })
})

const projectId = '00000000-0000-4000-8000-0000000000aa'

beforeEach(async () => {
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute({
    sql: `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`,
    args: [projectId, 'orch-test'],
  })
  await client.execute({ sql: `DELETE FROM action_log WHERE project_id = ?`, args: [projectId] })
  await client.execute({ sql: `DELETE FROM materialized_state WHERE project_id = ?`, args: [projectId] })
  await client.close()
})

function sceneCreate(sceneId: string, name: string, timestamp: number): Action {
  return {
    ...fillBaseFields(
      {
        type: 'scene/create',
        params: {
          sceneId,
          scene: { id: sceneId, name } as never,
        },
      },
      'user',
    ),
    timestamp,
  }
}

function sceneUpdate(sceneId: string, patch: Record<string, unknown>, timestamp: number): Action {
  return {
    ...fillBaseFields({ type: 'scene/update', params: { sceneId, patch } }, 'user'),
    timestamp,
  }
}

describe('snapshot orchestrator (integration)', () => {
  it('computes a snapshot that reflects every action in the log', async () => {
    const { appendActionRow } = await import('@/lib/db/queries/action-log')
    const { readLatestSnapshot } = await import('@/lib/db/queries/materialized-state')
    const { _computeSnapshotNow, _resetForTests } = await import('./snapshot-orchestrator')
    _resetForTests()

    // Three actions, increasing timestamps so listActions ordering is
    // deterministic. The first action seeds the scene; the second updates
    // it; the third creates a sibling.
    await appendActionRow(projectId, sceneCreate('scene-1', 'first', 1000))
    await appendActionRow(projectId, sceneUpdate('scene-1', { name: 'renamed' }, 2000))
    await appendActionRow(projectId, sceneCreate('scene-2', 'second', 3000))

    await _computeSnapshotNow({ projectId })

    const snap = await readLatestSnapshot(projectId)
    expect(snap).not.toBeNull()
    const state = snap!.state as unknown as ProjectState
    expect(state.scenes.length).toBe(2)
    expect(state.scenes[0].id).toBe('scene-1')
    expect(state.scenes[0].name).toBe('renamed')
    expect(state.scenes[1].id).toBe('scene-2')
    expect(state.scenes[1].name).toBe('second')
    expect(snap!.lastActionId).toBeTruthy()
  })

  it('subsequent compute resumes from the prior snapshot', async () => {
    const { appendActionRow } = await import('@/lib/db/queries/action-log')
    const { readLatestSnapshot } = await import('@/lib/db/queries/materialized-state')
    const { _computeSnapshotNow, _resetForTests } = await import('./snapshot-orchestrator')
    _resetForTests()

    await appendActionRow(projectId, sceneCreate('a', 'A', 1_000))
    await _computeSnapshotNow({ projectId })

    const firstSnap = await readLatestSnapshot(projectId)
    expect(firstSnap!.state).toMatchObject({ scenes: [{ id: 'a' }] })

    // Add more actions AFTER the snapshot's createdAt. Use a far-future
    // timestamp so the orchestrator's `sinceTimestamp` filter picks them up.
    await appendActionRow(projectId, sceneCreate('b', 'B', Date.now() + 10_000))
    await _computeSnapshotNow({ projectId })

    const secondSnap = await readLatestSnapshot(projectId)
    const sceneIds = (secondSnap!.state as unknown as ProjectState).scenes.map((s) => s.id)
    expect(sceneIds).toEqual(['a', 'b'])
  })

  it('skips a failing action without aborting the whole replay', async () => {
    // scene/update for an unknown scene fails; subsequent scene/create
    // must still land in the snapshot. Proves the orchestrator's
    // continue-on-reducer-failure path keeps the snapshot useful when
    // the action log contains rows that reference pre-action-log state.
    const { appendActionRow } = await import('@/lib/db/queries/action-log')
    const { readLatestSnapshot } = await import('@/lib/db/queries/materialized-state')
    const { _computeSnapshotNow, _resetForTests } = await import('./snapshot-orchestrator')
    _resetForTests()

    await appendActionRow(projectId, sceneUpdate('does-not-exist', { name: 'noop' }, 1_000))
    await appendActionRow(projectId, sceneCreate('keeps-going', 'K', 2_000))

    await _computeSnapshotNow({ projectId })
    const snap = await readLatestSnapshot(projectId)
    expect(snap).not.toBeNull()
    const ids = (snap!.state as unknown as ProjectState).scenes.map((s) => s.id)
    expect(ids).toEqual(['keeps-going'])
  })
})
