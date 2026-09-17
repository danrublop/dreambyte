/**
 * Per-scene intermediate codec choice for the Tier 3 export.
 *
 * The crossfade path re-encodes through ffmpeg's xfade filter, so a per-scene
 * intermediate that is itself lossy compounds loss (CRF14 intermediate → CRF16
 * xfade = two lossy passes). When ANY transition is a real blend we instead
 * write a LOSSLESS per-scene intermediate so the xfade pass is the only lossy
 * encode.
 *
 * Cuts-only exports must NOT use a lossless intermediate: the stitcher
 * stream-copies (`-c copy`) cuts, so the intermediate IS the final file and a
 * lossless one would balloon. Those stay at the tuned CRF14.
 */
export type IntermediateCodec = 'lossless' | 'crf14'

export interface TransitionLike {
  type?: string | null
}

/** True when this transition produces a blend (anything that isn't a hard cut). */
export function isBlendTransition(t: TransitionLike | null | undefined): boolean {
  const type = t?.type ?? 'none'
  return type !== 'none'
}

/**
 * Choose the per-scene intermediate codec for an export.
 * @param transitions the N-1 scene-to-scene transitions
 * @returns 'lossless' if any transition blends (xfade re-encode follows), else 'crf14'
 */
export function chooseIntermediateCodec(
  transitions: ReadonlyArray<TransitionLike | null | undefined>,
): IntermediateCodec {
  return transitions.some(isBlendTransition) ? 'lossless' : 'crf14'
}
