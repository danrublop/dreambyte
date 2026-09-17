/**
 * auto_reframe orchestrator.
 *
 * Wires the configured `FrameDetector` to the pure `reframe-planner`,
 * then materialises an ActionInput plan of `keyframe/add` entries the
 * caller can dispatch in order. The compositor already honours
 * keyframed clip position (see `pixi-preview.ts:renderVideoClip`), so a
 * `keyframe/add` per (time, axis) is all we need to reframe.
 *
 * Pure once a synthetic detector is configured — that's how tests
 * cover the orchestrator without MediaPipe.
 */

import type { ActionInput } from '@/lib/actions'
import type { Clip } from '@/lib/types'
import { getFrameDetector, type DetectOptions } from './frame-detector'
import { framesToReframeKeyframes, type ReframeKeyframe } from './reframe-planner'

export interface AutoReframeArgs {
  /** The clip we're reframing. Used to pick the keyframe `clipId`. */
  clip: Clip
  /** Source URI the detector understands (dreambyte:// / absolute path). */
  sourceUri: string
  /** Output canvas width (project render dimensions). */
  targetWidth: number
  /** Output canvas height. */
  targetHeight: number
  /** Forwarded to the detector. */
  detectOptions?: DetectOptions
  /** Maximum number of keyframes per axis. Default 12. */
  maxKeyframes?: number
  /** EMA smoothing factor 0..1. Default 0.25. */
  smoothing?: number
  /** Drop detections below this confidence. Default 0.5. */
  minConfidence?: number
}

export interface AutoReframeResult {
  /** Ordered list of `keyframe/add` ActionInputs. */
  actions: ActionInput[]
  /** Raw (downsampled) keyframes for telemetry / preview tooling. */
  keyframes: ReframeKeyframe[]
  /** Source media dimensions discovered by the detector. */
  sourceWidth: number
  sourceHeight: number
  /** Detection count BEFORE downsampling — useful for "tracked N faces" UI. */
  detectionCount: number
}

export async function autoReframeForClip(args: AutoReframeArgs): Promise<AutoReframeResult> {
  const detector = getFrameDetector()
  const result = await detector.detect(args.sourceUri, args.detectOptions)

  const keyframes = framesToReframeKeyframes({
    detections: result.detections,
    sourceWidth: result.sourceWidth,
    sourceHeight: result.sourceHeight,
    targetWidth: args.targetWidth,
    targetHeight: args.targetHeight,
    maxKeyframes: args.maxKeyframes,
    smoothing: args.smoothing,
    minConfidence: args.minConfidence,
  })

  const actions: ActionInput[] = keyframes.map((kf) => ({
    type: 'keyframe/add',
    params: {
      clipId: args.clip.id,
      keyframe: {
        time: kf.time,
        property: kf.property,
        value: kf.value,
        easing: kf.easing ?? 'ease-in-out',
      },
    },
  }))

  return {
    actions,
    keyframes,
    sourceWidth: result.sourceWidth,
    sourceHeight: result.sourceHeight,
    detectionCount: result.detections.length,
  }
}
