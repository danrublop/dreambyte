/**
 * Pure decision for the cross-project post-run trigger. Extracted so
 * the abort-guard contract is unit-tested and shared by EVERY runAgentStream
 * caller's drain — the picker must open whether the agent called
 * dispatch_to_projects from the main send, an approve-plan build, or a
 * resumed run, not just the main handleSend path. Kept React- and
 * server-free so it stays trivially testable.
 */

export interface CrossProjectProposal {
  instruction: string
  /** The origin run's request body, captured WITH the proposal (at
   *  crossproject_proposed time) so the instruction and the body always come from
   *  the SAME run. Bundling them removes the fragile two-ref coupling where the
   *  body was read from a separate mutable ref at drain time — under a tight
   *  concurrent-trigger race that could pair run A's instruction with run B's
   *  body. null when the run had no captured body (resolves to no-open). */
  originBody: Record<string, unknown> | null
}

export interface CrossProjectPickerPayload {
  instruction: string
  originBody: Record<string, unknown>
}

/**
 * Resolve whether (and with what payload) to open the cross-project picker after
 * a run ends. Returns null when:
 *  - there is no proposal (the agent didn't call dispatch_to_projects), or
 *  - the run was aborted — a Stop pressed right after the proposal must NOT open
 *    the picker (runAgentStream swallows AbortError, so without this guard a
 *    cancelled run would still fan out), or
 *  - the origin body wasn't captured with the proposal (nothing to fan out).
 */
export function resolveCrossProjectPicker(
  spec: CrossProjectProposal | null,
  aborted: boolean,
): CrossProjectPickerPayload | null {
  if (!spec || aborted || !spec.originBody) return null
  return { instruction: spec.instruction, originBody: spec.originBody }
}
