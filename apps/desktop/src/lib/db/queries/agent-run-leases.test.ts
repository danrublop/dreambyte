// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-run-leases-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, agentRunLeases } from '../schema'
import { and, eq } from 'drizzle-orm'
import {
  acquireRunLease,
  heartbeatRunLease,
  releaseRunLease,
  getActiveRunLease,
  mintRunLeaseToken,
} from './agent-run-leases'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Each test gets its own project + branch id so leases never collide. */
async function seed(branchId = 'main') {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Lease Test' })
  return { projectId, branchId }
}

/** Force a row's heartbeat into the past so the TTL treats it as stale, without
 *  waiting real wall-clock time. Mirrors what a crashed window leaves behind. */
async function expireHeartbeat(projectId: string, branchId: string, secondsAgo = 120) {
  const old = new Date(Date.now() - secondsAgo * 1000)
  await db
    .update(agentRunLeases)
    .set({ heartbeatAt: old })
    .where(and(eq(agentRunLeases.projectId, projectId), eq(agentRunLeases.branchId, branchId)))
}

describe('agent run leases', () => {
  it('acquires a free (project, branch)', async () => {
    const { projectId, branchId } = await seed()
    const a = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A', pid: 111, instanceId: 'win-A' })
    expect(a.acquired).toBe(true)
    const live = await getActiveRunLease(projectId, branchId)
    expect(live?.ownerToken).toBe('tok-A')
    expect(live?.ownerInstanceId).toBe('win-A')
    expect(live?.ownerPid).toBe(111)
  })

  it('refuses a different live token and reports the holder', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A', pid: 111, instanceId: 'win-A' })
    const b = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-B', pid: 222, instanceId: 'win-B' })
    expect(b.acquired).toBe(false)
    if (!b.acquired) {
      expect(b.heldBy.instanceId).toBe('win-A')
      expect(b.heldBy.pid).toBe(111)
      expect(b.heldBy.ageMs).toBeGreaterThanOrEqual(0)
      expect(b.heldBy.ageMs).toBeLessThan(30_000)
    }
  })

  it('takes over a stale (TTL-expired) lease — simulated by an old heartbeatAt', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'crashed', pid: 999, instanceId: 'dead-win' })
    await expireHeartbeat(projectId, branchId)
    const takeover = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-B', pid: 222, instanceId: 'win-B' })
    expect(takeover.acquired).toBe(true)
    const live = await getActiveRunLease(projectId, branchId)
    expect(live?.ownerToken).toBe('tok-B')
    // getActiveRunLease should NOT see the stale predecessor before takeover.
  })

  it('self-reacquire with the same token is idempotent', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A' })
    const again = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A' })
    expect(again.acquired).toBe(true)
  })

  it('release then re-acquire (different token) succeeds', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A' })
    await releaseRunLease(projectId, branchId, 'tok-A')
    const b = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-B' })
    expect(b.acquired).toBe(true)
  })

  it('does not release for a non-owner token', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A', instanceId: 'win-A' })
    await releaseRunLease(projectId, branchId, 'tok-WRONG') // no-op
    const b = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-B' })
    expect(b.acquired).toBe(false)
    if (!b.acquired) expect(b.heldBy.instanceId).toBe('win-A')
  })

  it('heartbeat only succeeds for the owner and keeps the lease live', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A' })
    expect(await heartbeatRunLease(projectId, branchId, 'tok-A')).toBe(true)
    expect(await heartbeatRunLease(projectId, branchId, 'tok-B')).toBe(false)
    const live = await getActiveRunLease(projectId, branchId)
    expect(live?.ownerToken).toBe('tok-A')
  })

  it('heartbeat refreshes liveness so a near-stale lease stays held', async () => {
    const { projectId, branchId } = await seed()
    await acquireRunLease(projectId, branchId, { ownerToken: 'tok-A' })
    // Age it almost to the edge, then heartbeat to push it back to now.
    await expireHeartbeat(projectId, branchId, 29)
    expect(await heartbeatRunLease(projectId, branchId, 'tok-A')).toBe(true)
    const live = await getActiveRunLease(projectId, branchId)
    expect(live?.ownerToken).toBe('tok-A')
    // A foreign token must still be refused after a fresh heartbeat.
    const b = await acquireRunLease(projectId, branchId, { ownerToken: 'tok-B' })
    expect(b.acquired).toBe(false)
  })

  it('different branches of the same project run in parallel (composite PK)', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'Parallel Branches' })
    const a = await acquireRunLease(projectId, 'branch-1', { ownerToken: 'tok-1' })
    const b = await acquireRunLease(projectId, 'branch-2', { ownerToken: 'tok-2' })
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
  })

  it('normalizes a null/undefined branch to the same PK row', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'Null Branch' })
    const a = await acquireRunLease(projectId, null, { ownerToken: 'tok-A' })
    expect(a.acquired).toBe(true)
    // undefined must map to the SAME row as null → a foreign token is refused.
    const b = await acquireRunLease(projectId, undefined, { ownerToken: 'tok-B' })
    expect(b.acquired).toBe(false)
    // And release with null clears it so undefined can re-acquire.
    await releaseRunLease(projectId, null, 'tok-A')
    const c = await acquireRunLease(projectId, undefined, { ownerToken: 'tok-C' })
    expect(c.acquired).toBe(true)
  })

  it('mintRunLeaseToken returns a unique token each call', () => {
    const t1 = mintRunLeaseToken()
    const t2 = mintRunLeaseToken()
    expect(t1).not.toBe(t2)
    expect(t1.length).toBeGreaterThan(0)
  })
})

describe('agent run leases — Lane E regression (clean stop → resume not refused)', () => {
  it('a released lease is IMMEDIATELY re-acquirable with no TTL wait', async () => {
    const { projectId, branchId } = await seed('feat-resume')
    // A fresh-start run acquires, heartbeats, then the user STOPS it — the
    // run-start handler's .finally releases the lease.
    const start = await acquireRunLease(projectId, branchId, { ownerToken: 'run-1', pid: 100, instanceId: 'win-A' })
    expect(start.acquired).toBe(true)
    await heartbeatRunLease(projectId, branchId, 'run-1')
    await releaseRunLease(projectId, branchId, 'run-1') // clean stop

    // After release there is NO live lease (so a resume can't be falsely refused).
    expect(await getActiveRunLease(projectId, branchId)).toBeNull()

    // The resume goes through the SAME handler (resumeCheckpoint:true) and mints a
    // NEW owner token. It must acquire WITHOUT waiting out the 30s TTL.
    const resume = await acquireRunLease(projectId, branchId, { ownerToken: 'run-2-resume', pid: 100, instanceId: 'win-A' })
    expect(resume.acquired).toBe(true)
    const live = await getActiveRunLease(projectId, branchId)
    expect(live?.ownerToken).toBe('run-2-resume')
  })
})
