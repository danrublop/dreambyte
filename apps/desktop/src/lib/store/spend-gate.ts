'use client'

import { v4 as uuidv4 } from 'uuid'
import type { APIName, APIPermissions } from '../types'
import type { PermissionRequest } from '../types/permissions'
import type { Get } from './types'

/** The `permissionNeeded` block a gated media IPC returns when the project policy is always-ask. */
export interface PermissionNeededBlock {
  api: string
  estimatedCost: string
  estimatedCostUsd?: number
  costThresholdExceeded?: boolean
  reason?: string
  details?: Record<string, unknown>
}

/** A `permissionNeeded` block → the PermissionRequest the always-ask modal renders. */
export function permissionNeededToRequest(pn: PermissionNeededBlock): PermissionRequest {
  return {
    id: uuidv4(),
    api: pn.api as APIName,
    estimatedCost: pn.estimatedCost,
    estimatedCostUsd: pn.estimatedCostUsd,
    costThresholdExceeded: pn.costThresholdExceeded,
    reason: pn.reason ?? 'Generate media',
    details: (pn.details ?? {}) as PermissionRequest['details'],
  }
}

/**
 * Drive the always-ask modal for an in-app media generation and persist the user's decision.
 *
 *   - opens the modal (requestSpendApproval) and awaits the user
 *   - 'denied'   → returns false (caller cancels, no spend)
 *   - 'always'   → persists apiPermissions[api].mode = 'always_allow' (so the SERVER gate stops
 *                  asking — the renderer can't bypass it) then returns true
 *   - 'once'/'session' → records the session-approval (so 'session' skips the next prompt) and
 *                  returns true; the caller re-dispatches with approvedAsk:true
 *
 * Returns true when the caller should re-dispatch the generation, false when it should cancel.
 */
export async function resolveSpendGate(get: Get, api: string, pn: PermissionNeededBlock): Promise<boolean> {
  const decision = await get().requestSpendApproval(permissionNeededToRequest(pn))
  if (decision.decision === 'denied') return false
  if (decision.scope === 'always') {
    const { createDefaultPermissionConfig } = await import('../permissions')
    const current = get().project.apiPermissions?.[api as keyof APIPermissions] ?? createDefaultPermissionConfig()
    get().updateAPIPermissions({ [api]: { ...current, mode: 'always_allow' } } as Partial<APIPermissions>)
    await get().saveProjectToDb()
  } else {
    get().markSpendApproved(api)
  }
  return true
}
