// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

/**
 * Deleted-tool wiring coverage.
 *
 * tools.test.ts pins the SHAPE invariants (deleted names absent from every
 * list, fallback deduped). These tests pin the WIRING:
 *   1. The production fail-soft for deleted tools is executeTool's
 *      CANONICAL_TOOL_NAMES gate — handler-level tests never see it, so a
 *      replayed 'style_scene' / 'animate_ai_layer' call is exercised through
 *      the real entry point, including the no-mutation guarantee.
 *   2. filterToolsForAgent's `?? FALLBACK_AGENT_TOOLS` branch — every other
 *      test uses 'scene-maker' (curated entry), so a regression back to raw
 *      ALL_TOOLS would pass the whole suite without this.
 *   3. The MCP tools/list surface (getToolDefinitions) inherits the same
 *      pruning — a future `deprecated: true` tool must not re-leak there
 *      while it lingers in ALL_TOOLS for dispatch.
 */

import { describe, it, expect } from 'vitest'
import { executeTool, type WorldStateMutable } from './tool-executor'
import { filterToolsForAgent } from './context-builder'
import { getToolDefinitions } from './mcp-adapter'
import { ALL_TOOLS, FALLBACK_AGENT_TOOLS } from './tools'
import type { AgentType } from './types'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

const DELETED = ['style_scene', 'animate_ai_layer'] as const

function makeWorld(): WorldStateMutable {
  const scene = createDefaultScene()
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
  }
}

describe('deleted tools fail soft at the executor gate (the real replay path)', () => {
  it.each(DELETED)('executeTool(%s) returns Unknown tool and mutates nothing', async (name) => {
    const world = makeWorld()
    const sceneId = world.scenes[0].id
    const snapshot = JSON.stringify(world.scenes)
    const result = await executeTool(name, { sceneId, bgColor: '#fefefe', layerId: 'l1', animation: 'fade-in' }, world)
    expect(result.success).toBe(false)
    expect(result.error ?? '').toMatch(/Unknown tool/)
    expect(JSON.stringify(world.scenes)).toBe(snapshot)
  })
})

describe('fallback wiring — agent types without a curated AGENT_TOOLS entry', () => {
  it('filterToolsForAgent serves the DEDUPED fallback, not raw ALL_TOOLS', () => {
    const names = filterToolsForAgent(
      'no-such-agent' as AgentType,
      [],
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
      undefined,
      // Orchestrating run: this test is about the fallback REGISTRY, so measure the
      // full offering rather than the single-agent default's build-delegation strip.
      true,
    ).map((t) => t.name)
    // Deduped: no name dupes.
    expect(new Set(names).size).toBe(names.length)
    // Deleted names never resurface via the fallback.
    for (const dead of DELETED) expect(names).not.toContain(dead)
    // Distinguishes the fallback from raw ALL_TOOLS: any tool tagged
    // deprecated in the registry must be absent from the offered list.
    for (const t of ALL_TOOLS) {
      if (t.deprecated) expect(names, `deprecated "${t.name}" leaked into the fallback offering`).not.toContain(t.name)
    }
    // And its SOURCE is the fallback, not raw ALL_TOOLS: every offered name comes from
    // FALLBACK_AGENT_TOOLS, and there is at least one ALL_TOOLS name that never appears.
    // (This was an exact set-equality check, which only held because `activeTools: []`
    // short-circuited the filter and returned the source array untouched. With the
    // category and provider gates actually running, the offering is a strict subset —
    // that is the point of the gates, so assert the containment, not the identity.)
    const fallbackNames = new Set(FALLBACK_AGENT_TOOLS.map((t) => t.name))
    for (const n of names) expect(fallbackNames, `"${n}" is not in the fallback array`).toContain(n)
    expect(
      ALL_TOOLS.some((t) => !names.includes(t.name)),
      'offering is indistinguishable from raw ALL_TOOLS',
    ).toBe(true)
  })
})

describe('MCP tools/list surface (getToolDefinitions)', () => {
  it('inherits dedup pruning — no deprecated entries, no dupes, no deleted names', () => {
    const tools = getToolDefinitions()
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of tools) expect(t.deprecated, `MCP surface offers deprecated "${t.name}"`).toBeFalsy()
    for (const dead of DELETED) expect(names).not.toContain(dead)
  })
})
