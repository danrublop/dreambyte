import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getToolDefinitions } from './mcp-adapter'

/**
 * One MCP tools/list must never carry the same tool name twice.
 *
 * THE BUG: scripts/mcp/mcp-server.ts hand-defines a few MCP-only tools and then spreads
 * the shared registry after them. `write_scene_code` was in BOTH, so a single
 * tools/list advertised it twice with DIVERGENT schemas — free-form `sceneType` in
 * the local copy vs enum:['react'] in the registry. Which one a client honours is
 * undefined, and the loose copy invited a sceneType the renderer no longer supports.
 *
 * Static assertion rather than an import: scripts/mcp/mcp-server.ts calls main() at module
 * scope, so importing it to inspect the assembled list would start a real server.
 * Regex over the hand-written block — the collision is a name, not a type
 */
describe('MCP tools/list has no duplicate names', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'mcp', 'mcp-server.ts'), 'utf8')

  // The hand-written block runs from the ListTools handler to the registry spread.
  const start = src.indexOf('ListToolsRequestSchema')
  const spread = src.indexOf('...tools.map((t) => ({', start)

  it('locates the hand-written tool block', () => {
    expect(start).toBeGreaterThan(-1)
    expect(spread).toBeGreaterThan(start)
  })

  it('no hand-defined MCP tool shadows a registry tool', () => {
    const block = src.slice(start, spread)
    const handDefined = [...block.matchAll(/^\s*name: '([a-z0-9_]+)',$/gm)].map((m) => m[1])
    expect(handDefined.length).toBeGreaterThan(0) // guard the guard

    const registry = new Set(getToolDefinitions().map((t) => t.name))
    const collisions = handDefined.filter((n) => registry.has(n))
    expect(collisions).toEqual([])
  })

  it('the registry itself has no duplicate names', () => {
    const names = getToolDefinitions().map((t) => t.name)
    expect(names.length).toBe(new Set(names).size)
  })
})
