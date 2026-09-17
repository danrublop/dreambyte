// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// THE BUILD-CONTRACT GATE (the deterministic stand-in for a CI build eval).
//
// CI is billing-blocked / keyless, so we can't run a live model on every PR.
// Instead this drives the REAL tool path (executeTool + the persist cleaner)
// through a scripted multi-scene build — the exact sequence shape the
// photosynthesis / Bitcoin runs made — and asserts the build is NON-BROKEN
// end to end. It ties every regression lane together over one sequence, which
// no isolated test does, and would fail if any of them re-broke:
//   #2  dispatch_scene_builder honesty       #4  render-gate flip scope
//   #5  codeless-shell drop at persist       (render veto on real code authoring)
// Only the offscreen render + DB writes are mocked; the tool logic is real.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SceneFrameTruth } from '@/lib/services/scene-verifier'

vi.mock('@/lib/sceneTemplate', () => ({ generateSceneHTML: () => '<html><body><h1>hi</h1></body></html>' }))
vi.mock('@/lib/generation/generate', () => ({
  generateCode: vi.fn(async () => ({ code: 'export default () => null', usage: {} })),
}))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const noop = vi.fn(async () => {})
  return {
    ...actual,
    default: { ...actual, mkdir: noop, writeFile: noop, rename: noop, unlink: noop },
    mkdir: noop,
    writeFile: noop,
    rename: noop,
    unlink: noop,
  }
})
let mockFrame: SceneFrameTruth | undefined
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
import { cleanScenesForAgentPersistence } from '@/lib/services/agent-runner'
import type { GlobalStyle, SceneGraph, Scene } from '@/lib/types'

const HEALTHY: SceneFrameTruth = { nonblankRatio: 0.42, brokenImages: 0, totalImages: 1 }
const BLANK: SceneFrameTruth = { nonblankRatio: 0.004, brokenImages: 0, totalImages: 0 }
// Minimal renderable scene that clears the structural FLOW gate (a time-driven
// camera translate+scale + a big headline) — a bare `() => null` stub is now a
// static-slide floor violation (see flowBlockForTool in tool-executor.ts).
const CODE = [
  'export default function Scene() {',
  '  const f = useCurrentFrame()',
  '  const x = interpolate(f, [0, 60], [0, -180])',
  '  const s = interpolate(f, [0, 60], [1, 1.15])',
  '  return <div style={{ transform: `translate(${x}px, 0) scale(${s})`, fontSize: 120 }}>Hello</div>',
  '}',
].join('\n')

function makeWorld(extra?: Partial<WorldStateMutable>): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: { presetId: null } as unknown as GlobalStyle,
    projectName: 'p',
    projectId: 'project-test',
    currentRunId: 'run-test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: null } as unknown as SceneGraph,
    ...extra,
  } as unknown as WorldStateMutable
}

describe('build contract — a multi-scene build stays non-broken', () => {
  beforeEach(() => {
    mockFrame = HEALTHY
  })

  it('builds 3 coded scenes; every scene has renderable code (no codeless shell survives)', async () => {
    const world = makeWorld({ orchestratorAvailable: true })

    // plan
    const plan = await executeTool(
      'plan_scenes',
      {
        title: 'Build',
        totalDuration: 18,
        scenes: [
          { id: 's1', name: 'Hook', sceneType: 'react', duration: 6 },
          { id: 's2', name: 'Body', sceneType: 'react', duration: 6 },
          { id: 's3', name: 'End', sceneType: 'react', duration: 6 },
        ],
      },
      world,
    )
    expect(plan.success).toBe(true)

    // create + code each scene (the real per-scene loop)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const created = await executeTool(
        'create_scene',
        { name: `Scene ${i}`, prompt: `scene ${i}`, duration: 6 },
        world,
      )
      expect(created.success).toBe(true)
      const id = (created.data as { sceneId?: string }).sceneId as string
      ids.push(id)
      const wrote = await executeTool('write_scene_code', { sceneId: id, sceneCode: CODE }, world)
      expect(wrote.success).toBe(true)
    }

    // CONTRACT: every scene the build produced carries code — no codeless shell.
    expect(world.scenes.length).toBe(3)
    for (const s of world.scenes) {
      expect(((s as Scene).reactCode || (s as Scene).sceneCode || '').length).toBeGreaterThan(0)
    }
  })

  it('a NEW codeless shell never reaches persistence (#5)', async () => {
    const world = makeWorld({ orchestratorAvailable: true })
    // one coded + one orphan shell created but never coded
    const coded = await executeTool('create_scene', { name: 'Coded', prompt: 'x', duration: 6 }, world)
    await executeTool(
      'write_scene_code',
      { sceneId: (coded.data as { sceneId?: string }).sceneId!, sceneCode: CODE },
      world,
    )
    await executeTool('create_scene', { name: 'Orphan', prompt: '', duration: 6 }, world) // codeless, no prompt

    // both scenes really exist in the world — proving the drop is the cleaner's
    // doing, not a create that silently failed.
    expect(world.scenes.length).toBe(2)
    const persisted = cleanScenesForAgentPersistence(world.scenes as Scene[], [])
    expect(persisted.length).toBe(1)
    expect(((persisted[0] as Scene).reactCode || '').length).toBeGreaterThan(0)
  })

  it('a camera tool on a (legitimately) blank scene does NOT flip the build (#4)', async () => {
    const world = makeWorld({ orchestratorAvailable: true })
    const created = await executeTool('create_scene', { name: 'Dark', prompt: 'x', duration: 6 }, world)
    const id = (created.data as { sceneId?: string }).sceneId as string
    await executeTool('write_scene_code', { sceneId: id, sceneCode: CODE }, world)
    mockFrame = BLANK
    const cam = await executeTool('set_camera_motion', { sceneId: id, moves: [{ type: 'presetReveal' }] }, world)
    expect(cam.success).toBe(true) // not blamed for a pre-blank scene
  })

  it('a code-authoring tool that produces a blank scene IS flipped (#4)', async () => {
    const world = makeWorld({ orchestratorAvailable: true })
    const created = await executeTool('create_scene', { name: 'Blank', prompt: 'x', duration: 6 }, world)
    const id = (created.data as { sceneId?: string }).sceneId as string
    mockFrame = BLANK
    const wrote = await executeTool('write_scene_code', { sceneId: id, sceneCode: CODE }, world)
    expect(wrote.success).toBe(false)
  })

  it('dispatch_scene_builder honest-fails when no orchestrator will run (#2)', async () => {
    const world = makeWorld() // orchestratorAvailable falsy = MCP / sub-agent
    await executeTool(
      'plan_scenes',
      {
        title: 'P',
        totalDuration: 6,
        scenes: [{ id: 'a', name: 'A', sceneType: 'react', duration: 6 }],
      },
      world,
    )
    const r = await executeTool('dispatch_scene_builder', {}, world)
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not available')
  })
})
