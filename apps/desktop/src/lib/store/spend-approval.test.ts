// @vitest-environment node

import { describe, expect, it, beforeEach } from 'vitest'
import { createAgentActions } from './agent-actions'
import type { SpendApprovalDecision } from '../types/permissions'

/**
 * The always-ask spend modal is a Promise bridge: a gen-action calls `requestSpendApproval` and
 * awaits; PermissionDialog calls `resolveSpendApproval` to settle it. The resolver is module-local,
 * so these run against a minimal set/get harness exercising just the three new actions.
 */
function harness() {
  let state: Record<string, unknown> = {
    pendingPermissionRequest: null,
    spendApprovedThisSession: new Set<string>(),
  }
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function' ? (updater as (s: unknown) => object)(state) : updater
    state = { ...state, ...(patch as object) }
  }
  const get = () => state
  const actions = createAgentActions(set as never, get as never) as {
    requestSpendApproval: (req: unknown) => Promise<SpendApprovalDecision>
    resolveSpendApproval: (d: SpendApprovalDecision) => void
    markSpendApproved: (api: string) => void
  }
  return { actions, getState: () => state }
}

const REQ = { id: 'r1', api: 'imageGen', estimatedCost: '~$0.04', reason: 'Generate media', details: {} }

describe('requestSpendApproval / resolveSpendApproval', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
    // Settle any resolver left dangling by a prior test (module-local state).
    h.actions.resolveSpendApproval({ decision: 'denied' })
  })

  it('opens the modal (sets pendingPermissionRequest) and resolves approved with scope', async () => {
    const p = h.actions.requestSpendApproval(REQ)
    expect(h.getState().pendingPermissionRequest).toMatchObject({ api: 'imageGen' })
    h.actions.resolveSpendApproval({ decision: 'approved', scope: 'always' })
    await expect(p).resolves.toEqual({ decision: 'approved', scope: 'always' })
    // Settling clears the request so the dialog hides.
    expect(h.getState().pendingPermissionRequest).toBeNull()
  })

  it('resolves denied when the user declines', async () => {
    const p = h.actions.requestSpendApproval(REQ)
    h.actions.resolveSpendApproval({ decision: 'denied' })
    await expect(p).resolves.toEqual({ decision: 'denied' })
  })

  it('a new request supersedes an unsettled one — the stale awaiter unblocks as denied', async () => {
    const first = h.actions.requestSpendApproval(REQ)
    const second = h.actions.requestSpendApproval({ ...REQ, id: 'r2' })
    await expect(first).resolves.toEqual({ decision: 'denied' })
    h.actions.resolveSpendApproval({ decision: 'approved', scope: 'once' })
    await expect(second).resolves.toEqual({ decision: 'approved', scope: 'once' })
  })

  it('resolveSpendApproval with no pending awaiter is a safe no-op', () => {
    expect(() => h.actions.resolveSpendApproval({ decision: 'denied' })).not.toThrow()
  })

  it('markSpendApproved adds the api to the session-approved set', () => {
    h.actions.markSpendApproved('veo3')
    expect((h.getState().spendApprovedThisSession as Set<string>).has('veo3')).toBe(true)
  })
})
