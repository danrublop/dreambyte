/**
 * resolveWebSearchTools — native swap + Auto-Accept withholding. This is the security-relevant
 * gate: with Auto-Accept off and no session approval, native web_search must be WITHHELD and
 * (native models only) replaced by the request_web_search proxy. Once approved, the real tool
 * returns and the proxy drops. Non-native models never get the proxy.
 */
import { describe, it, expect } from 'vitest'
import { resolveWebSearchTools, REQUEST_WEB_SEARCH_TOOL } from './context-builder'
import type { ClaudeToolDefinition } from './types'

const tools = (...names: string[]): ClaudeToolDefinition[] =>
  names.map((n) => ({ name: n, description: n, input_schema: { type: 'object', properties: {} } }))
const names = (t: ClaudeToolDefinition[]) => t.map((x) => x.name)

const NATIVE = 'claude-sonnet-4-6' as never
const NON_NATIVE = 'ollama/llama3.1:8b' as never

describe('resolveWebSearchTools', () => {
  it('Auto-Accept ON (native model): native web_search present, no proxy', () => {
    const out = names(resolveWebSearchTools(tools('web_search', 'other'), 'anthropic', NATIVE, {
      webSearchEnabled: true,
      autoAcceptWebSearch: true,
    }))
    expect(out).toContain('web_search')
    expect(out).not.toContain(REQUEST_WEB_SEARCH_TOOL.name)
  })

  it('Auto-Accept OFF + unapproved (native model): web_search WITHHELD, proxy injected', () => {
    const out = names(resolveWebSearchTools(tools('web_search', 'other'), 'anthropic', NATIVE, {
      webSearchEnabled: true,
      autoAcceptWebSearch: false,
    }))
    expect(out).not.toContain('web_search')
    expect(out).toContain(REQUEST_WEB_SEARCH_TOOL.name)
    expect(out).toContain('other') // unrelated tools untouched
  })

  it('Auto-Accept OFF + session-approved: native web_search restored, no proxy', () => {
    const out = names(resolveWebSearchTools(tools('web_search'), 'anthropic', NATIVE, {
      webSearchEnabled: true,
      autoAcceptWebSearch: false,
      sessionPermissions: { web_search: 'allow' },
    }))
    expect(out).toContain('web_search')
    expect(out).not.toContain(REQUEST_WEB_SEARCH_TOOL.name)
  })

  it('Auto-Accept OFF + unapproved on a NON-native model: no web_search AND no proxy', () => {
    const out = names(resolveWebSearchTools(tools('web_search'), 'local', NON_NATIVE, {
      webSearchEnabled: true,
      autoAcceptWebSearch: false,
    }))
    expect(out).not.toContain('web_search')
    expect(out).not.toContain(REQUEST_WEB_SEARCH_TOOL.name) // couldSearch=false → no proxy
  })

  it('webSearchEnabled false: no-op (tool already filtered upstream)', () => {
    const input = tools('web_search', 'other')
    expect(resolveWebSearchTools(input, 'anthropic', NATIVE, { webSearchEnabled: false })).toEqual(input)
  })

  it('default (autoAcceptWebSearch undefined) behaves as ON — no withholding', () => {
    const out = names(resolveWebSearchTools(tools('web_search'), 'anthropic', NATIVE, { webSearchEnabled: true }))
    expect(out).toContain('web_search')
    expect(out).not.toContain(REQUEST_WEB_SEARCH_TOOL.name)
  })
})
