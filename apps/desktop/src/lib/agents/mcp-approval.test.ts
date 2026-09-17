// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// T6: inline approval over MCP. Paid providers default to always_ask, so over MCP
// a paid call returns permission-needed. approve_pending_generation adds the
// provider to a per-project grant set that mcp-handler reads into
// world.sessionPermissions (api -> 'allow'); the existing always_ask + session-allow
// path in checkApiPermission then lets the call proceed — WITHOUT bypassing the T5
// cost ceiling. These tests exercise that gate behavior directly.
import { describe, it, expect } from 'vitest'
import { checkApiPermission, type WorldStateMutable } from './tool-executor'
import { makeRunCostLedger, type RunCostLedger } from './run-cost-ledger'
import type { APIName, APIPermissions, PermissionConfig } from '../types/permissions'

// imageGen: paid, cheap estimate (~$0.04) — below the $0.50 single-call threshold,
// so a session-allow grant lets it proceed without re-prompting.
const API: APIName = 'imageGen'

const cfg = (): PermissionConfig => ({
  mode: 'always_ask',
  sessionLimit: null,
  monthlyLimit: null,
  sessionSpend: 0,
  monthlySpend: 0,
})

function world(opts: { approved?: boolean; ledger?: RunCostLedger }): WorldStateMutable {
  return {
    apiPermissions: { [API]: cfg() } as unknown as APIPermissions,
    // This is exactly what mcp-handler builds from the approval grant set.
    sessionPermissions: opts.approved ? { [API]: 'allow' } : {},
    ...(opts.ledger ? { mcpCostLedger: opts.ledger } : {}),
  } as unknown as WorldStateMutable
}

const allowed = (r: Awaited<ReturnType<typeof checkApiPermission>>) => r === null
const ask = (r: Awaited<ReturnType<typeof checkApiPermission>>) => !!r && 'permissionNeeded' in r && !!r.permissionNeeded
const blocked = (r: Awaited<ReturnType<typeof checkApiPermission>>) =>
  !!r && !('permissionNeeded' in r && r.permissionNeeded)

describe('MCP inline approval (T6)', () => {
  it('an always_ask provider with NO approval returns permission-needed (ask)', async () => {
    expect(ask(await checkApiPermission(world({}), API, { details: { model: 'flux' } }))).toBe(true)
  })

  it('an approved (session-allow) cheap provider proceeds', async () => {
    expect(allowed(await checkApiPermission(world({ approved: true }), API, { details: { model: 'flux' } }))).toBe(true)
  })

  it('approval does NOT bypass the cost ceiling — an approved call past the cap is still blocked', async () => {
    const ledger = makeRunCostLedger(0.01) // tiny cap, below imageGen's ~$0.04 estimate
    const r = await checkApiPermission(world({ approved: true, ledger }), API, { details: { model: 'flux' } })
    expect(blocked(r)).toBe(true)
    expect((r as { error?: string }).error).toMatch(/cost ceiling/i)
    // The cost gate runs before the session-allow logic, so nothing was reserved on the block.
    expect(ledger.spentUsd).toBe(0)
  })

  it('an approved call UNDER the cap proceeds and reserves its estimate', async () => {
    const ledger = makeRunCostLedger(5)
    expect(allowed(await checkApiPermission(world({ approved: true, ledger }), API, { details: { model: 'flux' } }))).toBe(true)
    expect(ledger.spentUsd).toBeGreaterThan(0)
  })
})
