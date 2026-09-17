// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { ALL_TOOLS, AGENT_TOOLS } from './tools'

describe('tool definitions', () => {
  it('every tool in ALL_TOOLS has a non-empty input_schema (Anthropic API requirement)', () => {
    const broken: Array<{ index: number; name: string; reason: string }> = []
    ALL_TOOLS.forEach((t, i) => {
      if (!t.input_schema) {
        broken.push({ index: i, name: t.name, reason: 'input_schema is missing/undefined' })
      } else if (typeof t.input_schema !== 'object') {
        broken.push({ index: i, name: t.name, reason: `input_schema is ${typeof t.input_schema}` })
      } else if ((t.input_schema as { type?: unknown }).type !== 'object') {
        broken.push({
          index: i,
          name: t.name,
          reason: `input_schema.type is "${(t.input_schema as { type?: unknown }).type}", expected "object"`,
        })
      }
    })
    if (broken.length > 0) {
      throw new Error(
        `Found ${broken.length} broken tool(s):\n` +
          broken.map((b) => `  [${b.index}] ${b.name} — ${b.reason}`).join('\n'),
      )
    }
    expect(broken).toEqual([])
  })

  it('every tool in every AGENT_TOOLS list has a valid input_schema', () => {
    const broken: Array<{ agent: string; index: number; name: string }> = []
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      tools.forEach((t, i) => {
        if (!t.input_schema || typeof t.input_schema !== 'object') {
          broken.push({ agent, index: i, name: t.name })
        }
      })
    }
    if (broken.length > 0) {
      throw new Error(
        `Found ${broken.length} broken tool(s) across agent lists:\n` +
          broken.map((b) => `  ${b.agent}[${b.index}] ${b.name}`).join('\n'),
      )
    }
    expect(broken).toEqual([])
  })

  // Regression: every tool OFFERED to an agent must be CANONICAL (present in
  // ALL_TOOLS), or executeTool returns "Unknown tool" at runtime and aborts the
  // call. This is exactly how create_design_brief failed: offered to scene-maker
  // + mandated first, but absent from ALL_TOOLS.
  it('every tool offered in any AGENT_TOOLS list is canonical (in ALL_TOOLS)', () => {
    const canonical = new Set(ALL_TOOLS.map((t) => t.name))
    const missing: Array<{ agent: string; name: string }> = []
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      for (const t of tools) {
        if (!canonical.has(t.name)) missing.push({ agent, name: t.name })
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Found ${missing.length} offered-but-non-canonical tool(s) (would "Unknown tool" at runtime):\n` +
          missing.map((m) => `  ${m.agent} → ${m.name}`).join('\n'),
      )
    }
    expect(missing).toEqual([])
  })
})
