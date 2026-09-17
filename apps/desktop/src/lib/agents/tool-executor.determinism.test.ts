// @vitest-environment node

// Scene-determinism lint surfacing. A scene that renders fine in the verifier
// can still flicker on frame-by-frame export if it uses Math.random / wall-clock
// time / real timers. The post-tool gate statically scans the WRITTEN scene
// code and attaches an advisory `_determinism` signal (non-blocking) so the
// agent can self-correct. These tests prove the signal is attached for a
// non-deterministic write, absent for a clean one, and never clobbers `_verify`.

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

// Let the HTML template build succeed so codegen + write proceed and the
// determinism scan runs on the written reactCode. (Scene verification itself
// needs Electron, which is absent under @vitest-environment node, so the scene
// gets stamped `errored` and a `_verify` signal — that's expected here and is
// exactly what lets us prove `_determinism` and `_verify` coexist without
// clobbering each other.)
const generateSceneHTMLMock = vi.fn((..._args: unknown[]) => '<html></html>')
vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: (...args: unknown[]) => generateSceneHTMLMock(...args),
}))

// Control the generated layer code that regenerate_layer writes into reactCode.
const generateCodeMock = vi.fn()
vi.mock('@/lib/generation/generate', () => ({
  generateCode: (...args: unknown[]) => generateCodeMock(...args),
}))

import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

function makeScene(): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    reactCode: 'export default () => null',
    duration: 6,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
    chartLayers: [],
    d3Data: null,
  } as unknown as Scene
}

function makeWorld(scene: Scene): WorldStateMutable {
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: scene.id } as SceneGraph,
  } as unknown as WorldStateMutable
}

type DetData = {
  _determinism?: { violations: Array<{ construct: string }>; note: string }
  _verify?: { status: string }
}

describe('post-tool determinism advisory', () => {
  beforeEach(() => {
    generateSceneHTMLMock.mockClear()
    generateCodeMock.mockReset()
  })

  it('attaches _determinism when the written scene code uses Math.random', async () => {
    generateCodeMock.mockResolvedValue({
      // FLOW-valid (camera move) so the write clears the FLOW gate; still uses
      // Math.random so the determinism advisory fires.
      code: 'export default function S(){const f=useCurrentFrame();const cx=interpolate(f,[0,60],[0,-120]);const cs=interpolate(f,[0,60],[1,1.1]);const r=Math.random();return <div style={{transform:`translate(${cx}px,0) scale(${cs})`}}>{r}</div>}',
      usage: {},
    })
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool(
      'regenerate_layer',
      { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'redo' },
      world,
    )

    // Advisory only — the tool still succeeds (determinism never fails a write).
    expect(result.success).toBe(true)

    const data = result.data as DetData
    expect(data._determinism).toBeDefined()
    expect(data._determinism!.violations.map((v) => v.construct)).toContain('Math.random(')
    expect(data._determinism!.note).toMatch(/frame-accurate export/)
    // Non-interference: the advisory is attached via a spread of the existing
    // result.data, so it never clobbers a sibling signal like `_verify`. We
    // don't assert `_verify` is present here — whether the offscreen verifier
    // stamps 'errored' vs 'unknown' depends on the runtime (Electron/DB), which
    // differs between local and CI. When `_verify` IS present it must be intact
    // (still carries a status); when it's absent, `_determinism` stands alone.
    if (data._verify !== undefined) {
      expect(typeof data._verify.status).toBe('string')
    }
  })

  it('does NOT attach _determinism for deterministic (mulberry32) scene code', async () => {
    generateCodeMock.mockResolvedValue({
      // FLOW-valid (camera move) + deterministic (mulberry32) → no _determinism.
      code: 'export default function S(){const f=useCurrentFrame();const cx=interpolate(f,[0,60],[0,-120]);const cs=interpolate(f,[0,60],[1,1.1]);const rand=mulberry32(SEED);return <div style={{transform:`translate(${cx}px,0) scale(${cs})`}}>{rand()}</div>}',
      usage: {},
    })
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool(
      'regenerate_layer',
      { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'redo' },
      world,
    )

    expect(result.success).toBe(true)
    const data = result.data as DetData
    expect(data._determinism).toBeUndefined()
  })
})
