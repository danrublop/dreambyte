// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { expandIdArgs, type WorldStateMutable } from './tool-executor'
import { AmbiguousIdError } from './short-id'

/**
 * `expandIdArgs` — the INPUT half of the id-prefix round
 * trip. The READ tools emit min-unique prefixes; executeTool calls this to
 * expand any prefix arg back to its full id before scope/scene resolution reads
 * it. Pins: scalar + array keys expand, a full/unique id passes through, an
 * unchanged call returns the SAME object reference (no needless clone), and an
 * ambiguous prefix throws AmbiguousIdError (executeTool turns it into a tool
 * error). collectIdUniverse/expandIdPrefix are unit-tested in short-id.test.ts;
 * this covers the arg-walking layer on top.
 */

// Scene + layer + timeline ids that diverge before the floor (so floor-length
// prefixes are unique), plus a pair that shares a long run (forces ambiguity).
const SCENE = '11111111-1111-4111-8111-111111111111'
const LAYER = '22222222-2222-4222-8222-222222222222'
const CLIP = '33333333-3333-4333-8333-333333333333'
const SHARE_A = 'abcdef01-2345-4678-9abc-def012345678'
const SHARE_B = 'abcdef01-2345-4678-9abc-def0ffffffff'

/** Minimal world: expandIdArgs only reads scenes/timeline/checkpoints via
 *  collectIdUniverse, so a structural stub (cast) is enough. */
function worldWith(ids: { scenes?: any[]; tracks?: any[]; markers?: any[] }): WorldStateMutable {
  return {
    scenes: ids.scenes ?? [],
    timeline: { tracks: ids.tracks ?? [], markers: ids.markers ?? [] },
  } as unknown as WorldStateMutable
}

describe('expandIdArgs — scalar keys', () => {
  it('expands a scene-id prefix to the full id', () => {
    const world = worldWith({ scenes: [{ id: SCENE }] })
    const out = expandIdArgs({ sceneId: SCENE.slice(0, 8) }, world)
    expect(out.sceneId).toBe(SCENE)
  })

  it('expands a layer-id prefix carried on a different scalar key', () => {
    const world = worldWith({ scenes: [{ id: SCENE, aiLayers: [{ id: LAYER }] }] })
    const out = expandIdArgs({ layerId: LAYER.slice(0, 8) }, world)
    expect(out.layerId).toBe(LAYER)
  })

  it('passes a full/unique id through unchanged', () => {
    const world = worldWith({ scenes: [{ id: SCENE }] })
    const out = expandIdArgs({ sceneId: SCENE }, world)
    expect(out.sceneId).toBe(SCENE)
  })
})

describe('expandIdArgs — array keys', () => {
  it('expands each element of an id-array arg, leaving non-prefix entries intact', () => {
    const world = worldWith({
      scenes: [{ id: SCENE }],
      tracks: [{ id: '44444444-4444-4444-8444-444444444444', clips: [{ id: CLIP }] }],
    })
    const out = expandIdArgs({ clipIds: [CLIP.slice(0, 8), 'legacy-short'] }, world)
    expect(out.clipIds).toEqual([CLIP, 'legacy-short'])
  })

  it('expands sceneIds[] prefixes', () => {
    const world = worldWith({ scenes: [{ id: SCENE }, { id: LAYER }] })
    const out = expandIdArgs({ sceneIds: [SCENE.slice(0, 8), LAYER.slice(0, 8)] }, world)
    expect(out.sceneIds).toEqual([SCENE, LAYER])
  })
})

describe('expandIdArgs — return contract', () => {
  it('returns the SAME object reference when nothing changes (no needless clone)', () => {
    const world = worldWith({ scenes: [{ id: SCENE }] })
    const args = { sceneId: SCENE, note: 'unchanged' }
    expect(expandIdArgs(args, world)).toBe(args)
  })

  it('returns the same reference when the universe is empty', () => {
    const args = { sceneId: SCENE.slice(0, 8) }
    expect(expandIdArgs(args, worldWith({}))).toBe(args)
  })

  it('returns a NEW object (originals untouched) when something expands', () => {
    const world = worldWith({ scenes: [{ id: SCENE }] })
    const args = { sceneId: SCENE.slice(0, 8) }
    const out = expandIdArgs(args, world)
    expect(out).not.toBe(args)
    expect(args.sceneId).toBe(SCENE.slice(0, 8)) // input not mutated
    expect(out.sceneId).toBe(SCENE)
  })

  it('leaves unrelated keys and non-string values alone', () => {
    const world = worldWith({ scenes: [{ id: SCENE }] })
    const out = expandIdArgs({ sceneId: SCENE.slice(0, 8), duration: 5, flag: true }, world)
    expect(out.duration).toBe(5)
    expect(out.flag).toBe(true)
  })
})

describe('expandIdArgs — ambiguity', () => {
  it('throws AmbiguousIdError when a prefix matches more than one id', () => {
    const world = worldWith({
      scenes: [{ id: SHARE_A, aiLayers: [{ id: SHARE_B }] }],
    })
    const shared = 'abcdef01-2345-4678-9abc-def0' // prefix of both
    expect(() => expandIdArgs({ sceneId: shared }, world)).toThrow(AmbiguousIdError)
  })

  it('propagates ambiguity from an array element too', () => {
    const world = worldWith({
      scenes: [{ id: SHARE_A }],
      tracks: [{ id: '55555555-5555-4555-8555-555555555555', clips: [{ id: SHARE_B }] }],
    })
    const shared = 'abcdef01-2345-4678-9abc-def0'
    expect(() => expandIdArgs({ clipIds: [shared] }, world)).toThrow(AmbiguousIdError)
  })
})
