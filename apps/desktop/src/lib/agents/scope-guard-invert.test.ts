// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import {
  executeTool,
  regenerateHTML,
  setWorldAbortSignal,
  READ_ONLY_FOREIGN_SCENE_TOOLS,
  type WorldStateMutable,
} from './tool-executor'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

/**
 * P0-1 — inverted scene-scope guard.
 *
 * A scene-builder sub-agent (`world.scopeForeignSceneIds` set) owns ONE scene.
 * The OLD guard only rejected tools tagged `mutates`, but almost every mutator
 * (`add_layer`, `place_image`, `add_narration`, `set_camera_motion`, …) is
 * UNTAGGED — so a sub-agent could freely stomp a foreign scene. The guard is now
 * INVERTED: block ANY tool that targets a foreign scene UNLESS it is on the
 * read-only allowlist. These tests pin BOTH sides: untagged mutators are now
 * rejected (the fix), and every allowlisted read tool still passes the guard
 * (the over-block regression this inversion risks).
 */

function twoSceneWorld(overrides?: Partial<WorldStateMutable>): WorldStateMutable {
  const owned = { ...createDefaultScene(), id: 'owned', name: 'Owned' }
  const foreign = { ...createDefaultScene(), id: 'foreign', name: 'Foreign' }
  return {
    scenes: [owned, foreign],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([owned, foreign]).sceneGraph,
    ...overrides,
  }
}

function oneSceneWorld(overrides?: Partial<WorldStateMutable>): WorldStateMutable {
  const scene = { ...createDefaultScene(), id: 'scene-1', name: 'S1' }
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
    ...overrides,
  }
}

describe('P0-1 inverted scope guard — UNTAGGED mutators are rejected on a foreign scene', () => {
  // These four are the exact tools the audit called out: all are mutators, none
  // is tagged `mutates`, so the OLD `if (scopeDef?.mutates)` guard let them
  // through. Each must now be rejected before it can touch the foreign scene.
  const UNTAGGED_MUTATORS = ['add_layer', 'place_image', 'add_narration', 'set_camera_motion']

  for (const tool of UNTAGGED_MUTATORS) {
    it(`rejects ${tool} targeting a foreign scene`, async () => {
      const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
      const foreignBefore = JSON.stringify(world.scenes.find((s) => s.id === 'foreign'))
      const result = await executeTool(tool, { sceneId: 'foreign', prompt: 'x' }, world)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/outside your assigned scope/i)
      // The foreign scene must be byte-for-byte unchanged.
      expect(JSON.stringify(world.scenes.find((s) => s.id === 'foreign'))).toBe(foreignBefore)
    })
  }

  it('still ALLOWS an untagged mutator on the OWNED scene (guard is scoped, not blanket)', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
    // set_camera_motion on the owned scene must not be scope-blocked.
    const result = await executeTool('set_camera_motion', { sceneId: 'owned', motion: 'zoom-in' }, world)
    expect(result.error ?? '').not.toMatch(/outside your assigned scope/i)
  })
})

describe('P0-1 over-block regression guard — every allowlisted read tool passes on a foreign scene', () => {
  it('the allowlist is exactly the enumerated read-only set', () => {
    expect([...READ_ONLY_FOREIGN_SCENE_TOOLS].sort()).toEqual(
      ['analyze_reference_media', 'capture_frame', 'inspect', 'review', 'verify_scene'].sort(),
    )
  })

  for (const tool of READ_ONLY_FOREIGN_SCENE_TOOLS) {
    it(`does NOT scope-block ${tool} on a foreign scene`, async () => {
      const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
      const result = await executeTool(tool, { sceneId: 'foreign' }, world)
      // It may return success:false for an UNRELATED reason (needs a renderer,
      // empty scene, missing reference), but it must NEVER be rejected by the
      // scope guard — that is the whole point of the allowlist.
      expect(result.error ?? '').not.toMatch(/outside your assigned scope/i)
    })
  }

  it('inspect actively SUCCEEDs on a foreign scene', async () => {
    const world = twoSceneWorld({ scopeForeignSceneIds: new Set(['foreign']) })
    const read = await executeTool('inspect', { sceneId: 'foreign' }, world)
    expect(read.success).toBe(true)
    const describe = await executeTool('inspect', { sceneId: 'foreign' }, world)
    expect(describe.success).toBe(true)
  })
})

describe('P2 — html-honesty: an aborted regenerateHTML surfaces as a tool failure', () => {
  it('regenerateHTML records the skipped write on world._recentHtmlUnwritten when aborted', async () => {
    const world = oneSceneWorld()
    const controller = new AbortController()
    setWorldAbortSignal(world, controller.signal)
    controller.abort()

    const r = await regenerateHTML(world, 'scene-1')
    expect(r.htmlWritten).toBe(false)
    expect(world._recentHtmlUnwritten?.['scene-1']?.reason).toBe('aborted')
  })

  it('a mutating tool whose HTML write is aborted mid-flight returns FAILURE, not a cheerful ok()', async () => {
    // The top-of-executeTool gate fires only if the run is ALREADY aborted; the
    // real bug is an abort landing DURING the handler (after the top gate, before
    // regenerateHTML). Model that with a stateful signal: the FIRST read (top
    // gate) sees not-aborted, every later read (the regenerateHTML persist gate)
    // sees aborted. scene_props(op:'background') mutates world then calls regenerateHTML
    // and returns ok() unconditionally — the exact P2 discard bug.
    const world = oneSceneWorld()
    let reads = 0
    const midFlightSignal = {
      get aborted() {
        return reads++ > 0
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    setWorldAbortSignal(world, midFlightSignal)

    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#123456' }, world)

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(true)
    expect((result.data as { htmlWritten?: boolean })?.htmlWritten).toBe(false)
  })

  it('a normal (non-aborted) mutating tool still reports success with the write landed', async () => {
    const world = oneSceneWorld()
    const result = await executeTool('scene_props', { op: 'background', sceneId: 'scene-1', bgColor: '#abcdef' }, world)
    expect(result.success).toBe(true)
    // No stale unwritten flag left behind.
    expect(world._recentHtmlUnwritten?.['scene-1']).toBeUndefined()
    expect(world.scenes[0].bgColor).toBe('#abcdef')
  })
})
