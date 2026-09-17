// @vitest-environment node

// A SYNTAX error in scene code is deterministic and never intentional. When a
// code-authoring (GENERATION_TOOL_SET) tool emits a scene the offscreen
// verifier classifies as `kind: 'syntax'`, the tool must HARD-FAIL
// (success:false) so the agent is forced to fix it — not return success:true
// with only an advisory a budget model can ignore, leaving the user a scene
// that throws on playback while the chat reports success.
//
// Scoped: runtime/timeout stay advisory (environment/timing-sensitive), and
// non-generation tools that merely touched a pre-broken scene are NOT blamed.

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

// HTML assembly succeeds so execution reaches the offscreen verifier.
const generateSceneHTMLMock = vi.fn((..._args: unknown[]) => '<html>ok</html>')
vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: (...args: unknown[]) => generateSceneHTMLMock(...args),
}))

vi.mock('@/lib/generation/generate', () => ({
  generateCode: vi.fn(async () => ({ code: 'export default () => null', usage: {} })),
}))

// The verifier reports a syntax error in the written scene code.
const verifyAndStampSceneMock = vi.fn(async (..._args: unknown[]) => ({
  status: 'errored' as const,
  error: { kind: 'syntax' as const, message: 'Unexpected token (3:10)', line: 3 },
}))
vi.mock('@/lib/services/scene-verifier', () => ({
  verifyAndStampScene: (...args: unknown[]) => verifyAndStampSceneMock(...args),
}))

import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

function makeScene(): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    reactCode: 'GOOD_CODE',
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

describe('syntax-error scenes hard-fail for code-authoring tools', () => {
  beforeEach(() => {
    generateSceneHTMLMock.mockClear()
    verifyAndStampSceneMock.mockClear()
  })

  it('flips a GENERATION tool (regenerate_layer) to success:false on a syntax error', async () => {
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool(
      'regenerate_layer',
      { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'redo' },
      world,
    )

    expect(world.scenes[0].verifyStatus).toBe('errored')
    // Hard failure: the agent cannot end its turn treating this as done.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/syntax error/i)
    // The recoverable advisory is still attached so the model knows how to fix it.
    const data = result.data as { _verify?: { kind: string; status: string } } | undefined
    expect(data?._verify?.kind).toBe('syntax')
    expect(data?._verify?.status).toBe('errored')
  })

  it('also hard-fails patch_layer_code (the primary edit tool) on a syntax error', async () => {
    const scene = makeScene() // reactCode: 'GOOD_CODE'
    const world = makeWorld(scene)

    // Patch reactCode 'GOOD_CODE' -> 'BROKEN'; the (mocked) verifier reports syntax.
    const result = await executeTool(
      'patch_layer_code',
      { sceneId: 'scene-1', layerId: 'scene-1', oldCode: 'GOOD_CODE', newCode: 'BROKEN' },
      world,
    )

    expect(world.scenes[0].verifyStatus).toBe('errored')
    // patch_layer_code is NOT in GENERATION_TOOL_SET but IS code-authoring, so it
    // must hard-fail too — otherwise the headline failure stays reachable via the
    // most common edit tool.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/syntax error/i)
  })

  it("does NOT fail a NON-generation tool (scene_props op:'background') for a pre-broken scene", async () => {
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)

    // The background change itself succeeded; the syntax error pre-existed and
    // is surfaced advisory-only so an unrelated edit isn't blamed for it.
    expect(result.success).toBe(true)
    expect(world.scenes[0].verifyStatus).toBe('errored')
    const data = result.data as { _verify?: { kind: string } } | undefined
    expect(data?._verify?.kind).toBe('syntax')
  })
})
