/**
 * Multi-variant agent runs ("Claude Code for video" wedge primitive).
 *
 * Takes one prompt and spawns N independent agent runs, each on its own
 * branch off the user's current branch. The user's current branch view
 * stays put — variants run silently in the background, persisted to their
 * own branches. When done, the user switches branches via the existing
 * selector to compare results.
 *
 * Parallel in batches of MAX_PARALLEL_VARIANTS. v0.3.8 lifted the per-project
 * run lock (now per-(projectId, branchId)), so variants on different branches
 * run concurrently; the batch cap bounds open LLM streams against API rate
 * limits. An optional `groupBudgetUsd` reserves an even budget share per variant
 * up front so the parallel group can't collectively overspend (see below).
 *
 * The renderer's `state_change` events are intentionally ignored for
 * variant runs — the agent runner has already persisted scenes to the
 * variant branch's DB rows. Applying them to the renderer's view would
 * blast the user's current-branch state with the variant's results.
 *
 * Caller responsibilities:
 *   - Provide `buildAgentRequest(branchId) => Record<string, unknown>` so
 *     this module doesn't need to know about chat-message shape, model
 *     overrides, scene context, etc. The chat assembles its full request;
 *     this just swaps in the target branchId.
 *   - Provide `onProgress(variantIdx, status, detail?)` for UI feedback.
 */

import { streamAgentSse } from '@/lib/agent-transport'
import { createLogger } from '@/lib/logger'

const log = createLogger('agents.spawn-variants')

export type VariantStatus = 'creating' | 'running' | 'done' | 'failed'

export interface VariantResult {
  index: number
  branchId: string
  branchName: string
  status: 'success' | 'failed'
  error?: string
  durationMs: number
}

export interface SpawnAgentVariantsOptions {
  /** Project id (required — variants live on branches of this project). */
  projectId: string
  /** Source branch to fork from (typically the user's current active branch). */
  sourceBranchId: string
  /** Free-text prompt used to derive variant branch names. */
  prompt: string
  /** Number of variants to spawn. Clamped to [2, 8]. */
  n: number
  /**
   * Build the agent request body for one variant. The caller (AgentChat)
   * composes the full request (message, agent overrides, model, scene
   * context, etc.); this function swaps in the per-variant branchId.
   */
  buildAgentRequest: (branchId: string) => Record<string, unknown>
  /** Per-variant progress callback (UI feedback). */
  onProgress?: (variantIdx: number, status: VariantStatus, detail?: string) => void
  /** AbortSignal — applies to the OVERALL operation, not individual runs. */
  signal?: AbortSignal
  /**
   * Optional cost ceiling for the WHOLE fan-out (USD). Because variants run in
   * parallel, an after-the-fact group tally can't stop a run that already blew
   * the cap — so we RESERVE up front: each variant's
   * `runBudgetUsd` is overridden to `groupBudgetUsd / n`, guaranteeing the sum
   * of per-run caps never exceeds the group cap. `undefined` → no group cap
   * (each variant keeps whatever budget `buildAgentRequest` set). `null` →
   * explicitly unlimited. A non-positive number is treated as unlimited so a
   * mis-set 0 can't trap every variant at the first token.
   */
  groupBudgetUsd?: number | null
}

/**
 * Per-variant budget reservation for a group cap. Splitting the group budget
 * evenly across N variants is a static reservation: sum(perRunCap) === groupCap,
 * so the parallel group can never exceed it, with no cross-run coordination.
 * Returns `undefined` (don't override the request's own budget) when no finite
 * group cap applies.
 */
export function reserveVariantBudget(groupBudgetUsd: number | null | undefined, n: number): number | undefined {
  if (groupBudgetUsd === undefined || groupBudgetUsd === null || groupBudgetUsd <= 0) return undefined
  if (n <= 0) return undefined
  return groupBudgetUsd / n
}

const MIN_VARIANTS = 2
const MAX_VARIANTS = 8

/** Used for derived branch names — keeps things URL-safe and short. */
function slugify(input: string, maxLen = 24): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, maxLen)
  return slug || 'variant'
}

interface BranchIpc {
  create(args: {
    projectId: string
    name: string
    sourceBranchId?: string
  }): Promise<{ branch: { id: string; name: string } }>
  delete(args: { projectId: string; id: string }): Promise<{ ok: boolean }>
}

/**
 * Best-effort cleanup. Used when Phase 1 fails partway through or the
 * overall operation aborts before all branches were used. Each delete is
 * independently caught — one cleanup failure does NOT stop the others. The
 * function never throws; orphan branches are a soft problem (user can
 * delete in the panel) and they should not mask the original error that
 * triggered cleanup.
 */
async function cleanupOrphanBranches(
  branchIpc: BranchIpc,
  projectId: string,
  branches: ReadonlyArray<{ id: string; name: string }>,
): Promise<void> {
  if (branches.length === 0) return
  log.warn('cleaning up orphan variant branches', {
    extra: { count: branches.length, names: branches.map((b) => b.name) },
  })
  await Promise.allSettled(
    branches.map((b) =>
      branchIpc.delete({ projectId, id: b.id }).catch((err) => {
        log.warn('orphan branch delete failed', { extra: { branchId: b.id, name: b.name }, error: err })
      }),
    ),
  )
}

function getBranchIpc(): BranchIpc | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ipc = (window as any).dreambyteApi?.branches as BranchIpc | undefined
  return ipc ?? null
}

/**
 * Spawn N agent variants. Returns one result per variant — success or
 * failure. The function tries every variant even if some fail (partial
 * success is the expected case under transient API errors / rate limits).
 *
 * Branch naming: `<prompt-slug>-v1`, `<prompt-slug>-v2`, etc. Collision
 * with an existing branch falls back to a uuid-suffix retry so the user
 * never gets a hard error mid-spawn from a name dup.
 */
export async function spawnAgentVariants(opts: SpawnAgentVariantsOptions): Promise<VariantResult[]> {
  const n = Math.max(MIN_VARIANTS, Math.min(MAX_VARIANTS, opts.n | 0))
  const branchIpc = getBranchIpc()
  if (!branchIpc) {
    throw new Error('spawnAgentVariants requires the desktop runtime (window.dreambyteApi.branches unavailable).')
  }

  const slug = slugify(opts.prompt)
  const created: Array<{ id: string; name: string }> = []
  // Phase 1: create N branches up front. Doing this BEFORE any agent
  // runs gives the user immediate feedback (branches appear in the
  // panel) and means a creation failure halts the operation before
  // burning LLM credits on partial work. Any error or abort triggers
  // cleanup of the already-created branches so failed spawns don't
  // leak trash branches into the project.
  try {
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) {
        throw new DOMException('Aborted before all variant branches were created', 'AbortError')
      }
      opts.onProgress?.(i, 'creating')
      const baseName = `${slug}-v${i + 1}`
      let branch
      try {
        ;({ branch } = await branchIpc.create({
          projectId: opts.projectId,
          name: baseName,
          sourceBranchId: opts.sourceBranchId,
        }))
      } catch (err) {
        const msg = (err as Error).message ?? ''
        // Name collision — retry with a short random suffix.
        if (msg.includes('already exists')) {
          const suffix = Math.random().toString(36).slice(2, 6)
          ;({ branch } = await branchIpc.create({
            projectId: opts.projectId,
            name: `${baseName}-${suffix}`,
            sourceBranchId: opts.sourceBranchId,
          }))
        } else {
          log.warn('variant branch create failed', { extra: { index: i, baseName }, error: err })
          throw err
        }
      }
      created.push({ id: branch.id, name: branch.name })
    }
  } catch (phase1Err) {
    // Clean up any branches that DID get created before re-throwing.
    // Without this, a quota error on branch 5 of 8 leaves the first 4
    // branches as project trash forever. The cleanup is best-effort —
    // failures are logged but never mask the original error.
    await cleanupOrphanBranches(branchIpc, opts.projectId, created)
    throw phase1Err
  }

  // Phase 2: run agents in parallel BATCHES of MAX_PARALLEL_VARIANTS.
  // v0.3.8 lifted the per-project run lock (now per-branch) so multiple
  // variants on different branches can run concurrently. Sequential was
  // the only safe path in v0.3.7. The batch cap exists because each
  // run holds open one LLM stream + transient memory; running all 8 at
  // once on free-tier API keys would hit rate limits. Cap matches
  // MAX_VARIANTS-by-UI so in practice (UI picker tops at 4) it doesn't
  // trip — it's safety insurance for direct API callers passing larger N.
  //
  // Results are positional (pre-allocated) so the returned array order
  // matches the variant index even though completion order is racy.
  const resultsByIdx: Array<VariantResult | null> = new Array(created.length).fill(null)

  async function runOneVariant(i: number): Promise<void> {
    const startedAt = Date.now()
    const { id: branchId, name: branchName } = created[i]

    if (opts.signal?.aborted) {
      resultsByIdx[i] = { index: i, branchId, branchName, status: 'failed', error: 'aborted', durationMs: 0 }
      opts.onProgress?.(i, 'failed', 'aborted')
      return
    }

    opts.onProgress?.(i, 'running')

    try {
      // buildAgentRequest first — if it throws (caller bug, missing
      // store field, etc.), we want to fail fast without ever
      // registering an abort listener. Previously the listener was
      // registered before this call, leaking on throw.
      const request = opts.buildAgentRequest(branchId)
      // Group-budget reservation: override this variant's per-run cap with its
      // reserved share so the parallel group can't collectively overspend.
      const reserved = reserveVariantBudget(opts.groupBudgetUsd, created.length)
      if (reserved !== undefined) request.runBudgetUsd = reserved
      const variantController = new AbortController()
      const onAbort = () => variantController.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await streamAgentSse(request, {
          signal: variantController.signal,
          // Ignore state_change events: the agent runner already persisted
          // to the variant branch's DB rows; applying them to the renderer
          // would overwrite the user's current-branch view.
          onEvent: () => undefined,
        })
        resultsByIdx[i] = {
          index: i,
          branchId,
          branchName,
          status: 'success',
          durationMs: Date.now() - startedAt,
        }
        opts.onProgress?.(i, 'done')
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      resultsByIdx[i] = {
        index: i,
        branchId,
        branchName,
        status: 'failed',
        error: msg,
        durationMs: Date.now() - startedAt,
      }
      opts.onProgress?.(i, 'failed', msg)
      // Continue — partial success beats abort.
    }
  }

  for (let batchStart = 0; batchStart < created.length; batchStart += MAX_PARALLEL_VARIANTS) {
    const batchEnd = Math.min(batchStart + MAX_PARALLEL_VARIANTS, created.length)
    const batch: Promise<void>[] = []
    for (let i = batchStart; i < batchEnd; i++) {
      batch.push(runOneVariant(i))
    }
    // Promise.all here is safe: runOneVariant catches its own errors and
    // never rejects. We just need to wait for all batch members to settle.
    await Promise.all(batch)
    if (opts.signal?.aborted) break
  }

  // Mark any variants in unfinished batches (post-abort) as failed.
  for (let i = 0; i < resultsByIdx.length; i++) {
    if (resultsByIdx[i] === null) {
      const { id, name } = created[i]
      resultsByIdx[i] = { index: i, branchId: id, branchName: name, status: 'failed', error: 'aborted', durationMs: 0 }
      opts.onProgress?.(i, 'failed', 'aborted')
    }
  }

  return resultsByIdx as VariantResult[]
}

const MAX_PARALLEL_VARIANTS = 4

export const __testing = { slugify, reserveVariantBudget, MIN_VARIANTS, MAX_VARIANTS, MAX_PARALLEL_VARIANTS }
