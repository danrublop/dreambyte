/**
 * MediaPipe-backed FrameDetector.
 *
 * Implements `src/lib/edit-engines/frame-detector.ts:FrameDetector` against a
 * hidden Electron BrowserWindow that runs `@mediapipe/tasks-vision`
 * (WASM-based face / pose detection) in renderer context. MediaPipe is
 * browser-only — it depends on DOM APIs (`<video>`, `<canvas>`) — so we
 * keep it out of the main process and IPC-bridge to it.
 *
 * Flow per `detect(source, options)`:
 *   1. Acquire (or create) the offscreen detector window. It loads a
 *      static HTML page that imports MediaPipe + exposes a `detectFrames`
 *      method on `window.__dreambyteMediaPipe`.
 *   2. Issue `executeJavaScript` with the source URI + options. The page
 *      seeks the video element to each sample timestamp, draws to a
 *      canvas, runs `FaceDetector.detectForVideo(canvas, ts)`, and
 *      returns the aggregated `FrameDetection[]` + media dims.
 *   3. Return the result to the main-process caller. Errors bubble up
 *      as rejected promises with the page-side message preserved.
 *
 * The same window can be reused across calls — MediaPipe init is the
 * expensive bit (~1-2s for FaceDetector). We keep one window alive and
 * destroy on `before-quit`.
 *
 * Test strategy: `createMediaPipeFrameDetector` accepts a transport
 * dependency (`executeDetect`) so unit tests can stub the IPC layer.
 * Runtime testing of the actual MediaPipe load + detect path requires
 * an Electron context and a real video file — see the test guide.
 */

import { createLogger } from '@/lib/logger'
import type { DetectOptions, DetectionResult, FrameDetector } from '@/lib/edit-engines/frame-detector'

const log = createLogger('mediapipe-frame-detector')

/**
 * The shape we expect from the offscreen page's `detectFrames`. Kept
 * narrow so the transport layer can serialize it cleanly across IPC.
 */
export interface MediaPipeDetectRequest {
  source: string
  options: DetectOptions
}

export interface MediaPipeDetectResponse {
  detections: Array<{
    time: number
    centerX: number
    centerY: number
    confidence?: number
  }>
  sourceWidth: number
  sourceHeight: number
}

export interface MediaPipeFrameDetectorOptions {
  /**
   * The transport function that ships a request to the offscreen page
   * and receives a response. Production wires this to an Electron
   * BrowserWindow's `executeJavaScript` call; tests pass a synthetic
   * function.
   */
  executeDetect: (request: MediaPipeDetectRequest) => Promise<MediaPipeDetectResponse>
}

/**
 * Build a `FrameDetector` that delegates to a renderer-side MediaPipe
 * implementation. The renderer-side logic isn't this file's concern —
 * see `src/electron/mediapipe-detector.html` + companion script.
 */
export function createMediaPipeFrameDetector(opts: MediaPipeFrameDetectorOptions): FrameDetector {
  return {
    async detect(source: string, options: DetectOptions = {}): Promise<DetectionResult> {
      if (!source) {
        throw new Error('MediaPipe FrameDetector: source URI is required')
      }
      try {
        const response = await opts.executeDetect({ source, options })
        return {
          detections: response.detections.map((d) => ({
            time: d.time,
            centerX: d.centerX,
            centerY: d.centerY,
            ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
          })),
          sourceWidth: response.sourceWidth,
          sourceHeight: response.sourceHeight,
        }
      } catch (err) {
        log.warn('MediaPipe detect failed', { extra: { source }, error: err })
        throw err
      }
    },
  }
}
