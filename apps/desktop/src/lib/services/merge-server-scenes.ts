/**
 * Branch-scoped server-scene merge.
 *
 * The agent run body carries the renderer's scenes, but localStorage partialize
 * strips heavy code fields (sceneCode/canvasCode/sceneHTML/...). The IPC handler
 * fills those back in from the DB before the run. The DB read (getProjectScenesLight) is
 * NOT branch-scoped, so on a multi-branch project it returns EVERY branch's
 * scenes — and the naive merge then appends other branches' scenes into a
 * single-branch run, polluting the run's context and (on persist) risking
 * cross-branch corruption.
 *
 * This helper scopes the server scenes to the run's effective branch BEFORE
 * merging. It is pure (no DB / no Electron) so the branch-scoping + merge logic
 * is unit-testable; the IPC handler does the DB reads and branch resolution.
 */

import { pickNonPlaceholder } from '@/lib/scenes/placeholder-content'

/** The code fields the merge backfills onto a client scene from the server row. */
const CODE_FIELDS = [
  'canvasCode',
  'sceneCode',
  'sceneHTML',
  'svgContent',
  'canvasBackgroundCode',
  'lottieSource',
] as const

/** A scene-like row. Only `id` + `branchId` are read structurally here; the rest
 *  (code fields etc.) is carried through opaquely. */
export interface MergeScene {
  id: string
  branchId?: string | null
  [key: string]: unknown
}

/**
 * Keep only the scenes that belong to the run's effective branch.
 *
 *  - `effectiveBranchId == null` → no branch context (legacy single-branch /
 *    pre-migration project): do NOT filter, preserving the original behavior.
 *  - otherwise → keep scenes whose `branchId` equals the effective branch. A
 *    null `branchId` predates the 0002 branch backfill (which assigns null →
 *    default branch), so a null-branch scene is treated as the DEFAULT branch's
 *    and is kept ONLY when the effective branch IS the default. This never lets a
 *    non-default run inherit an unstamped (default-ish) scene.
 */
export function filterScenesToBranch(
  scenes: MergeScene[],
  effectiveBranchId: string | null,
  defaultBranchId: string | null,
): MergeScene[] {
  if (!effectiveBranchId) return scenes
  return scenes.filter(
    (s) => s.branchId === effectiveBranchId || (s.branchId == null && effectiveBranchId === defaultBranchId),
  )
}

/**
 * Merge server scenes into the client body's scenes.
 *
 * 1. CODE-FILL is matched by id against ALL server scenes (NOT branch-scoped).
 *    Scene ids are globally unique — a branch clone gets fresh ids
 *    (branches.ts) — so a client id only ever matches its OWN row regardless of
 *    branch; filling from it never pulls cross-branch content. The unscoped
 *    match also covers variant runs that legitimately carry source-branch
 *    client scenes (which would otherwise lose their code to a scoped
 *    no-match). Server scenes must be blob-shaped (getProjectScenesLight):
 *    raw scene-table rows keep code fields inside sceneBlob, so
 *    `serverScene[field]` would be undefined and the fill a silent no-op.
 * 2. APPEND is branch-scoped (filterScenesToBranch). Appending EVERY branch's
 *    server scenes would leak other branches into a single-branch run.
 *
 * NOTE: this does NOT scrub cross-branch scenes the CLIENT body itself supplied
 * (e.g. the variant flow sends source-branch client scenes against a variant
 * branchId). That concern lives at a different layer (the request builder /
 * persist).
 */
export function mergeBranchScopedScenes(
  clientScenes: MergeScene[],
  serverScenes: MergeScene[],
  opts: { branchId: string | null; defaultBranchId: string | null },
): MergeScene[] {
  if (serverScenes.length === 0) return clientScenes
  const serverById = new Map(serverScenes.map((s) => [s.id, s]))

  const merged: MergeScene[] = clientScenes.map((clientScene) => {
    const serverScene = serverById.get(clientScene.id)
    if (!serverScene) return clientScene
    const filled: MergeScene = { ...clientScene }
    for (const field of CODE_FIELDS) {
      // The client value may be a stripped-code placeholder
      // (`[<n> chars]`) for non-selected scenes. That placeholder is TRUTHY, so
      // the old `client || server || ''` let it defeat the server's real code
      // and persist `"[8243 chars]"` as the scene source. pickNonPlaceholder
      // treats a placeholder client value as empty so the server's real code
      // wins; a genuine client value still wins over the server (and empty
      // falls through to the server, as before).
      filled[field] = pickNonPlaceholder(clientScene[field], serverScene[field])
    }
    return filled
  })

  const effectiveBranchId = opts.branchId ?? opts.defaultBranchId
  const scoped = filterScenesToBranch(serverScenes, effectiveBranchId, opts.defaultBranchId)
  for (const serverScene of scoped) {
    if (!merged.some((s) => s.id === serverScene.id)) merged.push(serverScene)
  }
  return merged
}
