// @vitest-environment node
//
// Security audit P1-4: every generated scene HTML carries the strict scene CSP
// as a <meta http-equiv>, injected first in <head> (before any script) and marked
// so the publish path can strip it for web-only embeds.

import { describe, it, expect } from 'vitest'
import { generateSceneHTML } from './sceneTemplate'
import { SCENE_CSP, stripSceneCsp } from './security/scene-csp'
import type { Scene } from './types'

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'csp-scene-1',
    name: 'CSP',
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

describe('scene HTML carries the audit CSP (P1-4)', () => {
  it('injects the CSP meta with the exact policy, marked for publish-strip', () => {
    const html = generateSceneHTML(makeScene())
    expect(html).toContain(`content="${SCENE_CSP}"`)
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain('data-dreambyte-csp')
  })

  it('places the CSP meta before the first <script> in the document', () => {
    const html = generateSceneHTML(makeScene())
    const cspIdx = html.indexOf('Content-Security-Policy')
    const scriptIdx = html.indexOf('<script')
    expect(cspIdx).toBeGreaterThan(-1)
    expect(scriptIdx).toBeGreaterThan(-1)
    expect(cspIdx).toBeLessThan(scriptIdx)
  })

  it('the publish strip removes the CSP meta from the scene HTML', () => {
    const html = generateSceneHTML(makeScene())
    const stripped = stripSceneCsp(html)
    expect(stripped).not.toContain('Content-Security-Policy')
    // The rest of the document survives.
    expect(stripped).toContain('<base href=')
  })
})
