// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-videojobs-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { closeDb } from '../index'
import {
  createVideoJob,
  getVideoJob,
  transitionVideoJobFromPending,
  recordCachedVideoJob,
  completeVideoJob,
  pruneTerminalVideoJobs,
  getPendingVideoJobByRequestHash,
} from './video-jobs'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('video-jobs durability queries', () => {
  it('creates a pending job and reads it back with the deadline', async () => {
    const deadline = 1_780_000_000_000
    await createVideoJob({
      operationName: 'op-1',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: 'r1',
      deadlineAtMs: deadline,
    })
    const job = await getVideoJob('op-1')
    expect(job?.status).toBe('pending')
    expect(job?.provider).toBe('veo3')
    expect(job?.reservationId).toBe('r1')
    // mode:'timestamp' truncates to seconds — compare at second granularity.
    expect(Math.floor((job?.deadlineAt.getTime() ?? 0) / 1000)).toBe(Math.floor(deadline / 1000))
  })

  // T23: the duration-scaled reserved cost must round-trip on the row so the stateless poll
  // commits the same amount it reserved (reserve == commit for per-second models).
  it('persists and reads back the reserved estimated cost (T23)', async () => {
    await createVideoJob({
      operationName: 'op-cost',
      projectId: 'p1',
      provider: 'seedance',
      reservationId: 'rc',
      deadlineAtMs: 1,
      estimatedCostCents: 240, // 8s @ $0.30/s
    })
    expect((await getVideoJob('op-cost'))?.estimatedCostCents).toBe(240)
    // Omitted → null (older rows / unknown cost), so the poll falls back to the flat per-call cost.
    await createVideoJob({
      operationName: 'op-nocost',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: null,
      deadlineAtMs: 1,
    })
    expect((await getVideoJob('op-nocost'))?.estimatedCostCents).toBeNull()
  })

  // The anti-double-bill guarantee: only the FIRST transition out of pending wins.
  it('transitions pending->done exactly once (concurrent/late polls lose)', async () => {
    await createVideoJob({
      operationName: 'op-2',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: 'r2',
      deadlineAtMs: 1,
    })
    const [a, b] = await Promise.all([
      transitionVideoJobFromPending('op-2', 'done'),
      transitionVideoJobFromPending('op-2', 'done'),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1) // exactly one winner
    expect((await getVideoJob('op-2'))?.status).toBe('done')
    // A later transition attempt also loses (already terminal).
    expect(await transitionVideoJobFromPending('op-2', 'timeout')).toBe(false)
  })

  // Start-cache: a cache HIT records an already-'done' job carrying the clip URL, so the
  // renderer's first poll returns it (no reservation, no provider call).
  it('recordCachedVideoJob writes a done row with the clip url and no reservation', async () => {
    await recordCachedVideoJob({
      operationName: 'cached-h1',
      projectId: 'p1',
      provider: 'veo3',
      requestHash: 'h1',
      videoUrl: '/generated/videos/h1.mp4',
      deadlineAtMs: 1,
    })
    const job = await getVideoJob('cached-h1')
    expect(job?.status).toBe('done')
    expect(job?.videoUrl).toBe('/generated/videos/h1.mp4')
    expect(job?.reservationId).toBeNull()
    expect(job?.requestHash).toBe('h1')
  })

  // completeVideoJob atomically sets done + url, winner-only (gates the alias + spend once).
  it('completeVideoJob stores the url and transitions pending->done exactly once', async () => {
    await createVideoJob({
      operationName: 'op-c',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: 'rc',
      deadlineAtMs: 1,
      requestHash: 'hc',
    })
    const [a, b] = await Promise.all([
      completeVideoJob('op-c', '/generated/videos/op-c.mp4'),
      completeVideoJob('op-c', '/generated/videos/op-c.mp4'),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1) // exactly one winner gates spend/alias
    const job = await getVideoJob('op-c')
    expect(job?.status).toBe('done')
    expect(job?.videoUrl).toBe('/generated/videos/op-c.mp4')
    expect(job?.requestHash).toBe('hc')
  })

  it('a terminal job cannot be transitioned again (no resurrection)', async () => {
    await createVideoJob({
      operationName: 'op-3',
      projectId: 'p1',
      provider: 'kling',
      reservationId: null,
      deadlineAtMs: 1,
    })
    expect(await transitionVideoJobFromPending('op-3', 'timeout', 'deadline exceeded')).toBe(true)
    expect(await transitionVideoJobFromPending('op-3', 'done')).toBe(false)
    const job = await getVideoJob('op-3')
    expect(job?.status).toBe('timeout')
    expect(job?.errorReason).toBe('deadline exceeded')
  })

  // T22: in-flight dedup — a fast second identical start finds the pending job by request hash
  // (so it polls that instead of paying again). A completed/absent job does not match.
  it('getPendingVideoJobByRequestHash finds a pending job, ignores completed ones', async () => {
    await createVideoJob({
      operationName: 'dedup-1',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: 'r',
      deadlineAtMs: 9_999_999_999_999,
      requestHash: 'hh',
    })
    expect((await getPendingVideoJobByRequestHash('p1', 'hh'))?.operationName).toBe('dedup-1')
    // wrong project / wrong hash → no match
    expect(await getPendingVideoJobByRequestHash('p2', 'hh')).toBeNull()
    expect(await getPendingVideoJobByRequestHash('p1', 'nope')).toBeNull()
    // once it completes, it's no longer "in flight"
    await completeVideoJob('dedup-1', '/generated/videos/d.mp4')
    expect(await getPendingVideoJobByRequestHash('p1', 'hh')).toBeNull()
  })

  // T21: prune deletes terminal rows past the age cutoff but leaves pending (in-flight) ones.
  it('pruneTerminalVideoJobs removes old terminal rows, keeps pending', async () => {
    await createVideoJob({
      operationName: 'prune-pending',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: null,
      deadlineAtMs: 9_999_999_999_999,
    })
    await createVideoJob({
      operationName: 'prune-done',
      projectId: 'p1',
      provider: 'veo3',
      reservationId: null,
      deadlineAtMs: 1,
    })
    await completeVideoJob('prune-done', '/generated/videos/x.mp4')
    // Negative maxAge → cutoff in the future → every terminal row is "old enough" to prune.
    // -2000ms (not -1) clears the current second: createdAt is stored at unixepoch-second
    // granularity, so a same-second cutoff wouldn't be strictly greater.
    const pruned = await pruneTerminalVideoJobs(-2000)
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect(await getVideoJob('prune-done')).toBeNull() // terminal → gone
    expect((await getVideoJob('prune-pending'))?.status).toBe('pending') // in-flight → kept
  })
})
