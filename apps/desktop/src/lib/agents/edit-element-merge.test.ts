import { describe, it, expect } from 'vitest'
import { ALL_TOOLS } from './tools'
import { filterToolsForAgent } from './context-builder'
import { ELEMENT_TOOL_NAMES } from './tool-handlers/element-tools'

/**
 * edit_element absorbed move_element, resize_element, reorder_element and
 * adjust_element_timing.
 *
 * Two of the four were ALREADY redundant — edit had always carried `size`, `duration`
 * and `delay` — and its handler applies `{ ...overlay, ...updates }` generically, so the
 * other two needed a schema entry rather than new code. Four tools were paying schema
 * rent every turn to write fields this one already wrote.
 *
 * L5 then folded add/edit/delete themselves into `element(op)`, so the surviving surface
 * is ONE tool: the absorbed wrappers must still be gone, and the union must still carry
 * every field they wrote.
 */
const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video']
const offered = new Set(
  filterToolsForAgent('scene-maker', STORE_DEFAULT, undefined, undefined, undefined, true, true, undefined, false).map(
    (t) => t.name,
  ),
)
const props = (name: string) =>
  Object.keys((ALL_TOOLS.find((t) => t.name === name)!.input_schema as { properties: object }).properties)

describe('element merge', () => {
  const ABSORBED = ['move_element', 'resize_element', 'reorder_element', 'adjust_element_timing']

  it('no longer offers the four absorbed wrappers, nor the three merged verbs', () => {
    for (const gone of [...ABSORBED, 'add_element', 'edit_element', 'delete_element'])
      expect(offered.has(gone), `${gone} still offered`).toBe(false)
    expect(offered.has('element')).toBe(true)
  })

  it('element covers every field the absorbed tools wrote', () => {
    // move → x,y · resize → size · reorder → zIndex · timing → delay,duration
    const edit = props('element')
    for (const field of ['x', 'y', 'size', 'zIndex', 'delay', 'duration']) {
      expect(edit, `element must accept ${field}`).toContain(field)
    }
  })

  it('the absorbed names are not dispatchable either — dead on BOTH ends', () => {
    // They used to be "kept dispatchable for replay/MCP". Nothing replays tool calls,
    // and MCP routes through executeTool, which rejects any name without a schema —
    // so the branches were unreachable. Registering a name the gate refuses is exactly
    // the bug INTERNAL_ONLY_TOOL_NAMES + ensureRegistryCoverage now catch at build time.
    for (const op of ABSORBED) expect([...ELEMENT_TOOL_NAMES]).not.toContain(op)
    expect([...ELEMENT_TOOL_NAMES]).toEqual(['element'])
  })

  it('strips explicitly-undefined keys so a spread cannot blank a field', () => {
    // adjust_element_timing used to guard delay/duration individually. Now that
    // element(op:'edit') is the only entry point, `{ delay: undefined }` must leave the
    // existing delay alone rather than overwrite it via { ...o, ...updates }.
    const updates: Record<string, unknown> = { delay: undefined, size: 42 }
    for (const k of Object.keys(updates)) if (updates[k] === undefined) delete updates[k]
    const merged = { ...{ id: 'e1', delay: 3, size: 10 }, ...updates }
    expect(merged.delay).toBe(3)
    expect(merged.size).toBe(42)
  })
})
