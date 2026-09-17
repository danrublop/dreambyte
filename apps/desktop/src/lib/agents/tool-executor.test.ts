// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, expect, it } from 'vitest'
import type { Scene } from '../types'
import { quickValidateScene } from './tool-executor'

describe('quickValidateScene', () => {
  it('treats React code as renderable scene content', () => {
    const scene = {
      id: 'react-scene',
      name: 'React Scene',
      sceneType: 'react',
      duration: 8,
      reactCode:
        'export default function Scene() { return <AbsoluteFill><div>Renderable React content</div></AbsoluteFill> }',
      svgObjects: [],
      aiLayers: [],
    } as unknown as Scene

    expect(quickValidateScene(scene)).not.toContain('EMPTY: Scene has no visual content after generation.')
  })

  it('includes React code length in minimal-code warnings', () => {
    const scene = {
      id: 'react-scene',
      name: 'React Scene',
      sceneType: 'react',
      duration: 8,
      reactCode:
        'export default function Scene() { return <AbsoluteFill><div>Enough content for validation</div></AbsoluteFill> }',
      svgObjects: [],
      aiLayers: [],
    } as unknown as Scene

    expect(quickValidateScene(scene).some((warning) => warning.startsWith('MINIMAL:'))).toBe(false)
  })

  // A static slideshow: small text (42px), one fade, no camera move — scanForFlow flags it.
  const SLIDESHOW =
    "export default function Scene() { const frame = useCurrentFrame(); const o = interpolate(frame,[0,30],[0,1]); return <AbsoluteFill style={{background:'#111'}}><div style={{fontSize:42,opacity:o}}>A title that just sits there with no camera</div></AbsoluteFill> }"

  it('FLOW soft-signal fires on a static react scene (camera/text warnings)', () => {
    const scene = {
      id: 's',
      name: 'S',
      sceneType: 'react',
      duration: 8,
      reactCode: SLIDESHOW,
      svgObjects: [],
      aiLayers: [],
    } as unknown as Scene
    const w = quickValidateScene(scene)
    expect(w.some((x) => x.startsWith('FLOW:'))).toBe(true)
  })

  it('FLOW soft-signal is gated OFF for non-explainer renderers (e.g. d3 charts)', () => {
    const scene = {
      id: 's',
      name: 'S',
      sceneType: 'd3',
      duration: 8,
      reactCode: SLIDESHOW,
      svgObjects: [],
      aiLayers: [],
    } as unknown as Scene
    const w = quickValidateScene(scene)
    expect(w.some((x) => x.startsWith('FLOW:'))).toBe(false)
  })
})
