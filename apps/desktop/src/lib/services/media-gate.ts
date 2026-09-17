/**
 * Shared spend / permission gate for in-app media generation.
 *
 * One home for the project-policy check that several generation services need. Reads the project's
 * stored apiPermissions and runs checkPermission for `api`. Mirrors the gate that has lived inline
 * in startVideo and (briefly) generateImageAsset — extracting it here makes the gate unit-testable
 * for the first time and stops the three copies from drifting (the drift that caused the i2i
 * estimate-vs-cap bug).
 *
 *   gateMediaSpend(projectId, api, details)
 *     ├─ no projectId            → null  (nothing to gate against)
 *     ├─ project row missing     → null  (can't read policy → don't block; logSpend still records)
 *     ├─ checkPermission 'deny'  → { denied, reason }   (cap exceeded / api disabled / denied)
 *     └─ 'ask' | 'allow'         → null  (both proceed)
 *
 * Outcomes:
 *   'deny'  → { denied, reason }            — the spend-cap / disabled path; always blocks.
 *   'ask'   → null (default)                — proceeds, UNLESS the caller opts in with
 *             { surfaceAsk: true } → returns { ask, permissionNeeded } so the renderer can pop the
 *             always-ask modal. After the user approves, the caller re-invokes with
 *             { approvedAsk: true } (or persists always_allow to project policy) and the gate
 *             returns null = proceed. `approvedAsk` only satisfies an 'ask' prompt — it can NEVER
 *             turn a 'deny' (cap exceeded / api disabled) into a proceed.
 *   'allow' → null                          — proceeds.
 *
 * Surfacing 'ask' is opt-in (overload) so callers that don't yet render the modal (audio / character
 * reuse / lipsync) keep their current proceed-on-ask behavior and their narrow `MediaSpendDenial`
 * return type — no churn. Wired today: image (generateImageAsset) and video (startVideo, inline).
 */

import type { APIName } from '@/lib/types/permissions'

export interface MediaSpendDenial {
  denied: true
  reason: string
}

/** The always-ask block, shaped to drop straight into the renderer's PermissionRequest /
 *  StartVideoResult.permissionNeeded surface. Shared by every gated media service. */
export interface MediaPermissionNeeded {
  api: APIName
  estimatedCost: string
  estimatedCostUsd: number
  costThresholdExceeded?: boolean
  reason: string
  details: { prompt?: string; model?: string }
}

export interface MediaSpendAsk {
  ask: true
  permissionNeeded: MediaPermissionNeeded
}

export interface GateMediaSpendOptions {
  /** Return { ask } instead of proceeding when the project policy says 'ask'. Default false. */
  surfaceAsk?: boolean
  /** The user already approved this 'ask' in the modal — proceed. Never bypasses a 'deny'. */
  approvedAsk?: boolean
}

// Overloads: only callers that opt in with surfaceAsk get the MediaSpendAsk variant in the type.
export async function gateMediaSpend(
  projectId: string | undefined,
  api: APIName,
  details: { model?: string; prompt?: string },
  opts?: { surfaceAsk?: false; approvedAsk?: boolean },
): Promise<MediaSpendDenial | null>
export async function gateMediaSpend(
  projectId: string | undefined,
  api: APIName,
  details: { model?: string; prompt?: string },
  opts: { surfaceAsk: true; approvedAsk?: boolean },
): Promise<MediaSpendDenial | MediaSpendAsk | null>
export async function gateMediaSpend(
  projectId: string | undefined,
  api: APIName,
  details: { model?: string; prompt?: string },
  opts: GateMediaSpendOptions = {},
): Promise<MediaSpendDenial | MediaSpendAsk | null> {
  if (!projectId) return null
  const { db, getProjectApiSpend } = await import('@/lib/db')
  const { projects: projectsTable } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { checkPermission, createDefaultAPIPermissions, createDefaultPermissionConfig, estimateApiCostUsd } =
    await import('@/lib/permissions')

  const row = await db.query.projects.findFirst({
    where: eq(projectsTable.id, projectId),
    columns: { apiPermissions: true },
  })
  if (!row) return null

  const defaults = createDefaultAPIPermissions()
  const stored = (row.apiPermissions as Partial<ReturnType<typeof createDefaultAPIPermissions>> | null) ?? {}
  const permissions = { ...defaults, ...stored }
  // Hydrate the cap counters from the LIVE apiSpend ledger before checking — logSpend writes the
  // ledger, never apiPermissions.sessionSpend/monthlySpend, so without this spendCapExceeded reads
  // a stale zero and the session/monthly dollar caps never fire. (Per-project, per-api.)
  const live = await getProjectApiSpend(projectId, api)
  const cfg = permissions[api] ?? createDefaultPermissionConfig()
  permissions[api] = { ...cfg, sessionSpend: live.session, monthlySpend: live.monthly }
  const estimatedCostUsd = estimateApiCostUsd(api, { prompt: details.prompt, model: details.model })
  const permission = checkPermission(
    permissions,
    api,
    `~$${estimatedCostUsd.toFixed(3)}`,
    'Generate media',
    { prompt: details.prompt, model: details.model },
    new Map(),
    { estimatedCostUsd },
  )
  if (permission.action === 'deny') return { denied: true, reason: permission.reason }
  if (permission.action === 'ask' && opts.surfaceAsk && !opts.approvedAsk) {
    return {
      ask: true,
      permissionNeeded: {
        api,
        estimatedCost: `~$${estimatedCostUsd.toFixed(3)}`,
        estimatedCostUsd,
        costThresholdExceeded: permission.request.costThresholdExceeded,
        reason: permission.request.reason,
        details: { prompt: details.prompt, model: details.model },
      },
    }
  }
  return null
}
