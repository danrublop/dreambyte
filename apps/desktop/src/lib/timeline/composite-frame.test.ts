import { describe, it, expect } from 'vitest'
import type { Timeline } from '@/lib/types'
import { planCompositeFrame, compositeLayerToElementStyle, type CompositeLayer } from './composite-frame'

// Same fixture shape as sequence.test.ts.
const aclip = (over: Partial<any> & { id: string; trackId: string }) =>
  ({
    sourceType: 'scene',
    sourceId: over.id,
    label: over.id,
    startTime: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  }) as any

const track = (over: Partial<any> & { id: string }) =>
  ({ name: over.id, type: 'video', position: 0, clips: [], muted: false, locked: false, ...over }) as any

const mtl = (tracks: any[]): Timeline => ({ tracks }) as any

describe('planCompositeFrame (core — active set, z, gaps, alpha)', () => {
  it('null/undefined timeline → gap', () => {
    expect(planCompositeFrame(null, 0)).toEqual({ isGap: true, layers: [] })
    expect(planCompositeFrame(undefined, 1)).toEqual({ isGap: true, layers: [] })
  })

  it('no clip active anywhere → gap (render black + silent)', () => {
    const t = mtl([track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 5 })] })])
    expect(planCompositeFrame(t, 6)).toEqual({ isGap: true, layers: [] })
  })

  it('single active scene → one layer, z=1, full opacity', () => {
    const t = mtl([
      track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', sourceId: 'A', startTime: 0, duration: 5 })] }),
    ])
    const plan = planCompositeFrame(t, 2)
    expect(plan.isGap).toBe(false)
    expect(plan.layers).toHaveLength(1)
    expect(plan.layers[0]).toMatchObject({
      kind: 'scene',
      layerKey: 'A',
      sceneId: 'A',
      src: '',
      clipId: 'a',
      localT: 2,
      z: 1,
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      posX: 0,
      posY: 0,
    })
  })

  it('V2 over V1 → both layers, sorted z-ascending (V1 then V2 = paint back-to-front)', () => {
    const t = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [aclip({ id: 'lo', trackId: 'v1', sourceId: 'LO', startTime: 0, duration: 10 })],
      }),
      track({
        id: 'v2',
        position: 1,
        clips: [aclip({ id: 'hi', trackId: 'v2', sourceId: 'HI', startTime: 3, duration: 4 })],
      }),
    ])
    const plan = planCompositeFrame(t, 5)
    expect(plan.layers.map((l) => [l.clipId, l.z])).toEqual([
      ['lo', 1],
      ['hi', 2],
    ])
  })

  it('gap on V1 under a V2 clip → only V2 layer (not a gap)', () => {
    // V1: clip ends at 4; V2: clip [3,9). At t=6, V1 is a hole but V2 covers it.
    const t = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [aclip({ id: 'a', trackId: 'v1', sourceId: 'A', startTime: 0, duration: 4 })],
      }),
      track({
        id: 'v2',
        position: 1,
        clips: [aclip({ id: 'b', trackId: 'v2', sourceId: 'B', startTime: 3, duration: 6 })],
      }),
    ])
    const plan = planCompositeFrame(t, 6)
    expect(plan.isGap).toBe(false)
    expect(plan.layers.map((l) => l.clipId)).toEqual(['b'])
  })

  it('localT honors trimStart + speed (split half plays its own range)', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          aclip({ id: 'left', trackId: 'v1', sourceId: 's', startTime: 0, duration: 4, trimStart: 0 }),
          aclip({ id: 'right', trackId: 'v1', sourceId: 's', startTime: 4, duration: 4, trimStart: 4 }),
        ],
      }),
    ])
    // global 5 → right half, source-local = trimStart 4 + (5-4)*1 = 5
    expect(planCompositeFrame(t, 5).layers[0]).toMatchObject({ clipId: 'right', localT: 5 })
    // speed 2: source advances twice as fast
    const t2 = mtl([
      track({
        id: 'v1',
        clips: [aclip({ id: 'c', trackId: 'v1', startTime: 10, duration: 5, trimStart: 1, speed: 2 })],
      }),
    ])
    // global 12 → 1 + (12-10)*2 = 5
    expect(planCompositeFrame(t2, 12).layers[0].localT).toBe(5)
  })

  it('half-open interval: active at start, gap at start+duration', () => {
    const t = mtl([track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', startTime: 2, duration: 3 })] })])
    expect(planCompositeFrame(t, 2).isGap).toBe(false) // [2,5)
    expect(planCompositeFrame(t, 5).isGap).toBe(true) // end exclusive
  })

  it('enabled === false is excluded; a frame with only disabled clips is a gap', () => {
    const t = mtl([
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'on', trackId: 'v1', startTime: 0, duration: 10 })] }),
      track({
        id: 'v2',
        position: 1,
        clips: [aclip({ id: 'off', trackId: 'v2', startTime: 0, duration: 10, enabled: false })],
      }),
    ])
    expect(planCompositeFrame(t, 5).layers.map((l) => l.clipId)).toEqual(['on'])
    const allOff = mtl([
      track({ id: 'v1', clips: [aclip({ id: 'x', trackId: 'v1', startTime: 0, duration: 5, enabled: false })] }),
    ])
    expect(planCompositeFrame(allOff, 2).isGap).toBe(true)
  })

  it('opacity reflects fade-in / fade-out / base opacity', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 10, opacity: 0.8, fadeIn: 2, fadeOut: 2 })],
      }),
    ])
    // mid-fade-in at t=1 → 0.8 * (1/2) = 0.4
    expect(planCompositeFrame(t, 1).layers[0].opacity).toBeCloseTo(0.4)
    // steady at t=5 → 0.8
    expect(planCompositeFrame(t, 5).layers[0].opacity).toBeCloseTo(0.8)
    // mid-fade-out at t=9 → tail 1s of 2 → 0.8 * 0.5 = 0.4
    expect(planCompositeFrame(t, 9).layers[0].opacity).toBeCloseTo(0.4)
  })

  it('non-finite t → gap (no NaN layers leak downstream)', () => {
    const t = mtl([track({ id: 'v1', clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 10 })] })])
    expect(planCompositeFrame(t, NaN)).toEqual({ isGap: true, layers: [] })
    expect(planCompositeFrame(t, Infinity)).toEqual({ isGap: true, layers: [] })
  })

  it('dedupes to ONE layer per scene (sourceId), keeping the top track', () => {
    // Same scene 's' active on BOTH V1 and V2 at once — preview shows one iframe
    // (top wins); export must not emit two layers of one sourceId.
    const t = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [aclip({ id: 'c1', trackId: 'v1', sourceId: 's', startTime: 0, duration: 10 })],
      }),
      track({
        id: 'v2',
        position: 1,
        clips: [aclip({ id: 'c2', trackId: 'v2', sourceId: 's', startTime: 0, duration: 10 })],
      }),
    ])
    const plan = planCompositeFrame(t, 5)
    expect(plan.layers).toHaveLength(1)
    expect(plan.layers[0]).toMatchObject({ sceneId: 's', clipId: 'c2', z: 2 }) // top (V2) wins
  })

  it('localT is clamped to the source out-point (trimEnd, else trim+dur*speed)', () => {
    // trimEnd at 3; even a t at the very end can't seek past 3.
    const t = mtl([
      track({
        id: 'v1',
        clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 5, trimStart: 1, trimEnd: 3 })],
      }),
    ])
    expect(planCompositeFrame(t, 4.999).layers[0].localT).toBeLessThanOrEqual(3)
    // no trimEnd → clamp to trimStart + duration*speed
    const t2 = mtl([
      track({
        id: 'v1',
        clips: [aclip({ id: 'b', trackId: 'v1', startTime: 0, duration: 4, trimStart: 2, trimEnd: null })],
      }),
    ])
    expect(planCompositeFrame(t2, 3.999).layers[0].localT).toBeLessThanOrEqual(2 + 4)
  })

  it('honors muted/hidden/solo via getActiveClips', () => {
    const base = [
      track({ id: 'v1', position: 0, clips: [aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 10 })] }),
      track({ id: 'v2', position: 1, clips: [aclip({ id: 'b', trackId: 'v2', startTime: 0, duration: 10 })] }),
    ]
    expect(planCompositeFrame(mtl([{ ...base[0], hidden: true }, base[1]]), 5).layers.map((l) => l.clipId)).toEqual([
      'b',
    ])
    expect(planCompositeFrame(mtl([base[0], { ...base[1], solo: true }]), 5).layers.map((l) => l.clipId)).toEqual(['b'])
  })
})

describe('planCompositeFrame (bare media clips — video/image)', () => {
  const vclip = (over: Partial<any> & { id: string; trackId: string }) =>
    aclip({ sourceType: 'video', sourceId: `/uploads/${over.id}.mp4`, ...over })

  it('a bare video clip becomes a layer kind=video keyed by clipId, src=sourceId', () => {
    const t = mtl([track({ id: 'v1', clips: [vclip({ id: 'v', trackId: 'v1', startTime: 0, duration: 6 })] })])
    const plan = planCompositeFrame(t, 2)
    expect(plan.isGap).toBe(false)
    expect(plan.layers).toHaveLength(1)
    expect(plan.layers[0]).toMatchObject({
      kind: 'video',
      layerKey: 'v', // clipId, NOT sourceId
      sceneId: '',
      src: '/uploads/v.mp4',
      clipId: 'v',
      z: 1,
    })
    expect(plan.layers[0].localT).toBeCloseTo(2) // remapTime, no speed kf → trimStart + t*speed
  })

  it('a bare image clip becomes a layer kind=image (no seek concept, localT still computed)', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          aclip({
            id: 'img',
            trackId: 'v1',
            sourceType: 'image',
            sourceId: '/uploads/p.png',
            startTime: 0,
            duration: 5,
          }),
        ],
      }),
    ])
    expect(planCompositeFrame(t, 1).layers[0]).toMatchObject({ kind: 'image', src: '/uploads/p.png', layerKey: 'img' })
  })

  it('title clips are NOT composited (excluded from the active set)', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          aclip({ id: 'title', trackId: 'v1', sourceType: 'title', sourceId: 'Hello', startTime: 0, duration: 5 }),
        ],
      }),
    ])
    expect(planCompositeFrame(t, 1)).toEqual({ isGap: true, layers: [] })
  })

  it('TWO clips of the SAME media file are TWO distinct layers (clipId-keyed, no sourceId collapse — OV-2)', () => {
    // Same file on V1 and V2 at once → preview draws two sprites; export must too.
    const t = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [vclip({ id: 'c1', trackId: 'v1', sourceId: '/uploads/same.mp4', startTime: 0, duration: 10 })],
      }),
      track({
        id: 'v2',
        position: 1,
        clips: [vclip({ id: 'c2', trackId: 'v2', sourceId: '/uploads/same.mp4', startTime: 0, duration: 10 })],
      }),
    ])
    const plan = planCompositeFrame(t, 5)
    expect(plan.layers).toHaveLength(2)
    expect(plan.layers.map((l) => l.layerKey).sort()).toEqual(['c1', 'c2'])
    expect(plan.layers.map((l) => l.z).sort()).toEqual([1, 2])
  })

  it('media transform mirrors Pixi (scale.x/y + position.x/y); scenes stay identity', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'v',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            scale: { x: 0.5, y: 0.25 },
            position: { x: 40, y: 80 },
          }),
        ],
      }),
    ])
    expect(planCompositeFrame(t, 1).layers[0]).toMatchObject({ scaleX: 0.5, scaleY: 0.25, posX: 40, posY: 80 })
  })

  it('media localT honors speed KEYFRAMES via remapTime (not just scalar speed)', () => {
    // a speed ramp from 1× to 3× over [0,2] integrates to more than scalar 1× would.
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'ramp',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            trimStart: 0,
            speed: 1,
            keyframes: [
              { property: 'speed', time: 0, value: 1, easing: 'linear' },
              { property: 'speed', time: 2, value: 3, easing: 'linear' },
            ],
          }),
        ],
      }),
    ])
    // scalar would give localT=2 at t=2; the ramp integrates to ~4 (avg speed 2× over 2s).
    expect(planCompositeFrame(t, 2).layers[0].localT).toBeGreaterThan(2.5)
  })

  it('video over a scene composites by z (scene V1 under video V2)', () => {
    const t = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [aclip({ id: 's', trackId: 'v1', sourceId: 'S', startTime: 0, duration: 10 })],
      }),
      track({ id: 'v2', position: 1, clips: [vclip({ id: 'v', trackId: 'v2', startTime: 0, duration: 10 })] }),
    ])
    const plan = planCompositeFrame(t, 5)
    expect(plan.layers.map((l) => [l.kind, l.z])).toEqual([
      ['scene', 1],
      ['video', 2],
    ])
  })
})

describe('planCompositeFrame (transform + opacity KEYFRAME eval — A5 parity with Pixi)', () => {
  const vclip = (over: Partial<any> & { id: string; trackId: string }) =>
    aclip({ sourceType: 'video', sourceId: `/uploads/${over.id}.mp4`, ...over })

  it('interpolates x/y/scale/rotation keyframes at the clip-local time (not frozen static)', () => {
    // Linear ramps over [0,2]: x 0→100, y 10→30, scaleX 1→0.5, rotation 0→90.
    // At t=1 (clip-local 1, the midpoint) each is exactly halfway.
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'kf',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            // static values that MUST be overridden by the keyframes at t=1
            position: { x: 999, y: 999 },
            scale: { x: 9, y: 9 },
            rotation: 999,
            keyframes: [
              { property: 'x', time: 0, value: 0, easing: 'linear' },
              { property: 'x', time: 2, value: 100, easing: 'linear' },
              { property: 'y', time: 0, value: 10, easing: 'linear' },
              { property: 'y', time: 2, value: 30, easing: 'linear' },
              { property: 'scaleX', time: 0, value: 1, easing: 'linear' },
              { property: 'scaleX', time: 2, value: 0.5, easing: 'linear' },
              { property: 'rotation', time: 0, value: 0, easing: 'linear' },
              { property: 'rotation', time: 2, value: 90, easing: 'linear' },
            ],
          }),
        ],
      }),
    ])
    const l = planCompositeFrame(t, 1).layers[0]
    expect(l.posX).toBeCloseTo(50)
    expect(l.posY).toBeCloseTo(20)
    expect(l.scaleX).toBeCloseTo(0.75)
    expect(l.rotation).toBeCloseTo(45)
  })

  it('falls back to static clip values for properties WITHOUT a keyframe', () => {
    // Only x is keyframed; y/scale/rotation must use the static clip fields.
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'partial',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            position: { x: 999, y: 77 },
            scale: { x: 0.3, y: 0.4 },
            rotation: 12,
            keyframes: [
              { property: 'x', time: 0, value: 0, easing: 'linear' },
              { property: 'x', time: 2, value: 100, easing: 'linear' },
            ],
          }),
        ],
      }),
    ])
    expect(planCompositeFrame(t, 1).layers[0]).toMatchObject({ posY: 77, scaleX: 0.3, scaleY: 0.4, rotation: 12 })
  })

  it('OPACITY keyframes drive alpha (matches Pixi computeClipAlpha(clip, t, kf.opacity)) — was frozen pre-fix', () => {
    // opacity ramps 1→0 over [0,4]; clip.opacity=1 so a frozen read would stay 1.
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'fade',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            opacity: 1,
            keyframes: [
              { property: 'opacity', time: 0, value: 1, easing: 'linear' },
              { property: 'opacity', time: 4, value: 0, easing: 'linear' },
            ],
          }),
        ],
      }),
    ])
    // clip-local t=1 → 1 - 1/4 = 0.75 (NOT the static 1)
    expect(planCompositeFrame(t, 1).layers[0].opacity).toBeCloseTo(0.75)
    expect(planCompositeFrame(t, 3).layers[0].opacity).toBeCloseTo(0.25)
  })
})

describe('compositeLayerToElementStyle (A3 — shared preview/export style source of truth)', () => {
  const layer = (over: Partial<CompositeLayer>): CompositeLayer =>
    ({
      kind: 'video',
      layerKey: 'c',
      sceneId: '',
      src: '/v.mp4',
      clipId: 'c',
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
    }) as CompositeLayer

  it('identity transform → empty string (no translate/rotate/scale emitted)', () => {
    expect(compositeLayerToElementStyle(layer({})).transform).toBe('')
  })

  it('emits ONLY the non-identity components, in order translate → rotate → scale', () => {
    expect(compositeLayerToElementStyle(layer({ posX: 40, posY: 80 })).transform).toBe('translate(40px,80px)')
    expect(compositeLayerToElementStyle(layer({ rotation: 30 })).transform).toBe('rotate(30deg)')
    expect(compositeLayerToElementStyle(layer({ scaleX: 0.5, scaleY: 0.25 })).transform).toBe('scale(0.5,0.25)')
    expect(
      compositeLayerToElementStyle(layer({ posX: 10, posY: 20, rotation: 45, scaleX: 2, scaleY: 3 })).transform,
    ).toBe('translate(10px,20px) rotate(45deg) scale(2,3)')
  })

  it('negative rotation is emitted; rotation 0 is omitted', () => {
    expect(compositeLayerToElementStyle(layer({ rotation: -15 })).transform).toBe('rotate(-15deg)')
    expect(compositeLayerToElementStyle(layer({ rotation: 0, posX: 5 })).transform).toBe('translate(5px,0px)')
  })

  it('passes filter / mix-blend-mode / opacity / zIndex straight through', () => {
    const s = compositeLayerToElementStyle(
      layer({ filterCss: 'grayscale(1)', blendMode: 'plus-lighter', opacity: 0.4, z: 3 }),
    )
    expect(s).toMatchObject({ filter: 'grayscale(1)', mixBlendMode: 'plus-lighter', opacity: 0.4, zIndex: 3 })
  })
})

describe('planCompositeFrame (fade transition, opts.fade)', () => {
  const seqTl = (transitionDur = 1) =>
    mtl([
      track({
        id: 'v1',
        clips: [
          aclip({
            id: 'a',
            trackId: 'v1',
            sourceId: 'A',
            startTime: 0,
            duration: 5,
            transition: { type: 'fade', duration: transitionDur },
          }),
          aclip({ id: 'b', trackId: 'v1', sourceId: 'B', startTime: 5, duration: 5, trimStart: 0 }),
        ],
      }),
    ])

  it('no crossfade outside the transition window', () => {
    const plan = planCompositeFrame(seqTl(1), 2, { fade: true })
    expect(plan.layers.map((l) => l.clipId)).toEqual(['a'])
    expect(plan.layers[0].opacity).toBe(1)
  })

  it('crossfades the outgoing down and adds the incoming up in the final window', () => {
    // td=1, clip a is [0,5); at t=4.5, remaining=0.5 → progress=0.5
    const plan = planCompositeFrame(seqTl(1), 4.5, { fade: true })
    const a = plan.layers.find((l) => l.clipId === 'a')!
    const b = plan.layers.find((l) => l.clipId === 'b')!
    expect(a.opacity).toBeCloseTo(0.5) // (1 - 0.5) * 1
    expect(b).toBeDefined()
    expect(b.opacity).toBeCloseTo(0.5) // progress
    expect(b.localT).toBe(0) // incoming pre-seeked to its trimStart
  })

  it('incoming fade layer is painted at z=1 (preview transition-layer z)', () => {
    const plan = planCompositeFrame(seqTl(1), 4.5, { fade: true })
    const incoming = plan.layers.find((l) => l.clipId === 'b')
    expect(incoming).toBeDefined()
    expect(incoming!.z).toBe(1)
  })

  it('does nothing when the clip has no fade transition or no next clip', () => {
    const noNext = mtl([
      track({
        id: 'v1',
        clips: [
          aclip({ id: 'a', trackId: 'v1', startTime: 0, duration: 5, transition: { type: 'fade', duration: 1 } }),
        ],
      }),
    ])
    // last clip → no incoming, just the outgoing at full alpha
    const plan = planCompositeFrame(noNext, 4.5, { fade: true })
    expect(plan.layers.map((l) => l.clipId)).toEqual(['a'])
    expect(plan.layers[0].opacity).toBe(1)
  })

  it('fade is opt-in: opts.fade omitted leaves opacity untouched in the window', () => {
    const plan = planCompositeFrame(seqTl(1), 4.5)
    expect(plan.layers.map((l) => l.clipId)).toEqual(['a'])
    expect(plan.layers[0].opacity).toBe(1)
  })

  // Regression: the catalog emits ids like 'crossfade'/'dissolve'/'wipe-left', NEVER the
  // literal 'fade' — the old `type !== 'fade'` gate silently made all 40 a hard cut. Any
  // real (non-'none') transition must now crossfade; 'none' must stay a hard cut.
  const seqWith = (type: string) =>
    mtl([
      track({
        id: 'v1',
        clips: [
          aclip({
            id: 'a',
            trackId: 'v1',
            sourceId: 'A',
            startTime: 0,
            duration: 5,
            transition: { type: type as any, duration: 1 },
          }),
          aclip({ id: 'b', trackId: 'v1', sourceId: 'B', startTime: 5, duration: 5, trimStart: 0 }),
        ],
      }),
    ])

  it("a real catalog transition ('crossfade') now crossfades, not a hard cut", () => {
    const plan = planCompositeFrame(seqWith('crossfade'), 4.5, { fade: true })
    const a = plan.layers.find((l) => l.clipId === 'a')!
    const b = plan.layers.find((l) => l.clipId === 'b')
    expect(a.opacity).toBeCloseTo(0.5)
    expect(b).toBeDefined()
    expect(b!.opacity).toBeCloseTo(0.5)
  })

  it("'none' stays a hard cut (no incoming layer in the window)", () => {
    const plan = planCompositeFrame(seqWith('none'), 4.5, { fade: true })
    expect(plan.layers.map((l) => l.clipId)).toEqual(['a'])
    expect(plan.layers[0].opacity).toBe(1)
  })
})

describe('planCompositeFrame (clip color grade — preview == export resolution)', () => {
  const vclip = (over: Partial<any> & { id: string; trackId: string }) =>
    aclip({ sourceType: 'video', sourceId: `/uploads/${over.id}.mp4`, ...over })

  it('a neutral / absent grade leaves the layer.grade undefined', () => {
    const t = mtl([track({ id: 'v1', clips: [vclip({ id: 'v', trackId: 'v1', startTime: 0, duration: 6 })] })])
    expect(planCompositeFrame(t, 2).layers[0].grade).toBeUndefined()
  })

  it('a CSS-tier grade resolves to tier=css and folds into the element filter', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({ id: 'v', trackId: 'v1', startTime: 0, duration: 6, grade: { exposure: 1, temperature: 8000 } }),
        ],
      }),
    ])
    const plan = planCompositeFrame(t, 2)
    const layer = plan.layers[0]
    expect(layer.grade?.tier).toBe('css')
    expect(layer.grade?.svgFilterMarkup).toContain('<filter')
    const style = compositeLayerToElementStyle(layer)
    // brightness(2) from exposure 1, plus the url(#...) for the white-balance SVG filter
    expect(style.filter).toContain('brightness(2)')
    expect(style.filter).toContain(`url(#${layer.grade!.svgFilterId})`)
  })

  it('a LUT grade resolves to tier=webgl (handled by the host shader pass)', () => {
    const t = mtl([
      track({
        id: 'v1',
        clips: [
          vclip({
            id: 'v',
            trackId: 'v1',
            startTime: 0,
            duration: 6,
            grade: { lut: { path: '/film.cube', dimension: 33, strength: 1 } },
          }),
        ],
      }),
    ])
    const plan = planCompositeFrame(t, 2)
    expect(plan.layers[0].grade?.tier).toBe('webgl')
  })

  it('a graded SCENE (media-asset scene) gets the CSS tier on its iframe — never webgl', () => {
    // Scenes render as iframes, which a WebGL pass can't sample, so even a LUT/hue
    // grade is pinned to the CSS+SVG tier (LUT/hue parts are dropped for scenes).
    const t = mtl([
      track({
        id: 's1',
        clips: [
          aclip({
            id: 's',
            trackId: 's1',
            startTime: 0,
            duration: 6,
            grade: { exposure: 1, temperature: 8000, lut: { path: '/film.cube', dimension: 33, strength: 1 } },
          }),
        ],
      }),
    ])
    const layer = planCompositeFrame(t, 2).layers[0]
    expect(layer.kind).toBe('scene')
    expect(layer.grade?.tier).toBe('css') // pinned to css despite the LUT
    const style = compositeLayerToElementStyle(layer)
    expect(style.filter).toContain('brightness(2)')
    expect(style.filter).toContain(`url(#${layer.grade!.svgFilterId})`)
  })

  it('a neutral grade on a scene stays undefined (ungraded scenes byte-identical)', () => {
    const t = mtl([track({ id: 's1', clips: [aclip({ id: 's', trackId: 's1', startTime: 0, duration: 6 })] })])
    expect(planCompositeFrame(t, 2).layers[0].grade).toBeUndefined()
  })
})
