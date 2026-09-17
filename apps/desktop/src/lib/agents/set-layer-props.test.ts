import { describe, it, expect } from 'vitest'
import { planLayerPropOps } from './tool-executor'
import { ALL_TOOLS } from './tools'
import { filterToolsForAgent } from './context-builder'
import { LAYER_TOOL_NAMES } from './tool-handlers/layer-tools'
import { AI_LAYER_TOOL_NAMES } from './tool-handlers/ai-layer-tools'

/**
 * set_layer_props replaced seven single-verb setters that all took (sceneId, layerId)
 * and differed only in which field they wrote. Its executor DELEGATES to those original
 * handler cases rather than reimplementing them, so the only new logic is the mapping
 * tested here: which legacy op runs, with which args, in what order.
 */
describe('planLayerPropOps — decomposition', () => {
  const S = 'scene-1'

  it('maps every property group to its legacy op', () => {
    const ops = planLayerPropOps(S, {
      layerId: 'L1',
      opacity: 0.5,
      visible: true,
      startAt: 2,
      filter: 'blur(2px)',
      transform: { x: 100, width: 400 },
      crop: { x: 50, y: 10, width: 800, height: 600 },
      grade: { exposure: 0.2 },
    })
    expect(ops.map((o) => o[0])).toEqual([
      'update_ai_layer',
      'crop_image_layer',
      'set_layer_timing',
      'set_layer_visibility',
      'set_layer_opacity',
      'set_layer_filter',
      'set_layer_grade',
    ])
  })

  it('runs geometry before paint', () => {
    // A resize and a grade in one call must land the same way every time, and crop
    // rewrites width/height that transform also touches.
    const ops = planLayerPropOps(S, { layerId: 'L1', grade: { exposure: 1 }, transform: { width: 10 } })
    expect(ops[0][0]).toBe('update_ai_layer')
    expect(ops[1][0]).toBe('set_layer_grade')
  })

  it('emits nothing for an entry with no properties', () => {
    expect(planLayerPropOps(S, { layerId: 'L1' })).toEqual([])
  })

  it('translates crop to the legacy cropX/cropY/cropWidth/cropHeight arg names', () => {
    const [[, args]] = planLayerPropOps(S, { layerId: 'L1', crop: { x: 25, y: 75, width: 640, height: 480 } })
    expect(args).toEqual({ sceneId: S, layerId: 'L1', cropX: 25, cropY: 75, cropWidth: 640, cropHeight: 480 })
  })

  it('spreads transform fields flat, as update_ai_layer expects', () => {
    const [[, args]] = planLayerPropOps(S, { layerId: 'L1', transform: { x: 5, y: 6, rotation: 90, label: 'hero' } })
    expect(args).toEqual({ sceneId: S, layerId: 'L1', x: 5, y: 6, rotation: 90, label: 'hero' })
  })

  it('resetGrade wins over grade, and passes reset:true', () => {
    const ops = planLayerPropOps(S, { layerId: 'L1', resetGrade: true, grade: { exposure: 0.9 } })
    expect(ops).toHaveLength(1)
    expect(ops[0][0]).toBe('set_layer_grade')
    expect(ops[0][1]).toEqual({ sceneId: S, layerId: 'L1', reset: true })
  })

  it('keeps falsy-but-present values — 0 opacity and false visibility are real edits', () => {
    // The classic bug in this shape: `if (u.opacity)` silently drops a fade-to-zero.
    const ops = planLayerPropOps(S, { layerId: 'L1', opacity: 0, visible: false, startAt: 0 })
    expect(ops.map((o) => o[0]).sort()).toEqual(['set_layer_opacity', 'set_layer_timing', 'set_layer_visibility'])
    expect(ops.find((o) => o[0] === 'set_layer_opacity')![1].opacity).toBe(0)
    expect(ops.find((o) => o[0] === 'set_layer_visibility')![1].visible).toBe(false)
  })

  it('allows an omitted layerId so grade can target the scene video', () => {
    const [[op, args]] = planLayerPropOps(S, { grade: { contrast: 0.3 } })
    expect(op).toBe('set_layer_grade')
    expect(args.layerId).toBeUndefined()
  })

  it('routes each op to the handler that owns it', () => {
    const ops = planLayerPropOps(S, {
      layerId: 'L1',
      opacity: 1,
      filter: 'none',
      transform: { x: 1 },
      crop: { width: 2, height: 3 },
      startAt: 1,
    })
    const owner = Object.fromEntries(ops.map((o) => [o[0], o[2]]))
    expect(owner).toEqual({
      update_ai_layer: 'ai',
      crop_image_layer: 'ai',
      set_layer_filter: 'ai',
      set_layer_opacity: 'layer',
      set_layer_timing: 'layer',
    })
  })
})

describe('set_layer_props — offered surface', () => {
  const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video']
  const offered = new Set(
    filterToolsForAgent('scene-maker', STORE_DEFAULT, undefined, undefined, undefined, true, true, undefined, false).map(
      (t) => t.name,
    ),
  )

  it('replaces all seven single-verb setters', () => {
    expect(offered.has('set_layer_props')).toBe(true)
    for (const gone of [
      'set_layer_opacity',
      'set_layer_visibility',
      'set_layer_timing',
      'set_layer_grade',
      'set_layer_filter',
      'crop_image_layer',
      'update_ai_layer',
    ]) {
      expect(offered.has(gone), `${gone} should no longer be offered`).toBe(false)
    }
  })

  it('the replaced names stay DISPATCHABLE as internal ops', () => {
    // set_layer_props' executor calls the original handlers by name, so those names must
    // stay in the handler name lists — that, not presence in ALL_TOOLS, is what keeps
    // delegation working. (They are correctly absent from ALL_TOOLS: the model must not
    // see seven redundant tools, and MCP shares that registry.)
    const dispatchable = new Set<string>([...LAYER_TOOL_NAMES, ...AI_LAYER_TOOL_NAMES])
    for (const op of planLayerPropOps('s', {
      layerId: 'L',
      opacity: 1,
      visible: true,
      startAt: 0,
      grade: { exposure: 1 },
      filter: 'none',
      transform: { x: 1 },
      crop: { width: 1, height: 1 },
    }).map((o) => o[0])) {
      expect(dispatchable.has(op), `${op} must stay dispatchable for delegation`).toBe(true)
    }
  })

  it('every op the planner can emit is one the model can no longer call directly', () => {
    const emittable = planLayerPropOps('s', {
      layerId: 'L',
      opacity: 1,
      visible: true,
      startAt: 0,
      grade: { exposure: 1 },
      filter: 'none',
      transform: { x: 1 },
      crop: { width: 1, height: 1 },
    }).map((o) => o[0])
    expect(emittable).toHaveLength(7) // all seven replaced tools are reachable via the merge
    for (const op of emittable) expect(offered.has(op)).toBe(false)
  })

  it('covers every property the old tools exposed', () => {
    const props = (ALL_TOOLS.find((t) => t.name === 'set_layer_props')!.input_schema as any).properties.updates.items
      .properties
    expect(Object.keys(props).sort()).toEqual(
      ['crop', 'filter', 'grade', 'layerId', 'opacity', 'resetGrade', 'startAt', 'transform', 'visible'].sort(),
    )
  })
})
