// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, beforeEach } from 'vitest'

import { executeTool, type WorldStateMutable } from './tool-executor'
import {
  setResearchSessionGrant,
  getResearchSessionGrant,
  clearResearchSessionGrants,
  researchGrantWorldFields,
} from './research-session-grants'
import { isConnectionError } from './mcp-adapter'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

/**
 * Agent-grantable Research mode (TODOS "Agent-grantable Research mode") +
 * the MCP bridge restart recovery (TODOS "MCP connection survives app
 * restart").
 *
 * set_research_mode semantics under test:
 *  - MCP sessions (world.mcpSession): the MCP client's permission prompt IS
 *    the grant — enable applies immediately AND persists to the session
 *    registry so the next per-call world rebuild sees the gates open.
 *  - In-app: enabling without the one-time session grant surfaces the same
 *    permissionNeeded approval card request_web_search uses; with the grant
 *    it applies. Disabling never needs a grant.
 */

function worldWith(overrides?: Partial<WorldStateMutable>): WorldStateMutable {
  const scene = { ...createDefaultScene(), id: 'scene-1', name: 'Scene 1' }
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    projectId: 'proj-research-test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
    ...overrides,
  }
}

beforeEach(() => clearResearchSessionGrants())

describe('set_research_mode — MCP path', () => {
  it('enables the gates immediately and persists the session grant', async () => {
    const world = worldWith({ mcpSession: true })
    expect(world.webSearchEnabled).toBeUndefined()

    const result = await executeTool('set_research_mode', { webSearch: true, webFetch: true, reason: 'stock b-roll' }, world)
    expect(result.success).toBe(true)
    expect(world.webSearchEnabled).toBe(true)
    expect(world.webFetchEnabled).toBe(true)

    // The grant survives to the NEXT world rebuild (the MCP bridge rebuilds
    // the world from the DB on every tool call).
    const grant = getResearchSessionGrant('proj-research-test')
    expect(grant?.webSearch).toBe(true)
    expect(grant?.webFetch).toBe(true)
  })

  it('opens the research-tool gate for a subsequent call on a granted world', async () => {
    const world = worldWith({ mcpSession: true, webSearchEnabled: true })
    // Gate passes — the failure (if any) comes from provider configuration,
    // never the "Web Search is off" gate.
    const result = await executeTool('find_stock_videos', { query: 'ocean' }, world)
    expect(result.error ?? '').not.toMatch(/Web Search is off/i)
  })

  it('still gates LIVE web search without a grant (fail-closed default)', async () => {
    // Stock/archival media discovery is NOT gated by the Web Search grant (own provider
    // APIs — see research-tools L5), so the fail-closed default is demonstrated on
    // web_search itself, the actual live-search tool that requires the grant.
    const world = worldWith({ mcpSession: true }) // no webSearchEnabled
    const result = await executeTool('web_search', { query: 'ocean' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Web Search is off/i)
  })

  it('merges partial grants (webFetch grant keeps a prior webSearch grant)', async () => {
    setResearchSessionGrant('proj-research-test', { webSearch: true })
    setResearchSessionGrant('proj-research-test', { webFetch: true })
    const grant = getResearchSessionGrant('proj-research-test')
    expect(grant?.webSearch).toBe(true)
    expect(grant?.webFetch).toBe(true)
  })

  it('a false patch REVOKES a prior true grant (audit-relevant path)', () => {
    setResearchSessionGrant('proj-research-test', { webSearch: true })
    setResearchSessionGrant('proj-research-test', { webSearch: false })
    expect(getResearchSessionGrant('proj-research-test')?.webSearch).toBe(false)
  })

  it('an empty patch preserves prior fields and advances grantedAt', () => {
    const first = setResearchSessionGrant('proj-research-test', { webSearch: true, reason: 'b-roll' })
    const second = setResearchSessionGrant('proj-research-test', {})
    expect(second.webSearch).toBe(true)
    expect(second.reason).toBe('b-roll')
    expect(second.grantedAt).toBeGreaterThanOrEqual(first.grantedAt)
  })

  it('grant→world-field mapping: false CLOSES the gate, absent leaves it unset', () => {
    expect(researchGrantWorldFields({ webSearch: false, grantedAt: 1 })).toEqual({ webSearchEnabled: false })
    expect(researchGrantWorldFields({ webSearch: true, webFetch: true, grantedAt: 1 })).toEqual({
      webSearchEnabled: true,
      webFetchEnabled: true,
    })
    expect(researchGrantWorldFields(undefined)).toEqual({})
  })
})

describe('set_research_mode — in-app path', () => {
  it('enabling without the session grant surfaces the approval card (permissionNeeded)', async () => {
    const world = worldWith() // not an MCP session, no sessionPermissions
    const result = await executeTool('set_research_mode', { webSearch: true }, world)
    expect(result.success).toBe(false)
    // Kind-less on purpose: the GENERIC approval flow re-dispatches this tool
    // via resumeToolCall, so the grant applies on approval (the 'web_search'
    // kind branch is a text nudge that never re-dispatches).
    expect(result.permissionNeeded?.api).toBe('web_search')
    expect(result.permissionNeeded?.kind).toBeUndefined()
    // Nothing flipped without the grant.
    expect(world.webSearchEnabled).toBeUndefined()
  })

  it('enabling WITH the one-time session grant applies', async () => {
    const world = worldWith({ sessionPermissions: { web_search: 'allow' } as never })
    const result = await executeTool('set_research_mode', { webSearch: true }, world)
    expect(result.success).toBe(true)
    expect(world.webSearchEnabled).toBe(true)
    // In-app grants are run-scoped — nothing persisted to the MCP registry.
    expect(getResearchSessionGrant('proj-research-test')).toBeUndefined()
  })

  it('CONSENT SCOPES ARE SEPARATE: a web_search grant does NOT authorize enabling Web Fetch', async () => {
    const world = worldWith({ sessionPermissions: { web_search: 'allow' } as never })
    const result = await executeTool('set_research_mode', { webFetch: true }, world)
    expect(result.success).toBe(false)
    expect(result.permissionNeeded?.api).toBe('web_fetch') // its own card, its own consent
    expect(world.webFetchEnabled).toBeUndefined()
  })

  it('a web_fetch grant enables Web Fetch (and only that)', async () => {
    const world = worldWith({ sessionPermissions: { web_fetch: 'allow' } as never })
    const result = await executeTool('set_research_mode', { webFetch: true }, world)
    expect(result.success).toBe(true)
    expect(world.webFetchEnabled).toBe(true)
    expect(world.webSearchEnabled).toBeUndefined()
  })

  it('both requested, neither granted: asks for web_search FIRST (sequential cards)', async () => {
    const world = worldWith()
    const result = await executeTool('set_research_mode', { webSearch: true, webFetch: true }, world)
    expect(result.success).toBe(false)
    expect(result.permissionNeeded?.api).toBe('web_search')
  })

  it('disabling never needs a grant', async () => {
    const world = worldWith({ webSearchEnabled: true, webFetchEnabled: true })
    const result = await executeTool('set_research_mode', { webSearch: false, webFetch: false }, world)
    expect(result.success).toBe(true)
    expect(world.webSearchEnabled).toBe(false)
    expect(world.webFetchEnabled).toBe(false)
  })

  it('rejects a call with neither flag', async () => {
    const world = worldWith()
    const result = await executeTool('set_research_mode', { reason: 'just because' }, world)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/webSearch and\/or webFetch/i)
  })

  it('mixed enable+disable: the enable forces the grant; once granted BOTH flips apply', async () => {
    const ungranted = worldWith()
    const r1 = await executeTool('set_research_mode', { webSearch: true, webFetch: false }, ungranted)
    expect(r1.success).toBe(false)
    expect(r1.permissionNeeded).toBeTruthy()
    expect(ungranted.webSearchEnabled).toBeUndefined()
    expect(ungranted.webFetchEnabled).toBeUndefined()

    const granted = worldWith({ sessionPermissions: { web_search: 'allow' } as never })
    const r2 = await executeTool('set_research_mode', { webSearch: true, webFetch: false }, granted)
    expect(r2.success).toBe(true)
    expect(granted.webSearchEnabled).toBe(true)
    expect(granted.webFetchEnabled).toBe(false)
  })
})

describe('mcp-adapter isConnectionError (bridge restart recovery)', () => {
  it('classifies dead-bridge failures as connection errors', () => {
    expect(isConnectionError(new TypeError('fetch failed'))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('boom'), { cause: { code: 'ECONNRESET' } }))).toBe(true)
  })

  it('does NOT classify timeouts or HTTP errors as connection errors', () => {
    expect(isConnectionError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(false)
    expect(isConnectionError(new Error('API 500: /api/mcp-tool — internal'))).toBe(false)
    expect(isConnectionError('not an error')).toBe(false)
  })
})
