import { describe, it, expect } from 'vitest'
import { filterToolsForAgent } from './context-builder'
import { NLE_EDIT_TOOL_NAMES, TIMELINE_TOOLS } from './tools'

/**
 * Scene builders don't edit the master sequence.
 *
 * Builders run one per scene, so anything in their toolset is paid N times over.
 * They were carrying all 23 timeline tools (~6.2k tokens each) despite owning a
 * single scene — the master timeline is assembled by the parent afterwards.
 */
const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'zdog', 'assets', 'audio', 'video']

const offered = (isSubAgent: boolean, allowlist?: string[]) =>
  filterToolsForAgent('scene-maker', STORE_DEFAULT, undefined, undefined, undefined, true, true, allowlist, isSubAgent)

describe('sub-agent timeline scope', () => {
  it('strips master-sequence tools from a scene builder', () => {
    const names = new Set(offered(true).map((t) => t.name))
    const leaked = [...NLE_EDIT_TOOL_NAMES].filter((n) => names.has(n))
    expect(leaked).toEqual([])
  })

  it('leaves the parent surface untouched — the sub-agent strip is not what gates the parent', () => {
    // The parent now gates this set on the `timeline` chip (L1), so "untouched" is
    // tested with the chip ON. That keeps the original point of this assertion — the
    // isSubAgent strip must not bleed into the parent path — while letting the
    // chip be the only thing that decides the parent's copy.
    const names = new Set(
      filterToolsForAgent(
        'scene-maker',
        [...STORE_DEFAULT, 'timeline'],
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
        false,
      ).map((t) => t.name),
    )
    const missing = [...NLE_EDIT_TOOL_NAMES].filter((n) => !names.has(n))
    expect(missing).toEqual([])
  })

  it('the parent gets NOTHING from this set with the chip off (L1)', () => {
    const names = new Set(offered(false).map((t) => t.name))
    const leaked = [...NLE_EDIT_TOOL_NAMES].filter((n) => names.has(n))
    expect(leaked).toEqual([])
  })

  it('keeps the bootstrap/read tools a builder is still pointed at', () => {
    // prompts.ts tells the model to use add_track + place_clip for timeline audio.
    // Stripping those would turn documented guidance into a phantom instruction.
    const names = new Set(offered(true).map((t) => t.name))
    for (const keep of ['init_timeline', 'read_timeline', 'add_track', 'place_clip']) {
      expect(names.has(keep)).toBe(true)
    }
  })

  it('an explicit allowlist still wins', () => {
    // Unlike PARENT_ONLY_TOOL_NAMES (applied before the allowlist on purpose), this
    // strip runs after it — a typed sub-agent that genuinely needs a timeline tool
    // can ask for one.
    const names = offered(true, ['apply_color', 'read_timeline']).map((t) => t.name)
    expect(names).toContain('apply_color')
  })

  it('saves the tokens it claims to', () => {
    const bytesOf = (ts: { name: string }[]) => ts.reduce((s, t) => s + JSON.stringify(t).length, 0)
    // Measure against a chip-ON parent. With the chip off both sides now lack the NLE
    // set, so a sub-vs-parent delta would measure the PARENT_ONLY strip alone (12,315b)
    // and this floor would be asserting something it never meant to.
    const parentWithTimeline = filterToolsForAgent(
      'scene-maker',
      [...STORE_DEFAULT, 'timeline'],
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
    )
    const saved = bytesOf(parentWithTimeline) - bytesOf(offered(true))
    // Measured 22,030b ≈ 5.5k tokens of timeline surface, on top of the pre-existing
    // PARENT_ONLY strip. Floor guards against the filter silently going no-op.
    expect(saved).toBeGreaterThan(20_000)
  })

  it('excludes every timeline tool except the four kept', () => {
    const kept = TIMELINE_TOOLS.filter((t) => !NLE_EDIT_TOOL_NAMES.has(t.name)).map((t) => t.name)
    expect(kept.sort()).toEqual(['add_track', 'init_timeline', 'place_clip', 'read_timeline'])
  })
})
