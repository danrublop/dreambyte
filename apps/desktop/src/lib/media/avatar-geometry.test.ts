import { describe, it, expect } from 'vitest'
import { computeAvatarPipCenter, clampSpriteCenterIntoCanvas, PIP_DEFAULT_SIZE } from './avatar-geometry'
import { resolveProjectDimensions } from '../dimensions'

const ASPECTS = ['16:9', '9:16', '1:1'] as const

describe('computeAvatarPipCenter — pip in-canvas at every aspect ratio', () => {
  it('keeps the pip box fully inside the frame for all four corners at 16:9/9:16/1:1', () => {
    const half = PIP_DEFAULT_SIZE / 2
    for (const ar of ASPECTS) {
      const dims = resolveProjectDimensions(ar, '1080p')
      for (const placement of ['pip_bottom_right', 'pip_bottom_left', 'pip_top_right', 'pip_top_left']) {
        const c = computeAvatarPipCenter(placement, dims)
        // box [c.x±half, c.y±half] must be within [0,W]×[0,H]
        expect(c.x - half).toBeGreaterThanOrEqual(0)
        expect(c.y - half).toBeGreaterThanOrEqual(0)
        expect(c.x + half).toBeLessThanOrEqual(dims.width)
        expect(c.y + half).toBeLessThanOrEqual(dims.height)
      }
    }
  })

  it('the old hardcoded 1640/800 would be offscreen on 9:16 — the computed center is not', () => {
    const dims = resolveProjectDimensions('9:16', '1080p') // 1080×1920
    // hardcoded x=1640 exceeds width 1080 → offscreen; computed must be < width
    const c = computeAvatarPipCenter('pip_bottom_right', dims)
    expect(c.x).toBeLessThan(dims.width)
    expect(1640).toBeGreaterThan(dims.width) // proves the bug the fix addresses
  })

  it('right placements sit on the right, top placements sit on top', () => {
    const dims = resolveProjectDimensions('16:9', '1080p')
    const br = computeAvatarPipCenter('pip_bottom_right', dims)
    const bl = computeAvatarPipCenter('pip_bottom_left', dims)
    const tr = computeAvatarPipCenter('pip_top_right', dims)
    expect(br.x).toBeGreaterThan(dims.width / 2)
    expect(bl.x).toBeLessThan(dims.width / 2)
    expect(tr.y).toBeLessThan(dims.height / 2)
    expect(br.y).toBeGreaterThan(dims.height / 2)
  })
})

describe('clampSpriteCenterIntoCanvas — export backstop', () => {
  it('pulls an offscreen center back so the box stays inside', () => {
    const clamped = clampSpriteCenterIntoCanvas(
      { x: 1640, y: 1800 },
      { width: 280, height: 280 },
      { width: 1080, height: 1920 },
    )
    expect(clamped.x + 140).toBeLessThanOrEqual(1080)
    expect(clamped.y + 140).toBeLessThanOrEqual(1920)
    expect(clamped.x - 140).toBeGreaterThanOrEqual(0)
  })

  it('leaves an already-inside center untouched', () => {
    const c = clampSpriteCenterIntoCanvas(
      { x: 540, y: 960 },
      { width: 280, height: 280 },
      { width: 1080, height: 1920 },
    )
    expect(c).toEqual({ x: 540, y: 960 })
  })

  it('centers a sprite larger than the canvas on that axis', () => {
    const c = clampSpriteCenterIntoCanvas({ x: 0, y: 0 }, { width: 4000, height: 200 }, { width: 1920, height: 1080 })
    expect(c.x).toBe(960) // canvas.width / 2
  })
})
