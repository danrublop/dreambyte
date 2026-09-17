// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Source-parity pins for the add_watermark wiring (v5 T9/E2).
 *
 * add_watermark used to write `world.watermark` and claim "the API route will
 * persist this" — nothing read it on either path, so the watermark never
 * reached project.watermark and never rendered. The wire is a chain across
 * four files; any link silently breaking re-creates the lie, so each link is
 * pinned here (same style as cap-checkpoint.test.ts):
 *
 *   handler (world.watermark) → runner return (updatedWatermark)
 *   → final state_change (src/lib/services/agent-runner.ts)
 *   → store apply (src/lib/hooks/use-agent-run.ts → setWatermark)
 *   and on the MCP path → persistMcpSceneWrite({ watermark }) guarded write.
 */

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

describe('add_watermark wiring (v5 T9/E2)', () => {
  it('runAgent returns updatedWatermark from world.watermark', () => {
    const src = read('src/lib/agents/runner.ts')
    expect(src).toMatch(/updatedWatermark\??:/) // in the return type
    expect(src).toMatch(/updatedWatermark: world\.watermark/) // in the return object(s)
  })

  it('the final state_change payload carries updatedWatermark', () => {
    const src = read('src/lib/services/agent-runner.ts')
    const emitBlock = src.match(/type: 'state_change',[\s\S]{0,1500}?\} as any\)/)
    expect(emitBlock, 'final state_change emit not found in agent-runner.ts').toBeTruthy()
    expect(emitBlock![0]).toContain('updatedWatermark: result.updatedWatermark')
  })

  it('the renderer applies updatedWatermark via store.setWatermark', () => {
    const src = read('src/lib/hooks/use-agent-run.ts')
    expect(src).toMatch(/event\.updatedWatermark !== undefined/)
    expect(src).toMatch(/setWatermark\(event\.updatedWatermark\)/)
  })

  it('the MCP path passes world.watermark into the version-checked persist', () => {
    const src = read('src/lib/agents/mcp-handler.ts')
    expect(src).toMatch(/watermark: world\.watermark/)
    // And persistMcpSceneWrite writes it inside the guarded updateSet.
    expect(src).toMatch(/updateSet\.watermark = watermark/)
  })
})
