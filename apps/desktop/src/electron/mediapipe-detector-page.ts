/**
 * MediaPipe detector page (browser-target, bundled into
 * dist-electron/mediapipe-detector-bundle.js by scripts/build/build-electron.mjs).
 *
 * Runs inside the hidden offscreen BrowserWindow created by
 * `src/electron/mediapipe-detector-host.ts`. Exposes:
 *
 *   window.__dreambyteDetect(request: MediaPipeDetectRequest)
 *     : Promise<MediaPipeDetectResponse>
 *
 * Pipeline per detect call:
 *   1. Lazy-init FaceDetector + FilesetResolver against locally bundled
 *      WASM (dist-electron/mediapipe-wasm/) and the FaceDetector model
 *      from MediaPipe's CDN (cached by Electron's HTTP cache after first
 *      run — offline-after-first-use, not offline-first; offline-first
 *      is the documented v0.3.x → v0.4 follow-up).
 *   2. Load the video from `request.source` (dreambyte:// URL works because
 *      the protocol handler is registered in main.ts).
 *   3. Sample frames at `options.fps` (default 6) within
 *      [options.startTime, options.endTime] (defaults: full duration).
 *   4. For each frame: seek the video, draw to canvas, run
 *      `faceDetector.detectForVideo(canvas, ts_ms)`. Pick the highest-
 *      confidence face per frame; record (time, centerX, centerY).
 *   5. Return aggregated detections + source dimensions.
 *
 * Error handling: any failure (WASM load, model load, video load, frame
 * seek, detection) propagates as a rejected promise. The host re-throws
 * via mediapipe-frame-detector.ts so auto_reframe surfaces the error to
 * the agent rather than silently returning empty detections.
 */

/// <reference lib="dom" />

import { FaceDetector, FilesetResolver, type Detection } from '@mediapipe/tasks-vision'

interface MediaPipeDetectRequest {
  source: string
  options: {
    fps?: number
    startTime?: number
    endTime?: number
  }
}

interface MediaPipeDetection {
  time: number
  centerX: number
  centerY: number
  confidence?: number
}

interface MediaPipeDetectResponse {
  detections: MediaPipeDetection[]
  sourceWidth: number
  sourceHeight: number
}

// FaceDetector model — bundled locally for offline-first operation.
// build.mjs copies `resources/mediapipe/blaze_face_short_range.tflite` to
// `dist-electron/mediapipe-models/` and the page resolves it via the
// HTML page's relative origin (file://...mediapipe-models/...).
const MODEL_PATH = './mediapipe-models/blaze_face_short_range.tflite'

// CDN fallback for the (rare) case the bundled model is missing —
// e.g., dev environment running an old build without the model copy
// step, or a packaging step that excluded the file. Keeps auto_reframe
// degrading-gracefully instead of throwing on a missing file.
const MODEL_CDN_FALLBACK =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

// Locally bundled WASM artifacts. Path is relative to the HTML page,
// which sits at dist-electron/mediapipe-detector.html. build.mjs copies
// the WASM files to dist-electron/mediapipe-wasm/.
const WASM_BASE_PATH = './mediapipe-wasm'

let faceDetectorPromise: Promise<FaceDetector> | null = null

async function tryInit(
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  modelAssetPath: string,
): Promise<FaceDetector> {
  // Try GPU first — offscreen Electron windows usually have hardware
  // acceleration, and GPU is ~10x faster on FaceDetector. Fall back to
  // CPU if GPU init fails (software rasterization setups, certain
  // headless configurations) so users on those machines still get
  // auto_reframe working, just slower.
  try {
    return await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    })
  } catch (gpuErr) {
    // eslint-disable-next-line no-console
    console.warn('[mediapipe] GPU delegate failed, falling back to CPU:', gpuErr)
    return await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    })
  }
}

async function getFaceDetector(): Promise<FaceDetector> {
  if (faceDetectorPromise) return faceDetectorPromise
  faceDetectorPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE_PATH)
    // Try the bundled local model first. MediaPipe's own model loader
    // handles file:// → tflite without relying on a separate fetch HEAD
    // probe (which has flaky semantics across Electron versions for
    // file:// origins). On any init failure (missing file in dev build,
    // packaging miss, anything in MediaPipe's loader path), retry once
    // with the CDN URL so auto_reframe degrades gracefully instead of
    // permanently breaking.
    try {
      return await tryInit(vision, MODEL_PATH)
    } catch (localErr) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mediapipe] local model init failed, retrying with CDN fallback:',
        localErr,
      )
      return await tryInit(vision, MODEL_CDN_FALLBACK)
    }
  })().catch((err) => {
    // Clear the cached promise on failure so the next call can retry.
    // Otherwise a transient init failure (e.g., network blip during
    // model load) would permanently break auto_reframe for the process.
    faceDetectorPromise = null
    throw err
  })
  return faceDetectorPromise
}

/**
 * Load a video into a hidden element and return it after metadata
 * resolves. On rejection the element is removed from the DOM to
 * prevent orphan-element accumulation in the long-lived offscreen
 * page (a single process can detect across many clips; each failed
 * load would otherwise leak the appended element forever).
 */
function loadVideo(source: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.style.display = 'none'

    const detach = () => {
      video.onloadedmetadata = null
      video.onerror = null
      try {
        video.removeAttribute('src')
        video.load()
        video.remove()
      } catch {
        // ignore — best-effort
      }
    }
    const failWith = (err: Error) => {
      detach()
      reject(err)
    }
    video.onloadedmetadata = () => {
      // Validate dims + duration before resolving; if invalid, treat as
      // a load failure so the element is detached.
      if (!video.videoWidth || !video.videoHeight) {
        failWith(new Error(`Video has zero dimensions: ${source}`))
        return
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        failWith(new Error(`Video has no finite duration: ${source}`))
        return
      }
      // Detach handlers on success too; the caller now owns lifecycle.
      video.onloadedmetadata = null
      video.onerror = null
      resolve(video)
    }
    video.onerror = () => {
      failWith(new Error(`Video failed to load: ${source}`))
    }

    document.body.appendChild(video)
    video.src = source
  })
}

/**
 * Seek the video to `t` seconds and wait for the `seeked` event.
 * Returns the actual position (browsers can land slightly off the
 * requested time depending on keyframe placement).
 */
function seekTo(video: HTMLVideoElement, t: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.onseeked = null
      video.onerror = null
    }
    video.onseeked = () => {
      cleanup()
      resolve(video.currentTime)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error(`Seek failed at t=${t}`))
    }
    video.currentTime = t
  })
}

/**
 * Run face detection across sampled frames. Returns the aggregated
 * detections in source pixel coordinates. Picks the highest-confidence
 * face per frame; frames with no detected face contribute nothing.
 */
async function detectAcrossFrames(
  video: HTMLVideoElement,
  fps: number,
  startTime: number,
  endTime: number,
): Promise<MediaPipeDetection[]> {
  const detector = await getFaceDetector()
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to acquire 2D canvas context for frame sampling')

  const step = 1 / Math.max(1, fps)
  const detections: MediaPipeDetection[] = []

  for (let t = startTime; t <= endTime; t += step) {
    const actualT = await seekTo(video, t)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const ts_ms = Math.round(actualT * 1000)
    const result = detector.detectForVideo(canvas, ts_ms)
    const best = pickBestDetection(result.detections)
    if (best) {
      const bbox = best.boundingBox
      // MediaPipe boundingBox is in canvas pixel space.
      if (bbox && Number.isFinite(bbox.originX) && Number.isFinite(bbox.originY)) {
        detections.push({
          time: actualT,
          centerX: bbox.originX + bbox.width / 2,
          centerY: bbox.originY + bbox.height / 2,
          confidence: best.categories?.[0]?.score ?? undefined,
        })
      }
    }
  }

  return detections
}

function pickBestDetection(list: Detection[] | undefined): Detection | null {
  if (!list || list.length === 0) return null
  let best = list[0]
  let bestScore = best.categories?.[0]?.score ?? 0
  for (let i = 1; i < list.length; i++) {
    const score = list[i].categories?.[0]?.score ?? 0
    if (score > bestScore) {
      best = list[i]
      bestScore = score
    }
  }
  return best
}

// Serializes concurrent dreambyteDetect calls. MediaPipe's
// FaceDetector.detectForVideo requires monotonically-increasing
// timestamps; two parallel detect runs sharing the same detector would
// pass interleaved timestamps and either crash or produce wrong results.
// Host today only fires one detect at a time, but defending here makes
// the contract safe under any caller pattern.
let detectChain: Promise<unknown> = Promise.resolve()

/**
 * Main entry point. Returns detections + dimensions. Throws on any
 * error so the host can surface to the agent (G2 fail-loud contract).
 * Calls are serialized internally to preserve the FaceDetector's
 * monotonic-timestamp invariant.
 */
async function dreambyteDetect(request: MediaPipeDetectRequest): Promise<MediaPipeDetectResponse> {
  const next = detectChain.then(() => runOneDetect(request))
  // Swallow this promise's settlement for the queue — the next caller
  // shouldn't see a prior caller's rejection.
  detectChain = next.catch(() => undefined)
  return next
}

async function runOneDetect(request: MediaPipeDetectRequest): Promise<MediaPipeDetectResponse> {
  if (!request || typeof request.source !== 'string' || request.source.length === 0) {
    throw new Error('dreambyteDetect: request.source is required')
  }
  const video = await loadVideo(request.source)
  try {
    const fps = request.options?.fps ?? 6
    const startTime = Math.max(0, request.options?.startTime ?? 0)
    const endTime = Math.min(video.duration, request.options?.endTime ?? video.duration)
    if (endTime <= startTime) {
      throw new Error(`Invalid time window: startTime=${startTime} endTime=${endTime}`)
    }
    const detections = await detectAcrossFrames(video, fps, startTime, endTime)
    return {
      detections,
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
    }
  } finally {
    // Best-effort cleanup. The page is long-lived (one per process) but
    // we don't want a queue of detached video elements building up.
    try {
      video.removeAttribute('src')
      video.load()
      video.remove()
    } catch {
      // ignore
    }
  }
}

// Expose to the page so the host's executeJavaScript() can invoke it.
;(window as unknown as { __dreambyteDetect: typeof dreambyteDetect }).__dreambyteDetect = dreambyteDetect
