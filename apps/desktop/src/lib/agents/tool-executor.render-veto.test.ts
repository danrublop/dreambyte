// @vitest-environment node

// Pixel-truth veto (the BLOCKING render gate): when a verified scene's frame is
// essentially blank, or every image failed to load, the post-tool gate must flip
// the tool result to success:false and attach a `result.data._render` signal with
// a fix hint — driving the agent / sub-agent into a corrective pass. A healthy
// frame must pass untouched. This is the closed loop that the audit found missing
// (advisory-only signals never blocked). Mirrors the layout-overflow test harness
// but uses the REAL evaluateRenderBlock policy (only verifyAndStampScene mocked).

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { SceneFrameTruth } from '@/lib/services/scene-verifier'

vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: () => '<html><body><h1>hi</h1></body></html>',
}))

vi.mock('@/lib/generation/generate', () => ({
  generateCode: vi.fn(async () => ({ code: 'export default () => null', usage: {} })),
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    default: {
      ...actual,
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    },
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
  }
})

// Controllable verify outcome. `frame` is what the offscreen render would have
// measured. Status is always 'verified' — the scene RAN; blankness is a separate
// quality verdict the gate applies. Keep the REAL evaluateRenderBlock so the test
// exercises the actual policy, not a re-implementation.
let mockFrame: SceneFrameTruth | undefined = undefined
vi.mock('@/lib/services/scene-verifier', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/scene-verifier')>('@/lib/services/scene-verifier')
  return {
    ...actual,
    verifyAndStampScene: vi.fn(async () => ({
      status: 'verified' as const,
      error: null,
      verifiedAt: Date.now(),
      durationMs: 1,
      ...(mockFrame ? { frame: mockFrame } : {}),
    })),
  }
})

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

type RenderData = {
  _render?: { status: string; nonblankRatio: number; brokenImages: number; totalImages: number; hint: string }
}

// The veto fires through a CODE-AUTHORING tool — that is the only class that
// can author the broken pixels. write_scene_code
// is the canonical one; it sets the scene's code and runs the same post-tool gate.
// FLOW-valid minimal scene (an interpolated camera translate+scale). A bare
// `() => null` is now a static-slide floor violation the FLOW gate flips; these
// tests exercise the render/codegen signals on an otherwise-valid write, so the
// code must clear FLOW. The blank-frame veto tests still work: the render gate
// sets success:false first and the FLOW gate is guarded on result.success.
const CODE =
  'export default function S(){const f=useCurrentFrame();const x=interpolate(f,[0,60],[0,-120]);const s=interpolate(f,[0,60],[1,1.1]);return <div style={{transform:`translate(${x}px,0) scale(${s})`}}>hi</div>}'

describe('pixel-truth veto blocks blank/broken renders (code-authoring tools)', () => {
  beforeEach(() => {
    mockFrame = undefined
  })

  it('flips success:false and attaches _render when the frame is blank', async () => {
    mockFrame = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }
    const world = makeWorld(makeScene())

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: CODE }, world)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Render check failed.*blank frame/)
    // The scene still VERIFIED (it ran) — blank is a quality block, not a JS error.
    expect(world.scenes[0].verifyStatus).toBe('verified')
    const data = result.data as RenderData
    expect(data._render?.status).toBe('blank')
    expect(data._render?.hint).toMatch(/patch_layer_code|regenerate_layer/)
  })

  it('flips success:false when every image failed to load', async () => {
    mockFrame = { nonblankRatio: 0.5, brokenImages: 2, totalImages: 2 }
    const world = makeWorld(makeScene())

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: CODE }, world)

    expect(result.success).toBe(false)
    const data = result.data as RenderData
    expect(data._render?.status).toBe('broken-images')
  })

  it('leaves a healthy frame untouched (success stays true, no _render)', async () => {
    mockFrame = { nonblankRatio: 0.42, brokenImages: 0, totalImages: 1 }
    const world = makeWorld(makeScene())

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: CODE }, world)

    expect(result.success).toBe(true)
    expect((result.data as RenderData | undefined)?._render).toBeUndefined()
  })

  it('does not block when only some images are broken', async () => {
    mockFrame = { nonblankRatio: 0.4, brokenImages: 1, totalImages: 3 }
    const world = makeWorld(makeScene())

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: CODE }, world)

    expect(result.success).toBe(true)
  })

  it('consumes the frame reading so it cannot re-fire stale on a later tool', async () => {
    mockFrame = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }
    const world = makeWorld(makeScene())

    await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: CODE }, world)
    expect(world._recentSceneFrame?.['scene-1']).toBeUndefined()
  })
})

// #4 real-seam assertion: a NON-authoring tool (camera / transition / background)
// regenerates HTML and measures a frame, but must NOT be flipped to failure for a
// scene that was already blank — that blamed the wrong tool and caused the
// delete/recreate churn that destroyed the "Hook" scene in the captured trace.
// The frame reading is still consumed (so it can't re-fire stale later).
describe('pixel-truth veto does NOT flip non-authoring tools (#4)', () => {
  beforeEach(() => {
    mockFrame = undefined
  })

  it("scene_props(op:'background') on a blank scene stays success:true with no _render", async () => {
    mockFrame = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }
    const world = makeWorld(makeScene())

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)

    expect(result.success).toBe(true)
    expect((result.data as RenderData | undefined)?._render).toBeUndefined()
  })

  it('still consumes the frame reading even though it did not flip', async () => {
    mockFrame = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }
    const world = makeWorld(makeScene())

    await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)
    expect(world._recentSceneFrame?.['scene-1']).toBeUndefined()
  })
})

// #6: ${...} inside a plain quoted string is a likely render bug, but it is
// surfaced as a NON-blocking advisory (a code-walkthrough scene can legitimately
// display "${...}" as text). success must stay true; a _codegen signal is attached.
type CodegenData = { _codegen?: { issue: string; note: string } }

describe('${...}-in-string lint is advisory, not blocking (#6)', () => {
  beforeEach(() => {
    mockFrame = { nonblankRatio: 0.42, brokenImages: 0, totalImages: 1 } // healthy frame
  })

  it('write_scene_code with ${} in a quoted string stays success:true + _codegen advisory', async () => {
    const world = makeWorld(makeScene())
    // ${x} inside a DOUBLE-quoted d="" is the bug; the backtick transform is a
    // legit camera move that clears the FLOW gate (and must NOT trip _codegen).
    const buggy =
      'export default function S(){const f=useCurrentFrame();const x=interpolate(f,[0,60],[0,-120]);const s=interpolate(f,[0,60],[1,1.1]);return <g style={{transform:`translate(${x}px,0) scale(${s})`}}><path d="M110 ${x} 60" /></g>}'

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: buggy }, world)

    expect(result.success).toBe(true)
    const data = result.data as CodegenData
    expect(data._codegen?.issue).toBe('template-interp-in-quoted-string')
  })

  it('clean code carries no _codegen signal', async () => {
    const world = makeWorld(makeScene())
    // Backtick ${} in the transform is a template literal, not the quoted-string
    // bug — _codegen must stay undefined AND the camera move clears the FLOW gate.
    const clean =
      'export default function S(){const f=useCurrentFrame();const x=interpolate(f,[0,60],[0,-120]);const s=interpolate(f,[0,60],[1,1.1]);return <g style={{transform:`translate(${x}px,0) scale(${s})`}}><path d="M110 140 V60" /></g>}'

    const result = await executeTool('write_scene_code', { sceneId: 'scene-1', sceneCode: clean }, world)

    expect(result.success).toBe(true)
    expect((result.data as CodegenData | undefined)?._codegen).toBeUndefined()
  })
})
