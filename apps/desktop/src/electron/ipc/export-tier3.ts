import { BrowserWindow, screen, nativeImage } from 'electron'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  getUserScenesDir,
  getUserAudioDir,
  getUserUploadsDir,
  getStaticAppDir,
  getRenderServerDir,
  validateExportDeps,
} from '../paths'
import { createLogger } from '../../lib/logger'
import { sanitizeSceneId } from '../../lib/audio/sanitize'
import { resolveAudioProcessing, resolveProgramNormalizeTarget } from '../../lib/audio/audio-processing'
import { normalizeFinalAudio, resolveExportFfmpegBin } from './audio-normalize'
import { runFfmpegInUtility, runFfmpegInUtilityCapture } from './ffmpeg-util'
import { burnCaptionsIntoFinal } from './caption-burn'
import type { AudioProcessing } from '../../lib/types/audio'
import { chooseIntermediateCodec, type IntermediateCodec } from '../../lib/export/intermediate-codec'
import { buildProgramOverlayArgs } from '../../lib/export/program-audio-overlay'
import { materializeForFfmpeg } from '../../lib/export/materialize-asar-audio'
import { isClientOnlyTtsUrl, isClientOnlyTtsProvider } from '../../lib/audio/download'
import { X264_QUALITY_PARAMS } from '../../lib/export/x264'
import {
  parseFfmpegProbe,
  checkExportArtifact,
  artifactFailureMessage,
  type ExportProbe,
} from '../../lib/export/verify-export-artifact'
import {
  selectOrphansToDelete,
  isExportOrphanHtml,
  isStaleTier3TmpDirName,
  type SweepEntry,
} from '../../lib/export/orphan-sweep'
import type { Timeline } from '../../lib/types'
import { planCompositeFrame } from '../../lib/timeline/composite-frame'
import type { CompositeLayer } from '../../lib/timeline/composite-frame'
import { getCompositeDuration } from '../../lib/timeline/sequence'
import { buildCompositeHostHtml, planToInstructions } from './composite-host'
import { lutUrlForPath } from '../../lib/compositor/grade-gl'
import { parseCubeLut } from '../../lib/edit-engines/cube-lut'

const log = createLogger('export-tier3')

/**
 * Tier 3 "real-compositor capture" MP4 export.
 *
 * Where the legacy path (src/lib/export2/pixi-mp4.ts) rasterizes each scene frame
 * with html2canvas — a JS re-implementation of CSS painting that drops Chrome's
 * gradient dithering (→ banding) plus box-shadow / filter / blend-mode — this
 * path screenshots the REAL Chromium compositor inside an offscreen
 * BrowserWindow and pipes the lossless frames to a single FFmpeg libx264 pass.
 * No JS rasterization, no debanding filter needed: Chrome's dither is already
 * in the captured pixels. This mirrors the working packages/render-server/ Puppeteer
 * reference (renderer.js → image2pipe → FFmpeg), ported to Electron's
 * offscreen window + webContents.capturePage / CDP screenshot.
 *
 * Determinism: each frame is seeked via the same bridge the editor preview and
 * the pixi path use — window.__clock.seek(t) (master timeline + tick subscribers +
 * draw(t) + __updateScene(t) + scrub callbacks) + WAAPI currentTime — so the
 * timeline is "lied to" about wall time.
 */

export interface Tier3SceneSpec {
  id: string
  /** Fully assembled, self-contained scene HTML (generateSceneHTML output). */
  html: string
  durationSeconds: number
  sceneType?: string
  bgColor?: string
  /** Transition id applied AFTER this scene (between this scene and the next). */
  transition?: string
  audioLayer?: Record<string, unknown> | null
  /**
   * Timeline mixer controls (track volume/mute/solo/pan + project master) resolved
   * per scene-audio category by `resolveSceneAudioMix`, so the tier3 mix matches the
   * preview. Absent ⇒ unity.
   */
  sceneAudioMix?: import('@/lib/audio/scene-audio-mix').SceneAudioMix | null
  /** True if the scene's HTML carries a <video> needing frame-seek in the
   *  composite path. Detected by the caller; the composite also sniffs
   *  the HTML as a fallback. */
  isVideoScene?: boolean
}

/** One standalone timeline-audio clip to overlay onto the stitched video.
 *  Mirrors src/lib/audio/program-audio.ts ProgramAudioClip (kept structural so the
 *  main process needn't import renderer modules). */
export interface Tier3ProgramAudioClip {
  src: string
  startTime: number
  duration: number
  trimStart: number
  speed: number
  gain: number
  /** Volume-automation samples in clip-local seconds (mirrors program-audio.ts).
   *  Present only when the clip has a gain envelope; export turns it into a
   *  piecewise-linear `volume` expression so fades match the preview. */
  gainEnvelope?: Array<{ t: number; v: number }>
}

export interface Tier3ExportArgs {
  scenes: Tier3SceneSpec[]
  outputPath: string
  fps: number
  width: number
  height: number
  profile?: 'fast' | 'quality'
  /** Supersample factor for SSAA. Overridden by DREAMBYTE_EXPORT_SS when set. */
  superSample?: number
  /** Standalone timeline audio (files on audio tracks) to overlay at stitch.
   *  Scene audio is already baked into each scene MP4; this is the gap that
   *  per-scene rendering can't cover. Empty/undefined ⇒ overlay is skipped and
   *  the pipeline is byte-identical to the scene-only export. */
  timelineAudio?: Tier3ProgramAudioClip[]
  /** Program master gain applied once on the overlaid bus (0..2). Default 1. */
  masterVolume?: number
  /** A3 caption burn-in: SRT text to hardcode into the final video (one
   *  post-stitch re-encode, before loudness normalization). Omit/empty = off. */
  burnCaptionsSrt?: string
  /**
   * NLE timeline. When present with scene content, the export takes the
   * single-stream COMPOSITE path (captureCompositeToVideo): the whole timeline is
   * walked frame-by-frame, stacking active scenes z-ordered, with true gaps black
   * — replacing the per-scene-MP4 + stitcher model. Scene audio then rides
   * `timelineAudio` (the caller builds it with includeSceneMirror), so there is no
   * per-scene audio bake. Absent ⇒ legacy per-scene path, byte-identical.
   */
  timeline?: Timeline
}

export interface Tier3Progress {
  phase: 'rendering' | 'mixing_audio' | 'stitching'
  currentScene: number
  totalScenes: number
  sceneProgress: number
}

type ProgressFn = (p: Tier3Progress) => void

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Bound a promise that can hang with no internal timeout. capturePage() and
// executeJavaScript() on a wedged/lost offscreen GPU surface never resolve OR
// reject — and a `.catch()` can't rescue a hang. Without this, a single hung
// capture in captureSceneFramesTier3 holds its concurrency slot forever, and
// after MAX_CAPTURE_WINDOWS such hangs the whole capture subsystem deadlocks.
// (full-branch review, finding 1)
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// ── Single-frame capture concurrency cap ──────────────────
// captureSceneFrameTier3 spins its OWN offscreen BrowserWindow per call (each
// ~50-100MB while alive). The MCP visual-feedback path (capture_frame /
// review_video) can fan several captures out at once, and the in-app agent's
// verify pool runs concurrently — so cap how many capture windows are alive at
// a time. Extra captures queue (FIFO) rather than spawning unbounded windows.
// A full export (captureSceneToVideo) is NOT gated here: it's user-initiated,
// one at a time, and already serialized by the export job.
const MAX_CAPTURE_WINDOWS = 2
let _activeCaptureWindows = 0
const _captureWaiters: Array<() => void> = []

async function acquireCaptureSlot(): Promise<void> {
  if (_activeCaptureWindows < MAX_CAPTURE_WINDOWS) {
    _activeCaptureWindows++
    return
  }
  // Wait for a releaser to hand us its slot (count stays at the cap).
  await new Promise<void>((resolve) => _captureWaiters.push(resolve))
}

function releaseCaptureSlot(): void {
  const next = _captureWaiters.shift()
  // Transfer the slot to the next waiter without decrementing; only when no one
  // is waiting does the active count actually drop.
  if (next) next()
  else _activeCaptureWindows--
}

// ── FFmpeg binary resolution ──────────────────────────────────────────────
// Resolution is shared with the normalize path (src/electron/ipc/audio-normalize.ts)
// so there's a single resolver, not two.
const resolveFfmpegBin = resolveExportFfmpegBin

// ── Per-frame deterministic seek ──────────────────────────────────────────
// Mirrors the pixi path's seekAndCopy seek (synchronous so no rAF needed —
// the playback controller blocks rAF + timers while paused) and the playback
// controller's own 'seek' command coverage (React scrub callbacks, raw anime).
function seekExpr(t: number): string {
  const ts = JSON.stringify(t)
  return `(function(){
    try {
      var t = ${ts};
      if (window.__clock) {
        var st = window.__clock.seek(Math.max(0, Math.min(t, window.__clock.duration())));
        if (document.getAnimations) {
          try { document.getAnimations().forEach(function(a){ try { a.currentTime = st*1000; a.pause(); } catch(e){} }); } catch(e){}
        }
      } else if (typeof window.__updateScene === 'function') {
        try { window.__updateScene(t); } catch(e){}
      }
    } catch(e){}
    return true;
  })()`
}

// Parse width/height from a PNG buffer (IHDR is the first chunk). Returns null
// if the buffer isn't a PNG — used to validate a CDP screenshot actually
// produced a usable image rather than checking a fragile byte-length threshold
// (a near-solid-black frame PNG-compresses well under any size guess).
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

// Returns true once the scene's playback bridge is present (window.__clock, or
// __updateScene for 3D scenes). false means the scene never initialized within
// the timeout — a broken HTML / failed CDN import — so the caller can fail the
// export instead of capturing a blank video.
async function waitForSceneReady(wc: WebContents, sceneType: string | undefined): Promise<boolean> {
  const heavy = sceneType === 'three' || sceneType === '3d_world' || sceneType === 'zdog'
  // 1) controller installed (__clock) or a 3D scene's __updateScene exists.
  let bridgeReady = false
  const tlDeadline = Date.now() + 15000
  while (Date.now() < tlDeadline) {
    const ready = await wc.executeJavaScript(`!!(window.__clock || window.__updateScene)`).catch(() => false)
    if (ready) {
      bridgeReady = true
      break
    }
    await sleep(80)
  }
  if (!bridgeReady) return false
  // 2) scene code registered its tweens. Scene <script type="module"> may await
  //    CDN imports (e.g. Three: unpkg) before adding tweens to the master timeline.
  const tweenWait = heavy ? 15000 : 10000
  const tweenDeadline = Date.now() + tweenWait
  while (Date.now() < tweenDeadline) {
    const n = (await wc
      .executeJavaScript(`(window.__clock ? window.__clock.childCount() : 0)`)
      .catch(() => 0)) as number
    if (n > 0) break
    await sleep(100)
  }
  // 3) 3D world scenes expose an async asset-loaded promise.
  if (sceneType === '3d_world') {
    await Promise.race([
      wc
        .executeJavaScript(
          `(window.__sceneReady && typeof window.__sceneReady.then === 'function') ? window.__sceneReady.then(function(){return true;}).catch(function(){return true;}) : true`,
        )
        .catch(() => true),
      sleep(15000),
    ])
  }
  return true
}

// ── Frame capture backend ─────────────────────────────────────────────────
interface CaptureBackend {
  outW: number
  outH: number
  capture: () => Promise<Buffer>
  dispose: () => void
}

function capturePageBackend(wc: WebContents, width: number, height: number): CaptureBackend {
  return {
    outW: width,
    outH: height,
    capture: async () => {
      const img = await wc.capturePage()
      return img.toPNG()
    },
    dispose: () => {},
  }
}

async function setupCaptureBackend(
  wc: WebContents,
  width: number,
  height: number,
  targetScale: number,
  displayScale: number,
): Promise<CaptureBackend> {
  // capturePage() already captures at the host display's scale factor (2x on
  // Retina = free SSAA). When that already meets the target supersample, use it
  // — it's the proven path and needs no CDP. Only when the display is below
  // target (1x display / CI box) do we drive a higher deviceScaleFactor via CDP
  // so output quality doesn't silently depend on the host's DPR. Falls back to
  // capturePage if the offscreen surface won't produce a CDP screenshot.
  if (displayScale >= targetScale) {
    return capturePageBackend(wc, width, height)
  }
  if (targetScale > 1) {
    try {
      const dbg = wc.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: targetScale,
        mobile: false,
        screenWidth: width,
        screenHeight: height,
      })
      const probe = (await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      })) as { data: string }
      const buf = Buffer.from(probe.data, 'base64')
      // Validate it's a real PNG of plausible size — not a byte-length guess
      // that a dark frame would fail.
      const sz = pngSize(buf)
      if (sz && sz.w >= width && sz.h >= height) {
        log.info('tier3: using CDP supersample capture', { extra: { targetScale, captured: `${sz.w}x${sz.h}` } })
        return {
          outW: sz.w,
          outH: sz.h,
          capture: async () => {
            const shot = (await dbg.sendCommand('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: false,
            })) as { data: string }
            return Buffer.from(shot.data, 'base64')
          },
          dispose: () => {
            try {
              void dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
            } catch {}
            try {
              if (dbg.isAttached()) dbg.detach()
            } catch {}
          },
        }
      }
      try {
        if (dbg.isAttached()) dbg.detach()
      } catch {}
    } catch (err) {
      log.warn('tier3: CDP supersample unavailable; using capturePage', { error: err })
    }
  }

  return capturePageBackend(wc, width, height)
}

// ── Per-scene capture + encode ────────────────────────────────────────────
async function captureSceneToVideo(
  spec: Tier3SceneSpec,
  opts: {
    fps: number
    width: number
    height: number
    profile: 'fast' | 'quality'
    /** Per-scene intermediate codec for the whole export (TODO 1). */
    intermediateCodec: IntermediateCodec
    targetScale: number
    displayScale: number
    ffmpegBin: string
    tmpDir: string
    onSceneProgress: (pct: number) => void
  },
): Promise<string> {
  const { fps, width, height, profile, intermediateCodec, targetScale, displayScale, ffmpegBin, tmpDir, onSceneProgress } =
    opts
  const totalFrames = Math.max(1, Math.round(spec.durationSeconds * fps))
  const scenesDir = getUserScenesDir()
  await fs.mkdir(scenesDir, { recursive: true })
  // Write fresh HTML into the scenes dir so it loads from the dreambyte://scenes
  // origin — relative /audio, /uploads, CDN imports + the <base> tag resolve
  // exactly as they do for a real scene / the editor preview.
  // spec.id is agent/DB-controlled, so sanitize it before it touches the
  // filesystem (path-traversal guard); fall back to the uuid alone if the id is
  // all-illegal so scene-${safeId}.mp4 can't collapse to a colliding name.
  const safeId = sanitizeSceneId(spec.id) || randomUUID()
  // One uuid shared by the html + mp4 names. Two scenes whose ids sanitize to
  // the same safeId (e.g. "a/b" and "a:b" → "ab") would otherwise collide on
  // scene-${safeId}.mp4 and silently overwrite each other in the stitched
  // output — the uuid keeps both unique regardless.
  const uid = randomUUID()
  const tmpHtmlName = `__export-${safeId}-${uid}.html`
  const tmpHtmlPath = path.join(scenesDir, tmpHtmlName)
  // Sidecar lock pins this html to a live owner so the startup orphan sweep
  // (TODO 4) never deletes a file an in-flight export (this or another instance)
  // is still reading. Removed in the finally alongside the html.
  const lockPath = `${tmpHtmlPath}.lock`
  await fs.writeFile(tmpHtmlPath, spec.html, 'utf-8')
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }), 'utf-8').catch(() => {})
  const sceneUrl = `dreambyte://scenes/${tmpHtmlName}`
  const outPath = path.join(tmpDir, `scene-${safeId}-${uid}.mp4`)

  let win: BrowserWindow | null = null
  let ff: ChildProcess | null = null
  let backend: CaptureBackend | null = null
  try {
    win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: spec.bgColor || '#000000',
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    win.webContents.setAudioMuted(true)
    try {
      win.webContents.setFrameRate(60)
    } catch {}

    // Capture a main-frame load failure so a broken scene fails the export
    // instead of silently producing a blank video.
    let loadFailure: string | null = null
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 /* ABORTED */) loadFailure = desc || `load failed (${code})`
    })

    await win.loadURL(sceneUrl)
    const ready = await waitForSceneReady(win.webContents, spec.sceneType)
    if (!ready) {
      throw new Error(
        `scene ${spec.id} did not initialize (no playback bridge after timeout)` +
          (loadFailure ? `: ${loadFailure}` : ''),
      )
    }

    backend = await setupCaptureBackend(win.webContents, width, height, targetScale, displayScale)

    const args = [
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-framerate',
      String(fps),
      '-i',
      '-',
      // Always normalize to the target resolution. capturePage() returns at the
      // display's device-scale (2x on Retina) and the CDP path captures at
      // superSample×, so frames arrive at 1x-2x. The lanczos downscale turns
      // that into supersampling AA and guarantees the output matches the
      // requested dimensions regardless of the host display's DPR.
      '-vf',
      `scale=${width}:${height}:flags=lanczos`,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      // Per-scene intermediate codec (TODO 1):
      //  - 'lossless' (the export has at least one crossfade): -qp 0 so the
      //    xfade re-encode in stitcher.js is the ONLY lossy pass — no compounding
      //    of two lossy encodes. ultrafast keeps it quick; x264 graphics tuning
      //    is moot at qp0.
      //  - 'crf14' (cuts-only): the stitcher stream-copies cuts, so this IS the
      //    deliverable. CRF 14 (near-visually-lossless) + graphics-tuned x264
      //    keep text edges crisp without smearing (fast profile uses CRF 18).
      // Source frames already carry Chrome's dither, so no gradfun is needed.
      ...(intermediateCodec === 'lossless'
        ? ['-preset', 'ultrafast', '-qp', '0']
        : [
            ...(profile === 'fast' ? ['-preset', 'veryfast', '-crf', '18'] : ['-preset', 'slow', '-crf', '14']),
            '-x264-params',
            X264_QUALITY_PARAMS,
          ]),
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      '+faststart',
      outPath,
    ]
    ff = spawn(ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let ffErr = ''
    ff.stderr?.on('data', (d: Buffer) => {
      ffErr += d.toString()
      if (ffErr.length > 8000) ffErr = ffErr.slice(-8000)
    })
    let ffExited = false
    const ffDone = new Promise<void>((resolve, reject) => {
      ff!.on('error', (e) => {
        ffExited = true
        reject(new Error(`ffmpeg spawn error: ${e.message}`))
      })
      ff!.on('close', (code) => {
        ffExited = true
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(-600)}`))
      })
    })
    // Mark the rejection handled so polling ffExited / racing below doesn't trip
    // an unhandledRejection. The real error still surfaces via `await ffDone`.
    ffDone.catch(() => {})

    const stdin = ff.stdin
    if (!stdin) throw new Error('ffmpeg stdin unavailable')
    // A dead ffmpeg makes writes emit EPIPE on stdin; without a handler that
    // becomes an uncaught error that can crash the main process. Swallow it —
    // the real cause surfaces through the close handler / `await ffDone`.
    stdin.on('error', () => {})

    const wc = win.webContents
    const heavy = spec.sceneType === 'three' || spec.sceneType === '3d_world' || spec.sceneType === 'zdog'
    const settleMs = heavy ? 24 : 12

    for (let i = 0; i < totalFrames; i++) {
      // If ffmpeg already died, stop now and surface its error instead of
      // writing into a closed pipe (or worse, hanging on a drain that never fires).
      if (ffExited) {
        await ffDone
        throw new Error('ffmpeg exited before the render finished')
      }
      const t = i / fps
      await wc.executeJavaScript(seekExpr(t)).catch(() => {})
      // Force the offscreen surface to repaint the seeked state, then settle
      // (page timers/rAF are blocked while the timeline is paused, so the wait
      // must happen here in the main process).
      try {
        wc.invalidate()
      } catch {}
      await sleep(settleMs)

      const png = await backend.capture()
      const ok = stdin.write(png)
      if (!ok) {
        // Race the drain against ffmpeg exit: if ffmpeg dies, ffDone rejects and
        // this throws instead of awaiting a drain that will never come.
        await Promise.race([new Promise<void>((r) => stdin.once('drain', () => r())), ffDone])
      }
      onSceneProgress(((i + 1) / totalFrames) * 100)
    }

    stdin.end()
    await ffDone
    backend.dispose()
    backend = null
    return outPath
  } finally {
    try {
      backend?.dispose()
    } catch {}
    try {
      if (ff && ff.stdin && !ff.stdin.destroyed) ff.stdin.end()
    } catch {}
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {}
    await fs.unlink(tmpHtmlPath).catch(() => {})
    await fs.unlink(lockPath).catch(() => {})
  }
}

// ── Single-stream multi-track composite capture ──────────────────────
/** One scene the composite can mount: its id, assembled HTML, and whether it
 *  carries a <video> that needs frame-seek. */
export interface CompositeSceneSpec {
  id: string
  html: string
  bgColor?: string
  sceneType?: string
  /** True if the scene's HTML contains a <video> (a video-layer scene). */
  isVideoScene?: boolean
}

/**
 * Capture the WHOLE timeline as ONE composited video stream instead of per-scene MP4s + a stitcher: a single offscreen host page
 * stacks an <iframe> per active scene, and we walk global time frame-by-frame,
 * driving the host's __composite.renderFrameAt(planCompositeFrame(t)) and capturing
 * the composited result into one FFmpeg pass. A gap (no active layer) renders the
 * host's black stage. Output is SILENT — audio is overlaid afterwards from the
 * program-audio bus, captions burned after that.
 *
 * Reuses the proven capture+encode primitives from captureSceneToVideo: the offscreen
 * BrowserWindow, setupCaptureBackend (CDP supersample / capturePage), and the
 * image2pipe→libx264 ffmpeg pipe. Determinism comes from the per-iframe paint-ack,
 * not wall-clock — same "lie about time" contract as the single-scene path.
 *
 * NOTE: validated in-app via a real export (the capturePage/paint-ack round-trip
 * can't be unit-tested); the pure pieces (planCompositeFrame, planToInstructions,
 * getCompositeDuration, host html) are covered by unit tests.
 */
async function captureCompositeToVideo(
  timeline: Timeline,
  scenes: CompositeSceneSpec[],
  opts: {
    fps: number
    width: number
    height: number
    profile: 'fast' | 'quality'
    targetScale: number
    displayScale: number
    ffmpegBin: string
    tmpDir: string
    onProgress: (pct: number) => void
  },
): Promise<string> {
  const { fps, width, height, profile, targetScale, displayScale, ffmpegBin, tmpDir, onProgress } = opts
  const totalDuration = getCompositeDuration(timeline)
  if (!(totalDuration > 0)) throw new Error('composite export: timeline has no scene content')
  const totalFrames = Math.max(1, Math.round(totalDuration * fps))

  const scenesDir = getUserScenesDir()
  await fs.mkdir(scenesDir, { recursive: true })

  // Write every scene's HTML up front + a lock, and build sceneId → {url, isVideoScene}
  // so the host can mount any active scene by URL during the walk. Tracked for cleanup.
  const written: string[] = []
  const sceneResolve = new Map<string, { url: string; isVideoScene: boolean }>()
  const runUid = randomUUID()
  for (const spec of scenes) {
    const safeId = sanitizeSceneId(spec.id) || randomUUID()
    const name = `__export-${safeId}-${runUid}.html`
    const htmlPath = path.join(scenesDir, name)
    const lockPath = `${htmlPath}.lock`
    await fs.writeFile(htmlPath, spec.html, 'utf-8')
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }), 'utf-8').catch(() => {})
    written.push(htmlPath, lockPath)
    sceneResolve.set(spec.id, {
      url: `dreambyte://scenes/${name}`,
      isVideoScene: spec.isVideoScene === true || /<video[\s>]/i.test(spec.html),
    })
  }

  // The host page (black stage + the __composite controller + injected seek agent).
  const hostName = `__export-host-${runUid}.html`
  const hostPath = path.join(scenesDir, hostName)
  await fs.writeFile(hostPath, buildCompositeHostHtml(width, height), 'utf-8')
  written.push(hostPath)

  let win: BrowserWindow | null = null
  let ff: ChildProcess | null = null
  let backend: CaptureBackend | null = null
  try {
    win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: '#000000',
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false },
    })
    win.webContents.setAudioMuted(true)
    try {
      win.webContents.setFrameRate(60)
    } catch {}
    const wc = win.webContents

    let loadFailure: string | null = null
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) loadFailure = desc || `load failed (${code})`
    })

    log.info('composite: start', { extra: { totalDuration, totalFrames, scenes: scenes.length, width, height, fps } })
    await withTimeout(win.loadURL(`dreambyte://scenes/${hostName}`), 30000, 'composite host loadURL')
    // Wait for the host controller to install.
    const hostDeadline = Date.now() + 15000
    let hostReady = false
    while (Date.now() < hostDeadline) {
      const ok = await wc.executeJavaScript('!!window.__composite').catch(() => false)
      if (ok) {
        hostReady = true
        break
      }
      await sleep(80)
    }
    if (!hostReady) throw new Error(`composite host did not initialize${loadFailure ? `: ${loadFailure}` : ''}`)
    log.info('composite: host ready', { extra: { hostName } })

    // Register Tier-B (LUT) grades ONCE before the frame loop. The host can't read the
    // filesystem or re-parse a `.cube` per frame, so the main process parses each unique
    // LUT (the SAME parseCubeLut the preview uses → identical strip) and ships its data
    // to the host keyed by url; per-frame instructions then reference it via gradeGL.lutUrl.
    {
      const lutSeen = new Set<string>()
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          const lut = clip.grade?.lut
          const url = lutUrlForPath(lut?.path)
          if (!lut?.path || !url || lutSeen.has(url)) continue
          lutSeen.add(url)
          try {
            const text = await fs.readFile(lut.path, 'utf8')
            const cube = parseCubeLut(text)
            if (!cube) {
              log.warn('composite: LUT failed to parse; webgl grade will skip it', { extra: { path: lut.path } })
              continue
            }
            await wc.executeJavaScript(
              `window.__composite.registerLut(${JSON.stringify(url)},${cube.dimension},${JSON.stringify(Array.from(cube.data))})`,
            )
            log.info('composite: registered LUT', { extra: { url, dimension: cube.dimension } })
          } catch (e) {
            log.warn('composite: could not register LUT', { extra: { path: lut.path }, error: e })
          }
        }
      }
    }

    backend = await setupCaptureBackend(wc, width, height, targetScale, displayScale)
    log.info('composite: backend ready', { extra: { outW: backend.outW, outH: backend.outH } })

    // Deterministic BLACK frame for true gaps. Capturing the hidden-iframe stage is
    // unreliable: an offscreen GPU compositor may NOT repaint when nothing is visible,
    // so capturePage returns the stale prior composite (a gap kept the last clip's
    // color). Emit this synthesized opaque-black PNG instead — matches the capture
    // dims so the ffmpeg scale filter treats it identically to a real frame.
    const blackBitmap = Buffer.alloc(backend.outW * backend.outH * 4)
    for (let p = 3; p < blackBitmap.length; p += 4) blackBitmap[p] = 255 // BGRA: opaque
    const blackPng = nativeImage.createFromBitmap(blackBitmap, { width: backend.outW, height: backend.outH }).toPNG()

    // Single-stream output IS the deliverable (no stitcher pass), so encode at the
    // quality crf directly — same tuned x264 as the cuts-only per-scene intermediate.
    const ff_args = [
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-vf',
      `scale=${width}:${height}:flags=lanczos`,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(profile === 'fast' ? ['-preset', 'veryfast', '-crf', '18'] : ['-preset', 'slow', '-crf', '14']),
      '-x264-params',
      X264_QUALITY_PARAMS,
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      '+faststart',
      path.join(tmpDir, `composite-${runUid}.mp4`),
    ]
    const outPath = ff_args[ff_args.length - 1]
    ff = spawn(ffmpegBin, ff_args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let ffErr = ''
    ff.stderr?.on('data', (d: Buffer) => {
      ffErr += d.toString()
      if (ffErr.length > 8000) ffErr = ffErr.slice(-8000)
    })
    let ffExited = false
    const ffDone = new Promise<void>((resolve, reject) => {
      ff!.on('error', (e) => {
        ffExited = true
        reject(new Error(`ffmpeg spawn error: ${e.message}`))
      })
      ff!.on('close', (code) => {
        ffExited = true
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(-600)}`))
      })
    })
    ffDone.catch(() => {})
    const stdin = ff.stdin
    if (!stdin) throw new Error('ffmpeg stdin unavailable')
    stdin.on('error', () => {})

    // Resolve a layer to its load URL. Scenes → the pre-written scene HTML.
    // Media (video/image) → an ABSOLUTE dreambyte:// URL: the host page loads from
    // dreambyte://scenes/, and main.ts only rewrites the 'app'/'' host, so a relative
    // "/uploads/x.mp4" here would resolve against the scenes mount and 404. Map the
    // known renderer-relative mounts (uploads/audio/generated) to their dreambyte:// host.
    const resolveMediaUrl = (src: string): string | null => {
      if (!src) return null
      const lowered = src.trim().toLowerCase()
      // Block dangerous schemes (mirrors set_video_layer's guard in asset-media-tools.ts):
      // clip.sourceId is agent-supplied, and the host mounts it as <video|img src> in the
      // privileged export window — never load file:/javascript:/vbscript:/data:text/html.
      const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lowered)?.[1]
      if (scheme === 'file' || scheme === 'javascript' || scheme === 'vbscript' || lowered.startsWith('data:text/html')) {
        return null
      }
      // Reject path traversal (fail fast; main.ts's protocol handler also 403s it, but
      // match the audio resolver's `..` guard for defense-in-depth).
      if (lowered.includes('..') || lowered.includes('%2e%2e')) return null
      if (src.startsWith('dreambyte://') || /^https?:\/\//.test(src)) return src
      const m = /^\/?(uploads|audio|generated|scenes)\/(.+)$/.exec(src)
      if (m) return `dreambyte://${m[1]}/${m[2]}`
      return `dreambyte://uploads/${src.replace(/^\/+/, '')}` // bare filename → uploads mount
    }
    const resolve = (layer: CompositeLayer): { url: string; isVideoScene: boolean } | null => {
      if (layer.kind === 'scene') return sceneResolve.get(layer.sceneId) ?? null
      const url = resolveMediaUrl(layer.src)
      return url ? { url, isVideoScene: false } : null
    }
    for (let i = 0; i < totalFrames; i++) {
      if (ffExited) {
        await ffDone
        throw new Error('ffmpeg exited before the composite render finished')
      }
      const t = i / fps
      const plan = planCompositeFrame(timeline, t, { fade: true })
      const instructions = planToInstructions(plan, resolve)

      if (instructions.length === 0) {
        // True gap (no active layer on any track): write the deterministic black
        // frame rather than capturing a hidden stage that may show the stale composite.
        const okGap = stdin.write(blackPng)
        if (!okGap) await Promise.race([new Promise<void>((r) => stdin.once('drain', () => r())), ffDone])
        onProgress(((i + 1) / totalFrames) * 100)
        if (i === 0 || (i + 1) % 24 === 0) log.info('composite: frame progress', { extra: { frame: i + 1, totalFrames, gap: true } })
        continue
      }
      // renderFrameAt mounts/seeks/opacity-sets each active layer; the main process
      // flushes paint via invalidate()+sleep below (no rAF) before capturePage.
      // Bounded: a wedged iframe paint-ack must never hang the whole export — on
      // timeout we capture whatever is currently painted and move on.
      await withTimeout(
        wc.executeJavaScript(`window.__composite.renderFrameAt(${JSON.stringify(instructions)})`),
        20000,
        `composite renderFrameAt frame ${i} (t=${t.toFixed(2)})`,
      ).catch((err) => log.warn('composite: renderFrameAt slow/failed; capturing current frame', { extra: { frame: i }, error: err }))
      // Flush the seeked composite to the offscreen surface WITHOUT rAF (which
      // starves in an offscreen GPU window): invalidate + a short settle, exactly
      // like the proven captureSceneToVideo path. 24ms covers stacked iframes.
      try {
        wc.invalidate()
      } catch {}
      await sleep(24)

      // capturePage on a wedged offscreen surface can hang forever — bound it.
      const png = await withTimeout(backend.capture(), 15000, `composite capture frame ${i}`)
      const ok = stdin.write(png)
      if (!ok) await Promise.race([new Promise<void>((r) => stdin.once('drain', () => r())), ffDone])
      onProgress(((i + 1) / totalFrames) * 100)
      if (i === 0 || (i + 1) % 24 === 0) log.info('composite: frame progress', { extra: { frame: i + 1, totalFrames } })
    }
    log.info('composite: all frames captured', { extra: { totalFrames } })

    stdin.end()
    await ffDone
    backend.dispose()
    backend = null
    return outPath
  } finally {
    try {
      backend?.dispose()
    } catch {}
    try {
      if (ff && ff.stdin && !ff.stdin.destroyed) ff.stdin.end()
    } catch {}
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {}
    for (const p of written) await fs.unlink(p).catch(() => {})
  }
}

// ── Single-frame headless capture ─────────────────────────
export interface Tier3FrameCapture {
  /** Base64-encoded PNG (no `data:` prefix). */
  pngBase64: string
  mimeType: 'image/png'
  /** Final pixel dimensions of the returned PNG (after any downscale). */
  width: number
  height: number
}

// Validate a raw capturePage PNG and downscale it for the model. Throws on an
// empty/0×0 buffer: capturePage() can return an unpainted surface as a 0×0
// buffer and nativeImage.createFromBuffer does NOT throw on that — returning it
// would re-introduce silent false-success (a blank frame the model trusts as
// "the scene"). Validate via the PNG IHDR (same approach the CDP backend uses).
function encodeCapturedFrame(png: Buffer, maxWidth: number, specId: string): Tier3FrameCapture {
  const rawSize = pngSize(png)
  if (!rawSize || rawSize.w < 1 || rawSize.h < 1) {
    throw new Error(`scene ${specId} produced an empty frame (offscreen surface not painted)`)
  }
  let img = nativeImage.createFromBuffer(png)
  let size = img.getSize()
  if (size.width < 1 || size.height < 1) {
    throw new Error(`scene ${specId} produced an empty frame`)
  }
  let out = png
  if (size.width > maxWidth) {
    img = img.resize({ width: maxWidth })
    out = img.toPNG()
    size = img.getSize()
  }
  return { pngBase64: out.toString('base64'), mimeType: 'image/png', width: size.width, height: size.height }
}

/**
 * Capture N rendered frames of a single scene at the given `times` (seconds),
 * headlessly, with a SINGLE offscreen window load.
 *
 * Reuses the tier-3 offscreen render path — its own offscreen BrowserWindow, the
 * deterministic `seekExpr(t)` bridge, `waitForSceneReady`, the `capturePage`
 * backend — but skips the ffmpeg encode. Loads + waits for the scene ONCE, then
 * seeks to each time and captures, so motion review (review_scene_motion over
 * MCP) pays the load cost once instead of per frame. Frames come back in the same
 * order as `times`. Time-correct (seeks to exactly each t, unlike scene-verifier).
 *
 * All-or-nothing: throws if the scene never initialises or any frame is empty —
 * the single-frame wrapper relies on that to surface capture_failed. Renders at
 * the scene's real `width`×`height`, downscaling each frame to `maxWidth` for
 * cheap VLM consumption. Concurrency-capped (one slot for the whole batch).
 */
export async function captureSceneFramesTier3(
  spec: Tier3SceneSpec,
  times: number[],
  opts: { width: number; height: number; maxWidth?: number } = { width: 1920, height: 1080 },
): Promise<Tier3FrameCapture[]> {
  const width = Math.max(1, Math.round(opts.width))
  const height = Math.max(1, Math.round(opts.height))
  const maxWidth = Math.max(1, Math.round(opts.maxWidth ?? 1280))

  await acquireCaptureSlot()

  // Path names are pure (synchronous, non-throwing); the fs writes that CAN
  // throw (mkdir/writeFile — ENOSPC/EACCES) live INSIDE the try below, so any
  // failure still hits the finally and releases the slot. If they ran out here,
  // a write failure would leak the slot and, after MAX_CAPTURE_WINDOWS such
  // failures, deadlock every future capture.
  // `__export-` prefix + sidecar lock so the startup orphan sweep reclaims this
  // html if a capture crashes mid-flight (same liveness mechanism as the export
  // path — see src/lib/export/orphan-sweep.ts). The `cap-` infix is just for logs.
  const scenesDir = getUserScenesDir()
  const safeId = sanitizeSceneId(spec.id) || randomUUID()
  const uid = randomUUID()
  const tmpHtmlName = `__export-cap-${safeId}-${uid}.html`
  const tmpHtmlPath = path.join(scenesDir, tmpHtmlName)
  const lockPath = `${tmpHtmlPath}.lock`
  const sceneUrl = `dreambyte://scenes/${tmpHtmlName}`

  let win: BrowserWindow | null = null
  try {
    await fs.mkdir(scenesDir, { recursive: true })
    await fs.writeFile(tmpHtmlPath, spec.html, 'utf-8')
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }), 'utf-8').catch(() => {})

    win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: spec.bgColor || '#000000',
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    win.webContents.setAudioMuted(true)
    try {
      win.webContents.setFrameRate(60)
    } catch {}

    let loadFailure: string | null = null
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 /* ABORTED */) loadFailure = desc || `load failed (${code})`
    })

    await win.loadURL(sceneUrl)
    const ready = await waitForSceneReady(win.webContents, spec.sceneType)
    if (!ready) {
      throw new Error(
        `scene ${spec.id} did not initialize (no playback bridge after timeout)` +
          (loadFailure ? `: ${loadFailure}` : ''),
      )
    }

    // Preview capture: targetScale=1 forces the capturePage backend (no CDP
    // supersample) since we downscale to maxWidth anyway.
    const backend = await setupCaptureBackend(win.webContents, width, height, 1, 1)
    const wc = win.webContents
    const heavy = spec.sceneType === 'three' || spec.sceneType === '3d_world' || spec.sceneType === 'zdog'

    const frames: Tier3FrameCapture[] = []
    for (const rawT of times) {
      // Clamp the seek into the scene, paint, then settle. Settle a little longer
      // than the export's per-frame 12/24ms — paused timers/rAF mean the repaint
      // must be waited out here in the main process.
      const t = Math.max(0, Math.min(rawT, spec.durationSeconds))
      // Seek is non-fatal (proceed even if it fails), but time it out so a hung
      // executeJavaScript can't stall the batch — .catch can't rescue a hang.
      await withTimeout(wc.executeJavaScript(seekExpr(t)), 8000, 'seek').catch(() => {})
      try {
        wc.invalidate()
      } catch {}
      await sleep(heavy ? 80 : 40)
      // Capture IS fatal on timeout: throw so the finally releases the slot
      // (rather than hanging forever on a wedged surface — review finding 1).
      const png = await withTimeout(backend.capture(), 15000, 'capturePage')
      frames.push(encodeCapturedFrame(png, maxWidth, spec.id))
    }
    backend.dispose()
    return frames
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {}
    await fs.unlink(tmpHtmlPath).catch(() => {})
    await fs.unlink(lockPath).catch(() => {})
    releaseCaptureSlot()
  }
}

/**
 * Capture ONE rendered frame of a single scene at time `t`. Thin wrapper over
 * {@link captureSceneFramesTier3} — the time-correct pixel source for the MCP
 * `capture_frame` tool. (The in-app agent fulfils capture_frame via a live-
 * renderer round-trip instead; see pending-captures.)
 */
export async function captureSceneFrameTier3(
  spec: Tier3SceneSpec,
  timeSeconds: number,
  opts: { width: number; height: number; maxWidth?: number } = { width: 1920, height: 1080 },
): Promise<Tier3FrameCapture> {
  const [frame] = await captureSceneFramesTier3(spec, [timeSeconds], opts)
  // captureSceneFramesTier3 is all-or-nothing (throws, or returns one frame per
  // requested time), so frame is defined here. Assert it explicitly so a future
  // change that adds a per-frame skip can't silently return undefined as a frame.
  if (!frame) throw new Error(`scene ${spec.id} produced no frame`)
  return frame
}

// ── Audio (reuse packages/render-server/audio-mixer.js with Electron path resolution) ─
async function downloadToTemp(url: string, tmpDir: string): Promise<string | null> {
  try {
    const ext = path.extname(new URL(url).pathname) || '.mp3'
    const dest = path.join(tmpDir, `audio-${randomUUID()}${ext}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(dest, buf)
    return dest
  } catch (err) {
    log.warn('tier3: audio download failed', { extra: { url }, error: err })
    return null
  }
}

async function resolveDreambyteAudio(src: string | null | undefined, tmpDir: string): Promise<string | null> {
  if (!src) return null
  // Client-only TTS (web-speech / puter) has no downloadable file → silent at
  // export. Callers detect this separately (see hasClientOnlyNarration) so the
  // drop surfaces as a loud warning instead of vanishing here.
  if (isClientOnlyTtsUrl(src)) return null

  const fileIfExists = async (p: string) => {
    try {
      await fs.access(p)
      return p
    } catch {
      return null
    }
  }

  let host = ''
  let rest = ''
  if (src.startsWith('dreambyte://')) {
    try {
      const u = new URL(src)
      host = u.hostname
      rest = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    } catch {
      return null
    }
    if ((host === 'app' || host === '') && /^(audio|uploads|sfx-library)\//.test(rest)) {
      const slash = rest.indexOf('/')
      host = rest.slice(0, slash)
      rest = rest.slice(slash + 1)
    }
  } else if (src.startsWith('/audio/') || src.startsWith('/uploads/') || src.startsWith('/sfx-library/')) {
    const m = src.replace(/^\/+/, '')
    const slash = m.indexOf('/')
    host = m.slice(0, slash)
    rest = m.slice(slash + 1)
  } else if (src.startsWith('http://') || src.startsWith('https://')) {
    return downloadToTemp(src, tmpDir)
  } else if (path.isAbsolute(src)) {
    // Restrict absolute paths to known media dirs — audioLayer.src is
    // agent/DB-controlled, so an unguarded absolute path would let FFmpeg read
    // any file on disk. Mirrors packages/render-server/audio-mixer.js's project-root guard.
    const absResolved = path.resolve(src)
    const allowed = [getUserAudioDir(), getUserUploadsDir(), getStaticAppDir(), tmpDir, os.tmpdir()]
    const ok = allowed.some((d) => {
      const base = path.resolve(d)
      return absResolved === base || absResolved.startsWith(base + path.sep)
    })
    if (!ok) return null
    const f = await fileIfExists(absResolved)
    return f ? materializeForFfmpeg(f, tmpDir) : null
  } else {
    return null
  }

  if (rest.includes('..')) return null
  let resolved: string | null = null
  if (host === 'audio') {
    resolved = (await fileIfExists(path.join(getUserAudioDir(), rest))) ?? (await fileIfExists(path.join(getStaticAppDir(), 'audio', rest)))
  } else if (host === 'uploads') {
    resolved = await fileIfExists(path.join(getUserUploadsDir(), rest))
  } else if (host === 'sfx-library') {
    // Bundled SFX live under getStaticAppDir() = app.asar/out in packaged builds;
    // materializeForFfmpeg copies them out so the native FFmpeg can actually read
    // them (asar paths pass fs.access but fail ffmpeg's open() → silent drop).
    resolved = await fileIfExists(path.join(getStaticAppDir(), 'sfx-library', rest))
  }
  return resolved ? materializeForFfmpeg(resolved, tmpDir) : null
}

/** True if the file has at least one audio stream. `ffmpeg -i` with no output
 *  always exits non-zero but prints stream info to stderr — so no ffprobe.
 *  Routed through the utility runner like every other main-process ffmpeg call
 *  (no exceptions to the "ffmpeg never runs in main" policy). */
async function hasAudioStream(ffmpegBin: string, file: string): Promise<boolean> {
  const r = await runFfmpegInUtilityCapture(ffmpegBin, ['-i', file])
  return /Stream #\d+:\d+.*: Audio:/.test(r.stderr)
}

/**
 * Look at what was actually produced instead of inferring success from the
 * fact that nothing threw. Throws when the artifact is missing / empty / has no
 * video stream / is materially shorter than the timeline.
 *
 * Shared by runTier3Export and main.ts's concatMp4 (the pixi/WebCodecs path) so
 * BOTH engines are held to the same bar — one guard where the callers meet.
 */
export async function assertExportArtifact(
  ffmpegBin: string | null,
  outputPath: string,
  expectedSeconds?: number | null,
): Promise<void> {
  const sizeBytes = await fs
    .stat(outputPath)
    .then((s) => s.size)
    .catch(() => null)
  let probe: ExportProbe | null = null
  if (sizeBytes != null && ffmpegBin) {
    try {
      const r = await runFfmpegInUtilityCapture(ffmpegBin, ['-i', outputPath])
      probe = parseFfmpegProbe(r.stderr)
    } catch (err) {
      log.warn('export: could not probe the output; verifying size only', { error: err })
    }
  }
  const verdict = checkExportArtifact({ sizeBytes, probe, expectedSeconds })
  if (!verdict.ok) {
    log.error('export: artifact verification FAILED', { extra: { outputPath, reason: verdict.reason, sizeBytes } })
    throw new Error(artifactFailureMessage(outputPath, verdict.reason))
  }
  for (const w of verdict.warnings) log.warn(`export: ${w}`, { extra: { outputPath } })
}

/**
 * Overlay standalone timeline audio onto the stitched video (the D12 export
 * gap: scene audio is baked per-scene, but files dropped on audio tracks have
 * no scene to live in). Each clip is trimmed to its in-point, time-stretched
 * for speed, gain-scaled, delayed to its timeline position, summed, scaled by
 * the program master, then mixed ON TOP of the stitched scene audio. Writes the
 * result back over `videoPath`. No clips (or none resolvable) ⇒ no-op, so the
 * scene-only export is byte-identical.
 */
export async function overlayProgramAudio(
  ffmpegBin: string,
  videoPath: string,
  clips: Tier3ProgramAudioClip[],
  masterVolume: number,
  tmpDir: string,
): Promise<{ overlaid: number; skipped: number }> {
  // Resolve each clip's URL to a local file (reuses the scene-audio resolver,
  // including its absolute-path security guard).
  const resolved: Array<{ file: string; c: Tier3ProgramAudioClip }> = []
  for (const c of clips) {
    const file = await resolveDreambyteAudio(c.src, tmpDir)
    if (file) resolved.push({ file, c })
    else log.warn('tier3: program-audio clip unresolved; skipping', { extra: { src: c.src } })
  }
  if (resolved.length === 0) return { overlaid: 0, skipped: clips.length }

  // Arg assembly lives in src/lib/export/program-audio-overlay.ts (electron-free)
  // so the integration test runs the SAME args against real ffmpeg.
  const hasScene = await hasAudioStream(ffmpegBin, videoPath)
  const outPath = path.join(tmpDir, `with-program-audio-${randomUUID()}.mp4`)
  const args = buildProgramOverlayArgs({
    videoPath,
    resolved,
    masterVolume,
    videoHasAudio: hasScene,
    outPath,
  })
  // Run in a utility process — a raw filter_complex from the MAIN process
  // can SIGSEGV ffmpeg.
  log.info('tier3: overlaying program audio', { extra: { clips: resolved.length } })
  await runFfmpegInUtility(ffmpegBin, args)

  await fs.rename(outPath, videoPath).catch(async () => {
    // Cross-device rename can fail; fall back to copy+unlink.
    await fs.copyFile(outPath, videoPath)
    await fs.unlink(outPath).catch(() => {})
  })
  return { overlaid: resolved.length, skipped: clips.length - resolved.length }
}

async function mixSceneAudioElectron(
  videoPath: string,
  audioLayer: Record<string, any>,
  duration: number,
  tmpDir: string,
  sceneMix?: import('@/lib/audio/scene-audio-mix').SceneAudioMix | null,
): Promise<string | null> {
  const audioTracks: {
    tts?: { path: string; startOffset?: number; isFile?: boolean }
    sfx?: Array<{ path: string; triggerAt: number; volume: number }>
    music?: { path: string; volume: number; loop: boolean; duckDuringTTS: boolean; duckLevel: number }
  } = {}
  // Scene SFX ids parallel to audioTracks.sfx (same filtering), so the mixer can
  // look up each SFX's lane track mix (volume/mute/solo/pan) by id.
  const sfxIds: string[] = []

  // Scene-level start offset (the playback controller honors it in preview by
  // seeking currentTime; the mixer must seek the same way so export matches).
  const startOffset = Number(audioLayer.startOffset)
  const ttsStartOffset = Number.isFinite(startOffset) && startOffset > 0 ? startOffset : undefined

  const tts = audioLayer.tts as { src?: string; status?: string } | undefined
  if (tts?.src && (tts.status === 'ready' || !tts.status)) {
    const p = await resolveDreambyteAudio(tts.src, tmpDir)
    if (p) audioTracks.tts = { path: p, startOffset: ttsStartOffset }
  }

  const sfx = audioLayer.sfx as Array<{ src?: string; triggerAt?: number; volume?: number }> | undefined
  if (Array.isArray(sfx) && sfx.length) {
    audioTracks.sfx = []
    for (const fx of sfx) {
      if (!fx?.src) continue
      const p = await resolveDreambyteAudio(fx.src, tmpDir)
      if (p) {
        audioTracks.sfx.push({ path: p, triggerAt: fx.triggerAt ?? 0, volume: fx.volume ?? 0.8 })
        sfxIds.push((fx as { id?: string }).id ?? '')
      }
    }
  }

  const music = audioLayer.music as
    | { src?: string; volume?: number; loop?: boolean; duckDuringTTS?: boolean; duckLevel?: number }
    | undefined
  if (music?.src) {
    const p = await resolveDreambyteAudio(music.src, tmpDir)
    if (p) {
      audioTracks.music = {
        path: p,
        volume: music.volume ?? 0.12,
        loop: music.loop ?? false,
        duckDuringTTS: music.duckDuringTTS ?? false,
        duckLevel: music.duckLevel ?? 0.2,
      }
    }
  }

  // Base/imported file audio (audioLayer.src). Routes into the tts slot (lane A1
  // carries ONE of narration-or-file per scene); tagged isFile so the mixer reads
  // its lane mix from sceneMix.file (the `aud-` clip's fader/mute/pan), not the
  // narration lane. v5 A3: gated only on the tts slot being EMPTY — the old guard
  // also required no music/sfx, so a scene with a file PLUS music silently dropped
  // the file at export while preview and pixi both played it. The one state still
  // dropped is file+tts-both-set (the slot holds one source); pixi plays both —
  // a documented divergence, not replicated here.
  if (!audioTracks.tts && typeof audioLayer.src === 'string') {
    const p = await resolveDreambyteAudio(audioLayer.src as string, tmpDir)
    if (p) audioTracks.tts = { path: p, startOffset: ttsStartOffset, isFile: true }
  }

  const has = audioTracks.tts || (audioTracks.sfx && audioTracks.sfx.length > 0) || audioTracks.music
  if (!has) return null

  const mixerPath = path.join(getRenderServerDir(), 'audio-mixer.js')
  const mod = (await import(pathToFileURL(mixerPath).href)) as {
    mixAudioTracks?: (
      v: string,
      t: unknown,
      d: number,
      o: string,
      resolved?: unknown,
      runner?: (bin: string, args: string[]) => Promise<void>,
      sceneMix?: unknown,
      sfxIds?: string[],
    ) => Promise<string>
  }
  if (typeof mod.mixAudioTracks !== 'function') return null
  const out = videoPath.replace(/\.mp4$/, '-mixed.mp4')
  // Resolve the agent's per-scene mix settings (gain + ducking) and pass them
  // into the dumb FFmpeg mixer. Absent audioProcessing ⇒ null ⇒ byte-identical
  // legacy output. Loudness normalization is applied later, post-stitch.
  const resolved = audioLayer.audioProcessing
    ? resolveAudioProcessing(audioLayer.audioProcessing as AudioProcessing)
    : null
  // Run the mixer's filter_complex via the utilityProcess — a direct execFile
  // from the Electron MAIN process SIGSEGVs the bundled ffmpeg (same crash the
  // overlay hit), which would silently bake every scene's audio to silence.
  return mod.mixAudioTracks(videoPath, audioTracks, duration, out, resolved, runFfmpegInUtility, sceneMix, sfxIds)
}

// ── Client-only narration detection ───────────────────────────────────────
/**
 * True if any narration source in this export is a client-only TTS sentinel
 * (web-speech / puter-tts). Those only synthesize in the browser preview, so at
 * export they resolve to null and the MP4 ships with NO narration. The agent path
 * is already guarded (requiresServerOutput drops these providers), but a voice set
 * manually is not — so the export must surface this loudly rather than
 * silently drop the voice. Scans both the scene audio layers (narration intent)
 * and the timeline-audio bus (the composite path mirrors scene audio onto it).
 */
function hasClientOnlyNarration(args: Tier3ExportArgs): boolean {
  for (const s of args.scenes ?? []) {
    const al = s.audioLayer as Record<string, any> | null
    const tts = al?.tts as { src?: string; provider?: string; status?: string } | undefined
    // Primary signal: a client-only provider stores src=null (never a sentinel
    // url), so detect by provider id. The url checks stay as defense-in-depth.
    if (tts && isClientOnlyTtsProvider(tts.provider) && tts.status !== 'error' && !tts.src) return true
    if (isClientOnlyTtsUrl(tts?.src) || isClientOnlyTtsUrl(al?.src as string | undefined)) return true
  }
  for (const c of args.timelineAudio ?? []) {
    if (isClientOnlyTtsUrl(c.src)) return true
  }
  return false
}

// ── Orchestration ─────────────────────────────────────────────────────────
async function runTier3Export(
  args: Tier3ExportArgs,
  onProgress: ProgressFn,
): Promise<{
  outputPath: string
  captionsBurned: boolean | null
  /** null = no timeline audio requested; 'failed' = requested but none made it into the MP4. */
  programAudio: 'applied' | 'failed' | null
  /** True when a narration clip uses a client-only TTS provider (web-speech /
   *  puter-tts): preview-only voices that export SILENT. The renderer surfaces
   *  this as a visible warning so a voiceless MP4 never looks like a clean one. */
  clientOnlyNarration: boolean
}> {
  const deps = validateExportDeps()
  if (!deps.ok) throw new Error(deps.message)

  const scenes = args.scenes ?? []
  // NOTE: a MEDIA-ONLY timeline (bare video/image clips, no scenes) is valid — the
  // composite renders the clips from args.timeline directly. The authoritative
  // "nothing to render" guard is the composite check below (line ~1330:
  // !args.timeline || getCompositeDuration <= 0), which covers both no-scenes and
  // no-timeline. Do NOT re-add a scenes.length===0 throw here — it blocks footage-only exports.
  const { outputPath, width, height } = args
  const fps = Math.max(1, Math.round(args.fps))
  const profile = args.profile ?? 'quality'
  // Per-export intermediate codec (TODO 1): lossless when any crossfade is
  // present (the single xfade re-encode is then the only lossy pass); crf14 for
  // cuts-only (the stitcher stream-copies cuts, so the intermediate IS the
  // deliverable and must stay a tuned encode, not a giant lossless file).
  const exportTransitions = Array.from({ length: Math.max(0, scenes.length - 1) }, (_v, i) => ({
    type: scenes[i]?.transition ?? 'none',
    duration: 0.5,
  }))
  const intermediateCodec = chooseIntermediateCodec(exportTransitions)
  // Target capture supersample. Default 2x for consistent SSAA regardless of the
  // host display's DPR. capturePage already gives this on a Retina (2x) display;
  // on a 1x display the backend drives it via CDP. DREAMBYTE_EXPORT_SS overrides.
  const envSs = Number(process.env.DREAMBYTE_EXPORT_SS)
  const targetScale = Number.isFinite(envSs) && envSs >= 1 ? Math.min(4, Math.round(envSs)) : (args.superSample ?? 2)
  let displayScale = 1
  try {
    displayScale = screen.getPrimaryDisplay().scaleFactor || 1
  } catch {}

  const ffmpegBin = await resolveFfmpegBin()

  // Disk preflight: a lossless export can write GBs of intermediates; fail
  // early with a clear message instead of exhausting disk mid-render. Runs BEFORE
  // mkdtemp so a failed check leaks no tmp dir, and checks BOTH the temp
  // filesystem (intermediates) and the output filesystem (final mp4) — they can
  // be different drives. Best-effort: skip (don't block) if the platform lacks statfs.
  try {
    const totalSeconds = scenes.reduce((s, sc) => s + (sc.durationSeconds || 0), 0)
    const rawBytes = width * height * 1.5 * fps * totalSeconds // yuv420p
    const estIntermediate = rawBytes * (intermediateCodec === 'lossless' ? 0.5 : 0.06) * 1.3
    const estFinal = rawBytes * 0.05 // CRF16 final mp4, generous
    const checkFree = async (dir: string, need: number, label: string) => {
      const st = await fs.statfs(dir)
      const free = st.bavail * st.bsize
      if (free < need) {
        throw new Error(
          `tier3 export: not enough free disk on ${label} ` +
            `(need ~${Math.ceil(need / 1e9)}GB, ~${Math.floor(free / 1e9)}GB free). ` +
            `Free up space or export without crossfades.`,
        )
      }
    }
    await checkFree(os.tmpdir(), estIntermediate, 'the temp drive')
    await checkFree(path.dirname(outputPath), estFinal, 'the output drive')
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('tier3 export: not enough free disk')) throw err
    log.warn('tier3: disk preflight skipped', { error: err })
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-tier3-'))
  // Owner marker so the cross-instance startup sweep (TODO 4) can tell a live
  // export's tmp dir from a crashed orphan by PID liveness, not age alone.
  await fs
    .writeFile(path.join(tmpDir, '.dreambyte-owner'), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }), 'utf-8')
    .catch(() => {})
  const audioTmpDir = path.join(tmpDir, 'audio')
  await fs.mkdir(audioTmpDir, { recursive: true })

  log.info('tier3: export start', {
    extra: { scenes: scenes.length, fps, width, height, profile, targetScale, displayScale, outputPath },
  })

  // The single-stream multi-track COMPOSITE is the ONLY tier3 engine. The
  // whole timeline renders as one composited capture (true gaps black, V2 over V1,
  // no per-scene MP4s, no stitch); scene audio rides args.timelineAudio (built with
  // includeSceneMirror by the caller). It handles multi-track stacking and gaps
  // and matches the preview.
  if (!args.timeline || getCompositeDuration(args.timeline) <= 0) {
    throw new Error('tier3 export: timeline has no scene content to composite')
  }
  try {
    onProgress({ phase: 'rendering', currentScene: 1, totalScenes: 1, sceneProgress: 0 })
    const compositeScenes: CompositeSceneSpec[] = scenes.map((s) => ({
      id: s.id,
      html: s.html,
      bgColor: s.bgColor,
      sceneType: s.sceneType,
      isVideoScene: s.isVideoScene,
    }))
    const silentPath = await captureCompositeToVideo(args.timeline as Timeline, compositeScenes, {
      fps,
      width,
      height,
      profile,
      targetScale,
      displayScale,
      ffmpegBin,
      tmpDir,
      onProgress: (pct) => onProgress({ phase: 'rendering', currentScene: 1, totalScenes: 1, sceneProgress: pct }),
    })
    await fs.copyFile(silentPath, outputPath)

    // Overlay standalone timeline audio (files on audio tracks) onto the composited
    // video — the one thing per-scene rendering structurally can't cover. No-op
    // when there are no such clips, so scene-only exports are unaffected.
    // Runs BEFORE caption burn-in: the burn re-encodes video and copies audio,
    // so the overlaid mix survives it.
    // null = not requested; 'failed' = requested but the user's timeline audio is
    // NOT in the MP4 (overlay threw, or every clip failed to resolve). Surfaced
    // to the renderer as a visible export warning — a music-less export must not
    // look identical to a successful one.
    let programAudio: 'applied' | 'failed' | null = null
    if (args.timelineAudio && args.timelineAudio.length > 0) {
      onProgress({ phase: 'mixing_audio', currentScene: scenes.length, totalScenes: scenes.length, sceneProgress: 100 })
      try {
        const { overlaid } = await overlayProgramAudio(
          ffmpegBin,
          outputPath,
          args.timelineAudio,
          Number.isFinite(args.masterVolume) ? Math.max(0, Math.min(2, args.masterVolume as number)) : 1,
          audioTmpDir,
        )
        programAudio = overlaid > 0 ? 'applied' : 'failed'
      } catch (err) {
        programAudio = 'failed'
        log.warn('tier3: program-audio overlay failed; keeping scene-only audio', { error: err })
      }
    }

    // Caption burn-in — one re-encode over the stitched program, BEFORE
    // normalization (loudnorm uses -c:v copy, so burned video survives it).
    // null = burn not requested; the renderer surfaces `false` as a visible
    // completion warning (not just a buried diagnostic line).
    let captionsBurned: boolean | null = null
    if (args.burnCaptionsSrt && args.burnCaptionsSrt.trim()) {
      onProgress({ phase: 'stitching', currentScene: scenes.length, totalScenes: scenes.length, sceneProgress: 100 })
      const burnTotalSeconds = scenes.reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
      captionsBurned = await burnCaptionsIntoFinal(outputPath, args.burnCaptionsSrt, width, height, ffmpegBin, {
        totalSeconds: burnTotalSeconds,
        fps,
      })
      if (!captionsBurned) log.warn('tier3: caption burn-in failed — export ships WITHOUT burned captions')
    }

    // Program loudness normalization — one post-stitch pass on the final
    // video (program-level by design, not per scene). Shared selection policy.
    const { targetLufs: programTargetLufs, conflict: normalizeConflict } = resolveProgramNormalizeTarget(
      scenes.map((s) => ({ audioProcessing: (s.audioLayer as Record<string, any> | null)?.audioProcessing })),
    )
    if (normalizeConflict) {
      log.warn('tier3: scenes requested different LUFS targets; using the first', { extra: { programTargetLufs } })
    }
    if (programTargetLufs != null) {
      try {
        await normalizeFinalAudio(outputPath, programTargetLufs, fs, ffmpegBin)
      } catch (err) {
        log.warn('tier3: post-stitch normalize threw; keeping un-normalized', { error: err })
      }
    }

    // Loud, honest signal that a preview-only voice exported silent. The renderer
    // turns this into a visible warning; here we also leave a diagnostic trail.
    const clientOnlyNarration = hasClientOnlyNarration(args)
    if (clientOnlyNarration) {
      log.warn(
        'tier3: narration uses a client-only TTS provider (web-speech / puter-tts) — it exports SILENT; the MP4 has no voice',
      )
    }

    // The LAST thing before we call it complete — does the file we just
    // told the user about actually contain their video? Every step above can
    // succeed (or swallow its own failure, like the overlay/normalize catches)
    // and still leave a 0-byte or truncated MP4 behind.
    await assertExportArtifact(ffmpegBin, outputPath, getCompositeDuration(args.timeline as Timeline))

    log.info('tier3: export complete', { extra: { outputPath } })
    return { outputPath, captionsBurned, programAudio, clientOnlyNarration }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Orphan sweep (TODO 4) ──────────────────────────────────────────────────
// Read a sidecar lock and decide whether its owning export is still alive.
// process.kill(pid, 0) throws ESRCH for a dead pid, EPERM if it exists but we
// can't signal it (still alive). undefined ⇒ no/unreadable lock ⇒ caller uses
// the age backstop.
async function resolveLockOwnerAlive(lockPath: string): Promise<boolean | undefined> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAtMs?: unknown }
    // Reject pid 0 / negatives: process.kill(0, 0) targets the whole process
    // group and would falsely report "alive", pinning a corrupt lock forever.
    if (typeof parsed.pid !== 'number' || parsed.pid <= 0) return undefined
    // PID-reuse defense: a lock older than this hard cap is treated as dead even
    // if some process now holds that PID. No real export runs anywhere near this.
    const HARD_CAP_MS = 24 * 60 * 60 * 1000
    if (typeof parsed.startedAtMs === 'number' && Date.now() - parsed.startedAtMs > HARD_CAP_MS) return false
    try {
      process.kill(parsed.pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === 'EPERM' ? true : false
    }
  } catch {
    return undefined
  }
}

/**
 * Sweep orphaned export temp files left by a crashed / killed render: the
 * `__export-*.html` (+ `.lock`) in the scenes dir and the `dreambyte-tier3-*` dirs
 * in os.tmpdir. Safe under multiple app instances — a file owned by a live PID
 * is never deleted; lock-less files only go past the age backstop. Best-effort;
 * call at startup. Returns the count removed.
 */
export async function sweepExportOrphans(maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  const now = Date.now()
  let removed = 0

  // 1) __export-*.html (+ sidecar lock) in the user's scenes dir.
  const scenesDir = getUserScenesDir()
  try {
    const names = await fs.readdir(scenesDir)
    const entries: SweepEntry[] = []
    for (const name of names.filter(isExportOrphanHtml)) {
      const full = path.join(scenesDir, name)
      let mtimeMs: number
      try {
        mtimeMs = (await fs.stat(full)).mtimeMs
      } catch {
        continue
      }
      const ownerAlive = await resolveLockOwnerAlive(`${full}.lock`)
      entries.push({ name, mtimeMs, ownerAlive })
    }
    for (const name of selectOrphansToDelete(entries, now, maxAgeMs)) {
      await fs.unlink(path.join(scenesDir, name)).catch(() => {})
      await fs.unlink(path.join(scenesDir, `${name}.lock`)).catch(() => {})
      removed++
    }
  } catch (err) {
    log.warn('tier3: scenes-dir orphan sweep skipped', { error: err })
  }

  // 2) dreambyte-tier3-* tmp dirs in os.tmpdir (no lock — pure age backstop).
  try {
    const tmp = os.tmpdir()
    const names = await fs.readdir(tmp)
    const entries: SweepEntry[] = []
    for (const name of names.filter(isStaleTier3TmpDirName)) {
      const full = path.join(tmp, name)
      try {
        const mtimeMs = (await fs.stat(full)).mtimeMs
        // PID-aware like the html lock: a tmp dir owned by a live export is never
        // swept, so a second instance can't delete a long-running export's dir.
        const ownerAlive = await resolveLockOwnerAlive(path.join(full, '.dreambyte-owner'))
        entries.push({ name, mtimeMs, ownerAlive })
      } catch {
        /* gone already */
      }
    }
    for (const name of selectOrphansToDelete(entries, now, maxAgeMs)) {
      await fs.rm(path.join(tmp, name), { recursive: true, force: true }).catch(() => {})
      removed++
    }
  } catch (err) {
    log.warn('tier3: tmp-dir orphan sweep skipped', { error: err })
  }

  if (removed) log.info('tier3: swept export orphans', { extra: { removed } })
  return removed
}

// ── Single-scene capture (Lane C: per-scene engine mixing) ──────────────────
export interface Tier3SingleSceneArgs {
  spec: Tier3SceneSpec
  fps: number
  width: number
  height: number
  profile?: 'fast' | 'quality'
  /** Whole-export intermediate codec, computed by the renderer from all transitions. */
  intermediateCodec: IntermediateCodec
  superSample?: number
}

/**
 * Capture ONE scene to an intermediate mp4 and return its path (no stitch). The
 * renderer's mixed-engine path interleaves these tier3-captured scenes with
 * legacy-pixi scenes, then stitches once. Each call owns a `dreambyte-tier3-*` tmp
 * dir (reaped by sweepExportOrphans); the caller deletes the returned file via
 * concatMp4's cleanup. Mirrors one iteration of runTier3Export's loop — kept
 * separate so the validated all-tier3 path stays byte-for-byte unchanged.
 */
async function runTier3SceneExport(args: Tier3SingleSceneArgs): Promise<string> {
  const deps = validateExportDeps()
  if (!deps.ok) throw new Error(deps.message)
  const { spec, width, height } = args
  const fps = Math.max(1, Math.round(args.fps))
  const profile = args.profile ?? 'quality'
  const envSs = Number(process.env.DREAMBYTE_EXPORT_SS)
  const targetScale = Number.isFinite(envSs) && envSs >= 1 ? Math.min(4, Math.round(envSs)) : (args.superSample ?? 2)
  let displayScale = 1
  try {
    displayScale = screen.getPrimaryDisplay().scaleFactor || 1
  } catch {}
  const ffmpegBin = await resolveFfmpegBin()
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-tier3-'))
  try {
    await fs
      .writeFile(
        path.join(tmpDir, '.dreambyte-owner'),
        JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }),
        'utf-8',
      )
      .catch(() => {})
    const audioTmpDir = path.join(tmpDir, 'audio')
    await fs.mkdir(audioTmpDir, { recursive: true })

    let videoPath = await captureSceneToVideo(spec, {
      fps,
      width,
      height,
      profile,
      intermediateCodec: args.intermediateCodec,
      targetScale,
      displayScale,
      ffmpegBin,
      tmpDir,
      onSceneProgress: () => {},
    })
    const audioLayer = spec.audioLayer as Record<string, any> | null
    if (audioLayer && audioLayer.enabled) {
      try {
        const mixed = await mixSceneAudioElectron(videoPath, audioLayer, spec.durationSeconds, audioTmpDir, spec.sceneAudioMix ?? null)
        if (mixed) videoPath = mixed
      } catch (err) {
        log.warn('tier3: scene audio mix failed; keeping silent', { extra: { sceneId: spec.id }, error: err })
      }
    }

    // Move the finished part OUT of the per-call working dir to a flat temp file
    // so the renderer's mixed-engine loop can collect it and concatMp4(cleanup)
    // can delete it. The working dir (.dreambyte-owner, audio/, the pre-mix mp4) is
    // then removed in the finally instead of leaking one dir per scene. rename
    // stays within os.tmpdir (same filesystem), so it's an atomic move, not a copy.
    const part = path.join(os.tmpdir(), `dreambyte-tier3-part-${randomUUID()}.mp4`)
    await fs.rename(videoPath, part)
    return part
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:exportTier3', async (event: IpcMainInvokeEvent, args: Tier3ExportArgs) => {
    const sender = event.sender
    const onProgress: ProgressFn = (p) => {
      try {
        if (!sender.isDestroyed()) sender.send('dreambyte:exportTier3:progress', p)
      } catch {}
    }
    const { outputPath, captionsBurned, programAudio, clientOnlyNarration } = await runTier3Export(args, onProgress)
    return { ok: true as const, outputPath, captionsBurned, programAudio, clientOnlyNarration }
  })

  // Capture a single scene for the renderer's mixed-engine path. No
  // progress channel — the renderer reports coarse per-scene progress itself.
  ipcMain.handle('dreambyte:exportTier3Scene', async (_event: IpcMainInvokeEvent, args: Tier3SingleSceneArgs) => {
    const outputPath = await runTier3SceneExport(args)
    return { ok: true as const, outputPath }
  })
}
