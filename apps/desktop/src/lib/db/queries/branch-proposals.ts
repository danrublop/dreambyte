/**
 * Branch-scoped agent proposal / handoff state.
 *
 * Owns ALL reads/writes of the branch-scoped fields: structuralCutsProposed,
 * pausedAgentRun, runCheckpoint. They are per-branch working state — a proposal
 * made on branch A must not be read by branch B of the same project.
 *
 * The row is keyed (projectId, branchId) with a NOT NULL branchId. Callers may
 * pass a null branchId (the "default branch" / pre-branching case); this module
 * is the single boundary that resolves null -> the project's is_default branch id
 * (Codex review #8 — no nullable branch id reaches the table). `version` is a
 * monotonic counter bumped on every write; the SSE write path stamps it onto the
 * emitted event so the client can reject stale / out-of-order EVENTS (the guard
 * is client-side). This is NOT a check-expected-version CAS: the upsert always
 * bumps version and last-writer-wins per field. That's safe because writes are
 * serialized (single-writer SQLite) and each call sets only its own column, so
 * concurrent writes to different fields don't clobber each other. If this ever
 * runs against a multi-connection remote libsql, add a `where version = $expected`
 * predicate to make it a real CAS.
 */

import { db } from '../index'
import { branchProposals } from '../schema'
import { and, eq, sql } from 'drizzle-orm'
import { getOrCreateDefaultBranch } from './branches'
import { createLogger } from '@/lib/logger'
import type { RunCheckpoint } from '@/lib/agents/types'
import { RunCheckpointSchema } from '@/lib/agents/checkpoint-schema'

const log = createLogger('db.branch-proposals')

export type BranchProposalsRow = typeof branchProposals.$inferSelect

/** The branch-scoped JSON fields. */
export type ProposalField = 'structuralCutsProposed' | 'pausedAgentRun' | 'runCheckpoint'

/**
 * Single null->default resolver (the API boundary). Every read/write path goes
 * through here, so no nullable branch id ever reaches the (projectId, branchId)
 * PK. A null branchId means "the default branch" (pre-branching / implicit main).
 */
async function resolveBranchId(projectId: string, branchId: string | null | undefined): Promise<string> {
  if (branchId) return branchId
  const branch = await getOrCreateDefaultBranch(projectId)
  return branch.id
}

/** Read the full proposal row for (projectId, branchId). Null if none exists. */
export async function getBranchProposals(
  projectId: string,
  branchId: string | null,
): Promise<BranchProposalsRow | null> {
  const resolved = await resolveBranchId(projectId, branchId)
  const [row] = await db
    .select()
    .from(branchProposals)
    .where(and(eq(branchProposals.projectId, projectId), eq(branchProposals.branchId, resolved)))
    .limit(1)
  return row ?? null
}

/**
 * Upsert one proposal field for (projectId, branchId), bumping `version` and
 * `updatedAt`. Returns the post-write version so the caller can stamp it on the
 * SSE event. Passing `null` clears the field (the row is kept so `version` keeps
 * advancing — a clear must beat a slower stale set on the client).
 */
export async function setProposalField(
  projectId: string,
  branchId: string | null,
  field: ProposalField,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
): Promise<number> {
  const resolved = await resolveBranchId(projectId, branchId)
  const now = Date.now()
  const [row] = await db
    .insert(branchProposals)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ projectId, branchId: resolved, [field]: value, version: 1, updatedAt: now } as any)
    .onConflictDoUpdate({
      target: [branchProposals.projectId, branchProposals.branchId],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: { [field]: value, version: sql`${branchProposals.version} + 1`, updatedAt: now } as any,
    })
    .returning({ version: branchProposals.version })
  return row?.version ?? 1
}

/** Clear one proposal field (keeps the row + advances `version`). */
export async function clearProposalField(
  projectId: string,
  branchId: string | null,
  field: ProposalField,
): Promise<number> {
  return setProposalField(projectId, branchId, field, null)
}

// ── Run checkpoint (resume interrupted runs) — moved from projects.ts (0015) ──

/** Persist a run checkpoint so the user can resume after disconnect/timeout. */
export async function persistRunCheckpoint(
  projectId: string,
  branchId: string | null,
  checkpoint: RunCheckpoint,
): Promise<void> {
  await setProposalField(projectId, branchId, 'runCheckpoint', checkpoint)
}

/**
 * Fetch the run checkpoint for (projectId, branchId), or null. Validates shape
 * with Zod — returns null and logs a warning if the persisted data is malformed.
 */
export async function getRunCheckpoint(projectId: string, branchId: string | null): Promise<RunCheckpoint | null> {
  const row = await getBranchProposals(projectId, branchId)
  let raw = row?.runCheckpoint
  if (!raw) return null
  // Compat: checkpoints persisted before the rename carry the
  // legacy `storyboard` key. Migrate on read so a pending resume from an
  // older build still validates (zod would otherwise reject and silently
  // drop the resume).
  const legacy = raw as unknown as Record<string, unknown>
  if (legacy.scenePlan === undefined && legacy.storyboard !== undefined) {
    raw = { ...legacy, scenePlan: legacy.storyboard } as unknown as typeof raw
  }
  const parsed = RunCheckpointSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn('getRunCheckpoint: invalid checkpoint data, ignoring', { extra: { issues: parsed.error.issues } })
    return null
  }
  return parsed.data as unknown as RunCheckpoint
}

/** Clear the run checkpoint after successful resume or user discard. */
export async function clearRunCheckpoint(projectId: string, branchId: string | null): Promise<void> {
  await clearProposalField(projectId, branchId, 'runCheckpoint')
}
