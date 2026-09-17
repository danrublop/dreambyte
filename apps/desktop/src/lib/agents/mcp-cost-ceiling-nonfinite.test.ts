// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// T5 review #2: a non-finite cost estimate (Infinity for an unpriced catalog
// model, or NaN from a bad duration/textLength computation) must BLOCK under a
// ceiling — `NaN > 0` being false would otherwise silently skip the gate and let
// an unpriceable/expensive call through uncapped. Real api/model combos all price
// finite, so we mock the estimator to exercise the guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const estimateMock = vi.fn()
vi.mock('../permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions')>()
  return { ...actual, estimateApiCostUsd: (...args: unknown[]) => estimateMock(...args) }
})

import { checkApiPermission, type WorldStateMutable } from './tool-executor'
import { makeRunCostLedger, type RunCostLedger } from './run-cost-ledger'
import type { APIName, APIPermissions, PermissionConfig } from '../types/permissions'

const cfg = (): PermissionConfig => ({
  mode: 'always_allow',
  sessionLimit: null,
  monthlyLimit: null,
  sessionSpend: 0,
  monthlySpend: 0,
})
const world = (ledger?: RunCostLedger): WorldStateMutable =>
  ({
    apiPermissions: { heygen: cfg() } as unknown as APIPermissions,
    sessionPermissions: {},
    ...(ledger ? { mcpCostLedger: ledger } : {}),
  }) as unknown as WorldStateMutable
const blocked = (r: Awaited<ReturnType<typeof checkApiPermission>>) =>
  !!r && !('permissionNeeded' in r && r.permissionNeeded)

describe('MCP cost ceiling — non-finite estimate (T5 review #2)', () => {
  beforeEach(() => estimateMock.mockReset())

  it('blocks a NaN estimate (unknown cost) and reserves nothing', async () => {
    estimateMock.mockReturnValue(NaN)
    const ledger = makeRunCostLedger(25)
    const r = await checkApiPermission(world(ledger), 'heygen' as APIName)
    expect(blocked(r)).toBe(true)
    expect((r as { error?: string }).error).toMatch(/cost ceiling/i)
    expect(ledger.spentUsd).toBe(0)
  })

  it('blocks an Infinity estimate (unpriced model)', async () => {
    estimateMock.mockReturnValue(Infinity)
    const ledger = makeRunCostLedger(25)
    expect(blocked(await checkApiPermission(world(ledger), 'heygen' as APIName))).toBe(true)
    expect(ledger.spentUsd).toBe(0)
  })

  it('IN-APP INERT: a non-finite estimate with no ledger is NOT blocked by the ceiling', async () => {
    estimateMock.mockReturnValue(NaN)
    // No mcpCostLedger -> the ceiling branch never runs; an unpriced call follows
    // the normal in-app permission path (always_allow here -> allowed).
    expect(await checkApiPermission(world(undefined), 'heygen' as APIName)).toBe(null)
  })
})
