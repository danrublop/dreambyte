/**
 * Auto-cut-silence orchestrator.
 *
 * Glues the pure analyser + planner to the configured PCM decoder. The
 * agent tool branch and a future Inspector button both call into this one
 * entry point; everything below is testable without ffmpeg by injecting
 * a synthetic decoder via `setPcmDecoder`.
 *
 *   await autoCutSilenceForClip({ clip, sourceUri, threshold, minSilenceMs })
 *     → { plan: SilenceCutPlan, spans: SilenceSpan[], info: { sampleCount, sampleRate, durationSec } }
 *
 * The result's `plan.actions` is the ordered list of `ActionInput`s the
 * caller dispatches. Callers may also inspect `spans` to surface a
 * "review the cuts" UI before committing.
 */

import type { Clip } from '@/lib/types'
import { detectSilenceSpans, type SilenceSpan } from './silence-detector'
import { silenceSpansToActions, type SilenceCutPlan } from './silence-actions'
import { getPcmDecoder } from './pcm-decoder'

export interface AutoCutSilenceArgs {
  clip: Clip
  /** Input the configured PCM decoder understands (file path, URI, asset id). */
  sourceUri: string
  /** dBFS threshold. Default -40 dB is a common silence threshold. */
  threshold?: number
  /** Minimum span length (ms) before counting as silence. Default 250 ms. */
  minSilenceMs?: number
  /** RMS window (ms). Default 20 ms. */
  windowMs?: number
}

export interface AutoCutSilenceResult {
  plan: SilenceCutPlan
  spans: SilenceSpan[]
  info: {
    sampleCount: number
    sampleRate: number
    durationSec: number
  }
}

export async function autoCutSilenceForClip(args: AutoCutSilenceArgs): Promise<AutoCutSilenceResult> {
  const decoder = getPcmDecoder()
  const decoded = await decoder.decode(args.sourceUri)

  const spans = detectSilenceSpans(decoded.samples, decoded.sampleRate, {
    dbThreshold: args.threshold,
    minSilenceMs: args.minSilenceMs,
    windowMs: args.windowMs,
  })

  const plan = silenceSpansToActions(args.clip, spans)

  return {
    plan,
    spans,
    info: {
      sampleCount: decoded.samples.length,
      sampleRate: decoded.sampleRate,
      durationSec: decoded.samples.length / decoded.sampleRate,
    },
  }
}
