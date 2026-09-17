/**
 * Per-frame effective alpha for an NLE clip.
 *
 * Combines four signals into one number in [0, 1]:
 *
 *   1. base    — `clip.opacity` (or a per-frame keyframe override on the
 *                opacity property).
 *   2. fadeIn  — linear ramp from 0 → base over `[0, fadeIn]` clip-seconds.
 *   3. fadeOut — linear ramp from base → 0 over the last `fadeOut`
 *                clip-seconds.
 *   4. blendOpacity — optional 0..1 multiplier layered on top, used by the
 *                compositor when the user wants the blend mode applied at
 *                less than full intensity (a common NLE pattern).
 *
 * This file is intentionally renderer-free so we can unit-test the math without
 * mounting a renderer. Consumers — the DOM composite (`composite-frame.ts`) and
 * the MP4 export (`pixi-mp4.ts`) — pull the result and apply it as element/sprite
 * opacity.
 */

import type { Clip } from '@/lib/types'

/**
 * Compute the effective alpha for `clip` at `clipLocalTime` seconds
 * (0 = clip start, clip.duration = clip end).
 *
 * `kfOpacity` is the resolved keyframe override at this time, if any. Pass
 * `undefined` when there's no keyframe for the `opacity` property; the
 * helper falls back to `clip.opacity`.
 */
export function computeClipAlpha(clip: Clip, clipLocalTime: number, kfOpacity?: number): number {
  const base = kfOpacity ?? clip.opacity
  let alpha = base

  const fadeIn = clip.fadeIn ?? 0
  if (fadeIn > 0 && clipLocalTime < fadeIn) {
    // Clamp to [0, 1] so a negative clipLocalTime (clip not yet visible)
    // produces 0 rather than a negative multiplier.
    const p = Math.max(0, clipLocalTime) / fadeIn
    alpha *= Math.min(1, p)
  }

  const fadeOut = clip.fadeOut ?? 0
  if (fadeOut > 0 && clipLocalTime > clip.duration - fadeOut) {
    const tail = clip.duration - clipLocalTime
    alpha *= Math.max(0, Math.min(1, tail / fadeOut))
  }

  if (clip.blendOpacity !== undefined) {
    alpha *= Math.max(0, Math.min(1, clip.blendOpacity))
  }

  return Math.max(0, Math.min(1, alpha))
}
