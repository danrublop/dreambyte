// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Source-parity guards for two silent-success fixes whose failure mode is
 * "a guard that is present but can never fire". A behavioural test cannot tell
 * a guard that never fires from a guard that isn't there — both are green — so
 * these pin the source, the same idiom as tool-consumer-registry.test.ts.
 */

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

describe('E5 — no compaction call that can never fire', () => {
  /**
   * `compactInFlightMessages` gates on `estimateContentTokens`, which scores
   * tool_use / tool_result blocks as ZERO (see its own note in
   * context-builder.ts). An agentic history is almost entirely those blocks, so
   * an unforced call estimates ~0 tokens and returns unchanged EVERY time. Two
   * such calls sat on the periodic context-refresh tick, looking like the
   * long-run safety net while doing nothing.
   *
   * `force: true` is not the fix — the tick fires every N tool-bearing
   * iterations regardless of size, so forcing it would compact constantly. The
   * fix was deletion: the proactive guard at the top of the loop measures with
   * the tool-aware `estimatePromptTokens` against the model's context window,
   * and is now the single trigger.
   */
  it('every compactInFlightMessages call in the runner passes force', () => {
    const src = read('src/lib/agents/runner.ts')
    const calls = [...src.matchAll(/compactInFlightMessages\(messages,\s*\{([\s\S]*?)\}\)/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c[1], `unforced compaction call cannot fire on a tool-heavy history:\n${c[0]}`).toContain('force: true')
    }
  })

  it('the surviving trigger measures with the tool-aware estimator', () => {
    const src = read('src/lib/agents/runner.ts')
    expect(src).toContain('estimatePromptTokens(messages, ctx.systemPrompt.length)')
  })
})

describe('E3 — every export path verifies its artifact', () => {
  /**
   * Both engines used to infer success from control flow: ffmpeg exited 0 and
   * nothing threw, therefore "export complete" — nothing ever looked at the
   * file. These pin a guard on the artifact itself.
   */
  it('the tier3 composite export asserts the artifact before reporting complete', () => {
    const src = read('src/electron/ipc/export-tier3.ts')
    const idx = src.indexOf("log.info('tier3: export complete'")
    expect(idx).toBeGreaterThan(0)
    // The assertion must run BEFORE the "complete" log / return, not after.
    expect(src.slice(0, idx)).toContain('await assertExportArtifact(')
  })

  it('the pixi/WebCodecs concat path verifies its output too', () => {
    const src = read('src/electron/main.ts')
    expect(src).toContain('assertExportArtifact(bin, args.output)')
    // Both return points (single-input shortcut and the stitch path).
    expect([...src.matchAll(/await verifyOutput\(\)/g)]).toHaveLength(2)
  })
})
