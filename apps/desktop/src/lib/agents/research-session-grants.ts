/**
 * Research-mode session grants for the MCP path (set_research_mode).
 *
 * The MCP bridge rebuilds the agent world from the DB on EVERY tool call, so a
 * grant made by one call (set_research_mode) must survive to the next
 * (find_stock_videos). This main-process registry holds those grants keyed by
 * projectId for the lifetime of the app process — deliberately NOT persisted:
 * Research stays opt-in per session, exactly like the in-app toggle, and an
 * app restart resets it.
 *
 * globalThis-backed (same pattern as pending-captures/export-jobs) so the
 * electron main bundle and any sibling bundle share one map.
 */

export interface ResearchSessionGrant {
  webSearch?: boolean
  webFetch?: boolean
  /** Last grant mutation's stated reason — persisted so the grant is
   *  auditable independent of the chat transcript. */
  reason?: string
  /** unixepoch ms of the latest grant mutation — audit surface. */
  grantedAt: number
}

const GLOBAL_KEY = '__dreambyteResearchSessionGrants__' as const

function getMap(): Map<string, ResearchSessionGrant> {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, ResearchSessionGrant>()
  return g[GLOBAL_KEY] as Map<string, ResearchSessionGrant>
}

/** Merge a grant patch for a project (undefined fields keep their prior value). */
export function setResearchSessionGrant(
  projectId: string,
  patch: { webSearch?: boolean; webFetch?: boolean; reason?: string },
): ResearchSessionGrant {
  const map = getMap()
  const prior = map.get(projectId)
  const next: ResearchSessionGrant = {
    ...(prior ?? {}),
    ...(patch.webSearch !== undefined ? { webSearch: patch.webSearch } : {}),
    ...(patch.webFetch !== undefined ? { webFetch: patch.webFetch } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    grantedAt: Date.now(),
  }
  map.set(projectId, next)
  return next
}

/** Map a grant onto the world's gate fields. The undefined-vs-false
 *  distinction is load-bearing: a {webSearch:false} grant CLOSES the gate
 *  (webSearchEnabled=false), while an absent field leaves the world's
 *  default (undefined = gate closed by the handler's falsy check, but
 *  distinguishable for future default-on surfaces). Pure — unit-tested. */
export function researchGrantWorldFields(
  grant: ResearchSessionGrant | undefined,
): { webSearchEnabled?: boolean; webFetchEnabled?: boolean } {
  return {
    ...(grant?.webSearch !== undefined ? { webSearchEnabled: grant.webSearch } : {}),
    ...(grant?.webFetch !== undefined ? { webFetchEnabled: grant.webFetch } : {}),
  }
}

export function getResearchSessionGrant(projectId: string): ResearchSessionGrant | undefined {
  return getMap().get(projectId)
}

/** @internal test helper */
export function clearResearchSessionGrants(): void {
  getMap().clear()
}
