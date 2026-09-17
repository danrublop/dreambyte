import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flowBlockForTool } from './tool-executor'

// The FLOW gate promotes THE FLOW from an advisory warning to a BLOCKING check
// for code-authoring tools on react/motion scenes: code with NO time-driven
// motion of any kind (a static slide) is flipped to failure. Deliberately broad
// about what counts as motion so it does not over-block legitimate CSS/hook
// animation — only a genuinely motionless frame blocks.

const STATIC = 'export default () => <div style={{ fontSize: 120 }}>Hello world</div>'
const INTERPOLATE =
  'export default () => { const x = interpolate(f,[0,60],[0,1]); return <div style={{opacity:x}}>hi</div> }'
const KEYFRAMES = 'export default () => <div style={{ animation: "fadeIn 1s ease" }}>hi</div>'
const HOOK_TRANSFORM =
  'export default () => { const t = useDreambyteTime(); return <div style={{ transform: `translateX(${t}px)` }}>hi</div> }'

describe('flowBlockForTool — blocks only genuinely motionless slides', () => {
  it('blocks a static slide authored by write_scene_code on a react scene', () => {
    expect(flowBlockForTool('write_scene_code', 'react', STATIC)).not.toBeNull()
  })

  it('blocks static slides from every code-authoring tool (patch/motion too)', () => {
    expect(flowBlockForTool('patch_layer_code', 'react', STATIC)).not.toBeNull()
    expect(flowBlockForTool('write_scene_code', 'motion', STATIC)).not.toBeNull()
  })

  it('clears the Remotion interpolate/spring idiom (even a single reveal)', () => {
    expect(flowBlockForTool('write_scene_code', 'react', INTERPOLATE)).toBeNull()
  })

  it('clears legitimate CSS @keyframes animation (no interpolate)', () => {
    expect(flowBlockForTool('write_scene_code', 'react', KEYFRAMES)).toBeNull()
  })

  it('clears a hook-driven (${…}) transform (useDreambyteTime → translate)', () => {
    expect(flowBlockForTool('write_scene_code', 'react', HOOK_TRANSFORM)).toBeNull()
  })

  it('never blocks a non-authoring tool (camera/transition edits)', () => {
    expect(flowBlockForTool('set_camera_motion', 'react', STATIC)).toBeNull()
    expect(flowBlockForTool('set_transition', 'react', STATIC)).toBeNull()
  })

  it('only gates react/motion — charts and 3d have their own motion logic', () => {
    expect(flowBlockForTool('write_scene_code', 'three', STATIC)).toBeNull()
    expect(flowBlockForTool('write_scene_code', 'd3', STATIC)).toBeNull()
  })

  it('clears a static-coded scene that carries a structured cameraMotion track (③.4)', () => {
    // set_camera_motion injects a real time-driven camera move OUTSIDE the code
    // fields — the code-only scan can't see it, so without the track signal a
    // camera-driven scene would be wrongly blocked as a static slide.
    expect(flowBlockForTool('write_scene_code', 'react', STATIC, true)).toBeNull()
    // …but the SAME code with no camera track still blocks.
    expect(flowBlockForTool('write_scene_code', 'react', STATIC, false)).not.toBeNull()
  })

  it('integrates with the golden fixture: camera-travel.good clears the gate', () => {
    const good = readFileSync(join(process.cwd(), 'evals/motion-design/golden/camera-travel.good.txt'), 'utf8')
    expect(flowBlockForTool('write_scene_code', 'react', good)).toBeNull()
  })
})
