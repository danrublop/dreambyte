/**
 * Pure gating decision for agent run events that mutate project state.
 *
 * A run is scoped to the branch it started on (`runBranchId`). Its scene writes
 * and final sync target that branch. But `switchProjectBranch` aborts a live run
 * via `_abortNonce` asynchronously, so a branch-A run's late stream events (a
 * trailing `state_change`/`updatedScenes`, the final scene sync, an
 * action-dispatch fed by run events) can still arrive AFTER the active branch
 * has flipped to branch B — landing branch-A scenes onto branch B.
 *
 * The mutating handlers consult this before applying: drop the mutation when the
 * run's branch is no longer the active branch. A null `runBranchId` (run was not
 * branch-scoped) is treated as "apply" — there is no branch to mismatch against.
 */
export function shouldApplyRunEvent(
  runBranchId: string | null | undefined,
  activeBranchId: string | null | undefined,
): boolean {
  // Run was not scoped to a branch — nothing to gate against.
  if (runBranchId == null) return true
  return runBranchId === (activeBranchId ?? null)
}
