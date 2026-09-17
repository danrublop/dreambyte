import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_FILTER_CHIPS } from '../agent-tools'
import { DEFAULT_ACTIVE_TOOLS, filterToolsForAgent } from './context-builder'
import { AGENT_TOOLS, ALL_TOOLS } from './tools'
import { getToolDefinitions } from './mcp-adapter'
import { ensureAllHandlersRegistered } from './tool-executor'
import { toolRegistry } from './tool-registry'

/**
 * One source of truth for "which tool categories start enabled".
 *
 * THE BUG: TOOL_FILTER_CHIPS carried `default: true` on all 19 entries while the store
 * shipped 10. Nothing read the flag, so it was invisible — until an audit measured the
 * per-turn tool cost from it and got 132 tools / 40.3k tokens against a real shipped
 * surface of 121 / 36.3k. A 4k-token error in the one number the whole slim-down is
 * being steered by.
 * Pins the count, doesn't police it — raise the numbers when a cut lands
 */
describe('tool defaults have exactly one source', () => {
  const storeSrc = readFileSync(join(__dirname, '..', 'store', 'index.ts'), 'utf8')
  const match = storeSrc.match(/activeTools:\s*\[([^\]]*)\]/)
  const storeDefaults = (match?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)

  it('finds the store default list', () => {
    expect(storeDefaults.length).toBeGreaterThan(0)
  })

  it('every default id is a real chip (or a known chip-less renderer)', () => {
    const chipIds = new Set(TOOL_FILTER_CHIPS.map((c) => c.id))
    // 'react' is the default renderer: always on, reachable via write_scene_code, and
    // deliberately not user-toggleable — so it has no chip.
    const CHIPLESS = new Set(['react'])
    const orphans = storeDefaults.filter((id) => !chipIds.has(id) && !CHIPLESS.has(id))
    expect(orphans).toEqual([])
  })

  it('no chip re-introduces a competing default flag', () => {
    const withFlag = TOOL_FILTER_CHIPS.filter((c) => 'default' in c)
    expect(withFlag).toEqual([])
  })

  it('the shipped surface stays near its measured size', () => {
    const tools = filterToolsForAgent(
      'scene-maker',
      storeDefaults,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
    )
    const bytes = tools.reduce((s, t) => s + JSON.stringify(t).length, 0)

    // Ceilings on the default in-app tool surface. A jump means something was added
    // without anyone pricing it. Ratchet these down to the new measurement when a cut
    // lands; raise them only for a capability the product needs, and say what bought
    // the bytes in the change description.
    expect(tools.length).toBeLessThanOrEqual(67)
    expect(bytes).toBeLessThanOrEqual(85_700) // measured 85,612
  })

  it('does not ship the legacy zdog renderer by default', () => {
    // The planner cannot emit a zdog scene (sceneType is react-only), so its 4 tools
    // were ~976 tokens/turn advertising a renderer no plan can reach. The
    // context-builder gate keyed off this list and its comment claimed they were
    // already gated off — this default was what defeated it.
    expect(storeDefaults).not.toContain('zdog')
  })
})

/**
 * The MCP (Claude Code) surface used to be the RAW registry — `FALLBACK_AGENT_TOOLS`,
 * every name in ALL_TOOLS — so it advertised tools no in-app agent can be offered and
 * quietly kept them alive after they were cut from the agent. It now derives from
 * `AGENT_TOOLS['scene-maker']`, which is what makes that class of drift impossible.
 * Two ceilings and a not-present list, no per-tool policing
 */
describe('MCP surface derives from the agent surface', () => {
  const smNames = new Set(AGENT_TOOLS['scene-maker'].map((t) => t.name))
  const mcpNames = new Set(getToolDefinitions().map((t) => t.name))

  it('offers nothing outside scene-maker — it is now a SUBSET of it', () => {
    // Was `['start_recording']`: MCP_TOOLS hand-added it, and MCP was the one path
    // where it could never work (recording-tools.ts honest-fails it). getToolDefinitions
    // runs filterToolsForAgent now, which filters that array and can only ever remove.
    expect([...mcpNames].filter((n) => !smNames.has(n))).toEqual([])
  })

  it('runs the SAME gate as an in-app run, minus provider readiness', () => {
    // The whole point of routing through filterToolsForAgent: a tool the agent can't
    // be offered isn't offered to Claude Code either. The only permitted divergence is
    // provider-key readiness (`assumeProvidersReady`) — the daemon's env is a stale
    // spawn-time copy of the app's, so gating on it would hide keyed tools.
    const inApp = new Set(
      filterToolsForAgent(
        'scene-maker',
        [...DEFAULT_ACTIVE_TOOLS],
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
        false,
        undefined,
        false,
        true, // same assumeProvidersReady, so the comparison isolates the gate itself
      ).map((t) => t.name),
    )
    // MCP additionally drops the tools whose consumer is the in-app runner/renderer.
    const MCP_DROPS = ['dispatch_to_branches', 'dispatch_to_projects', 'ask_user']
    for (const n of MCP_DROPS) {
      expect(inApp.has(n), `${n} should exist in-app`).toBe(true)
      expect(mcpNames.has(n), `${n} can never work over MCP — don't offer it`).toBe(false)
    }
    expect([...inApp].filter((n) => !mcpNames.has(n)).sort()).toEqual([...MCP_DROPS].sort())
    expect([...mcpNames].filter((n) => !inApp.has(n))).toEqual([])
  })

  it('never advertises request_web_search', () => {
    // Injected dynamically by the context-builder only when web search is being
    // withheld for approval. Listing it on tools/list is a phantom offer.
    expect(mcpNames.has('request_web_search')).toBe(false)
  })

  it('stays within its measured size', () => {
    const tools = getToolDefinitions()
    const bytes = tools.reduce((s, t) => s + JSON.stringify(t).length, 0)
    // getToolDefinitions runs filterToolsForAgent, so the MCP surface takes the same
    // gating as the in-app agent (off-by-default chips, sub-agent dispatchers and
    // start_recording are excluded). Ratchet down when a cut lands; never up without
    // saying what bought the bytes.
    expect(tools.length).toBeLessThanOrEqual(67)
    expect(bytes).toBeLessThanOrEqual(89_000) // measured 88,905
  })

  it('does not resurrect the tools deleted in the L2 cut', () => {
    // Each was offered to NO in-app agent (absent from AGENT_TOOLS['scene-maker'])
    // and called zero times across every run in ~/.dreambyte/agent-runs/ and
    // agent-trace.jsonl. Deleting the schema without deleting the dispatch entry is
    // the usual retirement pattern here, so assert BOTH surfaces.
    const DELETED = [
      'animate_layer',
      'list_motion_presets',
      'pick_design_system',
      'list_design_systems',
      'export_fcpxml',
      'brand_kit',
    ]
    const defined = new Set(ALL_TOOLS.map((t) => t.name))
    ensureAllHandlersRegistered()
    const dispatchable = new Set(toolRegistry.getRegisteredToolNames())
    for (const name of DELETED) {
      expect(defined.has(name), `${name} is back in ALL_TOOLS`).toBe(false)
      expect(mcpNames.has(name), `${name} is back on the MCP surface`).toBe(false)
      expect(dispatchable.has(name), `${name} still has a handler`).toBe(false)
    }
  })

  it('does not resurrect the L3 transcoders — in the surface OR in the prose', () => {
    // The TRANSCODERS: each handler took structured JSON and string-built scene code.
    // apply_canvas_motion_template → buildCanvasAnimationCode(templateId) → Canvas2D JS.
    // three_data_scatter_scene    → buildThreeDataScatterSceneCode()      → a three module.
    // migrate_to_react            → wrapSceneAsReact(scene)               → a React shell
    //                                around the code the scene already had.
    // All three are what write_scene_code does, and it is the most-used tool in the
    // system (408 calls) while these have zero.
    //
    // The second half of this test is the one that catches the real recurring bug. A
    // tool can be deleted from ALL_TOOLS and still be NAMED in the system prompt or in
    // a routed rule pack — three of those PHANTOM INSTRUCTIONS have already shipped
    // here. The model reads the prose, tries the call, and gets an unknown-tool error.
    // So: no prose the agent can be shown may contain these names.
    const DELETED = ['apply_canvas_motion_template', 'three_data_scatter_scene', 'migrate_to_react']

    const defined = new Set(ALL_TOOLS.map((t) => t.name))
    ensureAllHandlersRegistered()
    const dispatchable = new Set(toolRegistry.getRegisteredToolNames())
    for (const name of DELETED) {
      expect(defined.has(name), `${name} is back in ALL_TOOLS`).toBe(false)
      expect(mcpNames.has(name), `${name} is back on the MCP surface`).toBe(false)
      expect(dispatchable.has(name), `${name} still has a handler`).toBe(false)
    }

    // Every prose source that can reach a model: the prompt builder's own literals,
    // the skill library injected per scene by selectSkillsForScene, the OKF rule packs
    // read by get_routed_craft, and the two docs prompt-docs.ts loads verbatim.
    const root = join(__dirname, '..', '..', '..')
    const proseFiles = [
      join(__dirname, 'prompts.ts'),
      ...globMd(join(root, 'src', 'lib', 'skills', 'library')),
      ...globMd(join(root, '.claude', 'skills', 'dreambyte', 'rules')),
      join(root, 'docs', 'agent', 'ROUTER.md'),
      join(root, 'docs', 'agent', 'SYSTEM.md'),
    ].filter((f) => existsSync(f))

    // Guard the guard: if the globs ever resolve to nothing this test would pass
    // vacuously, which is exactly how a phantom slips through.
    expect(proseFiles.length, 'no prose files found — the check would pass vacuously').toBeGreaterThan(5)

    const offenders: string[] = []
    for (const file of proseFiles) {
      const text = readFileSync(file, 'utf8')
      for (const name of DELETED) if (text.includes(name)) offenders.push(`${file} names ${name}`)
    }
    expect(offenders, 'phantom instruction: prose names a tool that no longer exists').toEqual([])
  })

  it('does not resurrect the L4 verb-split members — in the surface OR in the prose', () => {
    // Five tools became two. Each family was one NOUN with several verbs, and the
    // discriminator now carries the verb:
    //   style_skill  action: 'distill' | 'apply' | 'delete'
    //   world_scene  op: 'create' | add_object | remove_object | move_object |
    //                    add_panel | remove_panel | update_camera_path | change_environment
    // Same second half as the L3 guard above, and for the same reason: a deleted name
    // still NAMED in the system prompt or a routed rule pack is a phantom instruction —
    // the model reads the prose, makes the call, and gets an unknown-tool error.
    const DELETED = [
      'distill_style',
      'apply_saved_style',
      'delete_style_skill',
      'create_world_scene',
      'update_world_scene',
      // world_scene itself is now DELETED too (zero calls across 1,051 recorded tool
      // calls; 4,781b of schema), so its successors list drops to style_skill alone.
      'world_scene',
    ]

    const defined = new Set(ALL_TOOLS.map((t) => t.name))
    ensureAllHandlersRegistered()
    const dispatchable = new Set(toolRegistry.getRegisteredToolNames())
    for (const name of DELETED) {
      expect(defined.has(name), `${name} is back in ALL_TOOLS`).toBe(false)
      expect(mcpNames.has(name), `${name} is back on the MCP surface`).toBe(false)
      expect(dispatchable.has(name), `${name} still has a handler`).toBe(false)
    }
    // …and the successors ARE reachable, so this can't pass by deleting the capability.
    for (const name of ['style_skill']) {
      expect(defined.has(name), `${name} missing from ALL_TOOLS`).toBe(true)
      expect(dispatchable.has(name), `${name} has no handler`).toBe(true)
    }

    const root = join(__dirname, '..', '..', '..')
    const proseFiles = [
      join(__dirname, 'prompts.ts'),
      ...globMd(join(root, 'src', 'lib', 'skills', 'library')),
      ...globMd(join(root, '.claude', 'skills', 'dreambyte', 'rules')),
      join(root, 'docs', 'agent', 'ROUTER.md'),
      join(root, 'docs', 'agent', 'SYSTEM.md'),
    ].filter((f) => existsSync(f))
    expect(proseFiles.length, 'no prose files found — the check would pass vacuously').toBeGreaterThan(5)

    const offenders: string[] = []
    for (const file of proseFiles) {
      const text = readFileSync(file, 'utf8')
      for (const name of DELETED) if (text.includes(name)) offenders.push(`${file} names ${name}`)
    }
    expect(offenders, 'phantom instruction: prose names a tool that no longer exists').toEqual([])
  })

  it('does not resurrect the L5 verb-split members — in the surface OR in the prose', () => {
    // Twelve tools became four. Unlike L4's five (zero recorded calls between them),
    // these are the USED surface — find_stock_* alone accounts for 86 calls — so the
    // capability had to survive the rename, not just the name disappear:
    //   element         op:     add | edit | delete
    //   scene_props     op:     duration | background | transition | transition_all
    //   generate_image  source: prompt | reference | regenerate
    //   find_media      kind:   video | image | archival
    // Reachability of every op is asserted in tool-merge-l5.test.ts. This one guards the
    // two ways a merge rots afterwards: a name coming BACK, and prose still naming a
    // name that is gone (a phantom instruction — the model reads it, calls it, and gets
    // an unknown-tool error).
    const DELETED = [
      'add_element',
      'edit_element',
      'delete_element',
      'set_scene_duration',
      'set_scene_background',
      'set_transition',
      'set_all_transitions',
      'generate_image_from_reference',
      'regenerate_asset',
      'find_stock_videos',
      'find_stock_images',
      'find_archival_footage',
    ]

    const defined = new Set(ALL_TOOLS.map((t) => t.name))
    ensureAllHandlersRegistered()
    const dispatchable = new Set(toolRegistry.getRegisteredToolNames())
    for (const name of DELETED) {
      expect(defined.has(name), `${name} is back in ALL_TOOLS`).toBe(false)
      expect(mcpNames.has(name), `${name} is back on the MCP surface`).toBe(false)
      expect(dispatchable.has(name), `${name} still has a handler`).toBe(false)
    }
    // …and the successors ARE reachable, so this can't pass by deleting the capability.
    for (const name of ['element', 'scene_props', 'generate_image', 'find_media']) {
      expect(defined.has(name), `${name} missing from ALL_TOOLS`).toBe(true)
      expect(dispatchable.has(name), `${name} has no handler`).toBe(true)
    }

    const root = join(__dirname, '..', '..', '..')
    const proseFiles = [
      join(__dirname, 'prompts.ts'),
      ...globMd(join(root, 'src', 'lib', 'skills', 'library')),
      ...globMd(join(root, '.claude', 'skills', 'dreambyte', 'rules')),
      join(root, '.claude', 'skills', 'dreambyte', 'SKILL.md'),
      join(root, 'docs', 'agent', 'ROUTER.md'),
      join(root, 'docs', 'agent', 'SYSTEM.md'),
    ].filter((f) => existsSync(f))
    expect(proseFiles.length, 'no prose files found — the check would pass vacuously').toBeGreaterThan(5)

    const offenders: string[] = []
    for (const file of proseFiles) {
      const text = readFileSync(file, 'utf8')
      for (const name of DELETED) if (text.includes(name)) offenders.push(`${file} names ${name}`)
    }
    expect(offenders, 'phantom instruction: prose names a tool that no longer exists').toEqual([])
  })
})

function globMd(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
}
