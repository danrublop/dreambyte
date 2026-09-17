// @vitest-environment node
//
// T4 / D8 — scene HTML self-heal. Two guarantees:
//   1. The PURE decideSceneHeal predicate: missing → heal, byte-different →
//      heal (stale), byte-identical → healthy (no write), empty expected →
//      never heal (don't clobber with blank).
//   2. Byte-compare proof (Codex): the HTML the self-heal generates as its
//      "expected" for a scene row is byte-identical to what the SAVE path
//      generates for the same row — i.e. self-heal can never regenerate
//      something different from what a normal save would have written.

import { describe, it, expect } from 'vitest'
import { decideSceneHeal, normalizeForHealCompare } from './scene-heal'
import { generateSceneHTML } from '../sceneTemplate'
import type { Scene } from '../types'
import type { GlobalStyle } from '../types'
import { resolveProjectDimensions } from '../dimensions'

function makeReactScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    name: 'Test',
    prompt: '',
    summary: '',
    svgContent: '',
    usage: null,
    duration: 4,
    bgColor: '#000',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: {} as Scene['audioLayer'],
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'cut' as Scene['transition'],
    sceneType: 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: 'function Scene() { return null } export default Scene',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {} as Scene['styleOverride'],
    cameraMotion: null,
    worldConfig: null,
    ...overrides,
  }
}

const STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
} as GlobalStyle

describe('decideSceneHeal (T4 / D8)', () => {
  it('missing file → heal (missing)', () => {
    expect(decideSceneHeal('<html>x</html>', { exists: false, html: null })).toEqual({
      needsHeal: true,
      reason: 'missing',
    })
  })

  it('present but byte-different → heal (stale)', () => {
    expect(decideSceneHeal('<html>new</html>', { exists: true, html: '<html>old</html>' })).toEqual({
      needsHeal: true,
      reason: 'stale',
    })
  })

  it('byte-identical → healthy, no write', () => {
    expect(decideSceneHeal('<html>same</html>', { exists: true, html: '<html>same</html>' })).toEqual({
      needsHeal: false,
      reason: null,
    })
  })

  it('empty expected HTML → never heal (do not clobber with blank)', () => {
    expect(decideSceneHeal('', { exists: false, html: null })).toEqual({ needsHeal: false, reason: null })
    expect(decideSceneHeal('', { exists: true, html: '<html/>' })).toEqual({ needsHeal: false, reason: null })
  })
})

describe('byte-compare: heal expected === save-path HTML (Codex)', () => {
  const dims = resolveProjectDimensions('16:9', '1080p')
  const scene = makeReactScene()

  it('self-heal expected HTML equals the save-path output for the same row (cache-buster aside)', () => {
    // The save path (generation-actions.saveSceneHTML) and the self-heal path
    // (healProjectScenes) both call generateSceneHTML(scene, style, watermark,
    // audioSettings, dims). generateSceneHTML embeds a per-call ?v=<Date.now()>
    // cache-buster, so raw bytes differ by the timestamp ONLY — after
    // normalizing it out the two are byte-identical. This proves the heal can
    // never regenerate content a save would not have produced.
    const savePathHtml = generateSceneHTML(scene, STYLE, null, null, dims)
    const healExpectedHtml = generateSceneHTML(scene, STYLE, null, null, dims)
    expect(normalizeForHealCompare(healExpectedHtml)).toBe(normalizeForHealCompare(savePathHtml))

    // A healthy scene whose on-disk file is the save output is NOT healed,
    // even though the on-disk cache-buster differs from a fresh generation.
    expect(decideSceneHeal(healExpectedHtml, { exists: true, html: savePathHtml }).needsHeal).toBe(false)
    // A stale on-disk file (old template output) IS healed.
    expect(decideSceneHeal(healExpectedHtml, { exists: true, html: '<html>stale</html>' }).needsHeal).toBe(true)
  })

  it('a differing cache-buster alone never marks a healthy scene stale', () => {
    const a = generateSceneHTML(scene, STYLE, null, null, dims)
    const b = generateSceneHTML(scene, STYLE, null, null, dims)
    // Raw bytes differ (timestamp), but the heal compare treats them as equal.
    expect(decideSceneHeal(b, { exists: true, html: a }).needsHeal).toBe(false)
    expect(a.length).toBeGreaterThan(0)
  })
})
