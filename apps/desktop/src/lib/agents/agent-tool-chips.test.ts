import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_FILTER_CHIPS, panelToolChips } from '@/lib/agent-tools'
import { useVideoStore } from '@/lib/store'
import { filterToolsForAgent } from './context-builder'
import { NLE_EDIT_TOOL_NAMES } from './tools'

/**
 * A chip existing in TOOL_FILTER_CHIPS is not enough — it must be REACHABLE in the UI
 * (e.g. the `timeline` chip that gates the NLE tools), not dropped by a hardcoded list.
 */
describe('tool filter chips are reachable', () => {
  it('every chip declares a group — invisibility must be a decision, not an accident', () => {
    const ungrouped = TOOL_FILTER_CHIPS.filter((c) => c.group !== 'panel' && c.group !== 'auto')
    expect(ungrouped.map((c) => c.id)).toEqual([])
  })

  it('the panel renders from the data, with no second hand-written id list', () => {
    // The regression was a duplicate list in JSX. Assert the component maps over the
    // helper and that no array-of-ids filter came back.
    const src = readFileSync(join(process.cwd(), 'src/components/AgentChat.tsx'), 'utf8')
    expect(src, 'AgentChat must render panelToolChips()').toContain('panelToolChips()')
    expect(src, 'a hardcoded chip id list is back in AgentChat').not.toMatch(/\[\s*'canvas2d',\s*'svg'/)
  })

  it('a gated capability has a handle: timeline is on the panel', () => {
    // Gating the NLE is only defensible because the user can ungate it.
    expect(panelToolChips().map((c) => c.id)).toContain('timeline')
  })

  it('the timeline handle actually moves the tool surface', () => {
    // End to end: flipping the chip the panel exposes must change what the agent gets.
    const base = useVideoStore.getState().activeTools
    const names = (tools: string[]) =>
      new Set(filterToolsForAgent('scene-maker', tools, {}, {}, undefined, false, false).map((t) => t.name))
    const off = names(base)
    const on = names([...base, 'timeline'])
    expect([...NLE_EDIT_TOOL_NAMES].filter((n) => off.has(n))).toEqual([])
    expect([...NLE_EDIT_TOOL_NAMES].filter((n) => !on.has(n))).toEqual([])
  })
})
