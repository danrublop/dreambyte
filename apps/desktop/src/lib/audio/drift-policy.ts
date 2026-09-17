/**
 * drift-policy — how the timeline audio engine keeps each playing voice locked
 * to the transport clock, expressed as a PURE function so the (timing-sensitive,
 * hard-to-reproduce) correction logic can be unit-tested deterministically.
 *
 * An HTMLAudioElement drifts from the transport for two reasons: small, steady
 * clock skew (decoder vs. rAF), and large jumps (the user scrubs/seeks). They
 * need different fixes:
 *
 *  - Small drift (> 80 ms): NUDGE — bend playbackRate ±2 % to slide back into
 *    sync over a second or two, with `preservesPitch` on so the audio doesn't
 *    chipmunk. Released only once drift falls under 30 ms. The 80/30 ms
 *    hysteresis is what stops the nudge from oscillating on and off around a
 *    single threshold.
 *  - Large drift (> 500 ms): RESEEK — set currentTime directly, masked by a
 *    30 ms micro-fade so the discontinuity isn't an audible click.
 *
 * `decideDriftCorrection` is called every sync tick with the current drift and
 * whether a nudge is already engaged; it returns the action to apply and the
 * exact playbackRate/fade to use. No side effects, no DOM, no clock reads.
 */

/** |drift| above this → hard reseek (seconds). */
export const RESEEK_THRESHOLD_SEC = 0.5
/** |drift| above this (and not already nudging) → engage a nudge (seconds). */
export const NUDGE_ENGAGE_SEC = 0.08
/** While nudging, |drift| below this → release back to base rate (seconds). */
export const NUDGE_RELEASE_SEC = 0.03
/** Fractional playbackRate bend applied while nudging (±2 %). */
export const NUDGE_RATE_DELTA = 0.02
/** Equal-power-ish micro-fade applied around a reseek to mask the click. */
export const MICRO_FADE_SEC = 0.03

export interface DriftInput {
  /** `el.currentTime - expectedTime`, seconds. Positive = audio is AHEAD. */
  drift: number
  /** Is a rate-nudge currently engaged for this voice? */
  nudging: boolean
  /** The voice's intended playbackRate (clip.speed); the nudge bends around it. */
  baseRate: number
}

export type DriftAction = 'none' | 'nudge' | 'release' | 'reseek'

export interface DriftDecision {
  action: DriftAction
  /** The playbackRate to set. For 'none'/'release'/'reseek' this is baseRate;
   *  for 'nudge' it's baseRate bent toward convergence. */
  playbackRate: number
  /** True whenever a nudge is (or stays) engaged after this decision. */
  nudging: boolean
  /** Seconds of micro-fade to apply; non-zero only for 'reseek'. */
  microFadeSec: number
  /** Always true — nudges must never alter pitch. */
  preservesPitch: boolean
}

function nudgedRate(baseRate: number, drift: number): number {
  // Audio ahead (drift > 0) → slow down; behind → speed up.
  const factor = drift > 0 ? 1 - NUDGE_RATE_DELTA : 1 + NUDGE_RATE_DELTA
  return baseRate * factor
}

/**
 * Decide the correction for one voice this tick. Pure: same inputs → same
 * output. The caller applies it (sets playbackRate / currentTime / gain ramp)
 * and feeds back `nudging` next tick.
 */
export function decideDriftCorrection(input: DriftInput): DriftDecision {
  const { drift, nudging, baseRate } = input
  const adrift = Math.abs(drift)

  // Large jump always wins — a reseek also cancels any in-flight nudge.
  if (adrift > RESEEK_THRESHOLD_SEC) {
    return {
      action: 'reseek',
      playbackRate: baseRate,
      nudging: false,
      microFadeSec: MICRO_FADE_SEC,
      preservesPitch: true,
    }
  }

  if (nudging) {
    // Stay nudging until we're comfortably back in sync (release threshold).
    if (adrift < NUDGE_RELEASE_SEC) {
      return { action: 'release', playbackRate: baseRate, nudging: false, microFadeSec: 0, preservesPitch: true }
    }
    return {
      action: 'nudge',
      playbackRate: nudgedRate(baseRate, drift),
      nudging: true,
      microFadeSec: 0,
      preservesPitch: true,
    }
  }

  // Not currently nudging: only engage once drift exceeds the (higher) engage
  // threshold — the gap to the release threshold is the anti-oscillation band.
  if (adrift > NUDGE_ENGAGE_SEC) {
    return {
      action: 'nudge',
      playbackRate: nudgedRate(baseRate, drift),
      nudging: true,
      microFadeSec: 0,
      preservesPitch: true,
    }
  }

  return { action: 'none', playbackRate: baseRate, nudging: false, microFadeSec: 0, preservesPitch: true }
}
