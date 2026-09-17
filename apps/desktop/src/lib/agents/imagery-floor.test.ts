import { describe, it, expect } from 'vitest'
import { imageryFloorWarnings, sceneHasImagery } from './imagery-floor'
import type { Scene } from '../types/scene'

// Minimal scene stubs — the floor only reads videoLayer + aiLayers.
function scene(over: Partial<Scene>): Scene {
  return { aiLayers: [], videoLayer: { enabled: false, src: null }, ...over } as unknown as Scene
}

const wantsImagery = [{ name: 'Hero', mediaLayers: 'a photoreal product shot' }]

describe('imageryFloorWarnings — deterministic keys-absent slice', () => {
  it('WARNS: plan wanted imagery, no image provider, nothing placed', () => {
    const w = imageryFloorWarnings({
      plannedScenes: wantsImagery,
      builtScenes: [scene({})],
      hasImageGen: false,
      missingKeyHint: 'FAL_KEY',
    })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('"Hero"')
    expect(w[0]).toContain('FAL_KEY')
  })

  it('SILENT: an image provider IS available (this floor is not that case)', () => {
    expect(
      imageryFloorWarnings({ plannedScenes: wantsImagery, builtScenes: [scene({})], hasImageGen: true }),
    ).toEqual([])
  })

  it('WARNS via briefWantsImagery even when the plan carried NO mediaLayers note', () => {
    // The exact silent failure: a too-conservative plan drops every media note,
    // but the brief (stock/generate/research) still wanted imagery.
    const w = imageryFloorWarnings({
      plannedScenes: [{ name: 'A', mediaLayers: '' }],
      builtScenes: [scene({})],
      hasImageGen: false,
      missingKeyHint: 'FAL_KEY',
      briefWantsImagery: true,
    })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('real imagery')
    expect(w[0]).toContain('FAL_KEY')
  })

  it('SILENT: no plan media AND brief did not want imagery — false-positive guard holds', () => {
    expect(
      imageryFloorWarnings({
        plannedScenes: [{ name: 'A', mediaLayers: '' }],
        builtScenes: [scene({})],
        hasImageGen: false,
        briefWantsImagery: false,
      }),
    ).toEqual([])
  })

  it('SILENT: imagery was actually placed (any source) despite no provider', () => {
    const placed = scene({ aiLayers: [{ type: 'image' } as never] })
    expect(
      imageryFloorWarnings({ plannedScenes: wantsImagery, builtScenes: [placed], hasImageGen: false }),
    ).toEqual([])
  })

  it('SILENT (false-positive guard): the plan never called for imagery', () => {
    expect(
      imageryFloorWarnings({
        plannedScenes: [{ name: 'Intro', mediaLayers: undefined }, { name: 'Title', mediaLayers: '  ' }],
        builtScenes: [scene({})],
        hasImageGen: false,
      }),
    ).toEqual([])
  })

  it('SILENT: a placed video clip counts as imagery', () => {
    const withClip = scene({ videoLayer: { enabled: true, src: 'https://x/clip.mp4' } as never })
    expect(
      imageryFloorWarnings({ plannedScenes: wantsImagery, builtScenes: [withClip], hasImageGen: false }),
    ).toEqual([])
  })
})

describe('sceneHasImagery', () => {
  it('true for image/sticker/veo3/avatar aiLayers', () => {
    for (const type of ['image', 'sticker', 'veo3', 'avatar']) {
      expect(sceneHasImagery(scene({ aiLayers: [{ type } as never] }))).toBe(true)
    }
  })
  it('true for an enabled video layer with a src', () => {
    expect(sceneHasImagery(scene({ videoLayer: { enabled: true, src: 'x' } as never }))).toBe(true)
  })
  it('false for a bare CSS scene (no layers, disabled video)', () => {
    expect(sceneHasImagery(scene({}))).toBe(false)
  })
})
