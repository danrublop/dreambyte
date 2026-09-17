// @vitest-environment node

// Layout-overflow advisory: when a verified scene's text spills outside the
// frame, regenerateHTML's verify outcome carries `overflows`, and the post-tool
// gate must attach a NON-BLOCKING `result.data._layout` signal — alongside
// `_verify` / `_determinism`, never clobbering them, never setting
// success:false, never marking the scene errored. When there are no overflows,
// `_layout` must be absent.

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { SceneOverflow } from '@/lib/services/scene-verifier'

// generateSceneHTML succeeds (returns a string) so regenerateHTML reaches the
// verify + return path instead of its catch block.
vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: () => '<html><body><h1>hi</h1></body></html>',
}))

// regenerate_layer's whole-scene codegen "succeeds" so it proceeds to write.
vi.mock('@/lib/generation/generate', () => ({
  generateCode: vi.fn(async () => ({ code: 'export default () => null', usage: {} })),
}))

// Avoid real disk writes during the write path.
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

// The controllable verify outcome. Tests mutate `overflows` per case. Status is
// always 'verified' — overflow is advisory, never an error.
let mockOverflows: SceneOverflow[] | undefined = undefined
vi.mock('@/lib/services/scene-verifier', () => ({
  verifyAndStampScene: vi.fn(async () => ({
    status: 'verified' as const,
    error: null,
    verifiedAt: Date.now(),
    durationMs: 1,
    ...(mockOverflows ? { overflows: mockOverflows } : {}),
  })),
}))

import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

function makeScene(reactCode: string): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    reactCode,
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

describe('layout-overflow advisory surfaces to the agent', () => {
  beforeEach(() => {
    mockOverflows = undefined
  })

  it('attaches _layout when the verified scene reports overflowing text', async () => {
    mockOverflows = [{ id: 'h1:"The Big Title…"', edges: ['right'], overflowPx: 30 }]
    const scene = makeScene('export default () => null')
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)

    expect(result.success).toBe(true)
    // Scene still verifies — overflow does not error it.
    expect(world.scenes[0].verifyStatus).toBe('verified')
    const data = result.data as { _layout?: { overflows: SceneOverflow[]; note: string } } | undefined
    expect(data?._layout?.overflows).toEqual(mockOverflows)
    expect(data?._layout?.note).toMatch(/Text overflows the frame/)
  })

  it('consumes the signal after surfacing so it cannot re-surface stale', async () => {
    mockOverflows = [{ id: 'h1:"The Big Title…"', edges: ['right'], overflowPx: 30 }]
    const scene = makeScene('export default () => null')
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)
    const data = result.data as { _layout?: { overflows: SceneOverflow[] } } | undefined
    expect(data?._layout?.overflows).toEqual(mockOverflows)
    // The transient map entry is deleted once surfaced — so a subsequent
    // NON-regenerating tool (capture_frame / a clean re-verify) on this scene
    // can't re-emit a stale `_layout` advisory.
    expect(world._recentSceneOverflows?.['scene-1']).toBeUndefined()
  })

  it('omits _layout when the verified scene has no overflows', async () => {
    mockOverflows = []
    const scene = makeScene('export default () => null')
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#abcdef' }, world)

    expect(result.success).toBe(true)
    const data = result.data as { _layout?: unknown } | undefined
    expect(data?._layout).toBeUndefined()
  })

  it('coexists with _determinism (both attach, neither clobbers the other)', async () => {
    mockOverflows = [{ id: 'p:"jittery"', edges: ['bottom'], overflowPx: 12 }]
    // Non-deterministic construct triggers the _determinism advisory too.
    const scene = makeScene('export default () => { const x = Math.random(); return null }')
    const world = makeWorld(scene)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#222' }, world)

    expect(result.success).toBe(true)
    const data = result.data as
      | { _layout?: { overflows: SceneOverflow[] }; _determinism?: { violations: unknown[] } }
      | undefined
    expect(data?._layout?.overflows).toEqual(mockOverflows)
    expect(data?._determinism?.violations?.length).toBeGreaterThan(0)
  })
})
