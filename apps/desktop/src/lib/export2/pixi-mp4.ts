import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { WebDemuxer } from 'web-demuxer'
import { computeVeo3FullFrameDims, veo3DimsAreFalsy, resolveVeo3CenterCoords } from '@/lib/media/veo3-geometry'
import { clampSpriteCenterIntoCanvas } from '@/lib/media/avatar-geometry'
import { resolveAudioProcessing } from '@/lib/audio/audio-processing'
import { clamp, MAX_VOICE_GAIN } from '@/lib/audio/mix-math'
import type { SceneAudioMix, CategoryMix } from '@/lib/audio/scene-audio-mix'
import type { AudioProcessing } from '@/lib/types/audio'
import { rebuildLegacySceneHtml } from '@/lib/sceneTemplate'
import { openSceneFrameBridge } from './scene-frame-bridge'

type ExportTextOverlay = {
  id: string
  content: string
  font: string
  size: number
  color: string
  x: number
  y: number
  animation: 'fade-in' | 'slide-up' | 'typewriter'
  duration: number
  delay: number
}

type ExportCameraMove = {
  type: string
  params?: Record<string, unknown>
}

type ExportSvgObject = {
  id: string
  svgContent: string
  x: number
  y: number
  width: number
  opacity: number
  zIndex: number
}

type ExportLayerAnimation = {
  type:
    | 'fade-in'
    | 'fade-out'
    | 'slide-left'
    | 'slide-right'
    | 'slide-up'
    | 'slide-down'
    | 'scale-in'
    | 'scale-out'
    | 'spin-in'
    | 'none'
  duration: number
  delay: number
  easing?: string
}

type ExportAiLayer = {
  id: string
  type: 'image' | 'sticker' | 'avatar' | 'veo3' | string
  imageUrl?: string | null
  stickerUrl?: string | null
  videoUrl?: string | null
  playbackRate?: number
  loop?: boolean
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  zIndex: number
  startAt?: number
  animateIn?: boolean
  animation?: ExportLayerAnimation
}

type ExportTTSTrack = {
  src: string | null
  duration: number | null
}

type ExportSFXTrack = {
  /** Scene SFX id — used to look up this SFX's lane track mix (volume/mute/solo/pan). */
  id?: string
  src: string
  triggerAt: number
  volume: number
}

type ExportMusicTrack = {
  src: string
  volume: number
  loop: boolean
  duckDuringTTS: boolean
  duckLevel: number
}

type ExportAudioLayer = {
  enabled?: boolean
  src?: string | null
  volume?: number
  fadeIn?: boolean
  fadeOut?: boolean
  startOffset?: number
  tts?: ExportTTSTrack | null
  sfx?: ExportSFXTrack[]
  music?: ExportMusicTrack | null
  /** Agent-controlled mix (bus gain + ducking params). Normalization intent is
   *  read program-wide post-stitch, not here. */
  audioProcessing?: AudioProcessing | null
}

export type Export2Config = {
  sceneId?: string
  width: number
  height: number
  fps: number
  durationSeconds: number
  sceneType?: string
  svgContent?: string
  sceneHTML?: string
  bgColor: string
  videoSrc?: string | null
  videoOpacity?: number
  trimStart?: number
  trimEnd?: number | null
  textOverlays?: ExportTextOverlay[]
  svgObjects?: ExportSvgObject[]
  aiLayers?: ExportAiLayer[]
  layerHiddenIds?: string[]
  layerPanelOrder?: string[]
  cameraMotion?: ExportCameraMove[] | null
  audioSrc?: string | null
  audioStartOffset?: number
  audioVolume?: number
  audioFadeIn?: boolean
  audioFadeOut?: boolean
  audioLayer?: ExportAudioLayer | null
  /**
   * Timeline mixer controls (track volume / mute / solo / pan + project master)
   * resolved per scene-audio category by `resolveSceneAudioMix`. Folded into each
   * category's gain + pan so the exported MP4 matches the preview. Absent ⇒ the
   * mix is treated as unity (old callers / non-export use are unaffected).
   */
  sceneAudioMix?: SceneAudioMix | null
  profile?: 'fast' | 'quality'
  onProgress?: (ratio: number) => void
  onLog?: (message: string) => void
}

function parseHexColor(hex: string): number {
  const h = hex.trim().replace(/^#/, '')
  // 3- or 4-digit shorthand (#RGB / #RGBA) — expand RGB nibbles, drop alpha.
  // Without length===4 a #RGBA color fell through to black.
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16)
    const g = parseInt(h[1] + h[1], 16)
    const b = parseInt(h[2] + h[2], 16)
    return (r << 16) | (g << 8) | b
  }
  if (h.length >= 6) {
    return parseInt(h.slice(0, 6), 16)
  }
  return 0x000000
}

/**
 * Bound a video load/decode promise. A scene whose
 * <video> / demuxer never fires loadedmetadata (bad src, dead CDN, codec the
 * runtime can't parse) would otherwise hang the export forever — and a hang
 * is worse than a failure, because the UI shows "rendering…" with no way out
 * and headless callers wait their full 10-min export timeout. Reject loudly
 * after `timeoutMs` so the scene fails with a clear, actionable message.
 */
const VIDEO_LOAD_TIMEOUT_MS = 25_000

function withVideoLoadTimeout<T>(
  promise: Promise<T>,
  src: string,
  // Fired exactly once when the TIMEOUT wins the race (never on success or on
  // the wrapped promise's own rejection). Use it to abort the underlying load
  // so the <video>/demuxer stops fetching/decoding instead of leaking until GC.
  onTimeout?: () => void,
  timeoutMs = VIDEO_LOAD_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout()
        } catch {
          // Best-effort abort: a cleanup failure must not mask the timeout
          // error we're about to reject with.
        }
      }
      reject(new Error(`video failed to load: ${src}`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function exportSolidSceneMp4(config: Export2Config): Promise<ArrayBuffer> {
  const profile = config.profile ?? 'quality'
  const startedAt = performance.now()
  const phaseMs: Record<string, number> = {}
  const stats = {
    audioTracksAttempted: 0,
    audioTracksLoaded: 0,
    sfxTriggered: 0,
    sfxFailed: 0,
  }
  const log = (msg: string) => {
    console.log(`[pixi-mp4] ${msg}`)
    try {
      config.onLog?.(msg)
    } catch {}
  }
  log(
    `export init: type=${config.sceneType} dur=${config.durationSeconds}s hasHTML=${!!config.sceneHTML} htmlLen=${config.sceneHTML?.length ?? 0} hasSvg=${!!config.svgContent} svgLen=${config.svgContent?.length ?? 0}`,
  )
  const frameRate = Math.max(1, Math.round(config.fps))
  const totalFrames = Math.max(1, Math.round(config.durationSeconds * frameRate))
  const frameDurationUs = Math.round(1_000_000 / frameRate)

  // --- Pixi stage (renders to canvas) ---
  const canvas = document.createElement('canvas')
  canvas.width = config.width
  canvas.height = config.height

  const app = new Application()
  await app.init({
    canvas,
    width: config.width,
    height: config.height,
    backgroundAlpha: 0,
    antialias: true,
    resolution: 1,
    autoDensity: true,
  })

  const root = new Container()
  const cameraContainer = new Container()
  cameraContainer.sortableChildren = true
  app.stage.addChild(root)

  // bg must be added BEFORE cameraContainer so it renders behind content
  const bg = new Graphics()
  bg.rect(0, 0, config.width, config.height)
  bg.fill(parseHexColor(config.bgColor))
  root.addChild(bg)

  root.addChild(cameraContainer)

  let videoSprite: Sprite | null = null
  let baseSvgSprite: Sprite | null = null
  let baseCanvasSprite: Sprite | null = null
  let baseCanvasTexture: Texture | null = null
  let sceneBridgeCanvas: HTMLCanvasElement | null = null
  let sceneBridgeCtx: CanvasRenderingContext2D | null = null
  let lastFrame: VideoFrame | null = null
  const textSprites: Array<{ overlay: ExportTextOverlay; sprite: Text }> = []
  const svgSprites: Array<{ object: ExportSvgObject; sprite: Sprite }> = []
  const aiSprites: Array<{ layer: ExportAiLayer; sprite: Sprite; baseX: number; baseY: number }> = []
  const aiVideoSprites: Array<{
    layer: ExportAiLayer
    sprite: Sprite
    videoEl: HTMLVideoElement
    durationSec: number
  }> = []
  const hiddenIds = new Set(config.layerHiddenIds ?? [])
  const panelOrder = config.layerPanelOrder ?? []
  const panelRank = new Map<string, number>(panelOrder.map((id, i) => [id, panelOrder.length - i]))
  const resolveZ = (id: string, fallback: number) => {
    const rank = panelRank.get(id)
    return rank == null ? fallback : 1000 + rank
  }

  async function loadTextureFromSvgMarkup(svgContent: string): Promise<Texture | null> {
    try {
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject()
        img.src = dataUrl
      })
      return Texture.from({ resource: img })
    } catch {
      return null
    }
  }

  async function loadTextureFromUrl(url: string): Promise<Texture | null> {
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject()
        img.src = url
      })
      return Texture.from({ resource: img })
    } catch {
      return null
    }
  }

  async function createVideoTexture(layer: ExportAiLayer): Promise<{
    texture: Texture
    videoEl: HTMLVideoElement
    durationSec: number
  } | null> {
    const src = layer.videoUrl ?? null
    if (!src) return null
    try {
      const v = document.createElement('video')
      v.src = src
      v.crossOrigin = 'anonymous'
      v.muted = true
      v.playsInline = true
      v.preload = 'auto'
      // Bounded load (item 19): a missing/dead AI-video src must not hang the
      // whole export waiting on loadedmetadata that never fires. On timeout we
      // also abort the underlying load (remove listeners, clear src + .load())
      // so the <video> stops fetching/decoding instead of running until GC.
      let cleanupVideoLoad = () => {}
      await withVideoLoadTimeout(
        new Promise<void>((resolve, reject) => {
          const onReady = () => {
            cleanup()
            resolve()
          }
          const onErr = () => {
            cleanup()
            reject(new Error(`Failed to load video ${src}`))
          }
          const cleanup = () => {
            v.removeEventListener('loadedmetadata', onReady)
            v.removeEventListener('error', onErr)
          }
          cleanupVideoLoad = cleanup
          v.addEventListener('loadedmetadata', onReady, { once: true })
          v.addEventListener('error', onErr, { once: true })
        }),
        src,
        () => {
          // Timeout abort: detach listeners and stop the in-flight fetch. The
          // success/error paths already ran cleanup() (idempotent), so this is
          // safe to call again; clearing src + load() cancels the network/decode.
          cleanupVideoLoad()
          v.removeAttribute('src')
          v.load()
        },
      )
      const tx = Texture.from({ resource: v as unknown as HTMLVideoElement })
      return { texture: tx, videoEl: v, durationSec: Number(v.duration || 0) }
    } catch (err) {
      // A timeout/load failure is surfaced loudly (item 19) rather than
      // silently degrading to no-video: a hung or wrong AI-video layer is a
      // real export defect the user needs to see, not a frame to drop.
      log(`ai-video layer load failed: ${(err as Error).message}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  async function setupSceneIframeBridge(): Promise<{
    seekAndCopy: (timeSec: number) => Promise<void>
    dispose: () => void
  } | null> {
    const sceneType = config.sceneType ?? ''
    if (!config.sceneHTML) {
      log('iframe bridge skipped: no sceneHTML')
      return null
    }
    log(`iframe bridge: setting up for type=${sceneType}, html=${config.sceneHTML.length}ch`)
    try {
      // Security: the scene runs in an opaque-origin sandbox (no allow-same-origin)
      // and is driven over postMessage — see src/lib/export2/scene-frame-bridge.ts.
      // Pre-anime.js HTML becomes the regenerate placeholder first.
      const bridge = await openSceneFrameBridge({
        html: rebuildLegacySceneHtml(config.sceneHTML),
        width: config.width,
        height: config.height,
        sceneType,
        sceneId: config.sceneId,
        // Supersample DOM/React scenes on the quality profile: html2canvas at
        // scale 1 rasterizes at 1 device-pixel-per-CSS-pixel, so text and thin
        // strokes come out soft vs the Retina (DPR 2) editor preview. Scale 2
        // renders at 2x, then downscales with high-quality smoothing (SSAA).
        captureScale: profile === 'fast' ? 1 : 2,
        readyTimeoutMs: sceneType === 'three' ? 10000 : 5000,
      })

      // Wait for scene code to register tweens on the master timeline.
      // Scene code is in <script type="module"> which may await CDN imports
      // (e.g. Three.js from unpkg.com) before registering tweens.
      let children = await bridge.childCount()
      if (children >= 0) {
        const maxWait = sceneType === 'three' ? 15000 : 10000
        const pollStart = performance.now()
        while (children === 0 && performance.now() - pollStart < maxWait) {
          await new Promise((r) => setTimeout(r, 100))
          children = await bridge.childCount()
        }
        log(`scene tweens ready: ${children} children after ${Math.round(performance.now() - pollStart)}ms`)
        if (children === 0) {
          log(`warning: scene code may not have loaded — no timeline children found`)
        }
      } else {
        log(`warning: __clock not found on iframe — frames are captured unseeked`)
      }

      sceneBridgeCanvas = document.createElement('canvas')
      sceneBridgeCanvas.width = config.width
      sceneBridgeCanvas.height = config.height
      sceneBridgeCtx = sceneBridgeCanvas.getContext('2d', { willReadFrequently: true })
      if (!sceneBridgeCtx) {
        bridge.dispose()
        return null
      }

      baseCanvasTexture = Texture.from({ resource: sceneBridgeCanvas })
      baseCanvasSprite = new Sprite(baseCanvasTexture)
      baseCanvasSprite.x = 0
      baseCanvasSprite.y = 0
      baseCanvasSprite.width = config.width
      baseCanvasSprite.height = config.height
      baseCanvasSprite.alpha = 1
      baseCanvasSprite.zIndex = 11
      cameraContainer.addChild(baseCanvasSprite)

      // ── Seek + capture (inside the frame) ──────────────────
      const seekAndCopy = async (timeSec: number) => {
        const { bitmap, captured, error } = await bridge.capture(timeSec)
        if (!sceneBridgeCtx || !baseCanvasTexture) {
          bitmap?.close()
          return
        }
        sceneBridgeCtx.clearRect(0, 0, config.width, config.height)
        if (bitmap) {
          sceneBridgeCtx.drawImage(bitmap, 0, 0, config.width, config.height)
          bitmap.close()
        }
        if (!captured) {
          log(`frame capture failed for type=${sceneType} at t=${timeSec.toFixed(2)}s${error ? `: ${error}` : ''}`)
        }
        // Pixi v8: must update the texture source to re-upload canvas data to GPU
        baseCanvasTexture.source.update()
      }

      const dispose = () => bridge.dispose()

      log(`scene bridge initialized for type: ${sceneType}`)
      return { seekAndCopy, dispose }
    } catch (err) {
      log(`scene bridge setup failed: ${err}`)
      return null
    }
  }

  function applyAiLayerAnimation(sprite: Sprite, layer: ExportAiLayer, tSec: number, baseX: number, baseY: number) {
    const startAt = Math.max(0, Number(layer.startAt ?? 0))
    const anim = layer.animation
    if (!anim || anim.type === 'none') {
      if (tSec < startAt) {
        sprite.alpha = 0
        sprite.scale.set(1, 1)
        sprite.position.set(baseX, baseY)
        sprite.rotation = (Number(layer.rotation || 0) * Math.PI) / 180
        return
      }
      if (layer.type === 'sticker' && layer.animateIn && tSec < startAt) {
        sprite.alpha = 0
        sprite.scale.set(0.5, 0.5)
      } else if (layer.type === 'sticker' && layer.animateIn) {
        const p = Math.max(0, Math.min(1, (tSec - startAt) / 0.4))
        sprite.alpha = layer.opacity * p
        const s = 0.5 + 0.5 * p
        sprite.scale.set(s, s)
      } else {
        sprite.alpha = layer.opacity
        sprite.scale.set(1, 1)
      }
      sprite.position.set(baseX, baseY)
      sprite.rotation = (Number(layer.rotation || 0) * Math.PI) / 180
      return
    }

    const delay = Math.max(0, Number(anim.delay ?? 0))
    const dur = Math.max(0.01, Number(anim.duration ?? 0.5))
    const t0 = startAt + delay
    const t1 = t0 + dur
    if (tSec < t0) {
      // Pre-animation resting state
      if (
        anim.type === 'fade-in' ||
        anim.type === 'slide-left' ||
        anim.type === 'slide-right' ||
        anim.type === 'slide-up' ||
        anim.type === 'slide-down' ||
        anim.type === 'scale-in' ||
        anim.type === 'spin-in'
      ) {
        sprite.alpha = 0
      } else {
        sprite.alpha = layer.opacity
      }
      sprite.position.set(baseX, baseY)
      sprite.scale.set(
        anim.type === 'scale-in' || anim.type === 'spin-in' ? 0 : 1,
        anim.type === 'scale-in' || anim.type === 'spin-in' ? 0 : 1,
      )
      sprite.rotation = (Number(layer.rotation || 0) * Math.PI) / 180 + (anim.type === 'spin-in' ? -Math.PI : 0)
      return
    }

    const p = Math.max(0, Math.min(1, (tSec - t0) / Math.max(0.001, t1 - t0)))
    let alpha = layer.opacity
    let x = baseX
    let y = baseY
    let scale = 1
    let rot = (Number(layer.rotation || 0) * Math.PI) / 180
    if (anim.type === 'fade-in') alpha = layer.opacity * p
    if (anim.type === 'fade-out') alpha = layer.opacity * (1 - p)
    if (anim.type === 'slide-left') {
      alpha = layer.opacity * p
      x = baseX + (1 - p) * 100
    }
    if (anim.type === 'slide-right') {
      alpha = layer.opacity * p
      x = baseX - (1 - p) * 100
    }
    if (anim.type === 'slide-up') {
      alpha = layer.opacity * p
      y = baseY + (1 - p) * 60
    }
    if (anim.type === 'slide-down') {
      alpha = layer.opacity * p
      y = baseY - (1 - p) * 60
    }
    if (anim.type === 'scale-in') {
      alpha = layer.opacity * p
      scale = p
    }
    if (anim.type === 'scale-out') {
      alpha = layer.opacity * (1 - p)
      scale = 1 - p
    }
    if (anim.type === 'spin-in') {
      alpha = layer.opacity * p
      scale = p
      rot = rot + (1 - p) * -Math.PI
    }
    sprite.alpha = Math.max(0, Math.min(1, alpha))
    sprite.position.set(x, y)
    sprite.scale.set(Math.max(0, scale), Math.max(0, scale))
    sprite.rotation = rot
  }

  function getCameraState(tSec: number): { scale: number; x: number; y: number } {
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k
    const moves = config.cameraMotion ?? []
    let state = { scale: 1, xPercent: 0, yPercent: 0 }

    for (const move of moves) {
      const p = move.params ?? {}
      const at = Number(p.at ?? 0)
      const duration = Math.max(0.001, Number(p.duration ?? 1))
      if (tSec < at) continue
      const u = Math.max(0, Math.min(1, (tSec - at) / duration))

      if (move.type === 'kenBurns') {
        const startScale = Number(p.startScale ?? state.scale ?? 1)
        const endScale = Number(p.endScale ?? 1.08)
        const startX = Number(p.startX ?? state.xPercent ?? 0)
        const startY = Number(p.startY ?? state.yPercent ?? 0)
        const endX = Number(p.endX ?? -1.5)
        const endY = Number(p.endY ?? -0.8)
        state = {
          scale: lerp(startScale, endScale, u),
          xPercent: lerp(startX, endX, u),
          yPercent: lerp(startY, endY, u),
        }
      } else if (move.type === 'pan') {
        const fromX = Number(p.fromX ?? state.xPercent ?? 0)
        const fromY = Number(p.fromY ?? state.yPercent ?? 0)
        const toX = Number(p.toX ?? p.endX ?? -5)
        const toY = Number(p.toY ?? p.endY ?? 0)
        state = {
          scale: state.scale,
          xPercent: lerp(fromX, toX, u),
          yPercent: lerp(fromY, toY, u),
        }
      } else if (move.type === 'dollyIn') {
        const fromScale = Number(p.fromScale ?? state.scale ?? 1.0)
        const toScale = Number(p.toScale ?? 1.12)
        const fromX = Number(p.fromX ?? state.xPercent ?? 0)
        const fromY = Number(p.fromY ?? state.yPercent ?? 0)
        const toX = Number(p.toX ?? p.endX ?? 0)
        const toY = Number(p.toY ?? p.endY ?? 0)
        state = {
          scale: lerp(fromScale, toScale, u),
          xPercent: lerp(fromX, toX, u),
          yPercent: lerp(fromY, toY, u),
        }
      } else if (move.type === 'dollyOut') {
        const fromScale = Number(p.fromScale ?? state.scale ?? 1.12)
        const toScale = Number(p.toScale ?? 1.0)
        const fromX = Number(p.fromX ?? state.xPercent ?? 0)
        const fromY = Number(p.fromY ?? state.yPercent ?? 0)
        const toX = Number(p.toX ?? p.endX ?? 0)
        const toY = Number(p.toY ?? p.endY ?? 0)
        state = {
          scale: lerp(fromScale, toScale, u),
          xPercent: lerp(fromX, toX, u),
          yPercent: lerp(fromY, toY, u),
        }
      } else if (move.type === 'cut') {
        state = {
          scale: Number(p.scale ?? state.scale ?? 1),
          xPercent: Number(p.xPercent ?? p.toX ?? p.endX ?? state.xPercent ?? 0),
          yPercent: Number(p.yPercent ?? p.toY ?? p.endY ?? state.yPercent ?? 0),
        }
      } else if (move.type === 'reset') {
        state = { scale: 1, xPercent: 0, yPercent: 0 }
      }
    }

    return {
      scale: state.scale,
      x: (state.xPercent / 100) * config.width,
      y: (state.yPercent / 100) * config.height,
    }
  }

  const hasVideo = !!config.videoSrc
  let demuxer: WebDemuxer | null = null
  let decoder: VideoDecoder | null = null

  async function decodeFrameAt(timeSec: number): Promise<VideoFrame | null> {
    if (!demuxer || !decoder) return null
    const chunk = await demuxer.seek('video', Math.max(0, timeSec))
    let latest: VideoFrame | null = null
    decoder.decode(chunk as EncodedVideoChunk)
    await decoder.flush()
    // Output callback writes into window-scoped slot
    latest = (decoder as any).__latestFrame ?? null
    ;(decoder as any).__latestFrame = null
    return latest
  }

  if (hasVideo) {
    const v0 = performance.now()
    demuxer = new WebDemuxer({
      wasmFilePath: 'https://cdn.jsdelivr.net/npm/web-demuxer@4.0.0/dist/wasm-files/web-demuxer.wasm',
    })
    log(`video: loading ${config.videoSrc}`)
    // Bounded load + decoder-config probe (item 19): WebDemuxer fetches the
    // file (often a CDN URL) and parses headers — a dead src or unparseable
    // container would hang here forever. Fail loudly instead. On timeout,
    // destroy the demuxer so its worker/fetch stops instead of running until GC
    // (the finally block's destroy() is guarded + try/catch, so nulling here
    // avoids a double-destroy without risking a throw).
    const abortDemuxer = () => {
      try {
        demuxer?.destroy()
      } catch {
        // Best-effort: demuxer.destroy() must not mask the timeout rejection.
      }
      demuxer = null
    }
    await withVideoLoadTimeout(demuxer.load(config.videoSrc!), config.videoSrc!, abortDemuxer)
    const videoDecoderConfig = (await withVideoLoadTimeout(
      demuxer.getDecoderConfig('video') as Promise<VideoDecoderConfig>,
      config.videoSrc!,
      abortDemuxer,
    )) as VideoDecoderConfig
    decoder = new VideoDecoder({
      output: (frame) => {
        const prior = (decoder as any).__latestFrame as VideoFrame | undefined
        if (prior) prior.close()
        ;(decoder as any).__latestFrame = frame
      },
      error: (e) => {
        throw e instanceof Error ? e : new Error(String(e))
      },
    })
    decoder.configure(videoDecoderConfig)
    log('video: decoder configured')
    phaseMs.videoInit = performance.now() - v0
  }

  if (config.textOverlays?.length) {
    for (const ov of config.textOverlays) {
      if (hiddenIds.has(ov.id)) continue
      const sp = new Text({
        text: ov.content ?? '',
        style: {
          fontFamily: ov.font || 'Arial',
          fontSize: Math.max(10, ov.size || 48),
          fill: ov.color || '#ffffff',
        },
      })
      sp.x = (ov.x / 100) * config.width
      sp.y = (ov.y / 100) * config.height
      sp.alpha = 0
      sp.zIndex = resolveZ(ov.id, 60)
      cameraContainer.addChild(sp)
      textSprites.push({ overlay: ov, sprite: sp })
    }
  }

  if ((config.sceneType === 'svg' || !config.sceneType) && config.svgContent) {
    const tx = await loadTextureFromSvgMarkup(config.svgContent)
    if (tx) {
      const sp = new Sprite(tx)
      sp.x = 0
      sp.y = 0
      sp.width = config.width
      sp.height = config.height
      sp.alpha = 1
      sp.zIndex = 10
      cameraContainer.addChild(sp)
      baseSvgSprite = sp
    }
  }

  const sceneBridge = await setupSceneIframeBridge()

  if (!sceneBridge && !config.svgContent && !config.videoSrc) {
    config.onLog?.(`warning: no content source for scene (type=${config.sceneType}, hasHTML=${!!config.sceneHTML})`)
  }

  if (config.svgObjects?.length) {
    for (const obj of config.svgObjects) {
      if (hiddenIds.has(obj.id)) continue
      const tx = await loadTextureFromSvgMarkup(obj.svgContent || '')
      if (!tx) continue
      const sp = new Sprite(tx)
      const widthPx = (Math.max(0, Number(obj.width || 0)) / 100) * config.width
      const ratio = tx.width > 0 ? tx.height / tx.width : 1
      sp.width = Math.max(1, widthPx)
      sp.height = Math.max(1, widthPx * ratio)
      sp.x = (Math.max(0, Number(obj.x || 0)) / 100) * config.width
      sp.y = (Math.max(0, Number(obj.y || 0)) / 100) * config.height
      sp.alpha = Math.max(0, Math.min(1, Number(obj.opacity ?? 1)))
      sp.zIndex = resolveZ(obj.id, Number(obj.zIndex ?? 4))
      cameraContainer.addChild(sp)
      svgSprites.push({ object: obj, sprite: sp })
    }
  }

  if (config.aiLayers?.length) {
    for (const layer of config.aiLayers) {
      if (hiddenIds.has(layer.id)) continue
      const isStatic = layer.type === 'image' || layer.type === 'sticker'
      const isVideoLayer = layer.type === 'avatar' || layer.type === 'veo3'
      if (!isStatic && !isVideoLayer) continue
      let tx: Texture | null = null
      let vInfo: { videoEl: HTMLVideoElement; durationSec: number } | null = null
      if (isStatic) {
        const src = layer.type === 'sticker' ? (layer.stickerUrl ?? layer.imageUrl ?? null) : (layer.imageUrl ?? null)
        if (!src) continue
        tx = await loadTextureFromUrl(src)
      } else {
        const out = await createVideoTexture(layer)
        if (!out) continue
        tx = out.texture
        vInfo = { videoEl: out.videoEl, durationSec: out.durationSec }
      }
      if (!tx) continue
      const sp = new Sprite(tx)
      sp.anchor.set(0.5, 0.5)
      // For veo3 clips, derive a full-frame contain-fit box when dims are
      // falsy (defense-in-depth) and resolve CENTER coords — translating legacy
      // top-left coords at render time so a clip authored without dims lands in the
      // SAME visual center as the preview HTML. Images are already center-canon.
      let effW = Number(layer.width || 1)
      let effH = Number(layer.height || 1)
      let baseX = Number(layer.x || 0)
      let baseY = Number(layer.y || 0)
      if (layer.type === 'veo3') {
        if (veo3DimsAreFalsy(layer)) {
          const box = computeVeo3FullFrameDims((layer as { aspectRatio?: string }).aspectRatio, {
            width: config.width,
            height: config.height,
          })
          effW = box.width
          effH = box.height
        }
        const center = resolveVeo3CenterCoords({
          x: Number(layer.x || 0),
          y: Number(layer.y || 0),
          width: effW,
          height: effH,
          anchorVersion: (layer as { anchorVersion?: number }).anchorVersion,
        })
        baseX = center.cx
        baseY = center.cy
      }
      // D3 backstop: clamp an avatar pip's center so the sprite box stays inside
      // the canvas — covers avatars placed before D3 (or by a future writer that
      // forgets the aspect-aware center). Fullscreen avatars already fill the
      // frame; a clamp there is a harmless no-op.
      if (layer.type === 'avatar') {
        const clamped = clampSpriteCenterIntoCanvas(
          { x: baseX, y: baseY },
          { width: effW, height: effH },
          { width: config.width, height: config.height },
        )
        baseX = clamped.x
        baseY = clamped.y
      }
      sp.width = Math.max(1, effW)
      sp.height = Math.max(1, effH)
      sp.position.set(baseX, baseY)
      sp.alpha = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)))
      sp.rotation = (Number(layer.rotation || 0) * Math.PI) / 180
      sp.zIndex = resolveZ(layer.id, Number(layer.zIndex ?? 4))
      cameraContainer.addChild(sp)
      aiSprites.push({ layer, sprite: sp, baseX, baseY })
      if (vInfo) {
        aiVideoSprites.push({
          layer,
          sprite: sp,
          videoEl: vInfo.videoEl,
          durationSec: vInfo.durationSec,
        })
      }
    }
  }

  // --- WebCodecs encoder -> mediabunny MP4 mux ---
  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  })

  const videoSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoSource, { frameRate })
  const _aLayer = config.audioLayer ?? null
  const hasAnyAudio = !!(
    config.audioSrc ||
    (_aLayer?.enabled && _aLayer?.src) ||
    _aLayer?.tts?.src ||
    _aLayer?.music?.src ||
    (_aLayer?.sfx && _aLayer.sfx.length > 0)
  )
  const audioSource = hasAnyAudio ? new EncodedAudioPacketSource('opus') : null
  if (audioSource) output.addAudioTrack(audioSource)
  await output.start()

  const codec = 'avc1.640033' // H.264 High@5.1-ish; Electron will validate support

  let firstMeta: EncodedVideoChunkMetadata | undefined

  const encoder = new VideoEncoder({
    output: async (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      if (!firstMeta) {
        firstMeta = meta
        await videoSource.add(packet, meta)
      } else {
        await videoSource.add(packet)
      }
    },
    error: (e) => {
      throw e instanceof Error ? e : new Error(String(e))
    },
  })

  const encoderConfig: VideoEncoderConfig = {
    codec,
    width: config.width,
    height: config.height,
    // Bits-per-pixel-per-frame. The per-scene parts feed either a direct
    // stream-copy (single / all-cuts export = final quality) or the xfade
    // re-encode. Treat this as a near-lossless INTERMEDIATE so the FFmpeg
    // re-encode isn't compounding loss on a weak source: 0.20 ≈ 12.4 Mbps at
    // 1080p30 (graphics want ~11-15 Mbps). 'fast' stays at 0.06 for speed.
    // (History: 0.07 → softness+banding; 0.12 ≈ 7.4 Mbps still left the
    // re-encode starved on detailed/text-heavy frames.)
    bitrate: Math.max(
      500_000,
      Math.round(config.width * config.height * frameRate * (profile === 'fast' ? 0.06 : 0.2)),
    ),
    framerate: frameRate,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  }

  const support = await VideoEncoder.isConfigSupported(encoderConfig)
  if (!support.supported) {
    // Fall back to software encode preference; still uses same codec
    encoderConfig.hardwareAcceleration = 'prefer-software'
    const support2 = await VideoEncoder.isConfigSupported(encoderConfig)
    if (!support2.supported) {
      throw new Error(`VideoEncoder config unsupported: ${codec}`)
    }
  }

  encoder.configure(encoderConfig)

  async function renderAudioBlobForScene(): Promise<Blob | null> {
    const a0 = performance.now()
    const layer = config.audioLayer ?? null
    const baseSrc = layer?.enabled ? (layer.src ?? config.audioSrc ?? null) : (config.audioSrc ?? null)
    const ttsSrc = layer?.tts?.src ?? null
    const music = layer?.music ?? null
    const sfx = layer?.sfx ?? []

    const hasAnything = !!baseSrc || !!ttsSrc || !!music?.src || sfx.length > 0
    if (!hasAnything) return null
    log('audio: preparing scene mix')

    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm']
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''

    const ctx = new AudioContext()
    const dst = ctx.createMediaStreamDestination()
    // Per-scene master trim. Tracks connect to masterNode → dst, so a single
    // gain scales the whole scene mix. Default 1 ⇒ transparent. (Program loudness
    // normalization is applied once post-stitch, not here.)
    const mix = resolveAudioProcessing(layer?.audioProcessing)
    // Timeline mixer controls (track volume/mute/solo/pan + project master),
    // resolved per category upstream. Unity when absent so nothing changes for
    // callers that don't pass it.
    const UNITY_CAT: CategoryMix = { trackGain: 1, pan: 0, drop: false }
    const sceneMix = config.sceneAudioMix ?? null
    const fileCat = sceneMix?.file ?? UNITY_CAT
    const ttsCat = sceneMix?.tts ?? UNITY_CAT
    const musicCat = sceneMix?.music ?? UNITY_CAT
    const sfxCat = (id: string): CategoryMix => sceneMix?.sfx?.[id] ?? UNITY_CAT
    const masterNode = ctx.createGain()
    masterNode.gain.value = mix.masterGain
    masterNode.connect(dst)
    const cleanupFns: Array<() => void> = [
      () => {
        try {
          masterNode.disconnect()
        } catch {}
      },
    ]
    const timerIds: number[] = []

    async function createTrack(url: string, volume: number, cat: CategoryMix = UNITY_CAT) {
      // Track muted or solo-excluded on the timeline → omit the source entirely.
      if (cat.drop) return null
      stats.audioTracksAttempted++
      log(`audio: loading ${url}`)
      const el = document.createElement('audio')
      el.src = url
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error(`Failed to load audio source: ${url}`))
        }
        const cleanup = () => {
          el.removeEventListener('loadedmetadata', onLoaded)
          el.removeEventListener('error', onError)
        }
        el.addEventListener('loadedmetadata', onLoaded, { once: true })
        el.addEventListener('error', onError, { once: true })
      })
      const srcNode = ctx.createMediaElementSource(el)
      const gainNode = ctx.createGain()
      // Ceiling is the composed-voice max (4), not 1: per-bus gains (tts/music/sfx)
      // and the track fader can each exceed unity, and FFmpeg honors them up to 4 —
      // clamping to 1 here would silently break two-engine parity. The track-level
      // fader × project master (cat.trackGain) folds in here so the export matches
      // the preview's voice gain. Web Audio GainNode handles >1 fine.
      gainNode.gain.value = clamp(volume * cat.trackGain, 0, MAX_VOICE_GAIN)
      srcNode.connect(gainNode)
      // Stereo pan from the lane track. Skip the node entirely at center so the
      // common path is untouched (and mono sources stay mono).
      let panner: StereoPannerNode | null = null
      if (cat.pan !== 0) {
        panner = ctx.createStereoPanner()
        panner.pan.value = cat.pan
        gainNode.connect(panner)
        panner.connect(masterNode)
      } else {
        gainNode.connect(masterNode)
      }
      stats.audioTracksLoaded++
      cleanupFns.push(() => {
        try {
          el.pause()
        } catch {}
        el.src = ''
        el.load()
        try {
          srcNode.disconnect()
        } catch {}
        try {
          gainNode.disconnect()
        } catch {}
        try {
          panner?.disconnect()
        } catch {}
      })
      return { el, gainNode }
    }

    const chunks: Blob[] = []
    const rec = new MediaRecorder(
      dst.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 },
    )

    const blobPromise = new Promise<Blob>((resolve, reject) => {
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      rec.onerror = () => reject(new Error('MediaRecorder audio capture failed'))
      rec.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }))
    })

    const startOffset = Math.max(0, layer?.startOffset ?? config.audioStartOffset ?? 0)
    const stopMs = Math.max(100, Math.round(config.durationSeconds * 1000))
    try {
      if (ctx.state === 'suspended') await ctx.resume()
      log('audio: context resumed')

      // Double-play guard: add_narration stores the narration URL in BOTH
      // layer.src and layer.tts.src, which would create two tracks (~+6dB
      // narration). Skip the legacy base track when it's the same source as the
      // tts track; keep it only when it's genuinely a separate legacy single
      // source (no tts, or a different URL).
      const baseSrcEffective = baseSrc && baseSrc !== ttsSrc ? baseSrc : null
      const baseTrack = baseSrcEffective
        ? await createTrack(baseSrcEffective, layer?.volume ?? config.audioVolume ?? 1, fileCat)
        : null
      if (baseTrack) log('audio: base track ready')
      // Per-bus gains: narration ×ttsGain, music ×musicGain (folded into the
      // node volume), SFX ×sfxGain below. Default gains are 1 ⇒ unchanged.
      const ttsTrack = ttsSrc ? await createTrack(ttsSrc, mix.ttsGain, ttsCat) : null
      if (ttsTrack) log('audio: tts track ready')
      const musicTrack = music?.src
        ? await createTrack(music.src, (music.volume ?? 0.12) * mix.musicGain, musicCat)
        : null
      if (musicTrack) log('audio: music track ready')

      // Global scene fade applies to base track only in this step.
      if (baseTrack) {
        const now = ctx.currentTime
        // Match the steady gain createTrack set (volume × track fader × master),
        // so the fade ramps to/from the actual playing level, not a different one.
        const baseVol = clamp((layer?.volume ?? config.audioVolume ?? 1) * fileCat.trackGain, 0, MAX_VOICE_GAIN)
        const fadeIn = layer?.fadeIn ?? config.audioFadeIn ?? false
        const fadeOut = layer?.fadeOut ?? config.audioFadeOut ?? false
        const fadeSeconds = Math.min(0.8, Math.max(0.05, config.durationSeconds * 0.08))
        if (fadeIn) {
          baseTrack.gainNode.gain.setValueAtTime(0, now)
          baseTrack.gainNode.gain.linearRampToValueAtTime(baseVol, now + fadeSeconds)
        } else {
          baseTrack.gainNode.gain.setValueAtTime(baseVol, now)
        }
        if (fadeOut) {
          const sceneDur = Math.max(0.1, config.durationSeconds)
          const fadeOutStart = Math.max(0, sceneDur - fadeSeconds)
          baseTrack.gainNode.gain.setValueAtTime(baseVol, now + fadeOutStart)
          baseTrack.gainNode.gain.linearRampToValueAtTime(0, now + sceneDur)
        }
      }

      // Music ducking during TTS. Gate stays music.duckDuringTTS (set_audio_mix
      // mirrors ducking.enabled to it); the resolved mix supplies the level + attack/release.
      // The duck/restore targets are the GAINED music level so restore returns to
      // the actual playing volume (music.volume × musicGain).
      if (musicTrack && ttsTrack && music && music.duckDuringTTS) {
        // Restore target = the music's actual playing level, including the track
        // fader × master (musicCat.trackGain) createTrack folded in.
        const mVol = clamp((music.volume ?? 0.12) * mix.musicGain * musicCat.trackGain, 0, MAX_VOICE_GAIN)
        // duckLevel from the MusicTrack (authoritative, mirrored by set_audio_mix);
        // attack/release from the resolved mix params. Keeps the two engines aligned
        // and prevents a gain-only mix change from resetting the duck level.
        const duckVol = mVol * Math.max(music.duckLevel ?? 0.2, 0.01)
        const attackTau = mix.ducking.attackMs / 1000
        const releaseTau = mix.ducking.releaseMs / 1000
        ttsTrack.el.addEventListener('play', () => {
          musicTrack.gainNode.gain.cancelScheduledValues(ctx.currentTime)
          musicTrack.gainNode.gain.setTargetAtTime(duckVol, ctx.currentTime, attackTau)
        })
        const restore = () => {
          musicTrack.gainNode.gain.cancelScheduledValues(ctx.currentTime)
          musicTrack.gainNode.gain.setTargetAtTime(mVol, ctx.currentTime, releaseTau)
        }
        ttsTrack.el.addEventListener('pause', restore)
        ttsTrack.el.addEventListener('ended', restore)
      }

      rec.start()

      // Start continuous tracks.
      if (baseTrack) {
        baseTrack.el.currentTime = startOffset
        void baseTrack.el.play()
      }
      if (musicTrack) {
        musicTrack.el.currentTime = Math.max(0, startOffset)
        musicTrack.el.loop = !!music?.loop
        void musicTrack.el.play()
      }
      if (ttsTrack) {
        ttsTrack.el.currentTime = Math.max(0, startOffset)
        void ttsTrack.el.play()
      }

      // Fire SFX at trigger times.
      for (const fx of sfx) {
        if (!fx?.src) continue
        const triggerAtMs = Math.max(0, Math.round((fx.triggerAt ?? 0) * 1000))
        const tid = window.setTimeout(async () => {
          try {
            const fxTrack = await createTrack(fx.src, (fx.volume ?? 0.8) * mix.sfxGain, sfxCat(fx.id ?? ''))
            if (!fxTrack) return // SFX track muted / solo-excluded
            fxTrack.el.currentTime = 0
            void fxTrack.el.play()
            stats.sfxTriggered++
            log(`audio: sfx triggered at ${fx.triggerAt}s`)
          } catch {
            stats.sfxFailed++
            log(`audio: sfx failed ${fx.src}`)
          }
        }, triggerAtMs)
        timerIds.push(tid)
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, stopMs)
        timerIds.push(timer as unknown as number)
      })

      if (rec.state !== 'inactive') rec.stop()
      const blob = await blobPromise
      log(`audio: mix captured (${Math.round(blob.size / 1024)} KB)`)
      phaseMs.audioRender = performance.now() - a0
      return blob.size > 0 ? blob : null
    } finally {
      timerIds.forEach((id) => clearTimeout(id))
      cleanupFns.forEach((fn) => fn())
      try {
        dst.stream.getTracks().forEach((t) => t.stop())
      } catch {}
      try {
        await ctx.close()
      } catch {}
    }
  }

  async function muxAudioBlob(audioBlob: Blob): Promise<void> {
    if (!audioSource) return
    const m0 = performance.now()
    log('audio: muxing into mp4')
    const file = new File([audioBlob], 'scene-audio.webm', { type: audioBlob.type || 'audio/webm' })
    const ad = new WebDemuxer({
      wasmFilePath: 'https://cdn.jsdelivr.net/npm/web-demuxer@4.0.0/dist/wasm-files/web-demuxer.wasm',
    })
    await ad.load(file)
    const audioCfg = (await ad.getDecoderConfig('audio')) as AudioDecoderConfig
    const reader = ad.read('audio').getReader()
    let first = true
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || !value) break
        const packet = EncodedPacket.fromEncodedChunk(value as EncodedAudioChunk)
        if (first) {
          first = false
          await audioSource.add(packet, { decoderConfig: audioCfg })
        } else {
          await audioSource.add(packet)
        }
      }
      log('audio: mux complete')
      phaseMs.audioMux = performance.now() - m0
    } finally {
      try {
        await reader.cancel()
      } catch {}
      try {
        ad.destroy()
      } catch {}
    }
  }

  try {
    log(`profile: ${profile}`)
    const keyframeEvery = profile === 'fast' ? 240 : 120
    const decodeStride = profile === 'fast' ? 2 : 1
    const r0 = performance.now()
    for (let i = 0; i < totalFrames; i++) {
      const ts = i * frameDurationUs
      const tSec = ts / 1_000_000

      if (sceneBridge) {
        await sceneBridge.seekAndCopy(tSec)
      }

      if (hasVideo && demuxer && decoder) {
        const trimStart = Math.max(0, config.trimStart ?? 0)
        const trimEnd = config.trimEnd == null ? null : Math.max(trimStart, config.trimEnd)
        const clipT = trimEnd == null ? trimStart + tSec : Math.min(trimStart + tSec, trimEnd)
        const vf: VideoFrame | null = i % decodeStride === 0 || !lastFrame ? await decodeFrameAt(clipT) : null
        if (vf) {
          if (lastFrame) lastFrame.close()
          lastFrame = vf
        }
        if (lastFrame) {
          if (!videoSprite) {
            const tx = Texture.from({ resource: lastFrame as unknown as HTMLCanvasElement })
            videoSprite = new Sprite(tx)
            videoSprite.width = config.width
            videoSprite.height = config.height
            videoSprite.x = 0
            videoSprite.y = 0
            videoSprite.alpha = Math.max(0, Math.min(1, config.videoOpacity ?? 1))
            videoSprite.zIndex = 0
            cameraContainer.addChildAt(videoSprite, 0)
          } else {
            const old = videoSprite.texture
            videoSprite.texture = Texture.from({ resource: lastFrame as unknown as HTMLCanvasElement })
            old.destroy(true)
          }
        }
      }

      const cam = getCameraState(tSec)
      cameraContainer.scale.set(cam.scale, cam.scale)
      cameraContainer.position.set(cam.x, cam.y)

      for (const { overlay, sprite } of textSprites) {
        const start = Math.max(0, Number(overlay.delay || 0))
        const end = start + Math.max(0.01, Number(overlay.duration || 1))
        const isActive = tSec >= start && tSec <= end
        if (!isActive) {
          sprite.alpha = 0
          continue
        }

        const p = Math.max(0, Math.min(1, (tSec - start) / Math.max(0.01, end - start)))
        const fadeWindow = 0.25
        const a = Math.max(0, Math.min(1, p / fadeWindow))
        sprite.alpha = overlay.animation === 'fade-in' || overlay.animation === 'slide-up' ? a : 1

        const baseY = (overlay.y / 100) * config.height
        if (overlay.animation === 'slide-up') {
          sprite.y = baseY + (1 - a) * 20
        } else {
          sprite.y = baseY
        }

        if (overlay.animation === 'typewriter') {
          const chars = Math.max(0, Math.round((overlay.content || '').length * p))
          sprite.text = (overlay.content || '').slice(0, chars)
          sprite.alpha = 1
        } else {
          sprite.text = overlay.content || ''
        }
      }

      for (const { layer, sprite, baseX, baseY } of aiSprites) {
        applyAiLayerAnimation(sprite, layer, tSec, baseX, baseY)
      }

      for (const { layer, sprite, videoEl, durationSec } of aiVideoSprites) {
        const startAt = Math.max(0, Number(layer.startAt ?? 0))
        if (tSec < startAt) {
          sprite.alpha = 0
          continue
        }
        const playbackRate = Math.max(0.01, Number(layer.playbackRate ?? 1))
        const rawLocal = (tSec - startAt) * playbackRate
        const localT =
          layer.loop && durationSec > 0
            ? rawLocal % durationSec
            : Math.max(0, Math.min(rawLocal, Math.max(0, durationSec - 0.001)))
        if (Number.isFinite(localT) && Math.abs((videoEl.currentTime || 0) - localT) > 1 / Math.max(1, frameRate)) {
          try {
            videoEl.currentTime = localT
          } catch {}
        }
      }

      app.renderer.render(app.stage)
      config.onProgress?.((i + 1) / totalFrames)

      // @ts-expect-error: TS may not know CanvasImageSource is accepted by VideoFrame
      const vf = new VideoFrame(canvas, {
        timestamp: ts,
        duration: frameDurationUs,
        colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
      })
      encoder.encode(vf, { keyFrame: i % keyframeEvery === 0 })
      vf.close()
    }
    phaseMs.renderEncode = performance.now() - r0

    await encoder.flush()
    encoder.close()

    if (audioSource) {
      config.onProgress?.(1)
      const audioBlob = await renderAudioBlobForScene()
      if (audioBlob) {
        await muxAudioBlob(audioBlob)
      } else {
        log('audio: no mix produced')
      }
    }

    const f0 = performance.now()
    await output.finalize()
    phaseMs.finalize = performance.now() - f0
    phaseMs.total = performance.now() - startedAt
    log(
      `summary: tracks loaded ${stats.audioTracksLoaded}/${stats.audioTracksAttempted}, sfx ok ${stats.sfxTriggered}, sfx failed ${stats.sfxFailed}`,
    )
    log(
      `timings: videoInit=${Math.round(phaseMs.videoInit ?? 0)}ms render=${Math.round(phaseMs.renderEncode ?? 0)}ms audioRender=${Math.round(phaseMs.audioRender ?? 0)}ms audioMux=${Math.round(phaseMs.audioMux ?? 0)}ms finalize=${Math.round(phaseMs.finalize ?? 0)}ms total=${Math.round(phaseMs.total ?? 0)}ms`,
    )

    const buf: unknown = target.buffer
    if (!buf) throw new Error('MP4 mux produced no buffer')
    // buf may be a Uint8Array (with .buffer/.byteOffset) or an ArrayBuffer directly.
    // mediabunny's d.ts says ArrayBuffer but runtime may vary by version.
    if (buf instanceof ArrayBuffer) return buf
    if (ArrayBuffer.isView(buf)) {
      const view = buf as Uint8Array
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
    }
    return new Uint8Array(buf as ArrayBufferLike).buffer as ArrayBuffer
  } finally {
    if (lastFrame) lastFrame.close()
    if (decoder) {
      try {
        const remain = (decoder as any).__latestFrame as VideoFrame | undefined
        if (remain) remain.close()
      } catch {}
      try {
        decoder.close()
      } catch {}
    }
    if (demuxer) {
      try {
        demuxer.destroy()
      } catch {}
    }
    try {
      encoder.close()
    } catch {}
    for (const entry of aiVideoSprites) {
      try {
        entry.videoEl.pause()
      } catch {}
      try {
        entry.videoEl.src = ''
      } catch {}
      try {
        entry.videoEl.load()
      } catch {}
    }
    try {
      sceneBridge?.dispose()
    } catch {}
    try {
      app.destroy(true)
    } catch {}
  }
}
