// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { ALL_TOOLS, AGENT_TOOLS, FALLBACK_AGENT_TOOLS } from './tools'

describe('tool registry', () => {
  it('ALL_TOOLS has no duplicate tool names', () => {
    const seen = new Map<string, number>()
    for (const tool of ALL_TOOLS) {
      seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1)
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1)
    expect(duplicates, `duplicate tool names in ALL_TOOLS: ${duplicates.map(([n]) => n).join(', ')}`).toEqual([])
  })

  it('each AGENT_TOOLS entry has no duplicate tool names within that agent', () => {
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      const seen = new Map<string, number>()
      for (const tool of tools) {
        seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1)
      }
      const duplicates = [...seen.entries()].filter(([, count]) => count > 1)
      expect(duplicates, `agent "${agent}" has duplicates: ${duplicates.map(([n]) => n).join(', ')}`).toEqual([])
    }
  })

  it('every ALL_TOOLS entry has a non-empty description and an input_schema', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name, 'tool must have a name').toBeTruthy()
      expect(tool.description, `tool "${tool.name}" must have a description`).toBeTruthy()
      expect((tool.description ?? '').length, `tool "${tool.name}" description too short`).toBeGreaterThan(10)
      expect(tool.input_schema, `tool "${tool.name}" must have an input_schema`).toBeTruthy()
      expect(tool.input_schema?.type, `tool "${tool.name}" input_schema.type must be "object"`).toBe('object')
    }
  })

  it('A3 stage-1 deleted tools are GONE from every surface', () => {
    // animate_ai_layer and style_scene were deleted outright (not just
    // deprecated-pruned). Replayed calls fail soft via tool-executor's
    // unknown-tool error. Pin that no surface — registry, curated lists,
    // or fallback — resurrects them.
    const DELETED = ['animate_ai_layer', 'style_scene']
    const surfaces: Array<[string, string[]]> = [
      ['ALL_TOOLS', ALL_TOOLS.map((t) => t.name)],
      ['FALLBACK_AGENT_TOOLS', FALLBACK_AGENT_TOOLS.map((t) => t.name)],
      ...Object.entries(AGENT_TOOLS).map(([k, v]) => [`AGENT_TOOLS.${k}`, v.map((t) => t.name)] as [string, string[]]),
    ]
    for (const [label, names] of surfaces) {
      for (const dead of DELETED) {
        expect(names, `${label} resurrects deleted tool "${dead}"`).not.toContain(dead)
      }
    }
  })

  it('every deprecated tool description starts with [DEPRECATED] and points at a replacement', () => {
    // No deprecated tools exist after the A3 stage-1 deletions, but the
    // mechanism stays for the next deprecation cycle — keep the format pinned.
    for (const tool of ALL_TOOLS) {
      if (!tool.deprecated) continue
      expect(tool.description, `${tool.name} must have a description`).toBeTruthy()
      expect(
        tool.description!.startsWith('[DEPRECATED]'),
        `${tool.name} description must start with [DEPRECATED]`,
      ).toBe(true)
      // Must mention `\`some_tool\`` or `some_tool` so callers can find the replacement.
      expect(/`[a-z_]+`/.test(tool.description!), `${tool.name} must reference a replacement tool in backticks`).toBe(
        true,
      )
    }
  })

  it('FALLBACK_AGENT_TOOLS is the deduped registry — no deprecated entries, no name dupes', () => {
    // Sub-agent personas / CLI agent types without a curated AGENT_TOOLS entry
    // are offered THIS list, never raw ALL_TOOLS (A3 stage 1: the raw registry
    // previously leaked deprecated tools into fallback-path prompts).
    const seen = new Set<string>()
    for (const tool of FALLBACK_AGENT_TOOLS) {
      expect(tool.deprecated, `FALLBACK_AGENT_TOOLS contains deprecated tool "${tool.name}"`).toBeFalsy()
      expect(seen.has(tool.name), `FALLBACK_AGENT_TOOLS has duplicate "${tool.name}"`).toBe(false)
      seen.add(tool.name)
    }
    // And it must still cover the non-deprecated registry (same names, deduped).
    const allNonDeprecated = new Set(ALL_TOOLS.filter((t) => !t.deprecated).map((t) => t.name))
    expect(seen.size).toBe(allNonDeprecated.size)
  })

  it('deprecated tools are filtered out of every AGENT_TOOLS subset', () => {
    const deprecatedNames = new Set(ALL_TOOLS.filter((t) => t.deprecated).map((t) => t.name))
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      for (const tool of tools) {
        expect(deprecatedNames.has(tool.name), `agent "${agent}" still exposes deprecated tool "${tool.name}"`).toBe(
          false,
        )
      }
    }
  })

  // The generation handlers (image-video-tools.ts) were complete but their schemas were
  // NEVER registered, so the model could not emit them — the "no AI imagery" bug. These
  // pin that the schemas exist (→ canonical, executeTool won't reject) AND are offered.
  it('AI generation schemas are registered as canonical tools', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name))
    for (const t of ['generate_image', 'generate_veo3_video']) {
      expect(names.has(t), `${t} must be in ALL_TOOLS (else executeTool rejects it)`).toBe(true)
    }
  })

  it('AI generation tools are offered to the scene-maker agent', () => {
    const sceneMaker = new Set(AGENT_TOOLS['scene-maker'].map((t) => t.name))
    for (const t of ['generate_image', 'generate_veo3_video']) {
      expect(sceneMaker.has(t), `${t} must be in AGENT_TOOLS['scene-maker']`).toBe(true)
    }
  })
})
