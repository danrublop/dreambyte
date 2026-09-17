// @vitest-environment node

// T10: regenerateHTML failures must surface to the agent + user, and the
// last-good HTML on disk must be kept (the failing write uses temp+rename so
// it never replaces the prior file). This test forces the HTML build to throw
// and asserts the tool result carries a visible `_verify` error rather than
// silently shipping stale HTML as a success with no signal.

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

// Make generateSceneHTML throw so regenerateHTML hits its catch block.
const generateSceneHTMLMock = vi.fn()
vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: (...args: unknown[]) => generateSceneHTMLMock(...args),
}))

// Control layer content generation so regenerate_layer's whole-scene path
// "succeeds" at codegen and proceeds to the (failing) HTML regeneration.
vi.mock('@/lib/generation/generate', () => ({
  generateCode: vi.fn(async () => ({ code: 'export default () => null', usage: {} })),
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

describe('T10: regenerateHTML failure surfaces (not swallowed)', () => {
  beforeEach(() => {
    generateSceneHTMLMock.mockReset()
  })

  it('stamps the scene errored and surfaces a _verify signal when HTML build throws', async () => {
    generateSceneHTMLMock.mockImplementation(() => {
      throw new Error('boom: malformed layer code')
    })
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool(
      'regenerate_layer',
      { sceneId: 'scene-1', layerId: 'scene-1', prompt: 'redo' },
      world,
    )

    // The scene is stamped errored so the failure is no longer silent.
    expect(world.scenes[0].verifyStatus).toBe('errored')
    expect(world.scenes[0].verifyError?.message).toMatch(/HTML regeneration failed/)
    // The post-tool gate surfaces a visible signal the agent (and chat) can show.
    const data = result.data as { _verify?: { status: string; message: string } } | undefined
    expect(data?._verify?.status).toBe('errored')
    expect(data?._verify?.message).toMatch(/HTML regeneration failed/)
  })

  // P1#2: the _verify error signal must reach the agent for ANY tool whose
  // regenerateHTML fails — not only the 7 GENERATION_TOOL_SET tools. Before the
  // fix, a non-generation tool (e.g. scene_props op:'background') returned success:true
  // with NO _verify signal even though the USER saw the errored scene. This test
  // fails if the gate is reverted to GENERATION_TOOL_SET-only.
  it("surfaces _verify for a NON-generation tool (scene_props op:'background') when HTML build throws", async () => {
    generateSceneHTMLMock.mockImplementation(() => {
      throw new Error('boom: bad template')
    })
    const scene = makeScene()
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)

    // The tool itself "succeeds" (background was set) — verify is advisory.
    expect(result.success).toBe(true)
    // Scene stamped errored: the user sees the failure.
    expect(world.scenes[0].verifyStatus).toBe('errored')
    // AND the agent now gets the _verify signal too (the P1#2 fix).
    const data = result.data as { _verify?: { status: string; message: string } } | undefined
    expect(data?._verify?.status).toBe('errored')
    expect(data?._verify?.message).toMatch(/HTML regeneration failed/)
  })
})
