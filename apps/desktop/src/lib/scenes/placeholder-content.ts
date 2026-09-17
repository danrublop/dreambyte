/**
 * Shared placeholder-content predicate.
 *
 * When the renderer sends a run body, it strips the heavy code fields of every
 * NON-selected scene to keep the payload small, replacing each with a literal
 * placeholder string of the EXACT shape `[<n> chars]` (e.g. `"[8243 chars]"`)
 * — see `use-agent-run.ts`'s `lightScenes` map. The selected scene's full code
 * and `reactCode` are left intact.
 *
 * This placeholder is TRUTHY, which is the root of the corruption chain A0 kills:
 *
 *   - `mergeBranchScopedScenes` code-fill did `client[f] || server[f] || ''` —
 *     the truthy placeholder beat the server's real code, so `"[8243 chars]"`
 *     survived as the scene's "source".
 *   - `cleanScenesForAgentPersistence` restored placeholders from `body.scenes`,
 *     which were already poisoned, so the placeholder reached the DB as the
 *     scene's source code.
 *   - `read_scene_code` returned the placeholder verbatim as "the code".
 *
 * The predicate matches ONLY the full generated shape (anchored regex). A scene
 * whose real code merely CONTAINS that substring inside a larger body must NOT
 * match — hence the `^...$` anchors and the dedicated name-collision test.
 */

/** Matches the EXACT generated placeholder shape and nothing else. */
const PLACEHOLDER_CONTENT_RE = /^\[\d+ chars\]$/

/**
 * True iff `v` is exactly a stripped-code placeholder (`[<digits> chars]`).
 * Whitespace-trimmed before matching so a stray leading/trailing space (which
 * the strip never adds, but a downstream copy might) still reads as a
 * placeholder. A value that merely embeds the substring inside larger content
 * returns false.
 */
export function isPlaceholderContent(v: string | undefined | null): boolean {
  return typeof v === 'string' && PLACEHOLDER_CONTENT_RE.test(v.trim())
}

/**
 * Code-fill pick used by the server-scene merge: a real client value wins; a
 * placeholder client value is treated as empty so the server's real code fills
 * it; an empty client value falls through to the server (today's behavior).
 * Returns '' when neither side has real content.
 */
export function pickNonPlaceholder(clientValue: unknown, serverValue: unknown): string {
  const client = typeof clientValue === 'string' ? clientValue : ''
  const server = typeof serverValue === 'string' ? serverValue : ''
  if (client && !isPlaceholderContent(client)) return client
  if (server && !isPlaceholderContent(server)) return server
  // Neither side is real code. Prefer a real (non-placeholder) server value if
  // present, then a real client value, else empty — never persist a placeholder.
  return ''
}
