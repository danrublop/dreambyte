// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { GENERATION_FETCH_TIMEOUT_MS } from './mcp-adapter'
import { MEDIA_GEN_TOOL_TIMEOUT_MS, GENERATION_TOOL_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './tool-timeouts'

/**
 * Lane D drift-guard. The MCP bridge fetch timeout for slow tools MUST outlast
 * the server's paid-media deadline, or a legitimate 150s Flux/avatar/dub call
 * is aborted client-side, retried, and the already-billed asset is orphaned +
 * double-charged — over MCP only. The fetch timeout is DERIVED from the shared
 * media tier, so this can only fail if someone re-hardcodes it below the tier.
 */
describe('MCP bridge timeout parity (#lane-d)', () => {
  it('the MCP slow-tool fetch timeout outlasts the in-app paid-media deadline', () => {
    expect(GENERATION_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(MEDIA_GEN_TOOL_TIMEOUT_MS)
  })

  it('the timeout tiers are ordered (default < generation < media)', () => {
    expect(TOOL_TIMEOUT_MS).toBeLessThan(GENERATION_TOOL_TIMEOUT_MS)
    expect(GENERATION_TOOL_TIMEOUT_MS).toBeLessThan(MEDIA_GEN_TOOL_TIMEOUT_MS)
  })
})
