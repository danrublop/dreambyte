import { describe, it, expect } from 'vitest'
import { buildCompositeHostHtml, planToInstructions } from './composite-host'
import type { CompositeFramePlan, CompositeLayer } from '@/lib/timeline/composite-frame'

// Full CompositeLayer fixture (the shape planToInstructions consumes).
const layer = (over: Partial<CompositeLayer> & { kind: CompositeLayer['kind']; layerKey: string }): CompositeLayer => ({
  sceneId: '',
  src: '',
  clipId: over.layerKey,
  localT: 0,
  z: 1,
  opacity: 1,
  scaleX: 1,
  scaleY: 1,
  posX: 0,
  posY: 0,
  rotation: 0,
  filterCss: '',
  blendMode: '',
  ...over,
})

describe('buildCompositeHostHtml', () => {
  const html = buildCompositeHostHtml(1920, 1080)

  it('emits a black-backed stage + the __composite controller', () => {
    expect(html).toContain('id="stage"')
    expect(html).toContain('background:#000') // gaps composite over black, never transparent
    expect(html).toContain('1920px')
    expect(html).toContain('1080px')
    expect(html).toContain('window.__composite')
    expect(html).toContain('renderFrameAt')
  })

  it('drives the scene clock host-side via __clock (no eval into the iframe — CSP-proof)', () => {
    expect(html).toContain('win.__clock.seek') // host-driven seek, not an injected agent
    expect(html).not.toContain('contentWindow.eval') // no eval injection
    for (const hook of ['__updateScene', 'getAnimations']) {
      expect(html).toContain(hook)
    }
  })

  it('seeks <video> with a capture-anyway timeout (D2) and does NOT use requestAnimationFrame', () => {
    expect(html).toContain("querySelectorAll('video')") // scene-internal video seek
    expect(html).toContain("addEventListener('seeked'")
    expect(html).toContain('setTimeout') // D2 seeked-timeout
    expect(html).not.toContain('requestAnimationFrame')
  })

  it('mount polls for the bridge with a deadline (scene path not gated on load event)', () => {
    expect(html).toContain('__clock || win.__updateScene')
  })

  it('media: styles <video>/<img> for the stage + applies the Pixi-stretch fit', () => {
    expect(html).toContain('#stage video,#stage img')
    expect(html).toContain('object-fit:fill') // matches Pixi sprite.width = frame*scale
    expect(html).toContain('transform-origin:0 0')
  })

  it('media video: muted autoplay + decode-readiness gate (loadeddata / readyState>=2) before first seek (OV-4)', () => {
    expect(html).toContain('mountVideo')
    expect(html).toContain('loadeddata') // wait for a decoded frame, not just mount
    expect(html).toContain('readyState >= 2')
    expect(html).toContain('seekMediaVideo') // top-level video seek path
  })

  it('injects the Tier-B grade shaders + a single shared WebGL2 grader (LUT / hue curves)', () => {
    expect(html).toContain('window.__GRADE_SHADERS') // shader source injected once
    expect(html).toContain('#version 300 es') // the actual GLSL travels in the page
    expect(html).toContain('getGrader') // ONE shared context, lazily created
    expect(html).toContain('renderGrade')
    expect(html).toContain('registerLut') // LUT shipped once by url, not per frame
    expect(html).toContain('applyGrade') // draws the graded frame onto a per-layer canvas
    expect(html).toContain('window.__composite') // grader is part of the controller
    expect(html).toContain('preserveDrawingBuffer') // so the 2D drawImage copy is valid
  })

  it('evicts INACTIVE media (pause + remove + drop from pool) so the decoder/memory set stays bounded; scenes stay pooled', () => {
    // clipId-keyed media is unbounded across a long timeline — must not accumulate
    // live <video> decoders. Scenes (sourceId-keyed) stay pooled + hidden.
    expect(html).toContain('toEvict')
    expect(html).toContain('removeChild')
    expect(html).toContain('.pause()')
    expect(html).toContain("rec.kind === 'scene'") // scenes keep the hide-and-pool path
    expect(html).toContain('delete pool[')
  })
})

describe('planToInstructions', () => {
  // Resolver now takes the full layer: scene → scene HTML; media → its src URL.
  const resolve = (l: CompositeLayer) => {
    if (l.kind === 'scene') {
      return l.sceneId === 'missing' ? null : { url: `dreambyte://scenes/${l.sceneId}.html`, isVideoScene: l.sceneId === 'vid' }
    }
    return l.src === 'missing' ? null : { url: `dreambyte://uploads/${l.src}`, isVideoScene: false }
  }

  it('a gap plan → no instructions (caller emits black)', () => {
    expect(planToInstructions({ isGap: true, layers: [] }, resolve)).toEqual([])
  })

  it('maps SCENE layers to scene HTML url + isVideoScene, preserving z / opacity / localT', () => {
    const plan: CompositeFramePlan = {
      isGap: false,
      layers: [
        layer({ kind: 'scene', layerKey: 'a', sceneId: 'a', localT: 2, z: 1, opacity: 1 }),
        layer({ kind: 'scene', layerKey: 'vid', sceneId: 'vid', localT: 0.5, z: 2, opacity: 0.8 }),
      ],
    }
    expect(planToInstructions(plan, resolve)).toEqual([
      { kind: 'scene', layerKey: 'a', url: 'dreambyte://scenes/a.html', localT: 2, z: 1, opacity: 1, isVideoScene: false, transform: '', filter: '', mixBlendMode: '', gradeSvg: '' },
      { kind: 'scene', layerKey: 'vid', url: 'dreambyte://scenes/vid.html', localT: 0.5, z: 2, opacity: 0.8, isVideoScene: true, transform: '', filter: '', mixBlendMode: '', gradeSvg: '' },
    ])
  })

  it('maps MEDIA layers to resolved url + resolved element STYLE (transform/filter/blend via A3 helper)', () => {
    const plan: CompositeFramePlan = {
      isGap: false,
      layers: [
        layer({ kind: 'video', layerKey: 'c1', src: 'clip.mp4', localT: 3, z: 2, scaleX: 0.5, scaleY: 0.5, posX: 40, posY: 80, rotation: 15, filterCss: 'blur(2px)', blendMode: 'multiply' }),
        layer({ kind: 'image', layerKey: 'c2', src: 'pic.png', z: 1 }),
      ],
    }
    expect(planToInstructions(plan, resolve)).toEqual([
      { kind: 'video', layerKey: 'c1', url: 'dreambyte://uploads/clip.mp4', localT: 3, z: 2, opacity: 1, isVideoScene: false, transform: 'translate(40px,80px) rotate(15deg) scale(0.5,0.5)', filter: 'blur(2px)', mixBlendMode: 'multiply', gradeSvg: '' },
      { kind: 'image', layerKey: 'c2', url: 'dreambyte://uploads/pic.png', localT: 0, z: 1, opacity: 1, isVideoScene: false, transform: '', filter: '', mixBlendMode: '', gradeSvg: '' },
    ])
  })

  it('attaches a serializable gradeGL payload for webgl-tier layers (LUT url, uniforms)', () => {
    const grade = {
      tier: 'webgl' as const,
      filterCss: '',
      svgFilterMarkup: '',
      svgFilterId: 'clip-grade-c1',
      vignette: 0,
      raw: { exposure: 0.5, lut: { path: '/u/.dreambyte/luts/film.cube', dimension: 33, strength: 0.8 } },
    }
    const plan: CompositeFramePlan = {
      isGap: false,
      layers: [layer({ kind: 'video', layerKey: 'c1', src: 'clip.mp4', grade })],
    }
    const [inst] = planToInstructions(plan, resolve)
    expect(inst.gradeGL).toBeTruthy()
    expect(inst.gradeGL!.lutUrl).toBe('dreambyte://luts/film.cube')
    expect(inst.gradeGL!.lutSize).toBe(33)
    expect(inst.gradeGL!.lutIntensity).toBe(0.8)
    expect(inst.gradeGL!.exposure).toBe(0.5)
    // JSON-serializable: curve textures are plain arrays or null, never typed arrays.
    expect(JSON.parse(JSON.stringify(inst.gradeGL))).toEqual(inst.gradeGL)
  })

  it('omits gradeGL for css-tier / ungraded layers (hot path untouched)', () => {
    const css = {
      tier: 'css' as const,
      filterCss: 'contrast(1.1)',
      svgFilterMarkup: '<filter id="clip-grade-c1"></filter>',
      svgFilterId: 'clip-grade-c1',
      vignette: 0,
      raw: { contrast: 1.1 },
    }
    const plan: CompositeFramePlan = {
      isGap: false,
      layers: [layer({ kind: 'video', layerKey: 'c1', src: 'clip.mp4', grade: css })],
    }
    const [inst] = planToInstructions(plan, resolve)
    expect('gradeGL' in inst).toBe(false)
    expect(inst.gradeSvg).toContain('<filter') // css grade still injects its <filter>
  })

  it('drops layers that do not resolve (scene OR media) — no broken element mounted', () => {
    const plan: CompositeFramePlan = {
      isGap: false,
      layers: [
        layer({ kind: 'scene', layerKey: 'a', sceneId: 'a' }),
        layer({ kind: 'scene', layerKey: 'missing', sceneId: 'missing' }),
        layer({ kind: 'video', layerKey: 'cbad', src: 'missing' }),
      ],
    }
    expect(planToInstructions(plan, resolve).map((i) => i.layerKey)).toEqual(['a'])
  })
})
