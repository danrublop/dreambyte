// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

/**
 * A3 stage 2 — sub-agent tool scoping (parent-only strip).
 *
 * Measured before the change: a scene-builder sub-agent "scoped" to one
 * renderer still received 111 of scene-maker's 134 tools — the category
 * filter narrows add_layer/charts/etc., but the always-available base rode
 * along wholesale, including the dispatch_* family whose execution is
 * guarded to a no-op inside sub-agents (recursion guard + !isSubAgent gates
 * in the runner). These tests pin the strip and its lockstep contract.
 */

import { describe, it, expect } from 'vitest'
import { filterToolsForAgent } from './context-builder'
import { buildSceneMakerPrompt } from './prompts'
import {
  ALL_TOOLS,
  AGENT_TOOLS,
  PARENT_ONLY_TOOL_NAMES,
  SUB_AGENT_BUILD_TOOL_NAMES,
  NLE_EDIT_TOOL_NAMES,
} from './tools'

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)

describe('PARENT_ONLY_TOOL_NAMES lockstep', () => {
  it('every parent-only name is a REAL registry tool (a rename must break this)', () => {
    const registry = new Set(ALL_TOOLS.map((t) => t.name))
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(registry.has(name), `"${name}" is in PARENT_ONLY_TOOL_NAMES but not in ALL_TOOLS`).toBe(true)
    }
  })

  it('every parent-only tool is actually offered to the PARENT (the strip removes something real)', () => {
    const parent = new Set(names(AGENT_TOOLS['scene-maker']))
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(parent.has(name), `"${name}" not offered to the parent — stale entry?`).toBe(true)
    }
  })
})

describe('filterToolsForAgent with isSubAgent', () => {
  it('strips every parent-only tool from a sub-agent offering (and ONLY the two strips)', () => {
    const parent = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true)
    const sub = filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true, undefined, true)
    const subNames = new Set(names(sub))
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(subNames.has(name), `sub-agent still offered "${name}"`).toBe(false)
    }
    // Exactly the parent set minus the two documented strips — nothing else changes.
    // NLE_EDIT_TOOL_NAMES is the master-sequence surface (clips, grade,
    // captions): a builder owns one scene, the parent assembles the timeline.
    // See subagent-timeline-scope.test.ts.
    const expected = names(parent).filter((n) => !PARENT_ONLY_TOOL_NAMES.has(n) && !NLE_EDIT_TOOL_NAMES.has(n))
    expect(names(sub)).toEqual(expected)
  })

  it('scene-builder category scoping composes with the strip (svg sub-agent)', () => {
    const sub = filterToolsForAgent(
      'scene-maker',
      ['svg', 'audio', 'assets'],
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      true,
    )
    const subNames = new Set(names(sub))
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(subNames.has(name), `scoped sub-agent still offered "${name}"`).toBe(false)
    }
    // Still gets its build tools — the strip is surgical.
    expect(subNames.has('write_scene_code')).toBe(true)
    expect(subNames.has('verify_scene')).toBe(true)
  })

  it('an allowlist cannot re-admit a parent-only tool (strip runs first)', () => {
    const sub = filterToolsForAgent(
      'scene-maker',
      [],
      undefined,
      undefined,
      undefined,
      true,
      true,
      ['dispatch_subagent', 'inspect'],
      true,
    )
    expect(names(sub)).toEqual(['inspect'])
  })

  it('an ORCHESTRATING parent keeps every dispatch tool (no isSubAgent strip)', () => {
    const parent = new Set(
      names(
        filterToolsForAgent(
          'scene-maker',
          [],
          undefined,
          undefined,
          undefined,
          true,
          true,
          undefined,
          false,
          undefined,
          true,
        ),
      ),
    )
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(parent.has(name), `parent lost "${name}"`).toBe(true)
    }
  })

  it('a SINGLE-AGENT parent (the default) is offered no build-delegation tool', () => {
    const parent = new Set(names(filterToolsForAgent('scene-maker', [], undefined, undefined, undefined, true, true)))
    for (const name of SUB_AGENT_BUILD_TOOL_NAMES) {
      expect(parent.has(name), `single-agent parent still offered "${name}"`).toBe(false)
    }
    // Variations / cross-project are NOT sub-agent build delegation — they fire only on
    // an explicit user ask of their own and never take the current build off the parent.
    expect(parent.has('dispatch_to_branches')).toBe(true)
    expect(parent.has('dispatch_to_projects')).toBe(true)
    // It keeps everything it needs to build the video itself.
    expect(parent.has('plan_scenes')).toBe(true)
    expect(parent.has('write_scene_code')).toBe(true)
  })
})

describe('prompt/schema parity', () => {
  it('the sub-agent prompt variant swaps the delegation section — no stripped tool is instructed', () => {
    const sub = buildSceneMakerPrompt('svg', undefined, true)
    // The swap actually fired (a delegation-header rename must fail here,
    // not silently re-introduce the prompt/schema mismatch).
    expect(sub).toContain('focused sub-agent')
    expect(sub).not.toContain('Delegation mechanics')
    for (const name of PARENT_ONLY_TOOL_NAMES) {
      expect(sub, `sub-agent prompt still instructs "${name}"`).not.toContain(name)
    }
  })

  it('an ORCHESTRATING parent prompt keeps its delegation guidance', () => {
    const parent = buildSceneMakerPrompt(undefined, undefined, false, false)
    expect(parent).toContain('Delegation mechanics')
    expect(parent).toContain('dispatch_scene_builder')
  })

  it('a SINGLE-AGENT parent prompt instructs no tool it will not be offered', () => {
    const solo = buildSceneMakerPrompt(undefined, undefined, false, true)
    expect(solo).toContain('you build the whole video yourself')
    expect(solo).not.toContain('Delegation mechanics')
    for (const name of SUB_AGENT_BUILD_TOOL_NAMES) {
      expect(solo, `single-agent prompt still instructs "${name}"`).not.toContain(name)
    }
    // It still owns the plan surface — planning is not delegation.
    expect(solo).toContain('plan_scenes')
    expect(solo).toContain('write_plan')
  })
})
