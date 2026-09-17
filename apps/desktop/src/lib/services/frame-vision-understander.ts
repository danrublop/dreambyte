/**
 * Frame-vision VideoUnderstander (Phase 2, plan §5).
 *
 * The default (no-cloud-video) video backend: extract keyframes via the injected
 * ffmpeg extractor → down-select adaptively (plan §3a) → one multi-frame VLM
 * pass (local Ollama / cloud Haiku) → scene + events; plus a Whisper transcript
 * of the audio track as the Video-RAG text scaffold.
 *
 * ffmpeg lives in Electron, so the extractor is injected. Vision + transcript
 * default to the shared helpers but are overridable for tests.
 */

import {
  type VideoUnderstander,
  type VideoUnderstanding,
  type KeyframeExtractor,
  type UnderstandVideoOptions,
} from './video-understander'
import { selectKeyframes } from './keyframe-selection'
import { analyzeFramesVision, type FramesVisionResult } from '../agents/services/intake-engines/frames-vision'

export interface FrameVisionDeps {
  extractor: KeyframeExtractor
  /** Multi-frame vision runner. Defaults to the shared analyzeFramesVision. */
  runVision?: (
    frames: Awaited<ReturnType<KeyframeExtractor['extract']>>['frames'],
    engineId: string,
    ollamaEndpoint?: string,
  ) => Promise<FramesVisionResult>
  /** Audio→transcript. Defaults to the CaptionTranscriber seam (best-effort). */
  transcribe?: (source: string) => Promise<string | undefined>
}

const DEFAULT_MAX_FRAMES = 12

/** Default transcript path: Whisper via the caption-transcriber seam, degrade to undefined. */
async function defaultTranscribe(source: string): Promise<string | undefined> {
  try {
    const { getCaptionTranscriber } = await import('../edit-engines/caption-transcriber')
    const { srtToTranscript } = await import('../agents/services/intake-engines/audio-engine')
    const { srt } = await getCaptionTranscriber().transcribe(source)
    return srtToTranscript(srt).transcript || undefined
  } catch {
    return undefined
  }
}

export function createFrameVisionUnderstander(deps: FrameVisionDeps): VideoUnderstander {
  const runVision =
    deps.runVision ??
    ((frames, engineId, endpoint) => analyzeFramesVision(frames, engineId, { ollamaEndpoint: endpoint }))
  const transcribe = deps.transcribe ?? defaultTranscribe

  return {
    async understand(source: string, opts: UnderstandVideoOptions = {}): Promise<VideoUnderstanding> {
      const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES
      const engineId = opts.visionEngineId ?? 'local:ollama'

      const { frames } = await deps.extractor.extract(source, {
        fps: 1,
        maxFrames: maxFrames * 2, // over-sample, then adaptively down-select
        abortSignal: opts.abortSignal,
      })
      const selected = selectKeyframes(frames, maxFrames)

      // Vision + transcript in parallel; both degrade independently.
      const [vision, transcript] = await Promise.all([
        runVision(selected, engineId, opts.ollamaEndpoint).catch(() => ({ events: [] }) as FramesVisionResult),
        transcribe(source).catch(() => undefined),
      ])

      return {
        scene: vision.scene,
        events: vision.events,
        transcript,
        backend: `frame-vision:${engineId}`,
      }
    },
  }
}
