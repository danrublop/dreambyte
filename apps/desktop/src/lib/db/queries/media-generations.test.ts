// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-mediagen-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { closeDb } from '../index'
import {
  createMediaGeneration,
  getMediaGeneration,
  listActiveMediaGenerations,
  transitionMediaGeneration,
  pruneTerminalMediaGenerations,
} from './media-generations'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('media-generations job records', () => {
  it('creates a queued job and reads it back', async () => {
    const id = await createMediaGeneration({
      projectId: 'p1',
      kind: 'video',
      provider: 'kling',
      operationName: 'op-1',
      prompt: 'a cat',
      sceneId: 's1',
      layerId: 'l1',
      deadlineAtMs: 1_780_000_000_000,
    })
    const row = await getMediaGeneration(id)
    expect(row?.status).toBe('queued')
    expect(row?.kind).toBe('video')
    expect(row?.provider).toBe('kling')
    expect(row?.operationName).toBe('op-1')
    expect(row?.layerId).toBe('l1')
    expect(row?.attempts).toBe(0)
    expect(Math.floor((row?.deadlineAt?.getTime() ?? 0) / 1000)).toBe(Math.floor(1_780_000_000_000 / 1000))
  })

  it('advances queued→running→downloading→succeeded and bumps attempts', async () => {
    const id = await createMediaGeneration({ projectId: 'p1', kind: 'video', provider: 'kling' })
    expect(await transitionMediaGeneration(id, 'running', {}, 'queued')).toBe(true)
    expect(await transitionMediaGeneration(id, 'downloading', {}, 'running')).toBe(true)
    expect(
      await transitionMediaGeneration(id, 'succeeded', { resultUrl: '/media/cat.mp4', resultDurationMs: 5000 }, 'downloading'),
    ).toBe(true)
    const row = await getMediaGeneration(id)
    expect(row?.status).toBe('succeeded')
    expect(row?.resultUrl).toBe('/media/cat.mp4')
    expect(row?.resultDurationMs).toBe(5000)
    expect(row?.attempts).toBe(3)
  })

  it('terminal transition is atomic win-once (the from-guard rejects a re-fire)', async () => {
    const id = await createMediaGeneration({ projectId: 'p1', kind: 'video', provider: 'kling' })
    await transitionMediaGeneration(id, 'running', {}, 'queued')
    // Two concurrent pollers both see 'running' and try to finalize — only one wins.
    const a = await transitionMediaGeneration(id, 'succeeded', { resultUrl: '/a.mp4' }, ['running', 'downloading'])
    const b = await transitionMediaGeneration(id, 'failed', { error: 'late' }, ['running', 'downloading'])
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect((await getMediaGeneration(id))?.status).toBe('succeeded')
  })

  it('re-submitting the same id resets the lifecycle to a fresh queued attempt', async () => {
    // The submit path uses id == layerId, so a retry on the same layer re-runs createMediaGeneration
    // with the same id. onConflictDoUpdate must wipe any stale result/error/op so the collided row
    // can't carry forward a previous run's terminal state.
    const id = await createMediaGeneration({
      projectId: 'p-resub',
      kind: 'video',
      provider: 'kling',
      operationName: 'op-old',
    })
    await transitionMediaGeneration(id, 'failed', { error: 'first attempt died' }, ['queued', 'running'])
    const dead = await getMediaGeneration(id)
    expect(dead?.status).toBe('failed')
    expect(dead?.error).toBe('first attempt died')

    // Re-submit with the same id (new operation, fresh provider).
    const reId = await createMediaGeneration({
      id,
      projectId: 'p-resub',
      kind: 'video',
      provider: 'veo',
      operationName: 'op-new',
      prompt: 'second attempt',
    })
    expect(reId).toBe(id)

    const fresh = await getMediaGeneration(id)
    expect(fresh?.status).toBe('queued') // reset, not still failed
    expect(fresh?.error).toBeNull() // stale error wiped
    expect(fresh?.resultUrl).toBeNull()
    expect(fresh?.attempts).toBe(0) // attempt counter reset
    expect(fresh?.operationName).toBe('op-new') // new op, not the dead one
    expect(fresh?.provider).toBe('veo')
    expect(fresh?.prompt).toBe('second attempt')
    // And it's active again (re-pollable by the runner).
    const active = await listActiveMediaGenerations('p-resub')
    expect(active.map((r) => r.id)).toContain(id)
  })

  it('lists only active (non-terminal) jobs, scoped to a project', async () => {
    const active = await createMediaGeneration({ projectId: 'p-list', kind: 'image', provider: 'fal' })
    const done = await createMediaGeneration({ projectId: 'p-list', kind: 'image', provider: 'fal' })
    await transitionMediaGeneration(done, 'succeeded', { resultUrl: '/x.png' })
    const rows = await listActiveMediaGenerations('p-list')
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(active)
    expect(ids).not.toContain(done)
  })

  it('prunes terminal rows older than maxAge but keeps active ones', async () => {
    // Everything created so far is recent; a negative maxAge puts the cutoff in the future so
    // even same-second rows (createdAt is truncated to seconds) are strictly older than it.
    const deleted = await pruneTerminalMediaGenerations(-60_000)
    expect(deleted).toBeGreaterThan(0)
    // Active rows survive.
    const stillActive = await listActiveMediaGenerations()
    expect(stillActive.length).toBeGreaterThan(0)
  })
})
