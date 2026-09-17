// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy dynamic deps gateMediaSpend imports. The function does `await import(...)` for
// db / schema / drizzle / permissions; vi.mock intercepts dynamic imports too.
const findFirst = vi.fn()
const getProjectApiSpend = vi.fn()
vi.mock('@/lib/db', () => ({
  db: { query: { projects: { findFirst: (...a: unknown[]) => findFirst(...a) } } },
  getProjectApiSpend: (...a: unknown[]) => getProjectApiSpend(...a),
}))
vi.mock('@/lib/db/schema', () => ({ projects: { id: 'projects.id' } }))
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }))

const checkPermission = vi.fn()
vi.mock('@/lib/permissions', () => ({
  checkPermission: (...a: unknown[]) => checkPermission(...a),
  createDefaultAPIPermissions: () => ({ imageGen: { mode: 'always_ask', sessionSpend: 0, monthlySpend: 0 } }),
  createDefaultPermissionConfig: () => ({
    mode: 'always_ask',
    sessionSpend: 0,
    monthlySpend: 0,
    sessionLimit: null,
    monthlyLimit: null,
    singleCallCostThreshold: null,
  }),
  estimateApiCostUsd: () => 0.04,
}))

import { gateMediaSpend } from './media-gate'

describe('gateMediaSpend', () => {
  beforeEach(() => {
    findFirst.mockReset()
    checkPermission.mockReset()
    getProjectApiSpend.mockReset()
    getProjectApiSpend.mockResolvedValue({ session: 0, monthly: 0 })
  })

  it('returns null without touching the db when projectId is absent', async () => {
    const out = await gateMediaSpend(undefined, 'imageGen', { model: 'flux-schnell', prompt: 'p' })
    expect(out).toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('returns null when the project row is missing (can not read policy → do not block)', async () => {
    findFirst.mockResolvedValue(null)
    const out = await gateMediaSpend('proj1', 'imageGen', { model: 'flux-schnell', prompt: 'p' })
    expect(out).toBeNull()
  })

  it('returns a denial when the policy DENIES (cap exceeded / api disabled)', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({ action: 'deny', reason: 'Monthly spend cap reached.' })
    const out = await gateMediaSpend('proj1', 'imageGen', { model: 'flux-1.1-pro', prompt: 'p' })
    expect(out).toEqual({ denied: true, reason: 'Monthly spend cap reached.' })
  })

  it('returns null on ASK (always_ask default proceeds — interactive approval is a follow-up)', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({ action: 'ask', request: {} })
    const out = await gateMediaSpend('proj1', 'imageGen', { model: 'flux-schnell', prompt: 'p' })
    expect(out).toBeNull()
  })

  it('returns null on ALLOW', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({ action: 'allow' })
    const out = await gateMediaSpend('proj1', 'imageGen', { model: 'flux-schnell', prompt: 'p' })
    expect(out).toBeNull()
  })

  it('surfaces ASK as a permissionNeeded block when surfaceAsk is opted in', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({
      action: 'ask',
      request: { reason: 'Generate media', costThresholdExceeded: false },
    })
    const out = await gateMediaSpend(
      'proj1',
      'imageGen',
      { model: 'flux-1.1-pro', prompt: 'a cat' },
      { surfaceAsk: true },
    )
    expect(out).toMatchObject({
      ask: true,
      permissionNeeded: {
        api: 'imageGen',
        estimatedCostUsd: 0.04,
        reason: 'Generate media',
        details: { prompt: 'a cat', model: 'flux-1.1-pro' },
      },
    })
  })

  it('proceeds (null) on ASK when the user already approved — approvedAsk satisfies the prompt', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({ action: 'ask', request: { reason: 'Generate media' } })
    const out = await gateMediaSpend(
      'proj1',
      'imageGen',
      { model: 'flux-schnell', prompt: 'p' },
      { surfaceAsk: true, approvedAsk: true },
    )
    expect(out).toBeNull()
  })

  it('approvedAsk NEVER bypasses a DENY (cap exceeded / api disabled still blocks)', async () => {
    findFirst.mockResolvedValue({ apiPermissions: {} })
    checkPermission.mockReturnValue({ action: 'deny', reason: 'Monthly spend cap reached.' })
    const out = await gateMediaSpend(
      'proj1',
      'imageGen',
      { model: 'flux-1.1-pro', prompt: 'p' },
      { surfaceAsk: true, approvedAsk: true },
    )
    expect(out).toEqual({ denied: true, reason: 'Monthly spend cap reached.' })
  })

  it('hydrates the cap counters from the live ledger before checking (the stale-spend fix)', async () => {
    // Without hydration, spendCapExceeded reads apiPermissions.sessionSpend (a stale 0) and the
    // cap never fires. Assert the permissions handed to checkPermission carry the LIVE spend.
    findFirst.mockResolvedValue({
      apiPermissions: { imageGen: { mode: 'always_ask', sessionLimit: 5, monthlyLimit: 20 } },
    })
    getProjectApiSpend.mockResolvedValue({ session: 7.5, monthly: 12 })
    checkPermission.mockReturnValue({ action: 'allow' })
    await gateMediaSpend('proj1', 'imageGen', { model: 'flux-schnell', prompt: 'p' })
    const passedPermissions = checkPermission.mock.calls[0][0] as {
      imageGen: { sessionSpend: number; monthlySpend: number }
    }
    expect(passedPermissions.imageGen.sessionSpend).toBe(7.5)
    expect(passedPermissions.imageGen.monthlySpend).toBe(12)
    expect(getProjectApiSpend).toHaveBeenCalledWith('proj1', 'imageGen')
  })
})
