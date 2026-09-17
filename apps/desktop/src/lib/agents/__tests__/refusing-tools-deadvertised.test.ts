// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ALL_TOOLS } from '../tools'
import { ALWAYS_AVAILABLE_TOOL_NAMES } from '../context-builder'

/**
 * De-advertise guard for fail-honest tools: a tool that refuses must not ride
 * context-builder's "always available" tool list. This source-parity test pins the rule: NO tool in the refusing set
 * may appear in any advertised "always available" list. Their SCHEMAS stay
 * registered (a stray call gets the honest error), but prose/advertised lists
 * must not name them.
 *
 * If this fails because you wired a tool's consumer for real: remove it from
 * REFUSING_TOOLS here AND register the consumer in
 * tool-consumer-registry.test.ts.
 */

// EMPTY: every refusing stub is now DELETED outright rather than de-advertised.
// publish_interactive and request_screen_recording were the last two, and both were
// unreachable anyway — no schema meant executeTool's canonical-name gate answered
// `Unknown tool` before dispatch could reach the refusal.
//
// The guard is kept and re-pointed at the stronger invariant below: a name on the
// always-available list that ISN'T a real offered tool is the same class of lie.
const REFUSING_TOOLS: readonly string[] = []

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

describe('refusing tools are de-advertised (v5 T8)', () => {
  it("context-builder's always-available list names none of the refusing set", () => {
    const src = read('src/lib/agents/context-builder.ts')
    // Extract the always-available array literal (the block between the
    // "These are always available" comment and its `.includes(tool.name)`).
    const m = src.match(/\/\/ These are always available[\s\S]*?\]\.includes\(tool\.name\)/)
    expect(m, 'always-available block not found — did filterToolsForAgent move?').toBeTruthy()
    const block = m![0]
    // Only quoted entries count (comments mentioning a tool by name are fine).
    const entries = Array.from(block.matchAll(/'([a-z0-9_]+)'/g)).map((x) => x[1])
    for (const tool of REFUSING_TOOLS) {
      expect(entries, `refusing tool "${tool}" must not be advertised as always available`).not.toContain(tool)
    }
  })

  it('every always-available name is a real, offered tool', () => {
    // What REFUSING_TOOLS was reaching for: the list must never advertise something
    // the model cannot actually call. Derived, so it covers the next one for free.
    const defined = new Set(ALL_TOOLS.map((t) => t.name))
    const phantom = ALWAYS_AVAILABLE_TOOL_NAMES.filter((n) => !defined.has(n))
    expect(phantom, 'advertised as always available but absent from ALL_TOOLS').toEqual([])
  })

  it('start_recording schema tells the truth about its lifecycle (run-end dispatch, user-stopped)', () => {
    const src = read('src/lib/agents/tools.ts')
    const m = src.match(/name: 'start_recording',\s*\n\s*description:\s*\n?\s*['"`]([^'"`]+)/m)
    expect(m).toBeTruthy()
    expect(m![1]).toMatch(/when this run COMPLETES/i)
    expect(m![1]).toMatch(/cannot stop, pause, or monitor/)
  })
})
