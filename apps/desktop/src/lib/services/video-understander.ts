/**
 * VideoUnderstander seam (Phase 2, plan §5).
 *
 * Same single-slot pattern as `frame-detector` / `caption-transcriber`: `src/lib/`
 * declares the interface + a throwing stub; Electron registers a concrete
 * implementation at boot (`setVideoUnderstander`); tests inject a fake.
 *
 * The default frame-vision implementation (ffmpeg keyframes → VLM + Whisper)
 * needs ffmpeg, which only the Electron layer has — hence the seam. The cloud
 * Gemini-native-video path bypasses this seam entirely (it sends the file to
 * Gemini directly; see intake-engines/video-engine.ts).
 */

/** A decoded keyframe: its clip-relative time plus the image bytes. */
export interface KeyframeImage {
  timeSec: number
  bytes: Uint8Array
  mimeType: string
  /** ffmpeg scene-change score, when the extractor computed one. */
  sceneScore?: number
}

/** Extracts sampled keyframes (+ duration) from a video source. Injected by the
 *  Electron layer (ffmpeg); the frame-vision understander stays ffmpeg-free. */
export interface KeyframeExtractor {
  extract(
    source: string,
    opts?: { fps?: number; maxFrames?: number; abortSignal?: AbortSignal },
  ): Promise<{ durationSec: number; frames: KeyframeImage[] }>
}

export interface VideoUnderstanding {
  /** One-paragraph scene description of the whole clip. */
  scene?: string
  /** Time-stamped events (seconds-precise where the backend supports it). */
  events: { start: number; end: number; description: string }[]
  /** Speech transcript, when an audio track was transcribed. */
  transcript?: string
  /** Which engine produced this (e.g. `frame-vision:qwen2.5vl`). */
  backend: string
}

export interface UnderstandVideoOptions {
  /** Vision engine id to drive frames with (`local:<model>` / `cloud:anthropic`). */
  visionEngineId?: string
  /** Frame budget sent to the VLM. */
  maxFrames?: number
  /** Ollama endpoint for local vision. */
  ollamaEndpoint?: string
  abortSignal?: AbortSignal
}

export interface VideoUnderstander {
  understand(source: string, opts?: UnderstandVideoOptions): Promise<VideoUnderstanding>
}

const throwingStub: VideoUnderstander = {
  async understand(source: string) {
    throw new Error(
      `Video understander not configured. Call setVideoUnderstander(...) before analyzing video. (tried: ${source})`,
    )
  },
}

let active: VideoUnderstander = throwingStub

export function setVideoUnderstander(understander: VideoUnderstander | null): void {
  active = understander ?? throwingStub
}

export function getVideoUnderstander(): VideoUnderstander {
  return active
}

// ── Premium: Marlin (Phase 2.3) ──────────────────────────────────────────────
// A SECOND, separate slot for the CUDA-only Marlin backend. Kept distinct from
// the default frame-vision understander above: only the `premium:marlin` engine
// routes here, and only when a GPU host registered it. Its stub throws a clear
// "not available" so a forced pick on a non-GPU host degrades to an error
// analysis rather than silently using frame-vision.

const DEFAULT_MARLIN_UNAVAILABLE = 'needs an NVIDIA GPU + the Marlin sidecar'
let marlinUnavailableReason = DEFAULT_MARLIN_UNAVAILABLE

const marlinStub: VideoUnderstander = {
  async understand(source: string) {
    throw new Error(`Marlin video understander not available (${marlinUnavailableReason}). (tried: ${source})`)
  },
}

let marlin: VideoUnderstander = marlinStub

export function setMarlinUnderstander(understander: VideoUnderstander | null): void {
  marlin = understander ?? marlinStub
}

export function getMarlinUnderstander(): VideoUnderstander {
  return marlin
}

/** Why Marlin can't run on this host (shown in the stub error and the engine registry). */
export function setMarlinUnavailableReason(reason: string | null): void {
  marlinUnavailableReason = reason ?? DEFAULT_MARLIN_UNAVAILABLE
}

/** Null when a real Marlin understander is registered, else the reason it isn't. */
export function getMarlinUnavailableReason(): string | null {
  return marlin === marlinStub ? marlinUnavailableReason : null
}
