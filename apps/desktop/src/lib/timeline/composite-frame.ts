/**
 * planCompositeFrame — the single source of truth for "what the composited
 * frame looks like at global time `t`", shared by the multi-track preview and
 * the single-stream export.
 *
 * It is intentionally PURE (no BrowserWindow, no React, no Pixi) so the
 * compositing decision — which scenes are stacked, in what z-order, at what
 * source-local time, with what opacity — is unit-testable without mounting a
 * renderer. The Electron capture loop (src/electron/ipc/export-tier3.ts) and the
 * preview both execute this plan; that's how export and preview agree
 * frame-for-frame.
 *
 *   getActiveClips(t) ─▶ planCompositeFrame ─▶ { isGap, layers[] (z-ascending) }
 *                                                  │
 *                          export: mount/seek/opacity each layer iframe, capturePage
 *                          preview: same, in the DOM
 *
 * Transitions (fade crossfade, D3/T5) extend this via the optional
 * `transition` arg; the core (active set, z, fade-in/out alpha, gaps) stands
 * alone so it can be tested in isolation first.
 */

import type { Timeline, Clip } from '@/lib/types'
import { getActiveClips, getPlaybackSequenceClips } from './sequence'
import { computeClipAlpha } from '@/lib/compositor/clip-alpha'
import { remapTime, evaluateAllKeyframes } from '@/lib/compositor/interpolate'
import { clipFiltersToCss, clipBlendModeToCss } from '@/lib/compositor/clip-filter-css'
import { gradeRenderTier } from '@/lib/edit-engines/clip-grade'
import { compileClipGradeCss, clipGradeSvgFilterMarkup } from '@/lib/compositor/clip-grade-css'

/** What the host mounts for a layer: a scene HTML iframe, a `<video>`, or an `<img>`. */
export type CompositeLayerKind = 'scene' | 'video' | 'image'

/** One stacked layer in the composited frame — a scene iframe OR a bare media clip. */
export interface CompositeLayer {
  /** Discriminator — drives the host's mount/seek branch (scene→iframe, video→`<video>`, image→`<img>`). */
  kind: CompositeLayerKind
  /**
   * The host POOL key. Scenes key by `sceneId` (one iframe per scene, the top-z
   * clip wins — the preview composites the same way). Media keys by `clipId`
   * (each clip is its own element, so two clips of the SAME file don't collide).
   */
  layerKey: string
  /** Scene id (kind 'scene') — maps to scene HTML. Empty for media. */
  sceneId: string
  /** Media URL (kind 'video' | 'image') — `clip.sourceId`, resolved to a file by the export. Empty for scenes. */
  src: string
  /** The specific clip instance (clip.id) — distinguishes split halves / N copies. */
  clipId: string
  /**
   * Source-local seek time in seconds. Scenes: `trimStart + (t-startTime)*speed`.
   * Media: `remapTime(...)`, honoring speed KEYFRAMES (matches the Pixi preview).
   * The renderer drives the scene's `__clock.seek(localT)` or `<video>.currentTime`.
   */
  localT: number
  /** Paint order / z-index — higher composites on top. V1→1, V2→2, … (round(trackZBase/100)). */
  z: number
  /** Effective alpha in [0,1]: base opacity × fade-in × fade-out × blendOpacity × any transition ramp. */
  opacity: number
  /**
   * Transform (parity with Pixi): element fills `frame × scaleX/Y` at offset
   * `posX/posY` px, rotated `rotation` degrees. KEYFRAME-evaluated at the layer's
   * local time (matches Pixi `kfValues.x ?? clip.position.x`). Scenes = identity
   * (full-frame iframe, no transform).
   */
  scaleX: number
  scaleY: number
  posX: number
  posY: number
  /** Rotation in DEGREES (CSS `rotate(Ndeg)`). Keyframe-evaluated; 0 for scenes. */
  rotation: number
  /** CSS `filter` value from `clip.filters` — '' when none / scene. tone-curve skipped. */
  filterCss: string
  /** CSS `mix-blend-mode` value from `clip.blendMode` — '' = normal / scene. Media-over-media only. */
  blendMode: string
  /**
   * Clip color grade for this layer (media only). The compositor resolves
   * a clip's `grade` into a render-ready descriptor here so the preview pool and the
   * export host apply IDENTICAL grading (preview == export). `tier` selects how the
   * host renders it: 'none' (no grade), 'css' (CSS filter + injected SVG <filter>),
   * or 'webgl' (per-layer canvas shader pass — required for LUT / hue curves).
   * Additive field: composite-frame planning doesn't touch grade plumbing.
   */
  grade?: CompositeLayerGrade
}

/** Render-ready grade descriptor for a composite layer (see CompositeLayer.grade). */
export interface CompositeLayerGrade {
  tier: import('@/lib/edit-engines/clip-grade').GradeRenderTier
  /** CSS `filter` functions from the Tier-A compile (exposure/contrast/saturate). */
  filterCss: string
  /** SVG `<filter>` markup to inject + reference via `url(#id)` (white balance / curves). */
  svgFilterMarkup: string
  /** The id used in `svgFilterMarkup` (unique per clip). */
  svgFilterId: string
  /** Vignette amount 0..1 (host renders a radial overlay). */
  vignette: number
  /** The raw grade — the WebGL host reads LUT path / hue curves from here for Tier B. */
  raw: import('@/lib/edit-engines/clip-grade').ClipColorGrade
}

/** The composited frame at one instant. `layers` are sorted z-ascending (paint back-to-front). */
export interface CompositeFramePlan {
  /** True when nothing is active on any video track at `t` — render BLACK + silent. */
  isGap: boolean
  layers: CompositeLayer[]
}

/** Optional transition context for fade crossfades (D3/T5). */
export interface CompositeTransitionOpts {
  /** Enable the preview's fade crossfade between a clip and the next sequence clip. */
  fade?: boolean
}

const trackZToLayerZ = (trackZBase: number) => Math.max(1, Math.round(trackZBase / 100))

const sourceLocalTime = (clip: Clip, t: number): number => {
  // speed ≤ 0 / non-finite is degenerate (a real clip is always > 0); clamp to 1×
  // rather than freeze (0) or run backwards. This diverges from the preview's bare
  // `speed ?? 1` only for those invalid inputs, which no real clip produces.
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1
  const trimStart = Number.isFinite(clip.trimStart) ? clip.trimStart : 0
  const raw = trimStart + Math.max(0, t - clip.startTime) * speed
  // Clamp to the source out-point so float drift at the half-open clip end (or a
  // t just past the clip) never seeks the scene past its trimmed range.
  const dur = Number.isFinite(clip.duration) ? clip.duration : 0
  const outPoint = clip.trimEnd != null && Number.isFinite(clip.trimEnd) ? clip.trimEnd : trimStart + dur * speed
  return Math.min(raw, outPoint)
}

/**
 * Source seek time for a bare media clip — `remapTime` so speed KEYFRAMES match
 * the Pixi preview (pixi-preview.ts:550), not just a scalar speed. Clamped to the
 * source out-point so float drift at the clip end never seeks past trim.
 */
const mediaLocalTime = (clip: Clip, t: number): number => {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1
  const trimStart = Number.isFinite(clip.trimStart) ? clip.trimStart : 0
  const localTime = Math.max(0, t - clip.startTime)
  const raw = remapTime(localTime, speed, trimStart, clip.keyframes ?? [])
  const dur = Number.isFinite(clip.duration) ? clip.duration : 0
  const outPoint = clip.trimEnd != null && Number.isFinite(clip.trimEnd) ? clip.trimEnd : trimStart + dur * speed
  return Math.min(raw, outPoint)
}

/**
 * Per-clip transform from the clip's keyframe values `kf` (pre-evaluated
 * once by the caller at timeline-local `t - startTime`, shared with the opacity
 * alpha). Mirrors Pixi exactly: `kfValues.scaleX ?? clip.scale.x`, etc., with the
 * static `clip.{scale,position,rotation}` as the keyframe fallback. Without the
 * keyframe eval, animated/rotated media would render STATIC in preview and
 * export. Scenes are full-frame iframes → identity (no transform).
 */
const clipTransform = (clip: Clip, kind: CompositeLayerKind, kf: Record<string, number>) => {
  if (kind === 'scene') return { scaleX: 1, scaleY: 1, posX: 0, posY: 0, rotation: 0 }
  const fin = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
  return {
    scaleX: fin(kf.scaleX, Number.isFinite(clip.scale?.x) ? clip.scale.x : 1),
    scaleY: fin(kf.scaleY, Number.isFinite(clip.scale?.y) ? clip.scale.y : 1),
    posX: fin(kf.x, Number.isFinite(clip.position?.x) ? clip.position.x : 0),
    posY: fin(kf.y, Number.isFinite(clip.position?.y) ? clip.position.y : 0),
    rotation: fin(kf.rotation, Number.isFinite(clip.rotation) ? clip.rotation : 0),
  }
}

/**
 * Resolve a clip's `grade` into the render-ready CompositeLayerGrade. A neutral /
 * absent grade returns undefined so the host's hot path is untouched.
 *
 * MEDIA clips (video/image) get the full two-tier grade (CSS+SVG, plus the WebGL
 * LUT/hue pass). SCENE clips render as an iframe, which a WebGL pass cannot sample —
 * so a graded scene (the common "video dropped on the timeline" = a media-asset
 * scene) gets only the CSS+SVG tier applied to the iframe. LUT/hue curves are forced
 * off for scenes (the tier is pinned to 'css'); apply_color tells the user those
 * parts won't show on a scene. This keeps non-graded scenes byte-identical.
 */
const resolveClipGrade = (clip: Clip, kind: CompositeLayerKind): CompositeLayerGrade | undefined => {
  const grade = clip.grade
  if (gradeRenderTier(grade) === 'none' || !grade) return undefined
  const isScene = kind === 'scene'
  // Scenes can only take the CSS/SVG tier (iframe can't be a GL texture source).
  const tier = isScene ? 'css' : gradeRenderTier(grade)
  const svgFilterId = `clip-grade-${clip.id}`
  const compiled = compileClipGradeCss(grade)
  return {
    tier,
    filterCss: compiled.filterCss,
    svgFilterMarkup: clipGradeSvgFilterMarkup(grade, svgFilterId),
    svgFilterId,
    vignette: compiled.vignette,
    raw: grade,
  }
}

const layerKindForClip = (clip: Clip): CompositeLayerKind =>
  clip.sourceType === 'image' ? 'image' : clip.sourceType === 'video' ? 'video' : 'scene'

/**
 * Build the composite plan for global time `t`.
 *
 * Active set + z-order + mute/solo/hidden come from {@link getActiveClips}
 * (the same primitive the preview tick uses). We additionally drop
 * `enabled === false` clips (the "E" toggle — disabled clips stay on the
 * timeline but skip render); getActiveClips does not check enable.
 *
 * Per-layer opacity reuses {@link computeClipAlpha} — the same fade-in/out +
 * blendOpacity math the Pixi compositor and preview already use — keyed on the
 * TIMELINE-local time (`t - startTime`), not the source-local seek time.
 *
 * When `opts.fade` is set, a clip whose `transition.type === 'fade'` cross-
 * dissolves into the next sequence clip over its final `transition.duration`
 * seconds, mirroring PreviewPlayer.tsx (the outgoing ramps to 0, the incoming
 * is added pre-seeked to its trimStart and ramps up by `progress`).
 */
export function planCompositeFrame(
  timeline: Timeline | null | undefined,
  t: number,
  opts?: CompositeTransitionOpts,
): CompositeFramePlan {
  // A non-finite t (NaN/Infinity from a bad clock) would produce NaN localT /
  // opacity layers that silently corrupt the seek + composite — treat it as a gap.
  if (!Number.isFinite(t)) return { isGap: true, layers: [] }

  // Scene clips render as iframes; bare video/image clips render as <video>/<img>
  // DOM elements in the SAME composite. All
  // three kinds stack by track z-order in one pass.
  const active = getActiveClips(timeline, t, { sourceType: ['scene', 'video', 'image'] }).filter(
    (a) => a.clip.enabled !== false,
  )

  if (active.length === 0) return { isGap: true, layers: [] }

  // SCENES: one layer PER SCENE (sourceId), keeping the highest-z clip — mirrors
  // PreviewPlayer's `activeByScene`. The iframe pool is keyed by sourceId, so two
  // clips of the SAME scene can't seek one iframe to two times; the top track wins.
  // MEDIA (video/image): one layer PER CLIP (clipId-keyed element) — two clips of
  // the same file are distinct elements and must NOT collapse (OV-2).
  const topScene = new Map<string, (typeof active)[number]>()
  const mediaClips: (typeof active)[number][] = []
  for (const a of active) {
    if (a.clip.sourceType === 'scene') {
      const cur = topScene.get(a.clip.sourceId)
      if (!cur || a.trackZBase > cur.trackZBase) topScene.set(a.clip.sourceId, a)
    } else {
      mediaClips.push(a)
    }
  }

  const toLayer = (a: (typeof active)[number]): CompositeLayer => {
    const kind = layerKindForClip(a.clip)
    const isScene = kind === 'scene'
    const localTime = Math.max(0, t - a.clip.startTime)
    // Evaluate keyframes ONCE per clip and feed both the alpha (opacity keyframe,
    // matching Pixi's `computeClipAlpha(clip, t, kfValues.opacity)`) and the
    // transform. Without `kf.opacity`, an animated-opacity clip would freeze at
    // `clip.opacity` in BOTH the DOM preview and the export.
    const kf = evaluateAllKeyframes(a.clip.keyframes ?? [], localTime)
    return {
      kind,
      layerKey: isScene ? a.clip.sourceId : a.clip.id,
      sceneId: isScene ? a.clip.sourceId : '',
      src: isScene ? '' : a.clip.sourceId,
      clipId: a.clip.id,
      localT: isScene ? sourceLocalTime(a.clip, t) : mediaLocalTime(a.clip, t),
      z: trackZToLayerZ(a.trackZBase),
      opacity: computeClipAlpha(a.clip, localTime, kf.opacity),
      // Filters/blend apply to MEDIA only; scenes render their own (iframe).
      filterCss: isScene ? '' : clipFiltersToCss(a.clip.filters),
      blendMode: isScene ? '' : clipBlendModeToCss(a.clip.blendMode),
      grade: resolveClipGrade(a.clip, kind),
      ...clipTransform(a.clip, kind, kf),
    }
  }

  const layers: CompositeLayer[] = [...[...topScene.values()].map(toLayer), ...mediaClips.map(toLayer)]

  if (opts?.fade) applyFadeTransition(timeline, t, active, layers)

  // Paint back-to-front: lowest z first. Stable within a z-band (declaration order).
  layers.sort((p, q) => p.z - q.z)
  return { isGap: false, layers }
}

/**
 * Mirror PreviewPlayer's fade crossfade (PreviewPlayer.tsx:756-784, 2256-2266):
 * the TOP active clip, in its final `transition.duration` seconds, dissolves
 * into the next clip in the V1 sequence. Outgoing alpha → `(1-progress)*alpha`;
 * the incoming clip is added (or revealed) at alpha `progress`, pre-seeked to
 * its trimStart. Mutates `layers` in place.
 */
function applyFadeTransition(
  timeline: Timeline | null | undefined,
  t: number,
  active: ReturnType<typeof getActiveClips>,
  layers: CompositeLayer[],
): void {
  // Fade is a SCENE transition (the V1 scene sequence). Pick the top SCENE clip;
  // a media clip stacked above never owns a scene fade.
  const scenes = active.filter((a) => a.clip.sourceType === 'scene')
  if (scenes.length === 0) return
  let top = scenes[0]
  for (const a of scenes) if (a.trackZBase > top.trackZBase) top = a
  const clip = top.clip
  // Apply the crossfade for ANY real transition, not just the literal 'fade'. The catalog
  // stores ids like 'crossfade' / 'dissolve' / 'wipe-left' (src/lib/transitions.ts) and NOTHING
  // ever writes 'fade', so the old `!== 'fade'` gate silently made all 40 transitions a
  // hard cut in both preview and export. 'none' stays a hard cut; every other id renders as
  // a crossfade (per-effect wipes/slides/zooms are a follow-up — a crossfade beats a no-op).
  if (!clip.transition || clip.transition.type === 'none' || !(clip.transition.duration > 0)) return

  // The "next clip" comes from the SHARED playback sequence (V1 spine + non-
  // overlapping higher-track gap-fillers) — the same getPlaybackSequenceClips the
  // preview (PreviewPlayer) advances through, so a fade INTO a V2 gap-filler picks
  // the SAME incoming clip in preview and export. (Was getSequenceClips = V1-only,
  // which diverged from the preview on gap-filler projects.)
  const seq = getPlaybackSequenceClips(timeline)
  const idx = seq.findIndex((c) => c.id === clip.id)
  const next = idx >= 0 ? seq[idx + 1] : undefined
  if (!next) return

  const localT = Math.max(0, t - clip.startTime)
  const remaining = clip.duration - localT
  const td = clip.transition.duration
  if (!(remaining < td && remaining >= 0)) return

  const progress = Math.min(1, Math.max(0, 1 - remaining / td))

  // Outgoing: ramp the top layer down (× its own active alpha, as preview does).
  const outLayer = layers.find((l) => l.clipId === clip.id)
  if (outLayer) outLayer.opacity = (1 - progress) * outLayer.opacity

  // Incoming: the next sequence clip, pre-seeked to its in-point, ramping up.
  // Preview gives the incoming raw `progress` (not × its own alpha) and paints the
  // transition layer at z=1 (PreviewPlayer.tsx:2269 `isTransitionVisible ? 1`),
  // NOT the outgoing clip's track z — mirror both. Dedupe by scene (sourceId) to
  // match the layer set above.
  const existing = layers.find((l) => l.kind === 'scene' && l.sceneId === next.sourceId)
  if (existing) {
    existing.opacity = progress
  } else {
    layers.push({
      kind: 'scene',
      layerKey: next.sourceId,
      sceneId: next.sourceId,
      src: '',
      clipId: next.id,
      localT: Number.isFinite(next.trimStart) ? next.trimStart : 0,
      z: 1,
      opacity: progress,
      scaleX: 1,
      scaleY: 1,
      posX: 0,
      posY: 0,
      rotation: 0,
      filterCss: '',
      blendMode: '',
    })
  }
}

/** A composite layer resolved to concrete element styles — shared by the export
 *  host and the preview DOM media pool so media is styled identically in both. */
export interface CompositeElementStyle {
  /** CSS `transform` value: `translate(...) rotate(...) scale(...)`, '' = identity. */
  transform: string
  /** CSS `filter` value, '' = none. */
  filter: string
  /** CSS `mix-blend-mode` value, '' = normal. */
  mixBlendMode: string
  opacity: number
  zIndex: number
  /**
   * Color-grade render info for the host (preview pool + export host). When
   * `tier === 'css'` the host injects `svgFilterMarkup` once and the grade's CSS
   * + `url(#id)` are already folded into `filter`. When `tier === 'webgl'` the host
   * must run the per-layer shader pass (LUT / hue curves) reading `raw`. `undefined`
   * = no grade (hot path untouched). `vignette` drives a radial overlay either way.
   */
  grade?: CompositeLayerGrade
}

/**
 * Resolve a CompositeLayer to concrete CSS element styles (transform + filter +
 * blend + opacity + z). ONE source of truth so the preview `<video>`/`<img>` and
 * the export host element get identical styling. Order: translate → rotate → scale
 * (transform-origin 0 0; element is width/height 100% with object-fit fill, so
 * scale(sx,sy) fills `frame × sx/sy` — matches Pixi `sprite.width = frame*scale`).
 */
export function compositeLayerToElementStyle(layer: CompositeLayer): CompositeElementStyle {
  const t: string[] = []
  if (layer.posX !== 0 || layer.posY !== 0) t.push(`translate(${layer.posX}px,${layer.posY}px)`)
  if (layer.rotation) t.push(`rotate(${layer.rotation}deg)`)
  if (layer.scaleX !== 1 || layer.scaleY !== 1) t.push(`scale(${layer.scaleX},${layer.scaleY})`)

  // Fold the Tier-A clip grade into the element `filter`. For 'css' grades the
  // grade's CSS functions + the injected SVG filter (`url(#id)`) compose AFTER the
  // clip's own `filters` (Look/correction order). 'webgl' grades are rendered by
  // the host's shader pass instead — only the CSS-expressible primaries are folded
  // here as a degrade if the host can't run GL (it always can in Electron/Chromium).
  const filterParts: string[] = []
  if (layer.filterCss) filterParts.push(layer.filterCss)
  const grade = layer.grade
  if (grade && grade.tier === 'css') {
    if (grade.filterCss) filterParts.push(grade.filterCss)
    if (grade.svgFilterMarkup) filterParts.push(`url(#${grade.svgFilterId})`)
  }

  return {
    transform: t.join(' '),
    filter: filterParts.join(' '),
    mixBlendMode: layer.blendMode,
    opacity: layer.opacity,
    zIndex: layer.z,
    grade: layer.grade,
  }
}
