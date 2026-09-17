/**
 * DOM media element pool for the PREVIEW — renders bare
 * video/image timeline clips as real `<video>`/`<img>` elements composited with
 * the scene iframes, driven by `planCompositeFrame` (the SAME contract the export
 * uses). Replaces the Pixi sprite path; styling is the shared
 * `compositeLayerToElementStyle`, so preview and export agree frame-for-frame.
 *
 * VIDEO SYNC: real `<video>.play()` + DEBOUNCED
 * drift-correct — reseek `currentTime` ONLY after the drift exceeds 50ms for
 * 2 CONSECUTIVE samples (absorbs single-sample rAF/GC jitter without thrashing;
 * worst-case correction ≈160ms, under human A/V tolerance). Window-gate play/pause
 * by the clip's active range; direct seek on scrub/pause. The element is MUTED —
 * preview audio is the timeline-audio-engine's job, not the visual layer.
 *
 * Limitation: `playbackRate` stays 1, so constant-speed (the common case) is
 * exact; speed-ramped/sped media is held in sync by drift-correct alone (may be
 * slightly choppy). A per-clip playbackRate is a follow-up.
 */

import type { CompositeLayer } from '@/lib/timeline/composite-frame'
import { compositeLayerToElementStyle } from '@/lib/timeline/composite-frame'
import { ClipGradeGL, buildGradeUniforms, lutUrlForPath } from '@/lib/compositor/grade-gl'

/** Drift (seconds) past which a playing video is reseeked. */
export const DRIFT_THRESHOLD_S = 0.05
/** Consecutive over-threshold samples required before a reseek (debounce). */
export const DRIFT_REQUIRED_SAMPLES = 2

interface MediaEntry {
  el: HTMLVideoElement | HTMLImageElement
  kind: 'video' | 'image'
  /** Consecutive over-threshold drift samples; reset on every in-sync tick. */
  driftSamples: number
  /** Tier-B grade renderer + its visible canvas (created lazily on first webgl sync).
   *  `null` = probed once and GL is unavailable (don't reconstruct every tick). */
  gl?: ClipGradeGL | null
  canvas?: HTMLCanvasElement
  /** Last LUT url ensured into `gl`, and its resolved size (0 until the fetch lands). */
  lutUrl?: string | null
  lutSize?: number
}

export class PreviewMediaPool {
  private pool = new Map<string, MediaEntry>() // clipId (layerKey) -> entry
  /** Shared <svg> defs holding the injected color-grade <filter>s (Tier-A grades).
   *  The CSS-tier grade references these via `url(#clip-grade-<id>)`. */
  private gradeDefs: SVGSVGElement | null = null

  constructor(private readonly container: HTMLElement) {}

  /** Inject / refresh the grade <filter> markup for a layer (CSS tier). */
  private syncGradeFilter(layer: CompositeLayer): void {
    const grade = layer.grade
    if (!grade || grade.tier !== 'css' || !grade.svgFilterMarkup) return
    if (!this.gradeDefs) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '0')
      svg.setAttribute('height', '0')
      svg.style.cssText = 'position:absolute;width:0;height:0'
      svg.setAttribute('aria-hidden', 'true')
      this.container.appendChild(svg)
      this.gradeDefs = svg
    }
    // Replace any existing filter for this clip (the markup carries its own id).
    const existing = this.gradeDefs.querySelector(`#${CSS.escape(grade.svgFilterId)}`)
    if (existing) existing.remove()
    // Parse the self-generated markup in the SVG namespace and adopt the <filter>
    // node (avoids the innerHTML/insertAdjacentHTML XSS sink — the markup is built
    // by clipGradeSvgFilterMarkup from numeric params, but we parse it safely).
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${grade.svgFilterMarkup}</svg>`,
      'image/svg+xml',
    )
    const filterEl = doc.querySelector('filter')
    if (filterEl) this.gradeDefs.appendChild(this.gradeDefs.ownerDocument.importNode(filterEl, true))
  }

  /**
   * Sync the DOM media elements to the composite plan's MEDIA layers at the
   * current playhead. Mount new, style + drift-sync active, evict inactive.
   * `isPlaying` switches between playback (play+drift-correct) and scrub (seek).
   */
  sync(mediaLayers: CompositeLayer[], isPlaying: boolean): void {
    const active = new Set<string>()
    for (const layer of mediaLayers) {
      if (layer.kind === 'scene') continue
      active.add(layer.layerKey)
      const entry = this.pool.get(layer.layerKey) ?? this.mount(layer)
      const style = compositeLayerToElementStyle(layer)
      const el = entry.el
      // Keep the source decoding/seeking on the playhead in every tier — the webgl
      // path reads the SAME seeked frame as its GL texture source.
      if (entry.kind === 'video') this.syncVideo(entry, layer.localT, isPlaying)

      // Tier B (LUT / hue curves): render the graded frame into a <canvas> that
      // replaces the raw element. Tier A (css) + ungraded keep styling the element.
      if (layer.grade?.tier === 'webgl' && this.renderWebglLayer(entry, layer, style)) {
        el.style.visibility = 'hidden' // source feeds the GL texture only
        continue
      }
      this.teardownGl(entry) // grade left the webgl tier → drop the canvas
      this.syncGradeFilter(layer)
      el.style.transform = style.transform
      el.style.filter = style.filter
      el.style.mixBlendMode = style.mixBlendMode
      el.style.opacity = String(style.opacity)
      el.style.zIndex = String(style.zIndex)
      el.style.visibility = 'visible'
    }
    // Evict inactive media (pause + remove) — clipId-keyed pool is unbounded, so a
    // long timeline would otherwise accumulate live <video> decoders. A clip's active range is contiguous, so it won't churn-remount.
    for (const [key, entry] of this.pool) {
      if (active.has(key)) continue
      this.destroyEntry(entry)
      this.pool.delete(key)
    }
  }

  private mount(layer: CompositeLayer): MediaEntry {
    const kind: 'video' | 'image' = layer.kind === 'image' ? 'image' : 'video'
    let el: HTMLVideoElement | HTMLImageElement
    if (kind === 'video') {
      const v = document.createElement('video')
      v.muted = true // audio rides the timeline-audio-engine, not the visual element
      v.defaultMuted = true
      v.playsInline = true
      v.preload = 'auto'
      v.src = layer.src
      el = v
    } else {
      const img = document.createElement('img')
      img.src = layer.src
      el = img
    }
    el.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;transform-origin:0 0;pointer-events:none;'
    this.container.appendChild(el)
    const entry: MediaEntry = { el, kind, driftSamples: 0 }
    this.pool.set(layer.layerKey, entry)
    return entry
  }

  /**
   * Tier-B grade: draw the seeked source frame through the WebGL shader into a
   * per-clip `<canvas>` and style that canvas as the composite layer. Returns true
   * when the canvas is showing the graded frame; false when GL is unavailable or the
   * source isn't decodable yet (caller falls back to styling the raw element).
   *
   * Uniforms are rebuilt each tick (cheap, and the user may be live-editing a knob);
   * the LUT is fetched + uploaded once per url (the fetch is async, so the first frame
   * or two after adding a LUT render without it until `ensureLut` resolves).
   */
  private renderWebglLayer(
    entry: MediaEntry,
    layer: CompositeLayer,
    style: ReturnType<typeof compositeLayerToElementStyle>,
  ): boolean {
    const grade = layer.grade
    if (!grade) return false
    if (entry.gl === undefined) {
      // First webgl tick for this clip: probe WebGL2 once. On no-GPU/SSR, record a
      // null sentinel and fall back to the raw element — never append a dead canvas.
      const gl = new ClipGradeGL()
      if (!gl.supported || !gl.canvas) {
        gl.dispose()
        entry.gl = null
        return false
      }
      entry.gl = gl
      entry.canvas = gl.canvas
      entry.canvas.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;transform-origin:0 0;pointer-events:none;'
      this.container.appendChild(entry.canvas)
    }
    if (!entry.gl || !entry.canvas) return false

    // Intrinsic source resolution = the GL drawing buffer (1:1 sampling); CSS fills
    // the stage. Skip until the source has decoded a frame (dims 0).
    const src = entry.el
    const w = entry.kind === 'video' ? (src as HTMLVideoElement).videoWidth : (src as HTMLImageElement).naturalWidth
    const h = entry.kind === 'video' ? (src as HTMLVideoElement).videoHeight : (src as HTMLImageElement).naturalHeight
    if (!w || !h) return false

    const lutUrl = lutUrlForPath(grade.raw.lut?.path)
    if (entry.lutUrl !== lutUrl) {
      entry.lutUrl = lutUrl
      entry.lutSize = 0
      void entry.gl.ensureLut(lutUrl).then((size) => {
        entry.lutSize = size
      })
    }
    entry.gl.render(src, buildGradeUniforms(grade.raw), w, h, entry.lutSize ?? 0)

    // The grade is baked into pixels; the canvas still carries the clip's OWN
    // transform/blend/opacity + any non-grade clip filters (style.filter excludes
    // the webgl grade by construction).
    const c = entry.canvas
    c.style.transform = style.transform
    c.style.filter = style.filter
    c.style.mixBlendMode = style.mixBlendMode
    c.style.opacity = String(style.opacity)
    c.style.zIndex = String(style.zIndex)
    c.style.visibility = 'visible'
    return true
  }

  /** Drop a clip's GL canvas + context (grade left the webgl tier, or eviction). */
  private teardownGl(entry: MediaEntry): void {
    if (!entry.gl && !entry.canvas) return
    try {
      entry.canvas?.remove()
    } catch {
      /* ignore */
    }
    try {
      entry.gl?.dispose()
    } catch {
      /* ignore */
    }
    entry.gl = undefined
    entry.canvas = undefined
    entry.lutUrl = undefined
    entry.lutSize = undefined
  }

  /** Parent-media sync, isolated for unit-testing the drift logic. */
  private syncVideo(entry: MediaEntry, expectedT: number, isPlaying: boolean): void {
    const v = entry.el as HTMLVideoElement
    if (!isPlaying) {
      // Scrub / paused: pause + seek directly to the playhead.
      if (!v.paused) v.pause()
      if (Math.abs((v.currentTime || 0) - expectedT) > 0.001) {
        try {
          v.currentTime = expectedT
        } catch {
          /* readyState 0 — ignore, the next tick retries */
        }
      }
      entry.driftSamples = 0
      return
    }
    // Playing: ensure playback, then DEBOUNCED drift-correct. `play()` returns a
    // promise in browsers but may return undefined in some hosts — guard it.
    if (v.paused) {
      const p = v.play() as Promise<void> | undefined
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
    if (Math.abs((v.currentTime || 0) - expectedT) > DRIFT_THRESHOLD_S) {
      entry.driftSamples += 1
      if (entry.driftSamples >= DRIFT_REQUIRED_SAMPLES) {
        try {
          v.currentTime = expectedT
        } catch {
          /* ignore */
        }
        entry.driftSamples = 0
      }
    } else {
      entry.driftSamples = 0
    }
  }

  private destroyEntry(entry: MediaEntry): void {
    this.teardownGl(entry)
    try {
      if (entry.kind === 'video') (entry.el as HTMLVideoElement).pause()
    } catch {
      /* ignore */
    }
    try {
      entry.el.removeAttribute('src')
    } catch {
      /* ignore */
    }
    try {
      entry.el.remove()
    } catch {
      /* ignore */
    }
  }

  /** Tear down all media elements (component unmount / project switch). */
  dispose(): void {
    for (const entry of this.pool.values()) this.destroyEntry(entry)
    this.pool.clear()
  }

  /** Test/diagnostic: current live element count. */
  get size(): number {
    return this.pool.size
  }
}
