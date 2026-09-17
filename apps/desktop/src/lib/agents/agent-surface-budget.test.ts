import { describe, it, expect } from 'vitest'
import { buildAgentContext, filterToolsForAgent } from './context-builder'
import { MEDIA_PROVIDERS } from '../media/provider-registry'
import { AUDIO_PROVIDERS } from '../audio/provider-registry'
import type { GlobalStyle, Scene } from '../types'

/**
 * THE PER-TURN BUDGET. This is the test that is supposed to stop the next audit.
 *
 * The surface grows back unless the whole thing is measured: individual tools have
 * owners, the TOTAL does not. Tool schemas are the majority of the fixed per-turn
 * prefix, so prompt-only trimming misses most of the bill.
 *
 * So this asserts the number that actually gets billed, per turn, for both agent kinds.
 * It is a BUDGET, not a freeze: raising a ceiling is fine, doing it without noticing is
 * not. If you are here because this test failed, the diff printed below tells you which
 * half grew.
 *
 * One ceiling per surface, no per-tool policing — the total is the thing
 */

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}
const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video']

/**
 * The fixture used to be keyless and world-less, and that is the whole reason it
 * read comfortably under budget while real runs did not.
 *
 * `isMediaProviderReady` is `!!process.env[p.requiresKey]`, so on a bare CI env
 * every keyed provider reports unavailable and the prompt silently drops its
 * media sections. The old fixture also priced TOOLS with web search on and the
 * PROMPT with it off, because `filterToolsForAgent` took the flags and
 * `ContextOpts` never did. Measuring the cheapest possible configuration and
 * calling it the budget is how a ceiling stays green while the bill grows.
 *
 * So: keys present, every provider enabled, search on for both halves, and a
 * populated timeline. This is the maintainer's own machine, not an empty one.
 */
const PROVIDER_KEYS = [...MEDIA_PROVIDERS, ...AUDIO_PROVIDERS]
  .map((p) => (p as { requiresKey?: string }).requiresKey)
  .filter((k): k is string => !!k)

function withProviderKeys<T>(fn: () => T): T {
  const saved = new Map(PROVIDER_KEYS.map((k) => [k, process.env[k]]))
  for (const k of PROVIDER_KEYS) process.env[k] = 'budget-test-key'
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const ALL_ENABLED = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))

/** A populated timeline — world state scales with it, and real runs have one. */
const SCENES: Scene[] = Array.from({ length: 8 }, (_, i) => ({
  id: `scene-${i + 1}`,
  name: `Scene ${i + 1}`,
  prompt: 'a beat about something real, with a chart and a photo',
  sceneType: 'react',
  duration: 8,
  bgColor: '#000',
  transition: 'none',
  layers: [],
})) as unknown as Scene[]

function measure(isSubAgent: boolean) {
  return withProviderKeys(() => {
    const ctx = buildAgentContext(
      'scene-maker',
      {
        agentType: 'scene-maker',
        activeTools: STORE_DEFAULT,
        sceneContext: 'all',
        isSubAgent,
        // Match what the tool call below is priced with — see the note above.
        webSearchEnabled: true,
        webFetchEnabled: true,
        mediaGenEnabled: ALL_ENABLED(MEDIA_PROVIDERS.map((p) => p.id)),
        audioProviderEnabled: ALL_ENABLED(AUDIO_PROVIDERS.map((p) => p.id)),
      },
      SCENES,
      GLOBAL_STYLE,
      'Budget Test',
      'mp4',
    )
    const tools = filterToolsForAgent(
      'scene-maker',
      STORE_DEFAULT,
      ALL_ENABLED(AUDIO_PROVIDERS.map((p) => p.id)),
      ALL_ENABLED(MEDIA_PROVIDERS.map((p) => p.id)),
      undefined,
      true,
      true,
      undefined,
      isSubAgent,
      // The context above is built as 'mp4'; price the tools the same way or the ruler
      // reports a surface no real mp4 run is ever sent (it was counting use_template,
      // which is interactive-only and now gated out — see context-builder-active-tools).
      'mp4',
    )
    // systemPrompt is the ASSEMBLED whole — staticPrompt / stableCascade / volatileState
    // are substrings of it. Summing the parts double-counts, which is how an earlier
    // measurement reported a prompt nearly twice its real size.
    const promptBytes = (ctx.systemPrompt ?? '').length
    const toolBytes = tools.reduce((s, t) => s + JSON.stringify(t).length, 0)
    return { promptBytes, toolBytes, toolCount: tools.length, total: promptBytes + toolBytes }
  })
}

describe('per-turn agent surface budget', () => {
  // Byte ceilings for the per-turn surface (assembled system prompt + tool schemas),
  // measured with a keyed, 8-scene fixture so key-gated media/audio tools are counted.
  //
  // RATCHET RULE: a ceiling is an UPPER bound, so deleting tools can never fail it —
  // a cut that doesn't move the ceiling banks nothing and the next accretion eats it
  // silently. When you remove surface, lower these numbers to the new measurement in
  // the same change. Raise them only for surface the product genuinely needs, and say
  // what bought the bytes in the change description. `measure()` prices the DEFAULT
  // run (single-agent, no `subAgentsEnabled`).
  const PARENT_CEILING = 115_500 // measured 115,466b / 69 tools ≈ 28.9k tokens
  const SUB_CEILING = 102_600 // measured 102,567b / 65 tools ≈ 25.6k tokens

  it('parent run stays within its per-turn budget', () => {
    const m = measure(false)
    expect(
      m.total,
      `parent per-turn surface grew to ${m.total}b (prompt ${m.promptBytes}b + ${m.toolCount} tools ${m.toolBytes}b)`,
    ).toBeLessThanOrEqual(PARENT_CEILING)
  })

  it('sub-agent stays within its per-turn budget', () => {
    // Sub-agents run one per scene, so every byte here is multiplied by scene count.
    const m = measure(true)
    expect(
      m.total,
      `sub-agent per-turn surface grew to ${m.total}b (prompt ${m.promptBytes}b + ${m.toolCount} tools ${m.toolBytes}b)`,
    ).toBeLessThanOrEqual(SUB_CEILING)
  })

  it('a sub-agent is materially cheaper than a parent', () => {
    // Builders must not quietly re-acquire the parent's surface — that is exactly what
    // had happened with the 23 timeline tools.
    //
    // The ratio moved from 0.85 to 0.90 when the NLE block went behind the `timeline`
    // chip. That is not the guard weakening: most of the sub-agent's old advantage WAS
    // the NLE strip, and now the parent gets it too by default. The gap narrowing
    // because the parent got cheaper is the win, not a regression.
    //
    // The precise invariant this test used to stand in for — a builder never carrying
    // an NLE tool — is asserted directly in subagent-timeline-scope.test.ts, which is
    // where it belongs. This one only guards the coarse "sub < parent" direction.
    const parent = measure(false)
    const sub = measure(true)
    expect(sub.toolCount).toBeLessThan(parent.toolCount)
    expect(sub.total).toBeLessThan(parent.total * 0.9)
  })

  it('tool schemas remain the dominant cost — keep looking here first', () => {
    // Documents WHERE the money is, so the next person to optimize does not spend a
    // week on the prompt again. If this ever flips, the guidance above is stale.
    const m = measure(false)
    expect(m.toolBytes).toBeGreaterThan(m.promptBytes)
  })

  it('reports the split (always passes — this is the readout)', () => {
    const p = measure(false)
    const s = measure(true)
    const pct = (n: number, t: number) => `${Math.round((n / t) * 100)}%`
    console.log(
      `\n  PARENT  prompt ${p.promptBytes}b (${pct(p.promptBytes, p.total)})  ` +
        `tools ${p.toolBytes}b/${p.toolCount} (${pct(p.toolBytes, p.total)})  ` +
        `TOTAL ${p.total}b ≈ ${Math.round(p.total / 4)} tok\n` +
        `  SUB     prompt ${s.promptBytes}b (${pct(s.promptBytes, s.total)})  ` +
        `tools ${s.toolBytes}b/${s.toolCount} (${pct(s.toolBytes, s.total)})  ` +
        `TOTAL ${s.total}b ≈ ${Math.round(s.total / 4)} tok\n`,
    )
    expect(true).toBe(true)
  })
})
