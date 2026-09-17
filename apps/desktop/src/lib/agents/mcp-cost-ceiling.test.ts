// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { checkApiPermission, type WorldStateMutable } from './tool-executor'
import { makeRunCostLedger, type RunCostLedger } from './run-cost-ledger'
import { getMcpCostLedger, setMcpMaxRunCost } from './mcp-handler'
import { estimateApiCostUsd } from '../permissions'
import type { APIName, APIPermissions, PermissionConfig } from '../types/permissions'

// A paid provider with a non-zero estimate (the ceiling only gates est > 0).
const API: APIName = 'heygen'
const EST = estimateApiCostUsd(API, { prompt: 'x', model: 'heygen' })

const cfg = (): PermissionConfig => ({
  mode: 'always_allow',
  sessionLimit: null,
  monthlyLimit: null,
  sessionSpend: 0,
  monthlySpend: 0,
})

function world(ledger?: RunCostLedger, api: APIName = API): WorldStateMutable {
  return {
    apiPermissions: { [api]: cfg() } as unknown as APIPermissions,
    sessionPermissions: {},
    ...(ledger ? { mcpCostLedger: ledger } : {}),
  } as unknown as WorldStateMutable
}

const allowed = (r: Awaited<ReturnType<typeof checkApiPermission>>) => r === null
const blocked = (r: Awaited<ReturnType<typeof checkApiPermission>>) =>
  !!r && !('permissionNeeded' in r && r.permissionNeeded)

describe('MCP cost ceiling (T5)', () => {
  it('sanity: the chosen provider has a non-zero cost estimate', async () => {
    expect(EST).toBeGreaterThan(0)
  })

  it('allows a paid call under the cap AND reserves the estimate', async () => {
    const ledger = makeRunCostLedger(EST * 2)
    expect(allowed(await checkApiPermission(world(ledger), API, { details: { model: 'heygen' } }))).toBe(true)
    expect(ledger.spentUsd).toBeCloseTo(EST, 6)
  })

  it('blocks a paid call whose estimate would push spend past the cap (err, not an ask)', async () => {
    const ledger = makeRunCostLedger(EST * 0.5)
    const r = await checkApiPermission(world(ledger), API, { details: { model: 'heygen' } })
    expect(blocked(r)).toBe(true)
    expect(r && 'permissionNeeded' in r && r.permissionNeeded).toBeFalsy()
    expect((r as { error?: string }).error).toMatch(/cost ceiling/i)
    // A blocked call must NOT have reserved anything.
    expect(ledger.spentUsd).toBe(0)
  })

  it('accumulates across calls and blocks the one that crosses the cap', async () => {
    const ledger = makeRunCostLedger(EST * 1.5) // room for exactly one call
    expect(allowed(await checkApiPermission(world(ledger), API, { details: { model: 'heygen' } }))).toBe(true)
    expect(ledger.spentUsd).toBeCloseTo(EST, 6)
    // second call: spent (EST) + EST = 2*EST > 1.5*EST -> blocked, spend unchanged
    expect(blocked(await checkApiPermission(world(ledger), API, { details: { model: 'heygen' } }))).toBe(true)
    expect(ledger.spentUsd).toBeCloseTo(EST, 6)
  })

  it('never gates free stock search (estimate $0) even at a $0 cap', async () => {
    const ledger = makeRunCostLedger(0)
    // unsplash estimates to $0 -> the est>0 guard skips the ceiling entirely
    expect(allowed(await checkApiPermission(world(ledger, 'unsplash'), 'unsplash'))).toBe(true)
    expect(ledger.spentUsd).toBe(0)
  })

  it('IN-APP INERT: with no mcpCostLedger the ceiling never fires (would-exceed call is allowed)', async () => {
    // No ledger on world -> the guarded branch is skipped; the in-app agent path
    // is unaffected (its spend cap is governed by RunCostLedger in runner.ts).
    expect(allowed(await checkApiPermission(world(undefined), API, { details: { model: 'heygen' } }))).toBe(true)
  })
})

describe('MCP cost ledger is a SINGLE global ledger (security review #1)', () => {
  // A per-project ledger let an agent reset the cap by creating projects
  // (each fresh project = a fresh $25 cap = unbounded total spend). The ledger
  // must be one object for the whole session so spend can't be reset by switching
  // projects. This guards against a regression back to per-project keying.
  it('getMcpCostLedger() returns the same object every call (not keyed by project)', async () => {
    expect(getMcpCostLedger()).toBe(getMcpCostLedger())
  })

  it('set_max_run_cost adjusts that one shared ledger', async () => {
    setMcpMaxRunCost(7.25)
    expect(getMcpCostLedger().capUsd).toBe(7.25)
    setMcpMaxRunCost(25) // restore default for any later test ordering
  })
})
