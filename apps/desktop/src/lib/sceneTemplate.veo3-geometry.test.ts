// @vitest-environment node
//
// MEDIA-GEO T13/T14: veo3 preview HTML is center-anchored (canon), falls back
// to a full-frame box when dims are falsy, and errored layers render an error
// chip instead of nothing.

import { describe, it, expect } from 'vitest'
import { generateSceneHTML } from './sceneTemplate'
import type { Scene, Veo3Layer } from './types'
import { resolveProjectDimensions } from './dimensions'
import { computeVeo3FullFrameDims, VEO3_ANCHOR_VERSION } from './media/veo3-geometry'

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

function veo3(over: Partial<Veo3Layer> = {}): Veo3Layer {
  return {
    id: 'vid-1',
    type: 'veo3',
    prompt: 'a clip',
    negativePrompt: null,
    aspectRatio: '16:9',
    duration: 5,
    loop: false,
    playbackRate: 1,
    x: 960,
    y: 540,
    width: 1920,
    height: 1080,
    opacity: 1,
    zIndex: 50,
    videoUrl: 'https://example.com/clip.mp4',
    thumbnailUrl: null,
    status: 'ready',
    operationName: null,
    startAt: 0,
    label: 'clip',
    anchorVersion: VEO3_ANCHOR_VERSION,
    ...over,
  }
}

const dims = resolveProjectDimensions('16:9', '1080p')

describe('veo3 preview HTML — center anchor (D4)', () => {
  it('a flagged (center-canon) layer renders left/top as center − half', () => {
    // 1920×1080 box centered at (960,540) → left=0, top=0 in a 1920×1080 frame
    const html = generateSceneHTML(makeReactScene({ aiLayers: [veo3()] }), undefined, undefined, undefined, dims)
    expect(html).toContain('left:0px;top:0px;width:1920px;height:1080px')
  })

  it('matches pixi position math: visual center == sprite center for the same layer', () => {
    const layer = veo3({ x: 700, y: 400, width: 800, height: 450 })
    const html = generateSceneHTML(makeReactScene({ aiLayers: [layer] }), undefined, undefined, undefined, dims)
    // preview left = cx - w/2 = 700-400 = 300 ; pixi places sprite.position at (700,400)
    expect(html).toContain('left:300px;top:175px;width:800px;height:450px')
  })

  it('translates a LEGACY (unflagged, top-left) layer to center', () => {
    const layer = veo3({ x: 0, y: 0, width: 800, height: 450, anchorVersion: undefined })
    const html = generateSceneHTML(makeReactScene({ aiLayers: [layer] }), undefined, undefined, undefined, dims)
    // legacy center = (0+400, 0+225); left = 400-400 = 0, top = 225-225 = 0
    expect(html).toContain('left:0px;top:0px;width:800px;height:450px')
  })
})

describe('veo3 preview HTML — falsy-dims fallback (D1 defense-in-depth)', () => {
  it('a 0×0 layer falls back to a full-frame contain-fit box, never invisible', () => {
    const box = computeVeo3FullFrameDims('16:9', dims)
    const layer = veo3({ x: 0, y: 0, width: 0, height: 0, anchorVersion: undefined })
    const html = generateSceneHTML(makeReactScene({ aiLayers: [layer] }), undefined, undefined, undefined, dims)
    expect(html).toContain(`width:${box.width}px;height:${box.height}px`)
    expect(html).not.toContain('width:0px;height:0px')
  })
})

describe('errored layer chip (D5)', () => {
  it('renders an error chip for a status:error layer instead of nothing', () => {
    const layer = veo3({ status: 'error' })
    const html = generateSceneHTML(makeReactScene({ aiLayers: [layer] }), undefined, undefined, undefined, dims)
    expect(html).toContain('vid-1-error')
    expect(html).toContain('AI video failed to generate')
    // it must NOT render the <video> for an errored layer
    expect(html).not.toContain('vid-1-video')
  })

  it('a ready layer renders the video, not the chip', () => {
    const html = generateSceneHTML(makeReactScene({ aiLayers: [veo3()] }), undefined, undefined, undefined, dims)
    expect(html).toContain('vid-1-video')
    expect(html).not.toContain('vid-1-error')
  })
})
