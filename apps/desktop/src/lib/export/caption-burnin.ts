/**
 * Caption burn-in (A3): style + filter construction for hardcoding the
 * project's TTS captions into the exported MP4 pixels.
 *
 * Pure module — the ffmpeg invocation lives in src/electron/ipc/caption-burn.ts;
 * everything here is deterministic string-building so it can be unit-tested
 * and shared by any export path (tier3 / mixed / legacy all funnel their
 * final MP4 through the same burn pass).
 *
 * Styling uses libass `force_style` over the SRT. libass renders SRT against
 * a default 384x288 PlayRes, so FontSize/MarginV below are in 288-line units
 * and scale with the actual video height automatically.
 */

/** PlayResY libass uses for SRT input — style units are relative to this. */
const PLAY_RES_Y = 288

export interface CaptionStyle {
  fontSizePlayRes: number
  marginVPlayRes: number
}

/**
 * Safe-area styling per aspect class. Portrait (9:16 and 4:5, ratio < 0.9)
 * needs the biggest bottom margin — social UIs overlay controls/captions
 * there; square (1:1) sits between; landscape (16:9) uses a classic
 * broadcast-ish margin.
 */
export function captionStyleFor(width: number, height: number): CaptionStyle {
  const ratio = width / height
  if (ratio < 0.9) {
    // Portrait class: 9:16 (0.5625) and 4:5 (0.8) both land here
    return { fontSizePlayRes: 20, marginVPlayRes: Math.round(PLAY_RES_Y * 0.12) }
  }
  if (ratio <= 1.1) {
    // Square-ish (1:1)
    return { fontSizePlayRes: 18, marginVPlayRes: Math.round(PLAY_RES_Y * 0.08) }
  }
  // Landscape (16:9 and wider)
  return { fontSizePlayRes: 16, marginVPlayRes: Math.round(PLAY_RES_Y * 0.05) }
}

/** libass force_style string: bottom-center, white with outline + soft shadow. */
export function captionForceStyle(width: number, height: number): string {
  const s = captionStyleFor(width, height)
  return [
    'FontName=Arial',
    `FontSize=${s.fontSizePlayRes}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=1.5',
    'Shadow=0.5',
    'Alignment=2', // bottom-center
    `MarginV=${s.marginVPlayRes}`,
  ].join(',')
}

/**
 * Escape a filesystem path for use INSIDE an ffmpeg filter argument.
 *
 * The value goes through TWO parsers: the filtergraph tokenizer (we wrap the
 * path in single quotes, so graph-special chars `[];,` stay literal — but a
 * raw `'` would terminate that quote) and then the filter's own option parser
 * (which eats `\` and `:`, hence Windows drive letters become `\:`).
 *
 * A literal `'` therefore needs the quote-splice: close the graph quote, emit
 * a graph-escaped option-level `\'` (i.e. `\\` + `\'`), reopen the quote —
 * `'` → `'\\\''`. NOTE: a naive `\'` INSIDE the quotes does NOT work (the
 * graph parser treats everything inside quotes literally, so the `'` still
 * terminates) — verified against the bundled ffmpeg 6.0, which rejects the
 * naive form and accepts this one (see caption-burnin.integration.test.ts).
 * Order matters: backslashes first.
 */
export function escapeSubtitlesFilterPath(p: string): string {
  return p.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "'\\\\\\''")
}

/** The full -vf argument for the burn pass. */
export function buildSubtitlesFilterArg(srtPath: string, width: number, height: number): string {
  return `subtitles='${escapeSubtitlesFilterPath(srtPath)}':force_style='${captionForceStyle(width, height)}'`
}

// ── Shared bundle assembly (renderer-side) ────────────────────────────────────

import { mergeProjectCaptions, type CaptionBundle } from '../audio/captions'
import type { WordSegment } from '../audio/captions'

export interface CaptionSceneLike {
  duration: number
  words?: WordSegment[] | null
  /** Transition joining this scene to the NEXT one ('none'/undefined = hard cut). */
  transitionToNext?: string | null
  /** Requested transition duration in seconds (stitcher default: 0.5). */
  transitionToNextDuration?: number | null
}

/** True when the export will take the stitcher's xfade path (any real transition). */
export function hasXfadeTransitions(scenes: CaptionSceneLike[]): boolean {
  return scenes.slice(0, -1).some((s) => (s.transitionToNext ?? 'none') !== 'none')
}

/**
 * Where each scene's content starts in the FINAL stitched output.
 *
 * Cuts-only exports concat losslessly, so starts are the plain running sum.
 * But one real transition flips the stitcher onto its xfade path, where every
 * join overlaps its two inputs by transDur — the output is SHORTER than the
 * sum of scene durations, and a plain running sum drifts every later cue
 * progressively late (visibly so once captions are burned into pixels).
 *
 * The xfade branch is a port of packages/render-server/xfade-timeline.js
 * computeXfadeTimeline (offsets + clamping) — KEEP IN SYNC with it.
 */
function computeSceneStartOffsets(scenes: CaptionSceneLike[]): number[] {
  // Non-finite duration would poison every later cue's offset into
  // `NaN:NaN:NaN,NaN` SRT timestamps (which libass rejects → burn fails).
  const durations = scenes.map((s) => (Number.isFinite(s.duration) ? s.duration : 0))
  if (!hasXfadeTransitions(scenes)) {
    let cursor = 0
    return durations.map((d) => {
      const start = cursor
      cursor += d
      return start
    })
  }
  const CUT_TRANSITION_SECONDS = 0.04 // near-cut the xfade path uses for 'none' joins
  const starts = [0]
  let outLen = durations[0] || 0
  for (let i = 0; i < scenes.length - 1; i++) {
    const isCut = (scenes[i].transitionToNext ?? 'none') === 'none'
    const requestedDur = scenes[i].transitionToNextDuration || 0.5
    const next = durations[i + 1] || 0
    const transDur = Math.max(0, Math.min(isCut ? CUT_TRANSITION_SECONDS : requestedDur, outLen, next))
    starts.push(Math.max(0, outLen - transDur))
    outLen += next - transDur
  }
  return starts
}

/**
 * Assemble the project-level caption bundle from per-scene TTS word timings —
 * the single home for the cursor-accumulation logic the three export paths
 * (tier3 / mixed / legacy) share for their sidecars.
 *
 * Start offsets per scene come from one of two sources:
 *   - **non-timeline** export: the running sum of scene durations (xfade-aware).
 *   - **timeline** export (single-stream): the scene clips' REAL startTimes
 *     on the timeline, passed in as `timelineStarts` (parallel to `scenes`; a
 *     `null` entry = scene not placed on the timeline → its words are skipped).
 *     Scene-order accumulation can't be used here — gaps, reorders, and V2-over-V1
 *     overlaps would misalign every cue. Without `timelineStarts` a timeline
 *     project still returns null (the caller hasn't resolved offsets yet).
 *
 * Returns null when no scene carries word timings (or a timeline project gave no
 * offsets), or when the merged bundle has no cues.
 */
export function buildExportCaptionBundle(
  scenes: CaptionSceneLike[],
  hasTimeline: boolean,
  timelineStarts?: Array<number | null>,
): CaptionBundle | null {
  let starts: Array<number | null>
  if (hasTimeline) {
    if (!timelineStarts || timelineStarts.length !== scenes.length) return null
    starts = timelineStarts
  } else {
    starts = computeSceneStartOffsets(scenes)
  }
  const inputs: Array<{ startSeconds: number; words: WordSegment[] }> = []
  scenes.forEach((s, i) => {
    const start = starts[i]
    // Skip scenes with no words or an unresolved/non-finite offset — a NaN start
    // would poison the SRT timestamps (NaN:NaN:NaN) and fail the libass burn.
    if (s.words && s.words.length > 0 && start != null && Number.isFinite(start)) {
      inputs.push({ startSeconds: start, words: s.words })
    }
  })
  if (inputs.length === 0) return null
  const bundle = mergeProjectCaptions(inputs)
  return bundle.cues.length > 0 ? bundle : null
}
