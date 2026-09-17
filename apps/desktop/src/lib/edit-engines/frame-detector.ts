/**
 * Frame detector seam.
 *
 * Same single-slot pattern as `pcm-decoder.ts` / `caption-transcriber.ts`.
 * Production wires a MediaPipe-backed detector (face + pose) at boot;
 * tests inject a synthetic detector that returns a hand-crafted
 * `FrameDetection[]`. The orchestrator + the planner stay pure.
 *
 * Why per-frame sampling instead of a continuous stream:
 *   - The planner downsamples to ~12 keyframes anyway, so feeding it 30
 *     fps would be wasted decode work. Detectors are free to sample at
 *     whatever fps they want (default 6) and just return the result list.
 *   - Keeping the interface a flat array also means a unit test can
 *     synthesize "subject walks left-to-right" with three entries.
 *
 * The detector receives the SAME `source` string the PCM decoder gets
 * (dreambyte:// URI / absolute path), so callers don't need a second
 * resolution step.
 */

import type { FrameDetection } from './reframe-planner'

export interface DetectOptions {
  /**
   * Detection fps cap. Default 6 — high enough to track typical
   * walk/handheld motion, low enough that a 30s clip = 180 detections.
   */
  fps?: number
  /**
   * Clip-relative window in seconds to sample. If unset, the detector
   * scans the whole source.
   */
  startTime?: number
  endTime?: number
}

export interface DetectionResult {
  detections: FrameDetection[]
  /** Source media width in px (so the planner can offset against canvas center). */
  sourceWidth: number
  /** Source media height in px. */
  sourceHeight: number
}

export interface FrameDetector {
  detect(source: string, options?: DetectOptions): Promise<DetectionResult>
}

const throwingStub: FrameDetector = {
  async detect(source: string) {
    throw new Error(
      `Frame detector not configured. Call setFrameDetector(...) before invoking auto_reframe. (tried to scan: ${source})`,
    )
  },
}

let active: FrameDetector = throwingStub

export function setFrameDetector(detector: FrameDetector | null): void {
  active = detector ?? throwingStub
}

export function getFrameDetector(): FrameDetector {
  return active
}
