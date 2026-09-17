/**
 * PIXEL-UNIFY (P1c) — plan-level golden-frame parity test.
 *
 * Preview and export cannot diverge when they are the SAME renderer over the same
 * pure snapshot. Dreambyte's invariant is: the EXPORT host and the PREVIEW DOM both consume
 * `planCompositeFrame()` and resolve each layer with `compositeLayerToElementStyle()`.
 *
 * This test LOCKS that invariant deterministically (no Electron, no pixels):
 * for a representative timeline sampled across [0, duration), the EXPORT
 * instruction stream (`planToInstructions(planCompositeFrame(t))`, what the
 * composite host mounts/seeks/styles) is byte-identical to what the PREVIEW
 * consumes (`planCompositeFrame(t)` + `compositeLayerToElementStyle` per layer).
 *
 * Both sides call the IDENTICAL pure function, so this passes by construction
 * today — that's the point: any future change that makes the export resolve a
 * layer's seek/opacity/transform/filter/blend/z differently from the preview
 * fails HERE, before it can ship as a preview≠export bug. The real-pixel half
 * (host capturePage == preview capturePage within tolerance, via the Range-served
 * dreambyte:// protocol) runs
 * out-of-band like the composite smokes — it can't live in vitest.
 */
import { describe, it, expect } from 'vitest'
import type { Timeline } from '@/lib/types'
import { planCompositeFrame, compositeLayerToElementStyle, type CompositeLayer } from './composite-frame'
import { planToInstructions, type CompositeLayerInstruction } from '@/electron/ipc/composite-host'
import { getCompositeDuration } from './sequence'

// Same fixture shape as composite-frame.test.ts / sequence.test.ts.
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

/**
 * The PREVIEW's consumption of a plan: the same plan the DOM media pool
 * (src/lib/compositor/preview-media-pool.ts) and PreviewMediaLayer.tsx read, resolved
 * to the same concrete element styles via compositeLayerToElementStyle. This
 * mirrors what the host instruction carries (transform/filter/blend/opacity/z)
 * plus the seek (localT) + pool key.
 */
const previewView = (tl: Timeline, t: number, opts?: { fade?: boolean }) => {
  const plan = planCompositeFrame(tl, t, opts)
  if (plan.isGap) return { isGap: true as const, layers: [] }
  return {
    isGap: false as const,
    layers: plan.layers.map((l: CompositeLayer) => {
      const style = compositeLayerToElementStyle(l)
      return {
        kind: l.kind,
        layerKey: l.layerKey,
        localT: l.localT,
        z: style.zIndex,
        opacity: style.opacity,
        transform: style.transform,
        filter: style.filter,
        mixBlendMode: style.mixBlendMode,
      }
    }),
  }
}

/**
 * The EXPORT host's consumption of the SAME plan. `resolve` mirrors what
 * export-tier3 passes: a scene → its HTML url, media → the file url. The url
 * value itself is not under parity test (it's a path resolution); we normalize it
 * to the layerKey so the comparison is on seek/style/z/opacity — the pixel-bearing
 * fields — not on a host-only path string.
 */
const exportView = (tl: Timeline, t: number, opts?: { fade?: boolean }) => {
  const plan = planCompositeFrame(tl, t, opts)
  const instructions = planToInstructions(plan, (layer) => ({
    url: `resolved://${layer.layerKey}`,
    isVideoScene: false,
  }))
  if (plan.isGap) return { isGap: true as const, layers: [] }
  return {
    isGap: false as const,
    layers: instructions.map((i: CompositeLayerInstruction) => ({
      kind: i.kind,
      layerKey: i.layerKey,
      localT: i.localT,
      z: i.z,
      opacity: i.opacity,
      transform: i.transform,
      filter: i.filter,
      mixBlendMode: i.mixBlendMode,
    })),
  }
}

/** Sample [0, duration) at N evenly-spaced instants plus the clip-boundary edges. */
const sampleTimes = (tl: Timeline, n: number): number[] => {
  const dur = getCompositeDuration(tl)
  const times: number[] = []
  for (let i = 0; i < n; i++) times.push((dur * i) / n)
  // Boundary-adjacent samples — where float drift / active-set flips bite.
  for (const t of times.slice()) {
    times.push(Math.max(0, t - 0.001))
    times.push(t + 0.001)
  }
  return times.filter((t) => t >= 0 && t < dur)
}

describe('composite parity — export host plan == preview plan (pixel-unify P1c)', () => {
  it('plain scene sequence: every sample agrees frame-for-frame', () => {
    const tl = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [
          aclip({ id: 's1', trackId: 'v1', startTime: 0, duration: 4 }),
          aclip({ id: 's2', trackId: 'v1', startTime: 4, duration: 4 }),
        ],
      }),
    ])
    for (const t of sampleTimes(tl, 16)) {
      expect(exportView(tl, t), `t=${t}`).toEqual(previewView(tl, t))
    }
  })

  it('V2 media stacked over V1 scene, with transform + opacity + filter + blend', () => {
    const tl = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [aclip({ id: 's1', trackId: 'v1', startTime: 0, duration: 8 })],
      }),
      track({
        id: 'v2',
        position: 1,
        clips: [
          aclip({
            id: 'vid1',
            trackId: 'v2',
            sourceType: 'video',
            sourceId: 'vid1',
            startTime: 2,
            duration: 4,
            opacity: 0.6,
            position: { x: 120, y: 40 },
            scale: { x: 0.5, y: 0.5 },
            rotation: 15,
            filters: [{ type: 'brightness', value: 1.2 }],
            blendMode: 'screen',
          }),
        ],
      }),
    ])
    for (const t of sampleTimes(tl, 24)) {
      // Both the stacked-window (V2 visible) and the V1-only window must agree,
      // including the per-layer transform/filter/blend the host applies to media.
      expect(exportView(tl, t), `t=${t}`).toEqual(previewView(tl, t))
    }
  })

  it('gap between clips: export and preview both report a gap (black)', () => {
    const tl = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [
          aclip({ id: 's1', trackId: 'v1', startTime: 0, duration: 3 }),
          aclip({ id: 's2', trackId: 'v1', startTime: 6, duration: 3 }), // 3s..6s gap
        ],
      }),
    ])
    // Inside the gap both must be empty (the host shows the black stage; the
    // preview shows black) — the parity that proves a gap is a real gap on both.
    for (const t of [3.5, 4, 5, 5.999]) {
      const e = exportView(tl, t)
      const p = previewView(tl, t)
      expect(e.layers, `t=${t} export`).toEqual([])
      expect(p.isGap, `t=${t} preview`).toBe(true)
    }
    // Non-gap samples still agree.
    for (const t of sampleTimes(tl, 12)) {
      expect(exportView(tl, t), `t=${t}`).toEqual(previewView(tl, t))
    }
  })

  it('split halves of one scene keep distinct seek times on both sides', () => {
    const tl = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [
          aclip({ id: 's1', trackId: 'v1', startTime: 0, duration: 3, trimStart: 0 }),
          aclip({ id: 's1', trackId: 'v1', startTime: 3, duration: 3, trimStart: 3 }),
        ],
      }),
    ])
    for (const t of sampleTimes(tl, 12)) {
      expect(exportView(tl, t), `t=${t}`).toEqual(previewView(tl, t))
    }
  })

  // applyFadeTransition (composite-frame.ts) MUTATES the layer set mid-frame (ramps
  // the outgoing alpha and ADDS the incoming scene pre-seeked at z=1). The other
  // cases never pass opts.fade, so that whole code path shipped untested by the
  // parity suite. HONEST SCOPE: like every case here, this is single-resolver — both
  // views call the identical planCompositeFrame + compositeLayerToElementStyle, so it
  // CANNOT detect a preview≠export executor divergence (only the out-of-band pixel
  // harness can). What it DOES lock: that `planToInstructions` carries the
  // fade-doubled layer set into the EXPORT instruction stream without dropping,
  // reordering, or mis-resolving the added incoming layer — a real regression lock
  // (a future change that filtered fade-added layers on the export side fails here),
  // plus characterization of the fade math (progress, ramp, pre-seek to trimStart).
  it('crossfade (opts.fade): export==preview through the outgoing-ramp + added incoming layer', () => {
    const tl = mtl([
      track({
        id: 'v1',
        position: 0,
        clips: [
          // s1 fades into s2 over its final 1s (the 4s..5s window of s1's [0,5)).
          aclip({
            id: 's1',
            trackId: 'v1',
            startTime: 0,
            duration: 5,
            transition: { type: 'fade', duration: 1 },
          }),
          aclip({ id: 's2', trackId: 'v1', startTime: 5, duration: 5, trimStart: 0 }),
        ],
      }),
    ])
    // Dense sampling AROUND and THROUGH the fade window (4s..5s) — pre-fade (single
    // layer), mid-fade (two stacked layers, partial alphas), and the boundary — so a
    // divergence in when/how the incoming layer is added or ramped is caught.
    const fadeTimes = [...sampleTimes(tl, 20), 3.999, 4.0, 4.001, 4.25, 4.4, 4.5, 4.6, 4.75, 4.9, 4.999]
    let sawTwoLayers = false
    for (const t of fadeTimes) {
      const e = exportView(tl, t, { fade: true })
      const p = previewView(tl, t, { fade: true })
      expect(e, `t=${t}`).toEqual(p)
      if (!e.isGap && e.layers.length === 2) sawTwoLayers = true
    }
    // Guard the guard: the case is meaningless unless we actually exercised the
    // layer-doubling (two stacked scenes) somewhere in the fade window.
    expect(sawTwoLayers, 'fade window never produced two stacked layers').toBe(true)
  })
})
