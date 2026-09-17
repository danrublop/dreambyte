/**
 * Pure xfade timeline math for the crossfade stitch.
 *
 * Kept separate from stitcher.js so the offset calculation is unit-testable
 * without ffmpeg.
 * Plain ESM JS (no deps) so packages/render-server/stitcher.js can import it directly
 * AND the root vitest suite can import it from a src/lib/ test (render-server is
 * excluded from vitest test *discovery*, not from being imported).
 *
 * Each xfade overlaps its two inputs by transDur, so the chained output stream
 * grows by (nextScene − transDur) per join — NOT by the raw scene duration.
 *
 *   scene0   scene1   scene2
 *   [====]   [======] [======]
 *        \xf/      \xf/
 *   offset0 = len(scene0) − transDur
 *   offset1 = (running stream length so far) − transDur   ← must use the
 *             SHORTENED running length, not Σ raw durations
 *
 * Summing raw scene durations instead truncates the final scene on 3+ scene
 * crossfades (a 6+8+8 set would come out ~13.5s instead of ~21s).
 */

/** Keep in sync with src/lib/transitions.ts TRANSITION_CATALOG xfade values. */
const XFADE_MAP = {
  none: 'fade',
  crossfade: 'fade',
  dissolve: 'dissolve',
  'fade-black': 'fadeblack',
  'fade-white': 'fadewhite',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'wipe-up': 'wipeup',
  'wipe-down': 'wipedown',
  'wipe-tl': 'wipetl',
  'wipe-tr': 'wipetr',
  'wipe-bl': 'wipebl',
  'wipe-br': 'wipebr',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'slide-up': 'slideup',
  'slide-down': 'slidedown',
  'smooth-left': 'smoothleft',
  'smooth-right': 'smoothright',
  'smooth-up': 'smoothup',
  'smooth-down': 'smoothdown',
  'circle-open': 'circleopen',
  'circle-close': 'circleclose',
  radial: 'radial',
  'vert-open': 'vertopen',
  'horz-open': 'horzopen',
  'cover-left': 'coverleft',
  'cover-right': 'coverright',
  'reveal-left': 'revealleft',
  'reveal-right': 'revealright',
  'diag-tl': 'diagtl',
  'diag-tr': 'diagtr',
  'diag-bl': 'diagbl',
  'diag-br': 'diagbr',
  'zoom-in': 'zoomin',
  distance: 'distance',
}

/** Map a transition id to its FFmpeg xfade transition name (fallback: 'fade'). */
export function getXfadeType(transition) {
  return XFADE_MAP[transition] || 'fade'
}

/** A hard cut, when it appears inside an xfade graph, is a near-instant fade. */
export const CUT_TRANSITION_SECONDS = 0.04

/**
 * Compute per-join xfade offsets and the final stream length.
 *
 * @param {number[]} durations   per-scene durations in seconds (length N)
 * @param {Array<{type?:string, duration?:number}>} transitions  length N-1
 * @returns {{ joins: Array<{offset:number, transDur:number, xfadeType:string, isCut:boolean}>, finalLength:number }}
 */
export function computeXfadeTimeline(durations, transitions) {
  const n = durations.length
  const joins = []
  let outLen = durations[0] || 0

  for (let i = 0; i < n - 1; i++) {
    const transition = transitions[i] || { type: 'none', duration: 0.5 }
    const isCut = (transition.type ?? 'none') === 'none'
    const requestedDur = transition.duration || 0.5
    const next = durations[i + 1] || 0
    // ffmpeg xfade requires duration ≤ BOTH inputs: the accumulated left stream
    // (length outLen) and the next scene (length next). Clamp to the shorter side
    // so a short scene doesn't make xfade error — now fatal since the silent
    // concat fallback was removed. Cuts clamp too: a 1-frame scene can be
    // shorter than the 0.04s near-cut.
    const transDur = Math.max(
      0,
      Math.min(isCut ? CUT_TRANSITION_SECONDS : requestedDur, outLen, next),
    )
    const xfadeType = getXfadeType(transition.type)

    // Start the transition transDur before the CURRENT chained stream ends.
    const offset = Math.max(0, outLen - transDur)
    joins.push({ offset, transDur, xfadeType, isCut })

    outLen += next - transDur
  }

  return { joins, finalLength: outLen }
}
