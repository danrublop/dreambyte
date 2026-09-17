/**
 * Executor approval gate for request_web_search. When Auto-Accept is off, the proxy pauses the
 * run with permissionNeeded{kind:'web_search'} unless the user already approved this session.
 * Critically: approval comes ONLY from sessionPermissions — a model-supplied __approved arg must
 * NOT bypass the consent card (the model controls its own tool input).
 */
import { describe, it, expect } from 'vitest'
import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'

// In production request_web_search only exists when Web Search is enabled, so the handler's
// own webSearchEnabled gate is satisfied; mirror that here.
const world = (over: Partial<WorldStateMutable> = {}): WorldStateMutable =>
  ({ scenes: [], globalStyle: { presetId: null }, webSearchEnabled: true, ...over }) as unknown as WorldStateMutable

describe('executeTool — request_web_search approval gate', () => {
  it('returns permissionNeeded(kind=web_search) when not approved', async () => {
    const r = await executeTool('request_web_search', { reason: 'need facts' }, world())
    expect(r.success).toBe(false)
    expect(r.permissionNeeded?.kind).toBe('web_search')
    expect(r.permissionNeeded?.toolArgs).toMatchObject({ reason: 'need facts' })
  })

  it('passes when sessionPermissions.web_search === "allow"', async () => {
    const r = await executeTool('request_web_search', {}, world({ sessionPermissions: { web_search: 'allow' } }))
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ approved: true })
  })

  it('SECURITY: a model-supplied __approved arg does NOT bypass the consent card', async () => {
    const r = await executeTool('request_web_search', { __approved: true }, world())
    expect(r.success).toBe(false)
    expect(r.permissionNeeded?.kind).toBe('web_search')
  })
})
