/**
 * Parallel tool-batch invariants.
 *
 * The runner parallelizes CONTIGUOUS runs of generation tools when each call
 * targets a DISTINCT sceneId, executing each against a deep-cloned world and
 * merging back ONLY the affected scene (plus a globalStyle diff). Those three
 * properties are what make the parallel path safe without a conflict
 * resolver:
 *
 *   1. Only tools whose mutations are confined to their input sceneId may be
 *      in PARALLELIZABLE_TOOLS. Adding a broad-mutation tool (set_global_style,
 *      timeline ops, …) reintroduces silent last-write-wins data loss.
 *   2. A batch never contains two calls for the same scene.
 *   3. Merge-back writes only `result.affectedSceneId`'s scene — any other
 *      mutation a tool made to its isolated clone is dropped BY DESIGN.
 *
 * NOT guaranteed: globalStyle confinement. If two batch entries both diverge
 * globalStyle in their clones, the merge applies them in batch order and the
 * last one wins (pre-extraction behavior, unchanged). Safe today because the
 * generation tools don't write globalStyle — if one ever does, add a
 * divergence-conflict guard here.
 *
 * Extracted from runner.ts so the invariants are unit-testable without the
 * runner's provider dependency graph, and so a future edit to the tool set
 * trips a pinned test instead of shipping quietly.
 */

import type { Scene } from '../types'

/** Tools that invoke LLM code generation and need a longer timeout. */
export const GENERATION_TOOLS = new Set(['add_layer', 'regenerate_layer'])

/** Tools safe to run in parallel when targeting different scenes.
 *  INVARIANT: every member's mutations must be confined to its input sceneId
 *  (see module doc, property 1). Pinned by parallel-merge-invariants.test.ts —
 *  if you extend this set, prove scene-confinement and update the test. */
export const PARALLELIZABLE_TOOLS = GENERATION_TOOLS

export interface ParallelCandidateBlock {
  name: string
  inputError?: string | null
  parsedInput: unknown
}

export function isParallelizableBlock(block: ParallelCandidateBlock): boolean {
  return (
    !block.inputError &&
    PARALLELIZABLE_TOOLS.has(block.name) &&
    !!(block.parsedInput as { sceneId?: unknown } | null | undefined)?.sceneId
  )
}

/**
 * Build a contiguous candidate batch starting at `start`, stopping at the
 * first non-parallelizable block or repeated sceneId. Pure — the runner
 * decides what to do with batches of length <= 1.
 */
export function collectParallelBatch<T extends ParallelCandidateBlock>(
  blocks: T[],
  start: number,
): { batch: T[]; sceneIds: Set<string>; nextIndex: number } {
  const batch: T[] = []
  const sceneIds = new Set<string>()
  let j = start
  while (j < blocks.length) {
    const block = blocks[j]
    if (!isParallelizableBlock(block)) break
    const sceneId = (block.parsedInput as { sceneId: string }).sceneId
    if (sceneIds.has(sceneId)) break
    batch.push(block)
    sceneIds.add(sceneId)
    j += 1
  }
  return { batch, sceneIds, nextIndex: j }
}

/**
 * Dev/test assertion: a batch about to run in parallel must contain only
 * scene-confined tools with distinct scene targets. Unreachable today by
 * construction (collectParallelBatch gates entry) — this exists to make a
 * future refactor of the gating fail LOUDLY in dev instead of silently
 * dropping writes in production (no-op there).
 */
export function assertParallelBatchSafe(batch: ParallelCandidateBlock[]): void {
  if (process.env.NODE_ENV === 'production') return
  const seen = new Set<string>()
  for (const block of batch) {
    if (!PARALLELIZABLE_TOOLS.has(block.name)) {
      throw new Error(
        `assertParallelBatchSafe: "${block.name}" is not in PARALLELIZABLE_TOOLS — ` +
          `parallel execution requires scene-confined mutations (see src/lib/agents/parallel-batch.ts).`,
      )
    }
    const sceneId = (block.parsedInput as { sceneId?: string } | null | undefined)?.sceneId
    if (!sceneId) {
      throw new Error(`assertParallelBatchSafe: "${block.name}" has no sceneId — cannot isolate its world merge.`)
    }
    if (seen.has(sceneId)) {
      throw new Error(`assertParallelBatchSafe: duplicate sceneId "${sceneId}" in one parallel batch.`)
    }
    seen.add(sceneId)
  }
}

/** Minimal world shape the merge touches — keeps this module free of the
 *  runner's WorldStateMutable import. */
export interface MergeableWorld {
  scenes: Scene[]
  globalStyle: Record<string, unknown>
}

/**
 * Merge ONE isolated world's outcome back into the live world (property 3):
 * only the affected scene is written back; globalStyle is replaced wholesale
 * iff it diverged from the pre-batch snapshot. Mutates `world` in place —
 * mirrors the runner's original inline logic exactly.
 */
export function mergeIsolatedWorldEntry(
  world: MergeableWorld,
  isolatedWorld: MergeableWorld,
  affectedSceneId: string | null | undefined,
  baseStyleStr: string,
): void {
  if (affectedSceneId) {
    const updatedScene = isolatedWorld.scenes.find((s) => s.id === affectedSceneId)
    if (updatedScene) {
      const worldIdx = world.scenes.findIndex((s) => s.id === affectedSceneId)
      if (worldIdx !== -1) world.scenes[worldIdx] = updatedScene
      else world.scenes.push(updatedScene)
    }
  }

  // Merge style changes: only apply if the isolated world's style diverged.
  // Full replacement (clear + assign) so nested objects like palette are reverted.
  const isoStyle = isolatedWorld.globalStyle
  if (JSON.stringify(isoStyle) !== baseStyleStr) {
    const cloned = JSON.parse(JSON.stringify(isoStyle)) as Record<string, unknown>
    for (const key of Object.keys(world.globalStyle)) {
      delete world.globalStyle[key]
    }
    Object.assign(world.globalStyle, cloned)
  }
}
