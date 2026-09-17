// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cench-branch-locks-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, projectBranches } from '../schema'
import { eq } from 'drizzle-orm'
import { createBranch, deleteBranch, setDefaultBranch, getBranch } from './branches'
import {
  acquireBranchLock,
  releaseBranchLock,
  heartbeatBranchLock,
  getActiveBranchLock,
  withBranchLock,
  BranchLockedError,
  BranchLockTimeoutError,
  projectLockKey,
} from './branch-locks'

const migrationsFolder = path.resolve(__dirname, '../migrations')

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedBranch() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Lock Test' })
  const branch = await createBranch({ projectId, name: 'main', isDefault: true })
  return { projectId, branchId: branch.id }
}

describe('branch locks', () => {
  it('acquires a free branch and blocks a different owner', async () => {
    const { projectId, branchId } = await seedBranch()
    const a = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-A' })
    expect(a.acquired).toBe(true)

    const b = await acquireBranchLock({ branchId, projectId, operation: 'delete', ownerId: 'owner-B' })
    expect(b.acquired).toBe(false)
    expect(b.holder?.ownerId).toBe('owner-A')
    expect(b.holder?.operation).toBe('fork')
  })

  it('is re-entrant for the same owner', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'restore', ownerId: 'owner-A' })
    const again = await acquireBranchLock({ branchId, projectId, operation: 'restore', ownerId: 'owner-A' })
    expect(again.acquired).toBe(true)
  })

  it('releases so another owner can acquire', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-A' })
    await releaseBranchLock(branchId, 'owner-A')
    const b = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-B' })
    expect(b.acquired).toBe(true)
  })

  it('does not release for a non-owner', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-A' })
    await releaseBranchLock(branchId, 'owner-B') // wrong owner — no-op
    const b = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-B' })
    expect(b.acquired).toBe(false)
    expect(b.holder?.ownerId).toBe('owner-A')
  })

  it('lets a new owner take over a stale (TTL-expired) lock', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'crashed-owner' })
    // ttlSeconds:-1 makes the existing heartbeat count as already expired.
    const takeover = await acquireBranchLock({
      branchId,
      projectId,
      operation: 'delete',
      ownerId: 'owner-B',
      ttlSeconds: -1,
    })
    expect(takeover.acquired).toBe(true)
    expect(takeover.holder?.ownerId).toBe('owner-B')
  })

  it('heartbeat only succeeds for the owner; getActiveBranchLock sees a live lock', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-A' })
    expect(await heartbeatBranchLock(branchId, 'owner-A')).toBe(true)
    expect(await heartbeatBranchLock(branchId, 'owner-B')).toBe(false)
    const live = await getActiveBranchLock(branchId)
    expect(live?.ownerId).toBe('owner-A')
  })

  it('withBranchLock runs the body and releases afterwards', async () => {
    const { projectId, branchId } = await seedBranch()
    let ran = false
    const out = await withBranchLock({ branchId, projectId, operation: 'restore' }, async () => {
      ran = true
      return 42
    })
    expect(ran).toBe(true)
    expect(out).toBe(42)
    // Lock was released — another owner can acquire.
    const after = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-Z' })
    expect(after.acquired).toBe(true)
  })

  it('withBranchLock throws BranchLockedError when another owner holds the lock', async () => {
    const { projectId, branchId } = await seedBranch()
    await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'other-window' })
    await expect(
      withBranchLock({ branchId, projectId, operation: 'delete' }, async () => 'nope'),
    ).rejects.toBeInstanceOf(BranchLockedError)
    await releaseBranchLock(branchId, 'other-window')
  })

  it('acquire returns a fresh per-acquisition owner token when none is supplied', async () => {
    const { projectId, branchId } = await seedBranch()
    const a = await acquireBranchLock({ branchId, projectId, operation: 'fork' })
    expect(a.acquired).toBe(true)
    expect(typeof a.ownerId).toBe('string')
    expect(a.ownerId.length).toBeGreaterThan(0)
    // A second op in the same process with NO supplied token must NOT alias the
    // first one's lock (the old PROCESS_OWNER_ID bug). It gets a new token and is
    // blocked by the live holder.
    const b = await acquireBranchLock({ branchId, projectId, operation: 'delete' })
    expect(b.acquired).toBe(false)
    expect(b.ownerId).not.toBe(a.ownerId)
    await releaseBranchLock(branchId, a.ownerId)
  })
})

describe('branch locks — in-process queueing (race)', () => {
  it('serializes two same-process ops on one branch in arrival order', async () => {
    const { projectId, branchId } = await seedBranch()
    const order: string[] = []

    const opA = withBranchLock({ branchId, projectId, operation: 'fork' }, async () => {
      order.push('A:start')
      await new Promise((r) => setTimeout(r, 40))
      order.push('A:end')
    })
    // Start B a tick later so A is guaranteed first in line.
    const opB = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return withBranchLock({ branchId, projectId, operation: 'delete' }, async () => {
        order.push('B:start')
        order.push('B:end')
      })
    })()

    await Promise.all([opA, opB])
    // B must not start until A fully finished — no interleave, no steal.
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('a same-process op does NOT steal a live lock mid-operation', async () => {
    const { projectId, branchId } = await seedBranch()
    let bRan = false
    let aStillHeld = false

    const opA = withBranchLock({ branchId, projectId, operation: 'restore' }, async () => {
      aStillHeld = true
      await new Promise((r) => setTimeout(r, 50))
      // B must not have run while A was inside its body.
      expect(bRan).toBe(false)
      aStillHeld = false
    })
    // Kick off B concurrently (NOT awaited from inside A) — it must queue.
    const opB = withBranchLock({ branchId, projectId, operation: 'delete' }, async () => {
      // When B finally runs, A must have already released.
      expect(aStillHeld).toBe(false)
      bRan = true
    })

    await Promise.all([opA, opB])
    expect(bRan).toBe(true)
  })
})

describe('branch locks — watchdog zombie (max-hold timeout)', () => {
  it('watchdog fires → heartbeat STOPS (zombie stops refreshing the DB row) → stale-TTL takeover succeeds while the zombie still runs', async () => {
    const { projectId, branchId } = await seedBranch()

    let zombieFinished = false
    let zombieOwner: string | undefined
    let heartbeats = 0
    let heartbeatsAtTimeout = -1

    // Run an op whose body outlives a tiny max-hold, with a FAST heartbeat (15ms)
    // so the zombie WOULD keep ticking the heartbeat throughout its ~200ms life if
    // the fix were absent. The watchdog (20ms) must STOP that heartbeat the instant
    // it fires; the body then runs on as an un-cancellable zombie WITHOUT
    // heartbeating. `onHeartbeat` counts every tick so the test can assert the
    // count freezes once the watchdog trips.
    const caller = withBranchLock(
      {
        branchId,
        projectId,
        operation: 'restore',
        maxHoldMs: 20,
        heartbeatMs: 15,
        onHeartbeat: () => {
          heartbeats += 1
        },
      },
      async () => {
        const live = await getActiveBranchLock(branchId)
        zombieOwner = live?.ownerId
        await new Promise((r) => setTimeout(r, 200))
        zombieFinished = true
        return 'zombie-done'
      },
    )

    // Caller rejects loud with the timeout error.
    await expect(caller).rejects.toBeInstanceOf(BranchLockTimeoutError)
    expect(zombieOwner).toBeTruthy()
    expect(zombieFinished).toBe(false) // zombie still running
    heartbeatsAtTimeout = heartbeats

    // Wait many fast-heartbeat intervals while the zombie is still alive. With the
    // fix the heartbeat is dead → the tick count must NOT grow. Without the fix it
    // would tick ~8+ more times in this window (revert-sensitive).
    await new Promise((r) => setTimeout(r, 150))
    expect(zombieFinished).toBe(false) // still running across the observation window
    expect(heartbeats).toBe(heartbeatsAtTimeout)

    // Because the zombie no longer heartbeats, the DB TTL can reclaim the row.
    // Simulate the TTL having elapsed and confirm a brand-new owner takes over
    // even though the zombie is still mid-run.
    const takeover = await acquireBranchLock({
      branchId,
      projectId,
      operation: 'delete',
      ownerId: 'takeover-owner',
      ttlSeconds: -1,
    })
    expect(takeover.acquired).toBe(true)
    expect(takeover.holder?.ownerId).toBe('takeover-owner')
    expect(zombieFinished).toBe(false)

    // Let the zombie finish. Its eventual release() is token-scoped to ITS OWN
    // (now TTL-reclaimed) token, so it must NOT delete the takeover owner's new lock.
    await new Promise((r) => setTimeout(r, 250))
    expect(zombieFinished).toBe(true)
    const stillHeld = await getActiveBranchLock(branchId)
    expect(stillHeld?.ownerId).toBe('takeover-owner')
    expect(stillHeld?.ownerId).not.toBe(zombieOwner)

    await releaseBranchLock(branchId, 'takeover-owner')
  })
})

describe('branch locks — project-scoped key', () => {
  it('serializes cross-branch ops on the same project via projectLockKey', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'Proj Lock' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const feature = await createBranch({ projectId, name: 'feature' })
    const key = projectLockKey(projectId)
    const order: string[] = []

    // Two ops on DIFFERENT branches but the SAME project lock key must queue.
    const op1 = withBranchLock(
      { branchId: main.id, projectId, operation: 'promote', lockKey: key },
      async () => {
        order.push('1:start')
        await new Promise((r) => setTimeout(r, 30))
        order.push('1:end')
      },
    )
    const op2 = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return withBranchLock(
        { branchId: feature.id, projectId, operation: 'promote', lockKey: key },
        async () => {
          order.push('2:start')
          order.push('2:end')
        },
      )
    })()

    await Promise.all([op1, op2])
    expect(order).toEqual(['1:start', '1:end', '2:start', '2:end'])
  })

  it('delete-vs-promote cannot leave a project with no default branch', async () => {
    const projectId = crypto.randomUUID()
    await db.insert(projects).values({ id: projectId, name: 'No Orphan Default' })
    const main = await createBranch({ projectId, name: 'main', isDefault: true })
    const feature = await createBranch({ projectId, name: 'feature' })
    const key = projectLockKey(projectId)

    // Concurrently: promote `feature` to default AND delete `feature`. Both run
    // under the project-scoped lock exactly as the IPC handlers do. Whichever
    // wins, the project must end with exactly ONE default branch.
    const promote = withBranchLock(
      { branchId: feature.id, projectId, operation: 'promote', lockKey: key },
      async () => {
        const live = await getBranch(feature.id)
        if (!live) throw new Error('gone')
        await setDefaultBranch(projectId, feature.id)
      },
    ).catch((e) => e)
    const del = withBranchLock(
      { branchId: feature.id, projectId, operation: 'delete', lockKey: key },
      async () => {
        // Mirror the handler: refuse to delete the default branch (re-checked
        // inside the lock).
        const live = await getBranch(feature.id)
        if (!live) throw new Error('gone')
        if (live.isDefault) throw new Error('Cannot delete the default branch')
        await deleteBranch(feature.id)
      },
    ).catch((e) => e)

    await Promise.all([promote, del])

    const branchRows = await db.select().from(projectBranches).where(eq(projectBranches.projectId, projectId))
    const defaultCount = branchRows.filter((b) => b.isDefault).length
    // Exactly one default survives — never zero (the splice this guards against).
    expect(defaultCount).toBe(1)
    // And the original main branch is still present.
    expect(branchRows.some((b) => b.id === main.id)).toBe(true)
  })
})

describe('branch locks — release on throw (B9)', () => {
  it('withBranchLock releases the lock when the body THROWS, and the error propagates', async () => {
    const { projectId, branchId } = await seedBranch()
    await expect(
      withBranchLock({ branchId, projectId, operation: 'restore' }, async () => {
        throw new Error('body exploded')
      }),
    ).rejects.toThrow('body exploded')
    // The finally-release must have run — a different owner can acquire NOW
    // (no TTL wait): a leaked lock here would soft-brick the branch for the
    // whole heartbeat TTL after any failed restore/delete.
    const after = await acquireBranchLock({ branchId, projectId, operation: 'fork', ownerId: 'owner-after-throw' })
    expect(after.acquired).toBe(true)
    await releaseBranchLock(branchId, 'owner-after-throw')
  })
})
