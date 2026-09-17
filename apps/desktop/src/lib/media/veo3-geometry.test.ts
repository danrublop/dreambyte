import { describe, it, expect } from 'vitest'
import {
  computeVeo3FullFrameDims,
  veo3DimsAreFalsy,
  resolveVeo3CenterCoords,
  VEO3_ANCHOR_VERSION,
} from './veo3-geometry'
import { resolveProjectDimensions } from '../dimensions'

describe('computeVeo3FullFrameDims', () => {
  it('never returns a 0×0 box at any aspect ratio', () => {
    for (const ar of ['16:9', '9:16', '1:1', '4:5']) {
      for (const proj of [
        resolveProjectDimensions('16:9', '1080p'),
        resolveProjectDimensions('9:16', '1080p'),
        resolveProjectDimensions('1:1', '1080p'),
      ]) {
        const box = computeVeo3FullFrameDims(ar, proj)
        expect(box.width).toBeGreaterThan(0)
        expect(box.height).toBeGreaterThan(0)
      }
    }
  })

  it('contain-fits a 16:9 clip into a 16:9 frame to fill it exactly', () => {
    const box = computeVeo3FullFrameDims('16:9', { width: 1920, height: 1080 })
    expect(box).toEqual({ width: 1920, height: 1080 })
  })

  it('contain-fits a 16:9 clip into a 9:16 frame by frame width (letterboxed top/bottom)', () => {
    const box = computeVeo3FullFrameDims('16:9', { width: 1080, height: 1920 })
    expect(box.width).toBe(1080)
    expect(box.height).toBe(Math.round(1080 / (16 / 9))) // 608
    expect(box.height).toBeLessThan(1920)
  })

  it('contain-fits a 9:16 clip into a 16:9 frame by frame height (pillarboxed)', () => {
    const box = computeVeo3FullFrameDims('9:16', { width: 1920, height: 1080 })
    expect(box.height).toBe(1080)
    expect(box.width).toBe(Math.round(1080 * (9 / 16))) // 608
    expect(box.width).toBeLessThan(1920)
  })

  it('defends against garbage aspect ratio + zero project dims', () => {
    const box = computeVeo3FullFrameDims('garbage', { width: 0, height: 0 })
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
  })
})

describe('veo3DimsAreFalsy', () => {
  it('flags zero/missing dims', () => {
    expect(veo3DimsAreFalsy({ width: 0, height: 0 })).toBe(true)
    expect(veo3DimsAreFalsy({ width: 1920, height: 0 })).toBe(true)
    expect(veo3DimsAreFalsy({})).toBe(true)
    expect(veo3DimsAreFalsy({ width: 1920, height: 1080 })).toBe(false)
  })
})

describe('resolveVeo3CenterCoords — anchor convention + legacy translate', () => {
  it('treats a flagged layer (anchorVersion>=2) as already-center', () => {
    const c = resolveVeo3CenterCoords({ x: 960, y: 540, width: 1920, height: 1080, anchorVersion: VEO3_ANCHOR_VERSION })
    expect(c).toEqual({ cx: 960, cy: 540 })
  })

  it('translates a legacy (unflagged) top-left layer to center', () => {
    // legacy authored x/y as the top-left corner → center is x+w/2, y+h/2
    const c = resolveVeo3CenterCoords({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(c).toEqual({ cx: 960, cy: 540 })
  })

  it('anchor parity: a flagged layer renders to the SAME center as preview HTML math and pixi position', () => {
    // New-writer layer: x/y ARE the center. Preview computes left = cx - w/2;
    // pixi positions the 0.5-anchored sprite at (cx, cy). Both must agree on center.
    const layer = { x: 540, y: 960, width: 1080, height: 608, anchorVersion: VEO3_ANCHOR_VERSION }
    const center = resolveVeo3CenterCoords(layer)
    // pixi sets sprite.position = center (anchor 0.5)
    expect(center).toEqual({ cx: 540, cy: 960 })
    // preview HTML: left/top = center - half; the visual center is back at (cx, cy)
    const left = center.cx - layer.width / 2
    const top = center.cy - layer.height / 2
    expect(left + layer.width / 2).toBe(center.cx)
    expect(top + layer.height / 2).toBe(center.cy)
  })

  it('legacy translate is idempotent across a checkpoint/undo replay carrying unflagged coords', () => {
    // Replay restores the ORIGINAL (pre-migration) layer: top-left coords, no flag.
    // Because the resolver is pure (never writes back the flag), resolving the
    // restored layer yields the SAME center as the first resolve — apply twice == once.
    const legacy = { x: 100, y: 200, width: 800, height: 450 }
    const first = resolveVeo3CenterCoords(legacy)
    // Simulate replay: the stored object is unchanged (we never mutated it).
    const replayed = { ...legacy } // pre-migration coords, still no flag
    const second = resolveVeo3CenterCoords(replayed)
    expect(second).toEqual(first)
    expect(first).toEqual({ cx: 500, cy: 425 })
  })

  it('does NOT double-translate a flagged layer even if resolved repeatedly', () => {
    const flagged = { x: 500, y: 425, width: 800, height: 450, anchorVersion: VEO3_ANCHOR_VERSION }
    const a = resolveVeo3CenterCoords(flagged)
    const b = resolveVeo3CenterCoords({ ...flagged, x: a.cx, y: a.cy })
    expect(b).toEqual(a)
  })
})
