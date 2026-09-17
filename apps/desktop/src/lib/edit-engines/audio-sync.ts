/**
 * Audio-sync orchestrator — waveform cross-correlation alignment for
 * dual-system sound and multicam (`sync_audio`).
 *
 * Glues the pure correlator (`audio-correlate.ts`) to the configured PCM
 * decoder (the same `setPcmDecoder` seam `auto_cut_silence` uses). Decodes a
 * reference clip + a target clip, builds short-time RMS energy envelopes,
 * cross-correlates them, and reports the timeline offset that snaps the target
 * onto the reference — refusing honestly when the match is weak.
 *
 *   await computeAudioSyncOffset(referenceClip, targetClip, { ... })
 *     → { matched, offsetSeconds, newStartTime, confidence, peakRatio, reason? }
 *
 * The caller (the `sync_audio` agent tool, or a future renderer "Sync" button)
 * turns `newStartTime` into a `move_clip` so the move rides the existing
 * write-through (link-group siblings, overlap rules, action log, undo).
 *
 * Everything except `computeAudioSyncOffset` is pure + exported for testing.
 */

import type { Clip } from '@/lib/types'
import { getPcmDecoder, type DecodedPcm } from './pcm-decoder'
import { crossCorrelate } from './audio-correlate'

/** Envelope hop in seconds (100 Hz) — fine enough for frame-accurate sync. */
export const ENVELOPE_HOP_SECONDS = 0.01

export interface AudioSyncOptions {
  /** Max ± lag to search, in seconds. Default 30. */
  searchWindowSeconds?: number
  /** Minimum peak Pearson confidence 0–1. Default 0.5. */
  minConfidence?: number
  /** Minimum peak ÷ secondary-peak ratio. Default 1.15. Guards periodic audio. */
  minPeakRatio?: number
  /**
   * Map a clip to the decodable audio URI the PCM decoder should open. Scene-
   * mirror clips carry SYNTHETIC source ids (`aud-`/`tts-`/`mus-<sceneId>`) that
   * ffmpeg can't open — the real URL lives in the scene's `audioLayer`. Callers
   * pass a resolver (built from `buildAudioUrlMap(scenes)`) so narration/music
   * actually decode. Defaults to identity: imported file/upload clips already
   * carry a real URI in `sourceId`. Return `undefined`/`''` when no audio is
   * resolvable — sync then refuses honestly rather than feeding ffmpeg a
   * non-openable id.
   */
  resolveSource?: (clip: Clip) => string | undefined
}

export interface AudioSyncResult {
  matched: boolean
  /** Seconds to shift the target (target_new_start − target_old_start). 0 if matched but already aligned. */
  offsetSeconds: number
  /** Absolute timeline start the target should move to. */
  newStartTime: number
  confidence: number
  peakRatio: number
  /** Set when `matched` is false. */
  reason?: string
}

export const AUDIO_SYNC_DEFAULTS = {
  searchWindowSeconds: 30,
  minConfidence: 0.5,
  minPeakRatio: 1.15,
} as const

/**
 * Collapse mono PCM into a short-time RMS energy envelope at `hopSeconds`.
 * Pure — exported for tests. Each output sample is the RMS of one hop window.
 */
export function buildEnvelope(pcm: DecodedPcm, hopSeconds = ENVELOPE_HOP_SECONDS): Float32Array {
  const hop = Math.max(1, Math.round(pcm.sampleRate * hopSeconds))
  const { samples } = pcm
  const out = new Float32Array(Math.ceil(samples.length / hop))
  let w = 0
  for (let i = 0; i < samples.length; i += hop) {
    const end = Math.min(i + hop, samples.length)
    let sumSq = 0
    for (let j = i; j < end; j++) sumSq += samples[j] * samples[j]
    out[w++] = Math.sqrt(sumSq / (end - i))
  }
  return out.subarray(0, w)
}

/** Clamp `v` into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** A decoded envelope is "audible" if it has any non-trivial energy. */
function isSilent(env: Float32Array): boolean {
  for (let i = 0; i < env.length; i++) if (env[i] > 1e-6) return false
  return true
}

/**
 * Slice a clip's source-audio window out of a fully-decoded buffer. The clip
 * plays `[trimStart, trimStart + duration·speed)` of its source (seconds);
 * we correlate only that region so off-screen audio doesn't skew the match.
 */
function sliceToClipWindow(pcm: DecodedPcm, clip: Clip): DecodedPcm {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  const startSec = Math.max(0, clip.trimStart || 0)
  const lenSec = clip.duration * speed
  const startIdx = Math.min(pcm.samples.length, Math.round(startSec * pcm.sampleRate))
  const endIdx = Math.min(pcm.samples.length, Math.round((startSec + lenSec) * pcm.sampleRate))
  if (endIdx <= startIdx) return { samples: new Float32Array(0), sampleRate: pcm.sampleRate }
  return { samples: pcm.samples.subarray(startIdx, endIdx), sampleRate: pcm.sampleRate }
}

/**
 * Compute the offset that aligns `targetClip` to `referenceClip` by audio
 * cross-correlation. Decodes both via the active PCM decoder. The reference
 * stays put; the target moves to `newStartTime`.
 */
export async function computeAudioSyncOffset(
  referenceClip: Clip,
  targetClip: Clip,
  options: AudioSyncOptions = {},
): Promise<AudioSyncResult> {
  const searchWindowSeconds = options.searchWindowSeconds ?? AUDIO_SYNC_DEFAULTS.searchWindowSeconds
  // Clamp agent-supplied gates to their valid ranges. minConfidence outside
  // [0,1] is meaningless: <0 would disable the confidence gate (accept noise),
  // >1 would refuse everything. minPeakRatio has no upper bound but must be ≥0.
  const minConfidence = clamp(options.minConfidence ?? AUDIO_SYNC_DEFAULTS.minConfidence, 0, 1)
  const minPeakRatio = Math.max(0, options.minPeakRatio ?? AUDIO_SYNC_DEFAULTS.minPeakRatio)

  const fail = (reason: string): AudioSyncResult => ({
    matched: false,
    offsetSeconds: 0,
    newStartTime: targetClip.startTime,
    confidence: 0,
    peakRatio: 0,
    reason,
  })

  if (searchWindowSeconds <= 0) return fail('searchWindowSeconds must be > 0.')

  // Resolve each clip's decodable URI (scene-mirror clips carry synthetic ids).
  const resolveSource = options.resolveSource ?? ((c: Clip) => c.sourceId)
  const refSource = resolveSource(referenceClip)
  const tgtSource = resolveSource(targetClip)
  if (!refSource) return fail('reference clip has no resolvable audio source.')
  if (!tgtSource) return fail('target clip has no resolvable audio source.')

  const decoder = getPcmDecoder()
  let refPcm: DecodedPcm
  let tgtPcm: DecodedPcm
  try {
    refPcm = await decoder.decode(refSource)
  } catch (err) {
    return fail(`reference clip has no readable audio: ${(err as Error).message}`)
  }
  try {
    tgtPcm = await decoder.decode(tgtSource)
  } catch (err) {
    return fail(`target clip has no readable audio: ${(err as Error).message}`)
  }

  const refEnv = buildEnvelope(sliceToClipWindow(refPcm, referenceClip))
  const tgtEnv = buildEnvelope(sliceToClipWindow(tgtPcm, targetClip))
  if (refEnv.length === 0 || isSilent(refEnv)) return fail('reference clip has no audible audio.')
  if (tgtEnv.length === 0 || isSilent(tgtEnv)) return fail('target clip has no audible audio.')

  // Cap the lag search at the envelopes' combined length: beyond that the
  // overlap is below MIN_OVERLAP so no lag is scorable anyway. Without this an
  // agent-supplied searchWindowSeconds of, say, 1e7 would spin the correlator's
  // 2·maxLag+1 loop for billions of iterations and hang the tool.
  const requestedLag = Math.round(searchWindowSeconds / ENVELOPE_HOP_SECONDS)
  const maxLag = Math.max(1, Math.min(requestedLag, refEnv.length + tgtEnv.length))
  const result = crossCorrelate(refEnv, tgtEnv, maxLag)
  if (!result) return fail('correlation failed — clips too short to compare.')

  if (result.confidence < minConfidence || result.peakRatio < minPeakRatio) {
    return {
      matched: false,
      offsetSeconds: 0,
      newStartTime: targetClip.startTime,
      confidence: result.confidence,
      peakRatio: result.peakRatio,
      reason: `no confident alignment (confidence ${result.confidence.toFixed(2)}, peakRatio ${
        result.peakRatio === Infinity ? '∞' : result.peakRatio.toFixed(2)
      }) — clips may not overlap.`,
    }
  }

  // lagSamples is in envelope hops, defined so reference[i+lag] ≈ target[i].
  // Positive lag = target content occurs EARLIER than the reference's, so the
  // target slides RIGHT (newStart > refStart). Negative lag = target occurs
  // later → slides LEFT. (See CorrelationResult.lagSamples: a target delayed by
  // D yields lag = −D.)
  const lagSeconds = result.lagSamples * ENVELOPE_HOP_SECONDS
  const newStartTime = referenceClip.startTime + lagSeconds
  if (newStartTime < 0) {
    return {
      matched: false,
      offsetSeconds: 0,
      newStartTime: targetClip.startTime,
      confidence: result.confidence,
      peakRatio: result.peakRatio,
      reason: 'alignment falls before the timeline start.',
    }
  }

  return {
    matched: true,
    offsetSeconds: newStartTime - targetClip.startTime,
    newStartTime,
    confidence: result.confidence,
    peakRatio: result.peakRatio,
  }
}
