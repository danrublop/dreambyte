// @vitest-environment node

// regenerateHTML writes sceneHTML through the shared updateScene, so a cached
// runtime-verify outcome from before the write can't be reused afterwards.

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it, vi, beforeEach } from 'vitest'

let mockHtml = '<html><body>v2</body></html>'
vi.mock('@/lib/sceneTemplate', () => ({
  generateSceneHTML: () => mockHtml,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const stubs = {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
  }
  return { ...actual, ...stubs, default: { ...actual, ...stubs } }
})

const { verifyAndStampScene } = vi.hoisted(() => ({
  verifyAndStampScene: vi.fn(async () => ({
    status: 'errored' as const,
    error: { kind: 'runtime', message: 'boom' },
    verifiedAt: Date.now(),
    durationMs: 1,
  })),
}))
vi.mock('@/lib/services/scene-verifier', () => ({ verifyAndStampScene }))

import { executeTool, readRecentRuntimeVerify, regenerateHTML, writeRecentRuntimeVerify } from './tool-executor'
import type { WorldStateMutable } from './world-state'
import type { Scene, GlobalStyle, SceneGraph } from '@/lib/types'

function makeWorld(): WorldStateMutable {
  const scene = {
    id: 'scene-1',
    name: 'Scene 1',
    sceneType: 'react',
    reactCode: 'export default () => null',
    sceneHTML: '<html><body>v1</body></html>',
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

describe('regenerateHTML invalidates the runtime-verify cache', () => {
  beforeEach(() => {
    mockHtml = '<html><body>v2</body></html>'
    verifyAndStampScene.mockClear()
  })

  it('drops a cached PASS when the scene HTML changes, so verify_scene re-renders', async () => {
    const world = makeWorld()
    writeRecentRuntimeVerify(world, 'scene-1', { status: 'verified', error: null, durationMs: 5 })

    const res = await regenerateHTML(world, 'scene-1')
    expect(res.htmlWritten).toBe(true)
    expect(world.scenes[0].sceneHTML).toBe(mockHtml)
    expect(typeof world.scenes[0].updatedAt).toBe('number')
    expect(readRecentRuntimeVerify(world, 'scene-1')).toBeNull()

    verifyAndStampScene.mockClear()
    const result = await executeTool('verify_scene', { sceneId: 'scene-1' }, world)
    expect(verifyAndStampScene).toHaveBeenCalledTimes(1)
    const runtime = (result.data as { runtime?: { status: string; fromCache: boolean } }).runtime
    expect(runtime).toMatchObject({ status: 'errored', fromCache: false })
    expect(readRecentRuntimeVerify(world, 'scene-1')?.status).toBe('errored')
  })

  it('keeps the cache when the regenerated HTML is identical', async () => {
    const world = makeWorld()
    mockHtml = world.scenes[0].sceneHTML as string
    writeRecentRuntimeVerify(world, 'scene-1', { status: 'verified', error: null, durationMs: 5 })

    await regenerateHTML(world, 'scene-1')
    // regenerateHTML's own verify stamps verifyStatus (not a render field), so
    // the unchanged HTML leaves the cached entry in place.
    expect(readRecentRuntimeVerify(world, 'scene-1')?.status).toBe('verified')
  })
})
