// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  captionStyleFor,
  captionForceStyle,
  escapeSubtitlesFilterPath,
  buildSubtitlesFilterArg,
  buildExportCaptionBundle,
  hasXfadeTransitions,
} from './caption-burnin'

describe('captionStyleFor — safe-area presets per aspect class', () => {
  it('portrait (9:16, 4:5) gets the largest bottom margin (social UI chrome)', () => {
    const nineSixteen = captionStyleFor(1080, 1920)
    const fourFive = captionStyleFor(1080, 1350)
    expect(nineSixteen.marginVPlayRes).toBe(Math.round(288 * 0.12))
    expect(fourFive.marginVPlayRes).toBe(nineSixteen.marginVPlayRes)
    expect(nineSixteen.fontSizePlayRes).toBe(20)
  })

  it('square (1:1) sits between', () => {
    const square = captionStyleFor(1080, 1080)
    expect(square.marginVPlayRes).toBe(Math.round(288 * 0.08))
  })

  it('landscape (16:9) uses the broadcast-ish margin', () => {
    const wide = captionStyleFor(1920, 1080)
    expect(wide.marginVPlayRes).toBe(Math.round(288 * 0.05))
    expect(wide.fontSizePlayRes).toBe(16)
    // Strictly increasing margins: landscape < square < portrait
    expect(wide.marginVPlayRes).toBeLessThan(captionStyleFor(1080, 1080).marginVPlayRes)
    expect(captionStyleFor(1080, 1080).marginVPlayRes).toBeLessThan(captionStyleFor(1080, 1920).marginVPlayRes)
  })

  it('exact class boundaries: 0.9 is square (portrait is strict <), 1.1 is square (inclusive)', () => {
    const square = captionStyleFor(1080, 1080)
    expect(captionStyleFor(900, 1000)).toEqual(square) // ratio 0.9 → square branch
    expect(captionStyleFor(1100, 1000)).toEqual(square) // ratio 1.1 → still square
    expect(captionStyleFor(1101, 1000)).toEqual(captionStyleFor(1920, 1080)) // just above → landscape
  })
})

describe('captionForceStyle', () => {
  it('emits bottom-center alignment with outline + shadow', () => {
    const style = captionForceStyle(1920, 1080)
    expect(style).toContain('Alignment=2')
    expect(style).toContain('Outline=1.5')
    expect(style).toContain('PrimaryColour=&H00FFFFFF')
    expect(style).toContain(`MarginV=${Math.round(288 * 0.05)}`)
  })
})

describe('escapeSubtitlesFilterPath — ffmpeg filter-graph escaping', () => {
  it('escapes backslashes and colons (Windows drive paths survive)', () => {
    expect(escapeSubtitlesFilterPath('C:\\tmp\\cap.srt')).toBe("C\\:\\\\tmp\\\\cap.srt")
    expect(escapeSubtitlesFilterPath('/tmp/plain.srt')).toBe('/tmp/plain.srt')
  })

  it("quote-splices apostrophes (naive \\' inside the quoted path breaks ffmpeg's parse)", () => {
    // Close the graph-level quote, emit a graph-escaped option-level \' , reopen:
    // o'brien → o'\\\''brien. Verified against the bundled ffmpeg 6.0 in
    // caption-burnin.integration.test.ts — the previous \' form fails to parse.
    expect(escapeSubtitlesFilterPath("/tmp/o'brien.srt")).toBe("/tmp/o'\\\\\\''brien.srt")
  })

  it('leaves graph-special chars [];, alone — the quoted wrapper protects them', () => {
    expect(escapeSubtitlesFilterPath('/tmp/a [draft]; v2, final.srt')).toBe('/tmp/a [draft]; v2, final.srt')
  })
})

describe('buildSubtitlesFilterArg', () => {
  it('assembles subtitles= with the escaped path and force_style', () => {
    const arg = buildSubtitlesFilterArg('/tmp/captions.srt', 1080, 1920)
    expect(arg).toMatch(/^subtitles='\/tmp\/captions\.srt':force_style='/)
    expect(arg).toContain('Alignment=2')
    expect(arg).toContain(`MarginV=${Math.round(288 * 0.12)}`)
  })
})

describe('buildExportCaptionBundle — shared assembly for all export paths', () => {
  const words = (offset: number) => [
    { text: 'hello', start: offset + 0.0, end: offset + 0.4 },
    { text: 'world', start: offset + 0.5, end: offset + 0.9 },
  ]

  it('returns null for NLE-timeline projects when no offsets are provided', () => {
    expect(buildExportCaptionBundle([{ duration: 5, words: words(0) }], true)).toBeNull()
  })

  it('timeline export: offsets each scene by its REAL clip startTime (not scene order)', () => {
    // Two scenes; scene B sits BEFORE scene A on the timeline (reorder) with a gap.
    const bundle = buildExportCaptionBundle(
      [
        { duration: 5, words: words(0) }, // scene A, placed at t=10
        { duration: 5, words: words(0) }, // scene B, placed at t=2
      ],
      true,
      [10, 2],
    )
    expect(bundle).not.toBeNull()
    // Earliest cue must come from scene B at t≈2, NOT scene A's array position.
    expect(bundle!.cues[0].start).toBeGreaterThanOrEqual(2)
    expect(bundle!.cues[0].start).toBeLessThan(3)
    const last = bundle!.cues[bundle!.cues.length - 1]
    expect(last.start).toBeGreaterThanOrEqual(10) // scene A's slot at t=10
  })

  it('timeline export: a null offset (scene not on the timeline) skips that scene', () => {
    const bundle = buildExportCaptionBundle(
      [
        { duration: 5, words: words(0) }, // not placed → skipped
        { duration: 5, words: words(0) }, // placed at t=3
      ],
      true,
      [null, 3],
    )
    expect(bundle).not.toBeNull()
    // Only the placed scene contributes; its first cue is at t≈3.
    expect(bundle!.cues[0].start).toBeGreaterThanOrEqual(3)
    expect(bundle!.cues[0].start).toBeLessThan(4)
  })

  it('timeline export: mismatched offsets length → null (caller bug guard)', () => {
    expect(buildExportCaptionBundle([{ duration: 5, words: words(0) }], true, [1, 2])).toBeNull()
  })

  it('timeline export: all offsets null → null (nothing placed)', () => {
    expect(buildExportCaptionBundle([{ duration: 5, words: words(0) }], true, [null])).toBeNull()
  })

  it('returns null when no scene carries word timings', () => {
    expect(buildExportCaptionBundle([{ duration: 5 }, { duration: 3, words: [] }], false)).toBeNull()
  })

  it('builds cues and offsets scene 2 by scene 1 duration', () => {
    const bundle = buildExportCaptionBundle(
      [
        { duration: 5, words: words(0) },
        { duration: 5, words: words(0) }, // scene-local timings; cursor adds +5s
      ],
      false,
    )
    expect(bundle).not.toBeNull()
    expect(bundle!.cues.length).toBeGreaterThanOrEqual(2)
    const lastCue = bundle!.cues[bundle!.cues.length - 1]
    expect(lastCue.start).toBeGreaterThanOrEqual(5) // landed after scene 1's slot
    expect(bundle!.srt).toContain('hello world')
  })

  it('compensates cue offsets for xfade shortening (transitions overlap scenes)', () => {
    // Port-parity with packages/render-server/xfade-timeline.js: a 0.5s crossfade means
    // scene 2's content starts at 4.5s in the output, not 5s — a plain running
    // sum drifts every later cue late (visible once burned into pixels).
    const bundle = buildExportCaptionBundle(
      [
        { duration: 5, words: words(0), transitionToNext: 'crossfade', transitionToNextDuration: 0.5 },
        { duration: 5, words: words(0) },
      ],
      false,
    )
    expect(bundle).not.toBeNull()
    const lastCue = bundle!.cues[bundle!.cues.length - 1]
    expect(lastCue.start).toBeGreaterThanOrEqual(4.5)
    expect(lastCue.start).toBeLessThan(5) // shortened start, NOT the raw 5s sum
  })

  it("hasXfadeTransitions ignores the last scene's transition (no join after it)", () => {
    expect(hasXfadeTransitions([{ duration: 5, transitionToNext: 'crossfade' }])).toBe(false)
    expect(
      hasXfadeTransitions([
        { duration: 5, transitionToNext: 'none' },
        { duration: 5, transitionToNext: 'crossfade' },
      ]),
    ).toBe(false)
    expect(
      hasXfadeTransitions([
        { duration: 5, transitionToNext: 'crossfade' },
        { duration: 5 },
      ]),
    ).toBe(true)
  })

  it('a non-finite scene duration does not poison later cue offsets', () => {
    const bundle = buildExportCaptionBundle(
      [
        { duration: NaN, words: words(0) }, // bad duration — treated as 0
        { duration: 5, words: words(0) },
      ],
      false,
    )
    expect(bundle).not.toBeNull()
    expect(bundle!.srt).not.toContain('NaN')
    for (const cue of bundle!.cues) {
      expect(Number.isFinite(cue.start)).toBe(true)
      expect(Number.isFinite(cue.end)).toBe(true)
    }
  })
})
