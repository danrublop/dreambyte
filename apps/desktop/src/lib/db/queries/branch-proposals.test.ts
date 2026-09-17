// @vitest-environment node
//
// Real-DB (libsql file) tests for the 0015 branch-scoped proposal/handoff state.
// The headline guarantee: a proposal made on branch A is invisible on branch B
// and survives a round-trip back to A. This is the data-layer proof of the bug
// the migration fixes (proposals used to be one project-scoped row shared across
// all branches). Runs the real migration chain + real SQL so the PK/FK behavior
// is exercised, not mocked.

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Set DATABASE_URL before any db module loads so the lazy init picks it up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-branch-proposals-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate'
import { db, closeDb } from '../index'
import { projects, branchProposals } from '../schema'
import { and, eq } from 'drizzle-orm'
import { createBranch, deleteBranch, getOrCreateDefaultBranch } from './branches'
import {
  getBranchProposals,
  setProposalField,
  clearProposalField,
  getRunCheckpoint,
  persistRunCheckpoint,
  clearRunCheckpoint,
} from './branch-proposals'
import type { RunCheckpoint } from '@/lib/agents/types'

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
  await db.insert(projects).values({ id, name: `Test Project ${id.slice(0, 6)}` })
  return id
}

const cuts = (sceneId: string) => [{ sceneId, sceneName: 'S', detail: 'repeats', kind: 'redundancy' as const }]

describe('branch_proposals — cross-branch isolation (headline)', () => {
  it('propose on A → B sees nothing → back to A → still there', async () => {
    const projectId = await seedProject()
    const a = await createBranch({ projectId, name: 'variant-a', isDefault: true })
    const b = await createBranch({ projectId, name: 'variant-b' })

    // Propose on A.
    await setProposalField(projectId, a.id, 'structuralCutsProposed', cuts('scene-1'))

    // A has it.
    const onA = await getBranchProposals(projectId, a.id)
    expect(onA?.structuralCutsProposed).toEqual(cuts('scene-1'))

    // B sees nothing (the bug: B used to read A's project-scoped row).
    const onB = await getBranchProposals(projectId, b.id)
    expect(onB?.structuralCutsProposed ?? null).toBeNull()

    // A different proposal lands on B without touching A.
    await setProposalField(projectId, b.id, 'structuralCutsProposed', cuts('scene-9'))
    const onBAfter = await getBranchProposals(projectId, b.id)
    expect(onBAfter?.structuralCutsProposed).toEqual(cuts('scene-9'))

    // Back to A — still the original.
    const backOnA = await getBranchProposals(projectId, a.id)
    expect(backOnA?.structuralCutsProposed).toEqual(cuts('scene-1'))
  })

  it('isolates every field independently across branches', async () => {
    const projectId = await seedProject()
    const a = await createBranch({ projectId, name: 'a', isDefault: true })
    const b = await createBranch({ projectId, name: 'b' })
    await setProposalField(projectId, a.id, 'pausedAgentRun', {
      toolName: 'create_scene',
      toolInput: {},
      createdAt: new Date().toISOString(),
    })
    expect((await getBranchProposals(projectId, a.id))?.pausedAgentRun).toBeTruthy()
    expect((await getBranchProposals(projectId, b.id))?.pausedAgentRun ?? null).toBeNull()
  })
})

describe('branch_proposals — version compare-and-set', () => {
  it('bumps version monotonically on every write and clears keep the row', async () => {
    const projectId = await seedProject()
    const a = await createBranch({ projectId, name: 'a', isDefault: true })

    const v1 = await setProposalField(projectId, a.id, 'structuralCutsProposed', cuts('s1'))
    const v2 = await setProposalField(projectId, a.id, 'pausedAgentRun', { toolName: 'add_narration', toolInput: {}, createdAt: new Date().toISOString() })
    const v3 = await clearProposalField(projectId, a.id, 'structuralCutsProposed')
    expect(v1).toBe(1)
    expect(v2).toBe(2)
    expect(v3).toBe(3)

    const row = await getBranchProposals(projectId, a.id)
    expect(row?.version).toBe(3)
    // Cleared field is null, the other survives, the row persists.
    expect(row?.structuralCutsProposed ?? null).toBeNull()
    expect(row?.pausedAgentRun).toMatchObject({ toolName: 'add_narration' })
  })
})

describe('branch_proposals — null → default branch resolver', () => {
  it('a null branchId resolves to the project default branch', async () => {
    const projectId = await seedProject()
    // No branches yet — resolver should create the default and write there.
    await setProposalField(projectId, null, 'structuralCutsProposed', cuts('s1'))

    const def = await getOrCreateDefaultBranch(projectId)
    // Reading with the explicit default id sees the same row written via null.
    const viaDefault = await getBranchProposals(projectId, def.id)
    expect(viaDefault?.structuralCutsProposed).toEqual(cuts('s1'))
    // And reading via null again resolves to the same row.
    const viaNull = await getBranchProposals(projectId, null)
    expect(viaNull?.structuralCutsProposed).toEqual(cuts('s1'))
  })
})

describe('branch_proposals — run checkpoint (branch-scoped)', () => {
  const checkpoint = (runId: string): RunCheckpoint =>
    ({
      runId,
      agentType: 'auto',
      modelId: 'claude-opus-4-7',
      scenePlan: null,
      completedSceneIds: [],
      remainingSceneIndexes: [0, 1],
      progress: {},
      worldSnapshot: { scenes: [], globalStyle: {}, sceneGraph: {} },
      originalMessage: 'build it',
      partialUsage: null,
      createdAt: new Date().toISOString(),
      reason: 'disconnect',
    }) as unknown as RunCheckpoint

  it('persists + reads a checkpoint per branch and clears it', async () => {
    const projectId = await seedProject()
    const a = await createBranch({ projectId, name: 'a', isDefault: true })
    const b = await createBranch({ projectId, name: 'b' })

    await persistRunCheckpoint(projectId, a.id, checkpoint('run-A'))
    expect((await getRunCheckpoint(projectId, a.id))?.runId).toBe('run-A')
    // B's checkpoint is independent.
    expect(await getRunCheckpoint(projectId, b.id)).toBeNull()

    await clearRunCheckpoint(projectId, a.id)
    expect(await getRunCheckpoint(projectId, a.id)).toBeNull()
  })

  it('T9-S2 compat: reads a legacy checkpoint persisted under the old `storyboard` key', async () => {
    const projectId = await seedProject()
    const a = await createBranch({ projectId, name: 'a', isDefault: true })

    // A checkpoint saved by a pre-rename build: `storyboard`, no `scenePlan`.
    const legacy = checkpoint('run-legacy') as unknown as Record<string, unknown>
    delete legacy.scenePlan
    legacy.storyboard = { title: 'Old plan', scenes: [{ name: 'S1', purpose: 'p', sceneType: 'react', duration: 5 }], totalDuration: 5 }
    await setProposalField(projectId, a.id, 'runCheckpoint', legacy)

    const read = await getRunCheckpoint(projectId, a.id)
    expect(read?.runId).toBe('run-legacy')
    // The legacy key is migrated on read — the resume path sees scenePlan.
    expect(read?.scenePlan?.title).toBe('Old plan')
    expect(read?.scenePlan?.scenes).toHaveLength(1)
  })
})

describe('branch_proposals — branch delete removes the row', () => {
  it('deleteBranch removes the branch_proposals row (explicit cascade — FK off per-connection)', async () => {
    const projectId = await seedProject()
    await createBranch({ projectId, name: 'main', isDefault: true })
    const feature = await createBranch({ projectId, name: 'feature' })
    await setProposalField(projectId, feature.id, 'structuralCutsProposed', cuts('s1'))

    // Row exists before delete.
    const before = await db
      .select()
      .from(branchProposals)
      .where(and(eq(branchProposals.projectId, projectId), eq(branchProposals.branchId, feature.id)))
    expect(before).toHaveLength(1)

    await deleteBranch(feature.id)

    // Row is gone after delete — no orphan.
    const after = await db
      .select()
      .from(branchProposals)
      .where(and(eq(branchProposals.projectId, projectId), eq(branchProposals.branchId, feature.id)))
    expect(after).toHaveLength(0)
  })
})
