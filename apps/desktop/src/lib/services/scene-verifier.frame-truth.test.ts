// @vitest-environment node

// Pixel-truth helpers: computeNonblankRatio (histogram over a BGRA bitmap) and
// evaluateRenderBlock (the BLOCKING policy). Pure functions — no Electron, no
// window. These are the deterministic core of the slop loop's hard gate, so they
// get direct coverage independent of the offscreen-render plumbing.

import { describe, expect, it } from 'vitest'

import {
  computeNonblankRatio,
  computeFrameStats,
  evaluateRenderBlock,
  BLANK_FRAME_RATIO,
  buildSeekProbeJs,
  FRAME_SAMPLE_FRACTIONS,
} from './scene-verifier'

/** Build a width×height BGRA buffer filled with one color. */
function solid(width: number, height: number, b: number, g: number, r: number): Buffer {
  const buf = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = b
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = r
    buf[i * 4 + 3] = 255
  }
  return buf
}

/** Solid `bg`, with the first `fgFraction` of pixels painted a distinct `fg`
 *  color — a stand-in for a sparse title card (background + one headline). */
function withContent(
  width: number,
  height: number,
  fgFraction: number,
  bg: [number, number, number],
  fg: [number, number, number],
): Buffer {
  const buf = solid(width, height, bg[0], bg[1], bg[2])
  const fgPixels = Math.floor(width * height * fgFraction)
  for (let i = 0; i < fgPixels; i++) {
    buf[i * 4] = fg[0]
    buf[i * 4 + 1] = fg[1]
    buf[i * 4 + 2] = fg[2]
  }
  return buf
}

describe('content-presence escape (T9 — distinctColors)', () => {
  it('a uniform blank frame is one color and is BLOCKED', () => {
    const stats = computeFrameStats(solid(200, 200, 17, 17, 17))
    expect(stats.distinctColors).toBe(1)
    expect(evaluateRenderBlock({ ...stats, brokenImages: 0, totalImages: 0 })).not.toBeNull()
  })

  it('a sparse title card (bg + 1% headline) is below the ratio threshold but ESCAPES the veto', () => {
    // 1% distinct-colored content: nonblankRatio < 2% (would have been vetoed),
    // but two significant colors (background + text) => not blank.
    const stats = computeFrameStats(withContent(200, 200, 0.01, [255, 255, 255], [10, 10, 10]))
    expect(stats.nonblankRatio).toBeLessThan(BLANK_FRAME_RATIO)
    expect(stats.distinctColors).toBeGreaterThanOrEqual(2)
    expect(evaluateRenderBlock({ ...stats, brokenImages: 0, totalImages: 0 })).toBeNull()
  })

  it('falls back to the ratio-only gate when distinctColors is absent', () => {
    expect(evaluateRenderBlock({ nonblankRatio: 0.0, brokenImages: 0, totalImages: 0 })).not.toBeNull()
  })
})

describe('computeNonblankRatio', () => {
  it('returns ~0 for a uniform (blank) frame', () => {
    const buf = solid(64, 48, 17, 17, 17) // a solid dark background, nothing drawn
    expect(computeNonblankRatio(buf)).toBeLessThan(BLANK_FRAME_RATIO)
  })

  it('returns a high ratio when half the frame is a different color', () => {
    const w = 64
    const h = 48
    const buf = solid(w, h, 0, 0, 0)
    // Paint the top half white — that's content over the black background.
    for (let i = 0; i < (w * h) / 2; i++) {
      buf[i * 4] = 255
      buf[i * 4 + 1] = 255
      buf[i * 4 + 2] = 255
    }
    expect(computeNonblankRatio(buf)).toBeGreaterThan(0.4)
  })

  it('counts a small but real content region as non-blank above the floor', () => {
    const w = 100
    const h = 100
    const buf = solid(w, h, 20, 20, 20)
    // ~5% of pixels painted — a modest title/element. Above the 2% floor.
    for (let i = 0; i < 500; i++) {
      buf[i * 4] = 240
      buf[i * 4 + 1] = 240
      buf[i * 4 + 2] = 240
    }
    expect(computeNonblankRatio(buf)).toBeGreaterThan(BLANK_FRAME_RATIO)
  })

  it('samples the WHOLE frame — content in the bottom half is not missed (Retina regression)', () => {
    // The blocker this guards: getSize() reports DIP, toBitmap() returns physical
    // pixels. A bottom-weighted scene must still register as non-blank no matter how
    // the buffer is sized. Content only in the bottom half:
    const w = 64
    const h = 48
    const buf = solid(w, h, 0, 0, 0)
    for (let i = Math.floor((w * h) / 2); i < w * h; i++) {
      buf[i * 4] = 255
      buf[i * 4 + 1] = 255
      buf[i * 4 + 2] = 255
    }
    expect(computeNonblankRatio(buf)).toBeGreaterThan(0.4)
  })

  it('degrades safe (returns 1, never "blank") on a malformed/short buffer', () => {
    expect(computeNonblankRatio(Buffer.alloc(0))).toBe(1)
    expect(computeNonblankRatio(Buffer.alloc(2))).toBe(1)
  })

  it('quantizes near-identical anti-aliased shades into the same background bucket', () => {
    const w = 40
    const h = 40
    const buf = Buffer.alloc(w * h * 4)
    // Fill with values that differ by ≤15 — should collapse into one 4-bit bucket
    // and read as blank, not as content.
    for (let i = 0; i < w * h; i++) {
      const jitter = i % 12 // 0..11, within one 4-bit bucket (>>4)
      buf[i * 4] = jitter
      buf[i * 4 + 1] = jitter
      buf[i * 4 + 2] = jitter
      buf[i * 4 + 3] = 255
    }
    expect(computeNonblankRatio(buf)).toBeLessThan(BLANK_FRAME_RATIO)
  })
})

describe('evaluateRenderBlock', () => {
  it('blocks on a blank frame', () => {
    const block = evaluateRenderBlock({ nonblankRatio: 0.005, brokenImages: 0, totalImages: 0 })
    expect(block?.kind).toBe('blank')
    expect(block?.reason).toMatch(/blank frame/)
    expect(block?.hint).toMatch(/patch_layer_code|regenerate_layer/)
  })

  it('blocks when every image failed to load', () => {
    const block = evaluateRenderBlock({ nonblankRatio: 0.5, brokenImages: 3, totalImages: 3 })
    expect(block?.kind).toBe('broken-images')
    expect(block?.reason).toMatch(/3 image\(s\)/)
  })

  it('does NOT block a healthy frame', () => {
    expect(evaluateRenderBlock({ nonblankRatio: 0.4, brokenImages: 0, totalImages: 2 })).toBeNull()
  })

  it('does NOT block when only some images are broken (partial)', () => {
    expect(evaluateRenderBlock({ nonblankRatio: 0.4, brokenImages: 1, totalImages: 2 })).toBeNull()
  })

  it('blank takes precedence and is reported even if images are also present', () => {
    const block = evaluateRenderBlock({ nonblankRatio: 0.001, brokenImages: 0, totalImages: 1 })
    expect(block?.kind).toBe('blank')
  })
})

// ── Frame-seek probe (the render-gate false-blank root cause) ───────────────
// The capture used to read the window's DEFAULT frame (t=0), where a valid scene
// whose elements animate in from opacity 0 is genuinely blank — flipping every
// animate-in scene to a false "blank frame" failure on the in-app path. The fix
// seeks to a representative HOLD time before capturing. These lock the two traps
// that caused (or would re-cause) the bug.
describe('buildSeekProbeJs (frame-seek before capture)', () => {
  it('seeks through the host clock so tick subscribers (the React bridge) re-render', () => {
    // A bare timeline seek would move the tweens but not the React frame; the
    // controller's __clock.seek renders the timeline AND fires onTick.
    const js = buildSeekProbeJs(0.5)
    expect(js).toMatch(/clock\.seek\(\s*t\s*\)/)
    expect(js).not.toMatch(/__tl/)
  })

  it('falls back to __dreambyteSetFrame for pure-React scenes with no __clock', () => {
    const js = buildSeekProbeJs(0.5)
    expect(js).toMatch(/__dreambyteSetFrame/)
  })

  it('computes the hold time from DURATION × the requested fraction', () => {
    expect(buildSeekProbeJs(0.75)).toContain('var frac = 0.75;')
    expect(buildSeekProbeJs(0.3)).toContain('var frac = 0.3;')
    expect(buildSeekProbeJs(0.5)).toMatch(/dur \* frac/)
  })

  it('samples representative hold fractions, most-likely-populated first', () => {
    // Non-empty, all strictly inside (0,1) — never t=0 (the false-blank frame)
    // and never t=1.0 (exit/cleared state).
    expect(FRAME_SAMPLE_FRACTIONS.length).toBeGreaterThan(0)
    for (const f of FRAME_SAMPLE_FRACTIONS) {
      expect(f).toBeGreaterThan(0)
      expect(f).toBeLessThan(1)
    }
    expect(FRAME_SAMPLE_FRACTIONS[0]).toBe(0.5) // mid-scene hold sampled first
  })
})
