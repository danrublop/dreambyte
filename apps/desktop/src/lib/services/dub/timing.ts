// Segment-level dubbing timing (Tier 3 — video dubbing). After each translated cue is synthesized,
// its TTS audio rarely matches the source cue's duration (different language = different length).
// To keep lips tracking the source video across the whole clip, each dubbed cue is time-fit to its
// source window: sped up / slowed slightly (ffmpeg atempo) when close, padded with trailing silence
// when short, and (clamped) overflowing when a translation is simply too long to fit naturally.

/** Per-cue plan: how to make the dubbed audio occupy [windowMs] starting at the cue's startMs. */
export interface SegmentTimingPlan {
  /** ffmpeg atempo factor applied to the TTS audio. >1 speeds up (audio longer than window),
   *  <1 slows down. Clamped to [MIN_ATEMPO, MAX_ATEMPO] to avoid chipmunk / sludge artifacts. */
  atempo: number
  /** Silence (ms) to append AFTER the (re-tempo'd) audio so the next cue starts on time. 0 if none. */
  padMsAfter: number
  /** True when even at MAX_ATEMPO the audio is still longer than the window — it will spill past the
   *  cue end (we accept a small overlap rather than an unnatural >MAX_ATEMPO speedup). */
  overflows: boolean
  /** The resulting on-timeline duration (ms) this cue occupies once tempo + pad are applied. */
  resultMs: number
}

// Natural-speech bounds. atempo beyond ~1.3x reads as rushed/chipmunk; below ~0.8x as dragging.
export const MIN_ATEMPO = 0.8
export const MAX_ATEMPO = 1.3
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Fit one cue. `windowMs` is the source cue duration (endMs-startMs); `ttsMs` is the raw synthesized
 * audio duration. Returns the tempo + pad to make the dubbed cue best occupy the window:
 *  - ttsMs > windowMs → speed up toward the window (atempo = ttsMs/windowMs, clamped); if the clamp
 *    can't close the gap, mark overflows and accept spill.
 *  - ttsMs < windowMs → keep natural tempo (atempo 1) and pad the remainder with silence.
 *  - ttsMs ≈ windowMs → atempo ~1, no pad.
 */
export function planSegmentTiming(windowMs: number, ttsMs: number): SegmentTimingPlan {
  if (!(windowMs > 0) || !(ttsMs > 0)) {
    return { atempo: 1, padMsAfter: 0, overflows: false, resultMs: Math.max(0, ttsMs) }
  }
  const idealAtempo = ttsMs / windowMs // >1 means audio is longer than the window
  const atempo = clamp(idealAtempo, MIN_ATEMPO, MAX_ATEMPO)
  const adjustedMs = ttsMs / atempo // duration after applying atempo
  if (adjustedMs > windowMs + 1) {
    // Still too long even at max speed-up → spill past the cue (no negative pad).
    return { atempo, padMsAfter: 0, overflows: true, resultMs: adjustedMs }
  }
  // Fits (or shorter) → pad the slack with trailing silence so the next cue lands on time.
  const padMsAfter = Math.max(0, Math.round(windowMs - adjustedMs))
  return { atempo, padMsAfter, overflows: false, resultMs: adjustedMs + padMsAfter }
}

/** Total drift (ms) the dub accumulates vs the source: sum of per-cue overflow spill. 0 = perfect
 *  sync. Used to warn the user when a translation is too verbose for the source pacing. */
export function totalDriftMs(windows: number[], plans: SegmentTimingPlan[]): number {
  let drift = 0
  for (let i = 0; i < plans.length; i++) {
    const windowMs = windows[i] ?? 0
    if (plans[i].overflows) drift += plans[i].resultMs - windowMs
  }
  return Math.round(drift)
}
