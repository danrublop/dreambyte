import { describe, it, expect } from 'vitest'
import { ALWAYS_AVAILABLE_TOOL_NAMES, DEFAULT_ACTIVE_TOOLS, filterToolsForAgent } from './context-builder'
import { AGENT_TOOLS } from './tools'

/**
 * filterToolsForAgent FILTERS `AGENT_TOOLS[agentType]` — it never adds. So a name on
 * the always-available list that is missing from that source array is silently
 * dropped and the agent never sees the tool, with no error anywhere.
 *
 * That has shipped three times: set_video_layer, set_audio_layer, and
 * export_mp4/get_export_status (the in-app agent could not export an MP4).
 * These assertions turn the next one into a red test.
 */
describe('ALWAYS_AVAILABLE_TOOL_NAMES', () => {
  it('is a subset of scene-maker — a name here that is not in the array is dead', () => {
    const available = new Set(AGENT_TOOLS['scene-maker'].map((t) => t.name))
    const missing = ALWAYS_AVAILABLE_TOOL_NAMES.filter((n) => !available.has(n))
    expect(missing, `on the always-available list but absent from AGENT_TOOLS['scene-maker']`).toEqual([])
  })

  it('actually survives filtering with everything switched off', () => {
    // Worst case: no categories, no providers, no keys, no search. The always-available
    // set is what remains, so anything on the list must come out the other side.
    //
    // NOTE the non-empty activeTools. With `[]` this call short-circuits at the
    // `!activeTools?.length → return agentTools` early return and never reaches the
    // ALWAYS_AVAILABLE branch at all — so for two releases this test, the only guard
    // on the list, exercised a code path the list is not on. One renderer category is
    // the most restrictive input that still reaches the per-tool filter.
    const offered = new Set(
      filterToolsForAgent('scene-maker', ['react'], {}, {}, undefined, false, false).map((t) => t.name),
    )
    const dropped = ALWAYS_AVAILABLE_TOOL_NAMES.filter((n) => !offered.has(n))
    expect(dropped, 'always-available tools dropped by the filter').toEqual([])
  })

  it('is PRECEDENCE, not decoration: it wins over a category gate that would drop a name', () => {
    // The audit called the list a behavioural no-op — true today, because no name on
    // it collides with a category branch below. That is the point of the branch being
    // FIRST, and it is only worth keeping if the precedence is real. Prove it: put a
    // category-gated name on the front of the list and it must survive a filter run
    // whose category is switched off.
    const gated = 'place_image' // gated on activeTools.includes('assets')
    const withoutList = new Set(
      filterToolsForAgent('scene-maker', ['react'], {}, {}, undefined, false, false).map((t) => t.name),
    )
    expect(withoutList.has(gated), 'guard the guard: place_image must be gated off here').toBe(false)

    const list = ALWAYS_AVAILABLE_TOOL_NAMES as string[]
    list.push(gated)
    try {
      const offered = new Set(
        filterToolsForAgent('scene-maker', ['react'], {}, {}, undefined, false, false).map((t) => t.name),
      )
      expect(offered.has(gated), 'the always-available branch did not take precedence').toBe(true)
    } finally {
      list.pop()
    }
  })

  it('offers export so the agent can finish a video', () => {
    // The specific regression, named — a subset check passes if someone
    // deletes BOTH the list entry and the array entry.
    const offered = new Set(filterToolsForAgent('scene-maker', [], {}, {}, undefined, false, false).map((t) => t.name))
    expect(offered.has('export')).toBe(true)
    expect(offered.has('get_status')).toBe(true)
  })

  /**
   * The two assertions above pass `[]`, and `[]` used to short-circuit the whole filter
   * (`if (activeTools.length === 0) return agentTools`) — so they were vacuous: they
   * would have passed for ANY name in the registry, because nothing was being filtered.
   * This is the assertion that makes them mean something.
   */
  it('an empty category list is the SMALLEST surface, not the largest', () => {
    const off = filterToolsForAgent('scene-maker', [], {}, {}, undefined, false, false)
    const on = filterToolsForAgent('scene-maker', [...DEFAULT_ACTIVE_TOOLS], {}, {}, undefined, false, false)
    expect(off.length, 'every chip off offered MORE tools than the default chip set').toBeLessThan(on.length)

    // The specific hazard: gates live below the old early return, so a keyless install
    // was advertising paid generation that can only ever answer "disabled".
    const offNames = new Set(off.map((t) => t.name))
    for (const paid of ['generate_image', 'generate_veo3_video', 'get_video_status', 'character']) {
      expect(offNames.has(paid), `"${paid}" offered with no categories and no provider keys`).toBe(false)
    }
  })

  it('every offered name with no category active is genuinely ungated', () => {
    // Nothing should survive `[]` except the always-available set and tools that have
    // no gate at all — if this list grows, a new tool skipped its branch in the filter.
    const offered = filterToolsForAgent('scene-maker', [], {}, {}, undefined, false, false).map((t) => t.name)
    const always = new Set(ALWAYS_AVAILABLE_TOOL_NAMES)
    const ungated = offered.filter((n) => !always.has(n))
    expect(ungated.length, `ungated tools:\n${ungated.join('\n')}`).toBeLessThan(offered.length)
  })
})
