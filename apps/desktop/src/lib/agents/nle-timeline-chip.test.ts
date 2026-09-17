import { describe, it, expect } from 'vitest'
import { filterToolsForAgent } from './context-builder'
import { NLE_EDIT_TOOL_NAMES } from './tools'
import { panelToolChips } from '@/lib/agent-tools'
import { useVideoStore } from '@/lib/store'

/**
 * The NLE edit surface costs ~20.6kB on every parent turn and is essentially
 * never agent-called (clip/track edits come from the user), so it sits behind
 * the `timeline` chip, off by default.
 */
const STORE_DEFAULT_TOOLS = useVideoStore.getState().activeTools

const offered = (activeTools: string[]) =>
  new Set(filterToolsForAgent('scene-maker', activeTools, {}, {}, undefined, false, false).map((t) => t.name))

describe('NLE edit surface behind the `timeline` chip', () => {
  it('is OFF under the shipped store default', () => {
    expect(STORE_DEFAULT_TOOLS).not.toContain('timeline')
    const names = offered(STORE_DEFAULT_TOOLS)
    const leaked = [...NLE_EDIT_TOOL_NAMES].filter((n) => names.has(n))
    expect(leaked, 'NLE tools offered despite the timeline chip being off').toEqual([])
  })

  it('is ON when the user flips the chip — the capability is gated, not deleted', () => {
    // A gate that can't be opened is a deletion wearing a costume.
    const names = offered([...STORE_DEFAULT_TOOLS, 'timeline'])
    const missing = [...NLE_EDIT_TOOL_NAMES].filter((n) => !names.has(n))
    expect(missing, 'timeline chip on but these NLE tools never arrived').toEqual([])
  })

  it('keeps the four bootstrap/read timeline tools ungated', () => {
    // prompts.ts points the model at add_track + place_clip for timeline audio, so
    // gating these would turn a live instruction into a phantom one.
    const names = offered(STORE_DEFAULT_TOOLS)
    for (const n of ['init_timeline', 'read_timeline', 'add_track', 'place_clip']) {
      expect(names.has(n), `${n} must stay available with the chip off`).toBe(true)
    }
  })

  it('exposes a chip so the gate is reachable from the UI', () => {
    // This asserted TOOL_FILTER_CHIPS membership when first written, which was NOT
    // reachability — AgentChat rendered a hardcoded list of 8 ids and `timeline` was
    // not among them, so the gate shipped with no handle. Assert the panel set.
    // agent-tool-chips.test.ts covers the rest of the class.
    expect(panelToolChips().map((c) => c.id)).toContain('timeline')
  })
})
