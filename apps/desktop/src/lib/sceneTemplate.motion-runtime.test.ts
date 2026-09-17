// @vitest-environment node
//
// W1 runtime wire-up regression test. Confirms that a React scene whose
// aiLayers carry `layer.motion` emits per-layer motionStyle helpers and a
// scene-clock (onTick) bound applier. Layers without motion produce no helpers.

import { describe, it, expect } from 'vitest'
import { generateSceneHTML } from './sceneTemplate'
import type { Scene, ImageLayer } from './types'
import type { MotionRef } from './motion-dsl/types'

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

function makeImageLayer(id: string, motion?: MotionRef): ImageLayer & { motion?: MotionRef } {
  const layer: ImageLayer & { motion?: MotionRef } = {
    id,
    type: 'image',
    status: 'ready',
    prompt: 'an image',
    imageUrl: 'https://example.com/img.png',
    opacity: 1,
    zIndex: 1,
    startAt: 0,
    duration: 3,
    placement: 'fullscreen',
  } as unknown as ImageLayer & { motion?: MotionRef }
  if (motion) layer.motion = motion
  return layer
}

describe('React scene motion runtime wire-up', () => {
  it('emits a motionStyle helper + applier when an aiLayer carries motion', () => {
    const scene = makeReactScene({
      aiLayers: [makeImageLayer('layer-A', { kind: 'preset', preset: 'fadeInUp' })],
    })
    const html = generateSceneHTML(scene)
    expect(html).toContain('function motionStyle_layer_A(frame)')
    expect(html).toContain('window.__dreambyteApplyMotion')
    expect(html).toContain('"layer-A"')
    expect(html).toContain('db.onTick(')
  })

  it('emits no motion runtime when no aiLayer has motion', () => {
    const scene = makeReactScene({
      aiLayers: [makeImageLayer('layer-B')],
    })
    const html = generateSceneHTML(scene)
    expect(html).not.toContain('motionStyle_layer_B')
    expect(html).not.toContain('__dreambyteApplyMotion')
  })

  it('rejects layerIds that would not be valid JS identifiers', () => {
    const scene = makeReactScene({
      aiLayers: [
        makeImageLayer('layer/A', { kind: 'preset', preset: 'fadeInUp' }),
        makeImageLayer('layer-B', { kind: 'preset', preset: 'fadeInUp' }),
      ],
    })
    const html = generateSceneHTML(scene)
    expect(html).not.toContain('motionStyle_layer/A')
    expect(html).toContain('function motionStyle_layer_B(frame)')
  })

  it('emits the runtime for motion / canvas2d / lottie / three scenes — DOM aiLayers, same scene-clock source', () => {
    for (const sceneType of ['motion', 'canvas2d', 'lottie', 'three'] as const) {
      const scene = makeReactScene({
        sceneType,
        aiLayers: [makeImageLayer('layer-C', { kind: 'preset', preset: 'fadeInUp' })],
      })
      const html = generateSceneHTML(scene)
      expect(html, `${sceneType} should have motion runtime`).toContain('function motionStyle_layer_C(frame)')
      expect(html, `${sceneType} should subscribe to onTick`).toContain('db.onTick(')
    }
  })
})
