/* eslint-disable no-useless-escape -- <\/script> escapes required in template literal HTML to prevent early tag closing */
import { gradeSvgFilterMarkup, gradeToCssChain, type LayerColorGrade } from './edit-engines/layer-grade'

/** Radial-gradient vignette overlay (grade.vignette 0..1) — '' when off. */
function vignetteOverlayHTML(grade: LayerColorGrade | undefined, zIndex = 2): string {
  const amount = Math.max(0, Math.min(1, grade?.vignette ?? 0))
  if (amount < 1e-4) return ''
  const alpha = Math.round(amount * 0.85 * 1000) / 1000
  return `<div class="dreambyte-vignette" style="position:absolute;inset:0;pointer-events:none;z-index:${zIndex};background:radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,${alpha}) 100%);"></div>`
}
import type {
  Scene,
  AILayer,
  AvatarLayer,
  Veo3Layer,
  ImageLayer,
  StickerLayer,
  AudioLayer,
  GlobalStyle,
  WatermarkConfig,
  CameraMove,
  AudioSettings,
} from './types'
import { type ProjectDimensions, DEFAULT_DIMENSIONS } from './dimensions'
import { computeVeo3FullFrameDims, veo3DimsAreFalsy, resolveVeo3CenterCoords } from './media/veo3-geometry'
import {
  THREE_ENVIRONMENT_RUNTIME_SCRIPT,
  THREE_HELPERS_RUNTIME_SCRIPT,
  THREE_SCATTER_RUNTIME_SCRIPT,
} from './three-environments/inlined-runtimes'
import { CANVAS_RENDERER_CODE } from './canvas-renderer/inlined'
import { resolveStyle, type ResolvedStyle } from './styles/presets'
import { resolveSceneStyle } from './styles/scene-presets'
import { buildFontLink, buildMultiFontLink, resolveSceneFontFamily, sceneFontCssStack } from './fonts/catalog'
import { ANIME_HEAD } from './scene-html/anime-head'
import { legacyPlaceholderFromHtml, withLegacyPlaceholder } from './scene-html/legacy-gsap'
import { buildErrorCaptureScript } from './agents/error-capture-shared'
import { PLAYBACK_CONTROLLER } from './scene-html/playback-controller'
import { ELEMENT_REGISTRY } from './scene-html/element-registry'
import { SCENE_CSP_META } from './security/scene-csp'
import { normalizeAudioLayer } from './audio/normalize'
import { chartLayersUsePlotly, chartLayersUseRecharts } from './charts/compile'
import { emitReactMotionHelper } from './motion-dsl/compiler/react'
import type { MotionRef } from './motion-dsl/types'
import { REMOVED_LOCAL_AVATAR_MESSAGE, usesRemovedLocalAvatar } from './avatar/removed-local-avatar'

/**
 * Resolve the base URL used to stamp absolute asset references into scene HTML.
 *
 * Packaged Electron: the renderer runs from `dreambyte://app/…` and there is no
 *   HTTP server. Assets are served via the `dreambyte://uploads/`, `dreambyte://audio/`,
 *   and `dreambyte://scenes/` protocol mounts (src/electron/main.ts). `DREAMBYTE_APP_URL_BASE`
 *   is set to `dreambyte://app/` in main.ts before any handler loads this module.
 *
 * Renderer process: `process.env.DREAMBYTE_APP_URL_BASE` is not inherited by the
 *   renderer, so prefer `window.location.origin` when available (also resolves
 *   to `dreambyte://app` under packaged + dev:desktop flows).
 *
 * Last resort: `dreambyte://app`. We no longer fall back to `localhost:3000`
 *   because there is no HTTP server in any supported desktop flow.
 *
 * Scenes use this in three spots: the `<base href>` tag, the 3D world loader,
 * and the watermark `<img src>`. All three must point at an
 * origin that can actually serve the asset at runtime.
 */
function getAppBaseUrl(): string {
  const override = process.env.DREAMBYTE_APP_URL_BASE
  if (override) return override.endsWith('/') ? override.slice(0, -1) : override
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'dreambyte://app'
}

/** Build a Google Fonts link tag that loads both heading and body fonts (if different). */
function buildSceneFontLinks(style: ResolvedStyle): string {
  const unique = [...new Set([style.font, style.bodyFont].filter(Boolean) as string[])]
  if (unique.length === 0) return ''
  if (unique.length === 1) return buildFontLink(unique[0])
  return buildMultiFontLink(unique)
}

function canvasBgTag(W = 1920, H = 1080): string {
  return `<canvas id="c" width="${W}" height="${H}" style="display:block;position:absolute;left:0;top:0;width:100%;height:100%;z-index:0;margin:0;padding:0;border:0;pointer-events:none;"></canvas>`
}

function sceneUsesCanvasBackground(scene: Scene): boolean {
  return !!scene.canvasBackgroundCode?.trim() && ['motion', 'd3', 'svg', 'react'].includes(scene.sceneType ?? '')
}

// ── Multi-track audio HTML generation ─────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a string for safe insertion into a JS single-quoted string literal. */
function escapeJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\/script/gi, '<\\/script')
}

/** Strip closing style tags from CSS to prevent context escape in <style> blocks. */
function sanitizeCssBlock(s: string): string {
  return s.replace(/<\/style/gi, '/* escaped */')
}

function generateAudioHTML(audioLayer: AudioLayer | null | undefined): string {
  const al = normalizeAudioLayer(audioLayer)
  if (!al.enabled) return ''

  const parts: string[] = []
  const vol = Math.min(1, Math.max(0, Number(al.volume)))
  const startOff = Number.isFinite(al.startOffset) && al.startOffset > 0 ? al.startOffset : 0
  const volAttr = Number.isFinite(vol) ? vol : 1
  const dataVol = ` data-volume="${volAttr}"`
  const dataOff = ` data-start-offset="${startOff}"`

  // TTS track
  if (al.tts?.src && al.tts.status === 'ready') {
    parts.push(
      `<audio id="scene-tts" src="${escapeAttr(al.tts.src)}" data-track="tts"${dataVol}${dataOff} preload="auto"></audio>`,
    )
  } else if (al.tts && !al.tts.src && al.tts.status === 'ready') {
    // Client-side TTS (web-speech or puter): inject config div
    parts.push(
      `<div id="scene-tts-config" data-provider="${al.tts.provider}" data-text="${escapeAttr(al.tts.text)}" data-voice="${al.tts.voiceId ?? ''}" style="display:none"></div>`,
    )
  } else if (al.src) {
    // Legacy single-track audio
    parts.push(`<audio id="scene-audio" src="${escapeAttr(al.src)}"${dataVol}${dataOff} preload="auto"></audio>`)
  }

  // SFX tracks
  for (const sfx of al.sfx ?? []) {
    parts.push(
      `<audio id="sfx-${sfx.id}" src="${escapeAttr(sfx.src)}" data-track="sfx" data-trigger-at="${sfx.triggerAt}" data-volume="${sfx.volume}" preload="auto"></audio>`,
    )
  }

  // Music track
  if (al.music?.src) {
    parts.push(
      `<audio id="scene-music" src="${escapeAttr(al.music.src)}" data-track="music" data-volume="${al.music.volume}" ${al.music.loop ? 'loop' : ''} data-duck="${al.music.duckDuringTTS}" data-duck-level="${al.music.duckLevel}" preload="auto"></audio>`,
    )
  }

  return parts.join('\n  ')
}

// ── AI Layer HTML generation ────────────────────────────────────────────────

/**
 * W1 runtime wire-up: for every aiLayer with `layer.motion` set, emit
 * a per-layer `motionStyle_<id>(frame)` helper compiled from the React
 * adapter, plus a small applier that subscribes to the scene clock
 * (window.__dreambyte.onTick — the frame source the DreambyteReact runtime
 * listens on) and updates each
 * layer's inline `style.transform` / `style.opacity` per frame.
 *
 * Additive-only: layers without `motion` are unchanged. Existing inline
 * styles on layer container divs are preserved (we only touch transform
 * + opacity when motion is active).
 *
 * NOTE: `animate_layer` — the only thing that ever SET `layer.motion` — was
 * deleted with the L2 tool cut (offered to no agent, called zero times in every
 * recorded run). This reader stays so any project that already persisted a
 * `motion` field keeps rendering; `src/lib/motion-dsl/` is writer-less and is a
 * follow-up cut once that data question is settled.
 */
function generateMotionRuntimeScript(layers: AILayer[] | undefined, fps: number): string {
  if (!layers || layers.length === 0) return ''
  const animated = layers.filter((l) => (l as AILayer & { motion?: MotionRef }).motion)
  if (animated.length === 0) return ''

  // Sanitize layerIds — the helper name is interpolated into JS, so reject
  // anything that wouldn't be a valid identifier component. The retired
  // animate_layer tool validated layerIds at the agent boundary; with no writer
  // left this is the only guard, so it stays.
  const safeIdRe = /^[a-zA-Z0-9_-]+$/
  const safe = animated.filter((l) => safeIdRe.test(l.id))

  const helpers = safe
    .map((layer) => {
      const motion = (layer as AILayer & { motion?: MotionRef }).motion as MotionRef
      const helperName = `motionStyle_${layer.id.replace(/-/g, '_')}`
      return emitReactMotionHelper(
        motion,
        { fps, defaultEasing: 'power2.out', defaultSpring: 'gentle' },
        { helperName },
      )
    })
    .join('\n')

  const bindings = safe
    .map((layer) => `    { id: ${JSON.stringify(layer.id)}, helper: motionStyle_${layer.id.replace(/-/g, '_')} }`)
    .join(',\n')

  return `<script>
;(function () {
  ${helpers}
  var FPS = ${fps};
  var BINDINGS = [
${bindings}
  ];
  function applyAt(frame) {
    for (var i = 0; i < BINDINGS.length; i++) {
      var el = document.getElementById(BINDINGS[i].id);
      if (!el) continue;
      var s = BINDINGS[i].helper(frame);
      if (s.opacity !== undefined) el.style.opacity = s.opacity;
      if (s.transform !== undefined) el.style.transform = s.transform;
    }
  }
  function bindToTimeline() {
    var db = window.__dreambyte;
    if (!db || typeof db.onTick !== 'function') return false;
    db.onTick(function (t) { applyAt(Math.round(t * FPS)); });
    return true;
  }
  if (!bindToTimeline()) {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (bindToTimeline() || attempts > 50) clearInterval(poll);
    }, 50);
  }
  // Hook for export modes that drive frames directly
  var prevApply = window.__dreambyteApplyMotion;
  window.__dreambyteApplyMotion = function (f) { if (prevApply) prevApply(f); applyAt(f); };
  applyAt(0);
})();
<\/script>`
}

function generateAILayersHTML(
  layers: AILayer[] | undefined,
  audioSettings?: AudioSettings | null,
  dims: ProjectDimensions = DEFAULT_DIMENSIONS,
): string {
  if (!layers || layers.length === 0) return ''

  return layers
    .map((layer) => {
      // Errored layers render a small unobtrusive badge instead of nothing,
      // so a failed generation is visible in the canvas (was: silently dropped).
      if (layer.status === 'error') return generateErroredLayerHTML(layer)
      if (layer.status !== 'ready') return ''
      switch (layer.type) {
        case 'avatar':
          return generateAvatarLayerHTML(layer as AvatarLayer)
        case 'veo3':
          return generateVeo3LayerHTML(layer as Veo3Layer, dims)
        case 'image':
          return generateImageLayerHTML(layer as ImageLayer)
        case 'sticker':
          return generateStickerLayerHTML(layer as StickerLayer)
        default:
          return ''
      }
    })
    .join('\n  ')
}

/**
 * A small, unobtrusive error chip for a layer whose generation failed.
 * Replaces the previous behavior (errored layers rendered as nothing, so a
 * failure was invisible in the canvas). Positioned top-left, low z so it never
 * dominates the scene; labeled by the layer kind.
 */
function generateErroredLayerHTML(layer: AILayer): string {
  const kind =
    layer.type === 'veo3'
      ? 'AI video'
      : layer.type === 'avatar'
        ? 'Avatar'
        : layer.type === 'image'
          ? 'Image'
          : layer.type === 'sticker'
            ? 'Sticker'
            : 'Layer'
  return `<div id="${layer.id}-error" class="dreambyte-layer dreambyte-layer-error" style="position:absolute;left:24px;top:24px;z-index:9990;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:10px;background:rgba(40,12,12,0.82);border:1px solid rgba(255,90,90,0.5);color:#ffd2d2;font:600 18px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.35);">
  <span aria-hidden="true" style="font-size:18px;">⚠</span>
  <span>${kind} failed to generate</span>
</div>`
}

function generateAvatarLayerHTML(layer: AvatarLayer): string {
  const startAt = layer.startAt ?? 0
  const placement = layer.avatarPlacement
  const ns = layer.narrationScript
  const pipShape = ns?.pipShape ?? 'circle'
  const containerEnabled = ns?.containerEnabled !== false
  const avatarScale = ns?.avatarScale ?? 1.15

  // Determine positioning based on placement
  const posStyle = getAvatarPlacementCSS(placement, ns?.pipSize, pipShape, containerEnabled)

  if (usesRemovedLocalAvatar(layer)) {
    return `<div id="${layer.id}" class="dreambyte-layer" style="z-index:${layer.zIndex};${posStyle.container}">${removedLocalAvatarPlaceholderHTML()}</div>`
  }

  if (!layer.videoUrl) return ''
  const videoStyle = `${posStyle.media}transform:scale(${avatarScale});transform-origin:center bottom;`

  return `<div id="${layer.id}" class="dreambyte-layer" style="opacity:${layer.opacity};z-index:${layer.zIndex};${posStyle.container}">
  <video
    id="${layer.id}-video"
    style="${videoStyle}"
    src="${layer.videoUrl}"
    playsinline
    muted>
  </video>
  <script>
    // Sync avatar video to the master timeline (no autoplay; seeks don't start it)
    window.addEventListener('load', function() {
      var v = document.getElementById('${layer.id}-video');
      if (!v || !window.__tl) return;
      window.__tl.call(function() { if (window.__clock && window.__clock.isActive()) v.play(); }, ${startAt});
    });
  </script>
</div>`
}

function getAvatarPlacementCSS(
  placement?: string,
  pipSize?: number,
  pipShape?: string,
  containerEnabled: boolean = true,
): { container: string; media: string } {
  if (placement === 'fullscreen') {
    return {
      container: 'position:absolute;inset:0;',
      media: 'width:100%;height:100%;object-fit:cover;',
    }
  }
  if (placement === 'fullscreen_left') {
    return {
      container: 'position:absolute;left:0;bottom:0;width:40%;height:100%;',
      media: 'width:100%;height:100%;object-fit:cover;',
    }
  }
  if (placement === 'fullscreen_right') {
    return {
      container: 'position:absolute;right:0;bottom:0;width:40%;height:100%;',
      media: 'width:100%;height:100%;object-fit:cover;',
    }
  }

  const pipPositions: Record<string, string> = {
    pip_bottom_right: 'bottom:40px;right:40px;',
    pip_bottom_left: 'bottom:40px;left:40px;',
    pip_top_right: 'top:40px;right:40px;',
  }
  const pos = pipPositions[placement ?? 'pip_bottom_right'] ?? pipPositions.pip_bottom_right
  const size = pipSize ?? 280
  const radius = pipShape === 'square' ? '0' : pipShape === 'rounded' ? '16px' : '50%'
  const containerChrome = containerEnabled
    ? 'overflow:hidden;border:3px solid rgba(255,255,255,0.3);box-shadow:0 8px 32px rgba(0,0,0,0.4);'
    : 'overflow:visible;border:none;box-shadow:none;background:transparent;'

  return {
    container: `position:absolute;${pos}width:${size}px;height:${size}px;border-radius:${radius};${containerChrome}`,
    media: 'width:100%;height:100%;object-fit:cover;',
  }
}

/** Shown in place of an avatar whose local 3D model was removed (see src/lib/avatar/removed-local-avatar.ts). */
function removedLocalAvatarPlaceholderHTML(): string {
  return `<div class="dreambyte-removed-avatar" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;text-align:center;background:rgba(20,20,28,0.85);color:#e5e5ea;font:600 16px/1.3 system-ui,-apple-system,sans-serif;">${REMOVED_LOCAL_AVATAR_MESSAGE}</div>`
}

function generateVeo3LayerHTML(layer: Veo3Layer, dims: ProjectDimensions = DEFAULT_DIMENSIONS): string {
  if (!layer.videoUrl) return ''
  const startAt = layer.startAt ?? 0
  // Defense-in-depth: a legacy/in-flight layer may still be 0×0 — fall back
  // to a full-frame contain-fit box so it's never invisible. Center is canon
  // (matches images + pixi export); resolve the center, translating legacy
  // top-left coords at render time (pure — see veo3-geometry.ts).
  const size = veo3DimsAreFalsy(layer)
    ? computeVeo3FullFrameDims(layer.aspectRatio, dims)
    : { width: layer.width, height: layer.height }
  const { cx, cy } = resolveVeo3CenterCoords({
    x: layer.x,
    y: layer.y,
    width: size.width,
    height: size.height,
    anchorVersion: layer.anchorVersion,
  })
  const left = cx - size.width / 2
  const top = cy - size.height / 2
  return `<div id="${layer.id}" class="dreambyte-layer" style="opacity:${layer.opacity};z-index:${layer.zIndex};position:absolute;inset:0;">
  <video
    id="${layer.id}-video"
    style="position:absolute;left:${left}px;top:${top}px;width:${size.width}px;height:${size.height}px;object-fit:cover;"
    src="${layer.videoUrl}"
    playsinline
    muted
    ${layer.loop ? 'loop' : ''}>
  </video>
  <script>
    // Sync veo3 video to the master timeline (no autoplay; seeks don't start it)
    window.addEventListener('load', function() {
      var v = document.getElementById('${layer.id}-video');
      if (!v || !window.__tl) return;
      v.playbackRate = ${layer.playbackRate ?? 1};
      window.__tl.call(function() { if (window.__clock && window.__clock.isActive()) v.play(); }, ${startAt});
    });
  </script>
</div>`
}

/** Generate the master-timeline (anime.js) animation script for an AI layer */
function generateLayerAnimationScript(
  layerId: string,
  imgId: string,
  anim: import('./types').LayerAnimation | undefined,
  startAt: number,
): string {
  if (!anim || anim.type === 'none') return ''

  const ease =
    anim.easing === 'linear'
      ? 'linear'
      : anim.easing === 'ease-in'
        ? 'inCubic'
        : anim.easing === 'ease-in-out'
          ? 'inOutCubic'
          : 'outCubic'
  const delay = startAt + (anim.delay ?? 0)
  const dur = anim.duration ?? 0.5

  // Map animation types to explicit from→to tween params (initial = the CSS
  // state before the tween starts)
  const animMap: Record<string, { initial: string; props: string }> = {
    'fade-in': { initial: 'opacity:0;', props: `opacity:[0,1], duration:${dur}, ease:'${ease}'` },
    'fade-out': { initial: '', props: `opacity:[1,0], duration:${dur}, ease:'${ease}'` },
    'slide-left': {
      initial: 'opacity:0;transform:translateX(100px);',
      props: `opacity:[0,1], x:[100,0], duration:${dur}, ease:'${ease}'`,
    },
    'slide-right': {
      initial: 'opacity:0;transform:translateX(-100px);',
      props: `opacity:[0,1], x:[-100,0], duration:${dur}, ease:'${ease}'`,
    },
    'slide-up': {
      initial: 'opacity:0;transform:translateY(60px);',
      props: `opacity:[0,1], y:[60,0], duration:${dur}, ease:'${ease}'`,
    },
    'slide-down': {
      initial: 'opacity:0;transform:translateY(-60px);',
      props: `opacity:[0,1], y:[-60,0], duration:${dur}, ease:'${ease}'`,
    },
    'scale-in': {
      initial: 'opacity:0;transform:scale(0);',
      props: `opacity:[0,1], scale:[0,1], duration:${dur}, ease:'${ease}'`,
    },
    'scale-out': { initial: '', props: `opacity:[1,0], scale:[1,0], duration:${dur}, ease:'${ease}'` },
    'spin-in': {
      initial: 'opacity:0;transform:rotate(-180deg) scale(0);',
      props: `opacity:[0,1], rotate:[-180,0], scale:[0,1], duration:${dur}, ease:'${ease}'`,
    },
  }

  const config = animMap[anim.type]
  if (!config) return ''

  return `<script>
    window.addEventListener('load', function() {
      var el = document.getElementById('${imgId}');
      if (!el || !window.__tl) return;
      window.__tl.add(el, { ${config.props} }, ${delay});
    });
  </script>`
}

function generateImageLayerHTML(layer: ImageLayer): string {
  if (!layer.imageUrl) return ''
  // Look (layer.filter CSS) + advanced correction (colorGrade → CSS chain and,
  // when temp/tint/curves are in play, an SVG filter def referenced by url()).
  const gradeFilterId = `grade-${layer.id}`
  const gradeSvg = gradeSvgFilterMarkup(layer.colorGrade, gradeFilterId)
  const cssChain = gradeToCssChain(layer.colorGrade, {
    lookCss: layer.filter ?? '',
    svgFilterId: gradeSvg ? gradeFilterId : null,
  })
  const filterCSS = cssChain ? `filter:${cssChain.replace(/[<>{}]/g, '')};` : ''
  const anim = layer.animation
  const initialStyle = anim && anim.type !== 'none' ? getAnimInitialStyle(anim.type) : ''
  const cropStyle =
    (layer as any).cropX != null
      ? `object-fit:cover;object-position:${(layer as any).cropX}% ${(layer as any).cropY ?? 50}%;overflow:hidden;`
      : 'object-fit:contain;'
  const imgId = `${layer.id}-img`

  return `<div id="${layer.id}" class="dreambyte-layer" style="opacity:${layer.opacity};z-index:${layer.zIndex};position:absolute;inset:0;">
  ${gradeSvg ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${gradeSvg}</svg>` : ''}
  ${vignetteOverlayHTML(layer.colorGrade)}
  <img
    id="${imgId}"
    src="${layer.imageUrl}"
    style="position:absolute;left:${layer.x - layer.width / 2}px;top:${layer.y - layer.height / 2}px;width:${layer.width}px;height:${layer.height}px;transform:rotate(${layer.rotation}deg);${cropStyle}${filterCSS}${initialStyle}"
  >
  ${generateLayerAnimationScript(layer.id, imgId, anim, layer.startAt ?? 0)}
</div>`
}

function getAnimInitialStyle(type: string): string {
  const map: Record<string, string> = {
    'fade-in': 'opacity:0;',
    'slide-left': 'opacity:0;transform:translateX(100px);',
    'slide-right': 'opacity:0;transform:translateX(-100px);',
    'slide-up': 'opacity:0;transform:translateY(60px);',
    'slide-down': 'opacity:0;transform:translateY(-60px);',
    'scale-in': 'opacity:0;transform:scale(0);',
    'spin-in': 'opacity:0;transform:rotate(-180deg) scale(0);',
  }
  return map[type] ?? ''
}

function generateStickerLayerHTML(layer: StickerLayer): string {
  const src = layer.stickerUrl ?? layer.imageUrl
  if (!src) return ''
  const filterCSS = layer.filter ? `filter:${layer.filter};` : ''
  const imgId = `${layer.id}-img`

  // Use new animation system if set, otherwise fall back to legacy animateIn
  const anim = layer.animation
  const hasNewAnim = anim && anim.type !== 'none'
  const initialStyle = hasNewAnim
    ? getAnimInitialStyle(anim.type)
    : layer.animateIn
      ? 'opacity:0;transform:scale(0.5);'
      : ''

  return `<div id="${layer.id}" class="dreambyte-layer" style="opacity:${layer.opacity};z-index:${layer.zIndex};position:absolute;inset:0;">
  <img
    id="${imgId}"
    src="${src}"
    style="position:absolute;left:${layer.x - layer.width / 2}px;top:${layer.y - layer.height / 2}px;width:${layer.width}px;height:${layer.height}px;transform:rotate(${layer.rotation}deg);object-fit:contain;${filterCSS}${initialStyle}"
  >
  ${
    hasNewAnim
      ? generateLayerAnimationScript(layer.id, imgId, anim, layer.startAt ?? 0)
      : layer.animateIn
        ? `<script>
    window.addEventListener('load', function() {
      var img = document.getElementById('${imgId}');
      if (!img || !window.__tl) return;
      window.__tl.add(img, {
        opacity: [0, 1],
        scale: [0.5, 1],
        duration: 0.4,
        ease: 'outCubic',
      }, ${layer.startAt ?? 0});
    });
  </script>`
        : ''
  }
</div>`
}

function generateCanvasHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const { canvasCode = '' } = scene
  const useTexture = style.textureStyle !== 'none'
  const useRoughJs = style.roughnessLevel > 0
  const sceneHash = hashString(scene.id)

  const audioHTML = generateAudioHTML(scene.audioLayer)
  const motionRuntimeHTML = generateMotionRuntimeScript(scene.aiLayers, 30)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  ${buildSceneFontLinks(style)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      transform-origin: top left;
      ${buildBgStyleCSS(style)}
    }
    #scene-camera {
      position: absolute;
      inset: 0;
      width: ${W}px;
      height: ${H}px;
      overflow: hidden;
      transform-origin: center center;
      will-change: transform, filter;
    }
    canvas {
      display: block;
      position: absolute;
      left: 0;
      top: 0;
      width: ${W}px;
      height: ${H}px;
      margin: 0;
      padding: 0;
      border: 0;
    }
  </style>
  ${useRoughJs ? `<script src="https://unpkg.com/roughjs@4.6.6/bundled/rough.js"></script>` : ''}
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>
</head>
<body>
  <div id="scene-camera">
  <canvas id="c" width="${W}" height="${H}"></canvas>
  <canvas id="texture-canvas" width="${W}" height="${H}"
    style="display:${useTexture ? 'block' : 'none'}; position:absolute; inset:0; pointer-events:none;
           mix-blend-mode:${style.textureBlendMode}; opacity:${style.textureIntensity};"></canvas>
  ${audioHTML}

  <script>
    // ── Scene globals ─────────────────────────────────────
    var SCENE_ID     = '${escapeJsString(scene.id)}';
    var PALETTE      = ${JSON.stringify(style.palette)};
    var DURATION     = ${scene.duration};
    var ROUGHNESS    = ${style.roughnessLevel};
    var FONT         = '${style.font}';
    var BODY_FONT    = '${style.bodyFont || style.font}';
    var WIDTH        = ${W};
    var HEIGHT       = ${H};
    var TOOL         = '${style.defaultTool}';
    var STROKE_COLOR = '${style.strokeColor}';

    // Seeded random
    function mulberry32(seed) {
      return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      }
    }

    // Audio volume is handled by the playback controller
  </script>

  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}

  </div><!-- /scene-camera -->
  ${motionRuntimeHTML}

  <script>
${CANVAS_RENDERER_CODE}
  </script>

  <!-- playback-controller-slot -->

  <script>
${canvasCode}
  </script>

  <script>
    // ── Automatic texture overlay ─────────────────────────
    ${
      useTexture
        ? `
    (function applyTextureOverlay() {
      const textureCanvas = document.getElementById('texture-canvas');
      if (!textureCanvas) return;
      const ctx = textureCanvas.getContext('2d');
      function mulberry32(seed) {
        return function() {
          seed |= 0; seed = seed + 0x6D2B79F5 | 0;
          let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
          t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
      }
      const rand = mulberry32(${sceneHash});

      ${
        style.textureStyle === 'grain'
          ? `
        const imageData = ctx.createImageData(${W}, ${H});
        for (let i = 0; i < imageData.data.length; i += 4) {
          const noise = rand() * 255;
          imageData.data[i]   = noise;
          imageData.data[i+1] = noise;
          imageData.data[i+2] = noise;
          imageData.data[i+3] = rand() * 255;
        }
        ctx.putImageData(imageData, 0, 0);
      `
          : ''
      }

      ${
        style.textureStyle === 'paper'
          ? `
        for (let x = 0; x < ${W}; x += 1.5) {
          for (let y = 0; y < ${H}; y += 1.5) {
            const v = rand();
            ctx.fillStyle = \`rgba(0,0,0,\${v})\`;
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      `
          : ''
      }

      ${
        style.textureStyle === 'chalk'
          ? `
        for (let y = 0; y < ${H}; y += 2) {
          ctx.beginPath();
          ctx.strokeStyle = \`rgba(255,255,255,\${rand() * 0.3})\`;
          ctx.lineWidth = 1 + rand() * 2;
          ctx.moveTo(0, y + rand() * 2);
          for (let x = 0; x < ${W}; x += 20) {
            ctx.lineTo(x, y + (rand() - 0.5) * 4);
          }
          ctx.stroke();
        }
      `
          : ''
      }

      ${
        style.textureStyle === 'lines'
          ? `
        for (let y = 0; y < ${H}; y += 28) {
          ctx.beginPath();
          ctx.strokeStyle = \`rgba(0,0,0,0.06)\`;
          ctx.lineWidth = 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(${W}, y);
          ctx.stroke();
        }
      `
          : ''
      }
    })();
    `
        : '// No texture overlay for this style preset'
    }
  </script>
</body>
</html>`
}

function generateMotionHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const { sceneCode = '', sceneHTML = '', sceneStyles = '' } = scene

  const audioHTML = generateAudioHTML(scene.audioLayer)
  const fixedStage = sceneUsesCanvasBackground(scene)
  // W1 motion runtime — same applier pattern as React scenes; subscribes to the
  // shared scene clock. Adapters that emit JSX-only would diverge later.
  const motionRuntimeHTML = generateMotionRuntimeScript(scene.aiLayers, 30)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${buildSceneFontLinks(style)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    ${
      fixedStage
        ? `html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      transform-origin: top left;
      ${buildBgStyleCSS(style)}
    }
    #scene-camera {
      position: absolute;
      left: 0;
      top: 0;
      width: ${W}px;
      height: ${H}px;
      overflow: hidden;
      transform-origin: center center;
      will-change: transform, filter;
    }`
        : `html, body { width: 100%; height: 100vh; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      ${buildBgStyleCSS(style)}
    }
    #scene-camera {
      position: absolute;
      inset: 0;
      transform-origin: center center;
      will-change: transform, filter;
    }`
    }
    ${sanitizeCssBlock(sceneStyles)}
  </style>
  ${
    fixedStage
      ? `<script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>`
      : ''
  }
</head>
<body>
  <div id="scene-camera"${fixedStage ? '' : ' style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;"'}>
  ${sceneUsesCanvasBackground(scene) ? `${canvasBgTag(W, H)}<div id="motion-foreground" style="position:absolute;inset:0;z-index:1;width:100%;height:100%;overflow:hidden;">` : ''}
  ${sceneHTML}
  ${sceneUsesCanvasBackground(scene) ? `</div>` : ''}
  ${audioHTML}
  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div><!-- /scene-camera -->
  ${motionRuntimeHTML}

  <script>
    var SCENE_ID     = '${escapeJsString(scene.id)}';
    var PALETTE      = ${JSON.stringify(style.palette)};
    var DURATION     = ${scene.duration};
    var ROUGHNESS    = ${style.roughnessLevel};
    var FONT         = '${style.font}';
    var BODY_FONT    = '${style.bodyFont || style.font}';
    var STROKE_COLOR = '${style.strokeColor}';
    var BG_COLOR     = '${style.bgColor}';
    var WIDTH        = ${W};
    var HEIGHT       = ${H};

    // Audio volume is handled by the playback controller
  </script>

  <!-- playback-controller-slot -->

  <script type="module">
    ${sceneCode}
  </script>
</body>
</html>`
}

function generateD3HTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const { sceneCode = '', sceneStyles = '', d3Data = null } = scene
  const needsPlotly = chartLayersUsePlotly(scene.chartLayers)
  const needsRecharts = chartLayersUseRecharts(scene.chartLayers)
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080

  const audioHTML = generateAudioHTML(scene.audioLayer)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${
    needsRecharts
      ? `<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
  }
}
</script>`
      : ''
  }
  ${buildSceneFontLinks(style)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      transform-origin: top left;
      ${buildBgStyleCSS(style)}
    }
    #scene-camera {
      position: absolute;
      left: 0;
      top: 0;
      width: ${W}px;
      height: ${H}px;
      overflow: hidden;
      transform-origin: center center;
      will-change: transform, filter;
    }
    #chart { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; }
    ${
      needsRecharts
        ? `[data-dreambyte-recharts] { box-sizing: border-box; }
    [data-dreambyte-recharts] .recharts-cartesian-grid line { stroke: var(--dreambyte-recharts-grid, rgba(255,255,255,0.08)); }
    [data-dreambyte-recharts] .recharts-default-legend { color: var(--dreambyte-recharts-tick, rgba(232,228,220,0.75)); }`
        : ''
    }
    ${sanitizeCssBlock(sceneStyles)}
  </style>
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>
</head>
<body>
  <div id="scene-camera">
  ${sceneUsesCanvasBackground(scene) ? canvasBgTag(W, H) : ''}
  <div id="chart"></div>
  ${audioHTML}
  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div><!-- /scene-camera -->

  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
  <script src="/sdk/dreambyte-charts.js"></script>
  ${needsPlotly ? '<script src="https://cdn.plot.ly/plotly-3.4.0.min.js" charset="utf-8"></script>' : ''}
  <script>
    var SCENE_ID     = '${escapeJsString(scene.id)}';
    var DATA = ${JSON.stringify(d3Data)};
    var WIDTH = ${W}, HEIGHT = ${H};
    var PALETTE      = ${JSON.stringify(style.palette)};
    var DURATION     = ${scene.duration};
    var FONT         = '${style.font}';
    var BODY_FONT    = '${style.bodyFont || style.font}';
    var STROKE_COLOR = '${style.strokeColor}';
    var AXIS_COLOR   = '${style.axisColor}';
    var GRID_COLOR   = '${style.gridColor}';
    ${
      needsRecharts
        ? `(function () {
      var root = document.documentElement;
      var p = PALETTE || [];
      for (var i = 0; i < 5; i++) {
        if (p[i]) root.style.setProperty('--chart-' + (i + 1), p[i]);
      }
      root.style.setProperty('--dreambyte-font', FONT || 'system-ui, sans-serif');
      root.style.setProperty('--dreambyte-recharts-tick', AXIS_COLOR || 'rgba(232,228,220,0.65)');
      root.style.setProperty('--dreambyte-recharts-grid', GRID_COLOR || 'rgba(255,255,255,0.08)');
      root.style.setProperty('--dreambyte-recharts-title', 'rgba(240,236,224,0.95)');
    })();`
        : ''
    }

    // Audio volume is handled by the playback controller
  </script>

  <!-- playback-controller-slot -->

  <script>
    ${sceneCode}
  </script>
  ${
    needsRecharts
      ? `<script type="module">
  import { mountDreambyteRechartsLayers } from '/sdk/dreambyte-recharts-scene.mjs';
  mountDreambyteRechartsLayers().catch(function (e) { console.warn('[dreambyte-recharts]', e); });
</script>`
      : ''
  }
</body>
</html>`
}

function generateThreeHTML(
  scene: Scene,
  style?: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const { sceneCode = '' } = scene
  const effectiveBgColor = style?.bgColor ?? scene.bgColor ?? '#fffef9'
  const palette = JSON.stringify(style?.palette ?? ['#1a1a2e', '#e84545', '#16a34a', '#2563eb'])
  const duration = scene.duration ?? 8
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080

  const audioHTML = generateAudioHTML(scene.audioLayer)
  // Three.js aiLayers are DOM overlays (avatar/image/sticker) — same CSS
  // transform shell as the other scene types. Animating Object3Ds inside
  // the Three scene graph would be a separate layer kind, not in scope.
  const motionRuntimeHTML = generateMotionRuntimeScript(scene.aiLayers, 30)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.183.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.183.0/examples/jsm/",
      "three/examples/jsm/": "https://unpkg.com/three@0.183.0/examples/jsm/",
      "@pmndrs/vanilla": "https://esm.sh/@pmndrs/vanilla@1.25.0?external=three",
      "troika-three-text": "/vendor/troika-three-text.esm.js",
      "three-bvh-csg": "/vendor/three-bvh-csg.esm.js"
    }
  }
  </script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${effectiveBgColor};
      transform-origin: top left;
    }
    canvas { display: block; }
  </style>
  <script>
    // Scale ${W}x${H} body to fit the actual viewport
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);

    // Force preserveDrawingBuffer so export can read WebGL canvas via drawImage.
    // Without this, the buffer is cleared after compositing and reads return blank.
    // Applied unconditionally — perf cost is negligible at ${W}x${H}.
    (function() {
      var origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        if (type === 'webgl' || type === 'webgl2') {
          attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        }
        return origGetContext.call(this, type, attrs);
      };
    })();

    // Globals accessible from module scope via window.*
    window.WIDTH = ${W};
    window.HEIGHT = ${H};
    window.PALETTE = ${palette};
    window.DURATION = ${duration};
    window.SCENE_ID = '${escapeJsString(scene.id)}';

    window.MATERIALS = {
      plastic: function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.6, metalness: 0 }); },
      metal:   function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.2, metalness: 0.9 }); },
      glass:   function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), transparent: true, opacity: 0.3, roughness: 0, transmission: 0.9 }); },
      matte:   function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 1, metalness: 0 }); },
      glow:    function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), emissive: new T.Color(c), emissiveIntensity: 0.8 }); },
      clearcoat: function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), clearcoat: 1.0, clearcoatRoughness: 0.1, roughness: 0.3, metalness: 0.5 }); },
      iridescent: function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), iridescence: 1.0, iridescenceIOR: 1.5, roughness: 0.2, metalness: 0.8 }); },
      velvet: function(c) { var T = window.THREE; return new T.MeshPhysicalMaterial({ color: new T.Color(c), sheen: 1.0, sheenRoughness: 0.8, sheenColor: new T.Color(c), roughness: 0.9 }); },
      lowpoly: function(c) { var T = window.THREE; return new T.MeshStandardMaterial({ color: new T.Color(c), roughness: 0.7, metalness: 0, flatShading: true }); },
      // ── Shader materials (require updateShaderMaterials(scene, t) each frame) ──
      hologram: function(c, opts) {
        var T = window.THREE; opts = opts || {};
        return new T.ShaderMaterial({
          uniforms: {
            color:    { value: new T.Color(c || '#00ffaa') },
            time:     { value: 0 },
            opacity:  { value: opts.opacity !== undefined ? opts.opacity : 0.88 },
            scanFreq: { value: opts.scanFreq || 22 },
            rimPow:   { value: opts.rimPow   || 2.5 },
          },
          vertexShader: [
            'varying vec3 vNormal; varying vec3 vWorldPos;',
            'void main() {',
            '  vNormal = normalize(normalMatrix * normal);',
            '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
            '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
            '}'
          ].join('\\n'),
          fragmentShader: [
            'uniform vec3 color; uniform float time; uniform float opacity;',
            'uniform float scanFreq; uniform float rimPow;',
            'varying vec3 vNormal; varying vec3 vWorldPos;',
            'void main() {',
            '  vec3 viewDir = normalize(cameraPosition - vWorldPos);',
            '  float rim = 1.0 - abs(dot(normalize(vNormal), viewDir));',
            '  rim = pow(rim, rimPow);',
            '  float scan = sin(vWorldPos.y * scanFreq - time * 3.2) * 0.5 + 0.5;',
            '  scan = pow(scan, 4.0) * 0.38 + 0.62;',
            '  float flicker = sin(time * 11.7) * 0.035 + 0.965;',
            '  vec3 col = color * (rim * 0.75 + 0.25) * scan * flicker;',
            '  float alpha = (rim * 0.72 + 0.28) * opacity * scan * flicker;',
            '  gl_FragColor = vec4(col, alpha);',
            '}'
          ].join('\\n'),
          transparent: true, side: T.FrontSide, depthWrite: false,
        });
      },
      xray: function(c, opts) {
        var T = window.THREE; opts = opts || {};
        return new T.ShaderMaterial({
          uniforms: {
            color:   { value: new T.Color(c || '#88ccff') },
            power:   { value: opts.power   || 3.0 },
            opacity: { value: opts.opacity || 0.75 },
          },
          vertexShader: [
            'varying vec3 vNormal; varying vec3 vViewPos;',
            'void main() {',
            '  vNormal = normalize(normalMatrix * normal);',
            '  vec4 vp = modelViewMatrix * vec4(position, 1.0);',
            '  vViewPos = vp.xyz;',
            '  gl_Position = projectionMatrix * vp;',
            '}'
          ].join('\\n'),
          fragmentShader: [
            'uniform vec3 color; uniform float power; uniform float opacity;',
            'varying vec3 vNormal; varying vec3 vViewPos;',
            'void main() {',
            '  float rim = abs(dot(normalize(vNormal), normalize(-vViewPos)));',
            '  rim = pow(1.0 - rim, power);',
            '  gl_FragColor = vec4(color, rim * opacity);',
            '}'
          ].join('\\n'),
          transparent: true, side: T.DoubleSide, depthWrite: false,
        });
      },
      pulse: function(c, opts) {
        var T = window.THREE; opts = opts || {};
        return new T.ShaderMaterial({
          uniforms: {
            color:   { value: new T.Color(c) },
            time:    { value: 0 },
            speed:   { value: opts.speed || 2.0 },
            minI:    { value: opts.min   || 0.35 },
            maxI:    { value: opts.max   || 1.0 },
          },
          vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: [
            'uniform vec3 color; uniform float time, speed, minI, maxI;',
            'void main() {',
            '  float p = sin(time * speed) * 0.5 + 0.5;',
            '  gl_FragColor = vec4(color * mix(minI, maxI, p), 1.0);',
            '}'
          ].join('\\n'),
        });
      },
      fresnel: function(c, rimColor, opts) {
        var T = window.THREE; opts = opts || {};
        return new T.ShaderMaterial({
          uniforms: {
            baseColor: { value: new T.Color(c) },
            rimColor:  { value: new T.Color(rimColor || '#ffffff') },
            power:     { value: opts.power || 2.0 },
            rimStrength: { value: opts.rimStrength || 1.0 },
          },
          vertexShader: [
            'varying vec3 vNormal; varying vec3 vViewDir;',
            'void main() {',
            '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
            '  vNormal = normalize(normalMatrix * normal);',
            '  vViewDir = normalize(-mvPos.xyz);',
            '  gl_Position = projectionMatrix * mvPos;',
            '}'
          ].join('\\n'),
          fragmentShader: [
            'uniform vec3 baseColor, rimColor; uniform float power, rimStrength;',
            'varying vec3 vNormal, vViewDir;',
            'void main() {',
            '  float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), power);',
            '  vec3 col = mix(baseColor, rimColor, fresnel * rimStrength);',
            '  gl_FragColor = vec4(col, 1.0);',
            '}'
          ].join('\\n'),
        });
      },
    };

    window.mulberry32 = function(seed) {
      return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    };
  </script>
  <!-- UMD Three.js r160 — sets window.THREE synchronously so the IIFE shader
       libs below can read THREE.ShaderChunk at evaluation time. The user's
       scene module imports ESM Three via the importmap; that overrides
       window.THREE with 0.183 by the time scene code runs. The libs only
       use THREE.ShaderChunk at init (one-time string lookup) — no version
       mismatch issue at runtime. -->
  <script src="https://unpkg.com/three@0.160.0/build/three.min.js"><\/script>
  <!-- Shader extension libs (IIFE bundles; require window.THREE at eval). -->
  <script src="/vendor/three-custom-shader-material.js"><\/script>
  <script src="/vendor/enhance-shader-lighting.js"><\/script>
  <script src="/vendor/three-csm.js"><\/script>
  <script>
    if (window.ThreeCSM && window.ThreeCSM.default) window.CustomShaderMaterial = window.ThreeCSM.default;
    else if (window.ThreeCSM) window.CustomShaderMaterial = window.ThreeCSM;
    if (window.EnhanceShaderLighting && window.EnhanceShaderLighting.default) window.enhanceShaderLighting = window.EnhanceShaderLighting.default;
    else if (window.EnhanceShaderLighting) window.enhanceShaderLighting = window.EnhanceShaderLighting;
    if (window.ThreeCSMLib && window.ThreeCSMLib.CSM) window.CSM = window.ThreeCSMLib.CSM;
  <\/script>
  <!-- Studio3D SDK: window.buildExtrudedText, buildExtrudedSVG, TEXT_EFFECTS, etc. -->
  <script src="/sdk/dreambyte-studio3d.js?v=${Date.now()}"><\/script>
</head>
<body>
  <div id="scene-camera" style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;">
  ${audioHTML}
  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div><!-- /scene-camera -->
  ${motionRuntimeHTML}

  <!-- playback-controller-slot -->

  <!-- Template setup: import THREE, define globals + setupEnvironment on window -->
  <script type="module">
    import * as THREE from 'three';
    import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
    import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
    import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
    import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
    import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
    import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
    import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';
    import { GlitchPass } from 'three/addons/postprocessing/GlitchPass.js';
    import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
    import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
    import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
    import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
    import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
    window.THREE = THREE;
    // Expose SVGLoader for the studio3D SDK (window.buildExtrudedSVG uses it).
    window.SVGLoader = SVGLoader;

    // Studio environment map for PBR materials. Loads a real HDRI when available,
    // falls back to a procedural sky+panels scene if the file 404s. The procedural
    // path also runs synchronously so first-frame renders aren't unlit while the
    // HDRI is in flight.
    window.setupEnvironment = function(targetScene, renderer, opts) {
      opts = opts || {};
      const hdriUrl = opts.hdriUrl !== undefined ? opts.hdriUrl : '/vendor/hdri/studio_small_03_1k.hdr';

      // Procedural baseline (always runs first so materials have *some* env).
      try {
        const pmrem0 = new THREE.PMREMGenerator(renderer);
        const envScene = new THREE.Scene();
        const skyGeo = new THREE.SphereGeometry(50, 32, 16);
        const skyMat = new THREE.ShaderMaterial({
          side: THREE.BackSide,
          uniforms: {
            topColor:    { value: new THREE.Color(0xddeeff) },
            bottomColor: { value: new THREE.Color(0xfff8f0) },
          },
          vertexShader: \`varying vec3 vWorldPos;
            void main() { vec4 wp = modelMatrix * vec4(position, 1.0);
              vWorldPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }\`,
          fragmentShader: \`uniform vec3 topColor; uniform vec3 bottomColor;
            varying vec3 vWorldPos;
            void main() { float h = normalize(vWorldPos).y * 0.5 + 0.5;
              gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0); }\`,
        });
        envScene.add(new THREE.Mesh(skyGeo, skyMat));
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(8, 4),
          new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
        panel.position.set(-6, 8, 5); panel.lookAt(0, 0, 0); envScene.add(panel);
        const fillPanel = new THREE.Mesh(new THREE.PlaneGeometry(6, 3),
          new THREE.MeshBasicMaterial({ color: 0xe0e8ff, side: THREE.DoubleSide }));
        fillPanel.position.set(7, 3, 3); fillPanel.lookAt(0, 0, 0); envScene.add(fillPanel);
        targetScene.environment = pmrem0.fromScene(envScene, 0.04).texture;
        pmrem0.dispose();
        envScene.clear();
      } catch(e) {
        console.warn('setupEnvironment procedural fallback failed:', e);
      }

      // Upgrade to a real HDRI when available. Scene materials read scene.environment
      // every frame, so swapping in flight is safe — bevels suddenly read correctly
      // once the HDR finishes loading.
      if (hdriUrl) {
        try {
          new RGBELoader().load(hdriUrl, function(tex) {
            try {
              tex.mapping = THREE.EquirectangularReflectionMapping;
              const pmrem = new THREE.PMREMGenerator(renderer);
              const envMap = pmrem.fromEquirectangular(tex).texture;
              targetScene.environment = envMap;
              pmrem.dispose();
              tex.dispose();
            } catch(e) { console.warn('setupEnvironment: HDRI PMREM failed:', e); }
          }, undefined, function() { /* fallback already in place */ });
        } catch(e) { console.warn('setupEnvironment: RGBELoader unavailable:', e); }
      }
    };

    // Safe post-processing wrapper — SYNCHRONOUS, no .then() needed.
    // Scene code calls: const pp = createPostProcessing(renderer, scene, camera, { bloom: 0.3 })
    // Then in animation loop: pp.render() instead of renderer.render(scene, camera)
    window.createPostProcessing = function(renderer, scene, camera, opts) {
      opts = opts || {};
      try {
        var composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        if (opts.bloom !== false) {
          var strength = typeof opts.bloom === 'number' ? opts.bloom : 0.3;
          composer.addPass(new UnrealBloomPass(
            new THREE.Vector2(window.WIDTH, window.HEIGHT), strength, 0.4, 0.85
          ));
        }
        composer.addPass(new OutputPass());
        return { render: function() { composer.render(); }, composer: composer };
      } catch(e) {
        console.warn('createPostProcessing failed, using direct render:', e);
        return { render: function() { renderer.render(scene, camera); } };
      }
    };

    // Studio scene presets — one-call setup for common 3D scene configurations.
    // Scene code calls: const studio = createStudioScene('corporate')
    // Returns { scene, camera, renderer, floor, render }
    window.createStudioScene = function(style) {
      style = style || 'corporate';
      var T = THREE;
      var W = window.WIDTH, H = window.HEIGHT;
      var P = window.PALETTE;

      var renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      renderer.toneMapping = T.LinearToneMapping;
      renderer.outputColorSpace = T.SRGBColorSpace;
      document.body.appendChild(renderer.domElement);

      var scene = new T.Scene();
      var camera = new T.PerspectiveCamera(50, W / H, 0.1, 1000);
      window.__threeCamera = camera;

      var configs = {
        corporate: { camPos: [0, 3, 12], camLookAt: [0, 0, 0], exposure: 1.0, floorY: -2.5, skyTop: '#999999', skyBot: '#ffffff', floorCol: '#ffffff', gridCol: '#d0cdc8', offset: 50, exponent: 0.6 },
        playful:   { camPos: [10, 8, 10], camLookAt: [0, 0, 0], exposure: 1.0, floorY: -2,   skyTop: '#908880', skyBot: '#ffffff', floorCol: '#ffffff', gridCol: '#c8c4be', offset: 50, exponent: 0.6 },
        cinematic: { camPos: [0, 2, 14],  camLookAt: [0, 0, 0], exposure: 1.0, floorY: -3,   skyTop: '#020204', skyBot: '#0e0c14', floorCol: '#0e0c14', gridCol: '#1a1828', offset: 30, exponent: 0.5 },
        showcase:  { camPos: [0, 2, 14],  camLookAt: [0, 0, 0], exposure: 1.0, floorY: -3,   skyTop: '#06050a', skyBot: '#18141e', floorCol: '#18141e', gridCol: '#221e2a', offset: 30, exponent: 0.5 },
        tech:      { camPos: [0, 4, 14],  camLookAt: [0, 0, 0], exposure: 1.0, floorY: -3,   skyTop: '#020204', skyBot: '#080810', floorCol: '#080810', gridCol: '#1a1a28', offset: 30, exponent: 0.5 },
        sky:       { camPos: [0, 3, 12],  camLookAt: [0, 0, 0], exposure: 0.5, floorY: -2.5, skyTop: null, skyBot: null, floorCol: '#c8d8c0', gridCol: '#a0b098', offset: 0, exponent: 0 },
      };
      var c = configs[style] || configs.corporate;

      renderer.toneMappingExposure = c.exposure;
      camera.position.set(c.camPos[0], c.camPos[1], c.camPos[2]);
      camera.lookAt(c.camLookAt[0], c.camLookAt[1], c.camLookAt[2]);

      // ── Lighting (3-point studio for all styles) ──
      var isLight = (style === 'corporate' || style === 'playful');
      scene.add(new T.AmbientLight(isLight ? 0xffffff : 0x111122, isLight ? 0.3 : 0.08));
      var keyL = new T.DirectionalLight(isLight ? 0xfff6e0 : 0xffffff, isLight ? 1.0 : 0.8);
      keyL.position.set(-5, 8, 5);
      keyL.castShadow = true;
      keyL.shadow.mapSize.set(2048, 2048);
      keyL.shadow.camera.left = -15; keyL.shadow.camera.right = 15;
      keyL.shadow.camera.top = 15; keyL.shadow.camera.bottom = -15;
      keyL.shadow.bias = -0.001;
      scene.add(keyL);
      var fillL = new T.DirectionalLight(isLight ? 0xd0e8ff : 0x4444aa, isLight ? 0.35 : 0.2);
      fillL.position.set(6, 2, 4);
      scene.add(fillL);
      var rimL = new T.DirectionalLight(isLight ? 0xffe0d0 : 0xff6040, isLight ? 0.5 : 0.35);
      rimL.position.set(0, 4, -9);
      scene.add(rimL);

      // ── Sky Background ──
      var fY = c.floorY;
      if (style === 'sky') {
        import('three/addons/objects/Sky.js').then(function(mod) {
          var skySun = new mod.Sky();
          skySun.scale.setScalar(450000);
          scene.add(skySun);
          var u = skySun.material.uniforms;
          u['turbidity'].value = 10;
          u['rayleigh'].value = 2;
          u['mieCoefficient'].value = 0.005;
          u['mieDirectionalG'].value = 0.8;
          u['sunPosition'].value.set(400000, 400000, 400000);
        }).catch(function() {});
      } else {
        // Sky gradient sphere — 128 vertical segments = smooth, no banding
        var skyGeo = new T.SphereGeometry(5000, 32, 128);
        var skyVS = 'varying vec3 vWorldPosition; void main() { vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
        var skyFS = 'uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main() { float h = normalize(vWorldPosition + offset).y; gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0); }';
        var skyMat = new T.ShaderMaterial({
          uniforms: { topColor: { value: new T.Color(c.skyTop) }, bottomColor: { value: new T.Color(c.skyBot) }, offset: { value: c.offset }, exponent: { value: c.exponent } },
          vertexShader: skyVS, fragmentShader: skyFS, side: T.BackSide, depthWrite: false
        });
        scene.add(new T.Mesh(skyGeo, skyMat));
      }

      // ── Infinite Grid (inlined from Fyrestar/THREE.InfiniteGridHelper) ──
      var gridGeo = new T.PlaneGeometry(2, 2, 1, 1);
      var gridVS = 'varying vec3 worldPosition; uniform float uDistance; void main() { vec3 pos = position.xzy * uDistance; pos.xz += cameraPosition.xz; worldPosition = pos; gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0); }';
      var gridFS = 'varying vec3 worldPosition; uniform float uSize1; uniform float uSize2; uniform vec3 uColor; uniform float uDistance; float getGrid(float size) { vec2 r = worldPosition.xz / size; vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r); float line = min(grid.x, grid.y); return 1.0 - min(line, 1.0); } void main() { float d = 1.0 - min(distance(cameraPosition.xz, worldPosition.xz) / uDistance, 1.0); float g1 = getGrid(uSize1); float g2 = getGrid(uSize2); gl_FragColor = vec4(uColor.rgb, mix(g2, g1, g1) * pow(d, 3.0)); gl_FragColor.a = mix(0.5 * gl_FragColor.a, gl_FragColor.a, g2); if (gl_FragColor.a <= 0.0) discard; }';
      var gridMat = new T.ShaderMaterial({
        side: T.DoubleSide, transparent: true,
        uniforms: { uSize1: { value: 10 }, uSize2: { value: 100 }, uColor: { value: new T.Color(c.gridCol) }, uDistance: { value: 3000 } },
        vertexShader: gridVS, fragmentShader: gridFS,
        extensions: { derivatives: true }
      });
      var grid = new T.Mesh(gridGeo, gridMat);
      grid.frustumCulled = false;
      grid.position.y = fY;
      scene.add(grid);

      // ── Floor — infinite with fog blend ──
      var floorGeo = new T.PlaneGeometry(10000, 10000);
      var floorMat = new T.MeshStandardMaterial({ color: new T.Color(c.floorCol), roughness: 1.0, metalness: 0, envMapIntensity: 0.2 });
      var floor = new T.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = fY - 0.01;
      floor.receiveShadow = true;
      scene.add(floor);
      scene.fog = new T.FogExp2(new T.Color(c.skyBot), 0.003);

      // ── Environment map for PBR reflections ──
      window.setupEnvironment(scene, renderer);

      return {
        scene: scene, camera: camera, renderer: renderer, floor: floor,
        render: function() { renderer.render(scene, camera); }
      };
    };

    ${THREE_ENVIRONMENT_RUNTIME_SCRIPT}
    ${THREE_SCATTER_RUNTIME_SCRIPT}
    ${THREE_HELPERS_RUNTIME_SCRIPT}
  </script>

  <!-- Scene code: separate module so it can have its own imports at the top -->
  <script type="module">
    ${sceneCode}
  </script>
</body>
</html>`
}

function generateZdogHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const { sceneCode = '' } = scene
  const bgColor = scene.bgColor || style.bgColor || '#fffef9'
  const palette = JSON.stringify(style.palette)
  const duration = scene.duration ?? 8
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080

  const audioHTML = generateAudioHTML(scene.audioLayer)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${bgColor};
      transform-origin: top left;
    }
    canvas { display: block; }
  </style>
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>
</head>
<body>
  <div id="scene-camera" style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;">
  <canvas id="zdog-canvas" width="${W}" height="${H}"></canvas>
  ${audioHTML}
  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div><!-- /scene-camera -->

  <script src="https://unpkg.com/zdog@1/dist/zdog.dist.min.js"></script>
  <script>
    var WIDTH = ${W}, HEIGHT = ${H};
    var PALETTE = ${palette};
    var DURATION = ${duration};
    var FONT = '${style.font}';
    var BODY_FONT = '${style.bodyFont || style.font}';
    var STROKE_COLOR = '${style.strokeColor}';

    // Seeded PRNG — use mulberry32(seed)() instead of Math.random()
    function mulberry32(seed) {
      return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    var SCENE_ID = '${escapeJsString(scene.id)}';

    // Audio volume is handled by the playback controller
  </script>

  <!-- playback-controller-slot -->

  <script>
${sceneCode}
  </script>
</body>
</html>`
}

function generateLottieHTML(scene: Scene, audioSettings?: AudioSettings | null, dims?: ProjectDimensions): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const { bgColor = '#fffef9', lottieSource = '', svgContent = '' } = scene

  const audioHTML = generateAudioHTML(scene.audioLayer)
  const motionRuntimeHTML = generateMotionRuntimeScript(scene.aiLayers, 30)

  const lottieInit = lottieSource.startsWith('http')
    ? `path: "${lottieSource}"`
    : `animationData: ${lottieSource || '{}'}`

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bgColor}; }
    #lottie-container { width: 100%; height: 100%; }
    #svg-overlay { position: absolute; inset: 0; pointer-events: none; }
    #svg-overlay svg { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="scene-camera" style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;">
  <div id="lottie-container"></div>
  <div id="svg-overlay">${svgContent}</div>
  ${audioHTML}
  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div><!-- /scene-camera -->
  ${motionRuntimeHTML}

  <script>
    var SCENE_ID = '${escapeJsString(scene.id)}';
    var DURATION = ${scene.duration ?? 8};

    const anim = lottie.loadAnimation({
      container: document.getElementById('lottie-container'),
      renderer: 'svg',
      loop: false,
      autoplay: false,
      ${lottieInit}
    });

    // Force render frame 0 as soon as lottie-web builds its SVG DOM.
    // Without this, autoplay:false + a paused scene clock = no frame ever painted.
    anim.addEventListener('DOMLoaded', function() {
      anim.goToAndStop(0, true);
    });

    // Drive Lottie from the master timeline (proxy pattern → seekable)
    window.addEventListener('load', () => {
      if (window.__tl) {
        const proxy = { frame: 0 };
        const totalFrames = anim.totalFrames || 1;
        window.__tl.add(proxy, {
          frame: [0, totalFrames],
          duration: DURATION,
          ease: 'linear',
          onUpdate: () => anim.goToAndStop(proxy.frame, true),
        }, 0);
        // Belt-and-suspenders: ensure frame 0 is visible while paused
        anim.goToAndStop(0, true);
      }
    });

    // Audio volume is handled by the playback controller
  </script>
</body>
</html>`
}

// ── Helper functions ──────────────────────────────────────────────────────────

function buildBgStyleCSS(style: ResolvedStyle): string {
  switch (style.bgStyle) {
    case 'grid':
      return `
        background-image:
          linear-gradient(${style.gridColor} 1px, transparent 1px),
          linear-gradient(90deg, ${style.gridColor} 1px, transparent 1px);
        background-size: 40px 40px;`
    case 'dots':
      return `
        background-image: radial-gradient(
          circle, ${style.gridColor} 1.5px, transparent 1.5px
        );
        background-size: 40px 40px;`
    default:
      return ''
  }
}

function generateCameraMotionScript(moves: CameraMove[]): string {
  const calls = moves
    .map((move) => {
      const paramsStr = move.params && Object.keys(move.params).length > 0 ? JSON.stringify(move.params) : '{}'
      return `  DreambyteCamera.${move.type}(${paramsStr});`
    })
    .join('\n')

  return `<script>
// Camera motion (added by set_camera_motion)
window.addEventListener('load', function() {
  if (typeof DreambyteCamera === 'undefined') return;
${calls}
});
</script>`
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function resolveStyleFromGlobal(globalStyle?: GlobalStyle): ResolvedStyle {
  if (!globalStyle) return resolveStyle(null)
  return resolveStyle(globalStyle.presetId, globalStyle)
}

/** `WorldEnvironment` uses underscores; files on disk use hyphens (e.g. studio_room → studio-room.html). */
function worldTemplateFilename(environment: string): string {
  const map: Record<string, string> = {
    meadow: 'meadow.html',
    studio_room: 'studio-room.html',
    void_space: 'void-space.html',
  }
  return map[environment] ?? `${environment.replace(/_/g, '-')}.html`
}

function generateWorldHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const wc = scene.worldConfig
  if (!wc) return '<!-- No worldConfig -->'

  const environment = wc.environment || 'meadow'
  const worldHtmlFile = worldTemplateFilename(environment)
  // Legacy field read by older world templates; there is no server TTS endpoint.
  const configWithAudio = {
    ...wc,
    ttsEndpoint: null,
  }
  const configJSON = JSON.stringify(configWithAudio)
  const appBaseUrl = getAppBaseUrl()

  // Server-side: read the world template from disk and inject __worldConfig
  // before the <script type="module"> so config is available at parse time.
  if (typeof window === 'undefined') {
    try {
      const fs = require('fs')
      const pathMod = require('path')
      const templatePath = pathMod.join(process.cwd(), 'public', 'worlds', worldHtmlFile)
      let templateHTML: string = fs.readFileSync(templatePath, 'utf-8')

      const configScript = `<script>
    window.__worldConfig = ${configJSON};
    window.DURATION = ${scene.duration ?? 10};
    window.SCENE_ID = '${escapeJsString(scene.id)}';
  </script>`

      const moduleIdx = templateHTML.indexOf('<script type="module">')
      if (moduleIdx !== -1) {
        templateHTML = templateHTML.slice(0, moduleIdx) + configScript + '\n  ' + templateHTML.slice(moduleIdx)
      } else {
        templateHTML = templateHTML.replace('</body>', `${configScript}\n</body>`)
      }

      templateHTML = templateHTML.replace('<head>', `<head>\n  <base href="${appBaseUrl}/">`)
      return templateHTML
    } catch {
      /* fall through */
    }
  }

  // Client-side fallback: a loader page that fetches the template, injects
  // config into a blob URL, and renders it in a full-size iframe.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000;
      transform-origin: top left;
    }
    iframe { border: none; width: ${W}px; height: ${H}px; display: block; }
  </style>
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>
</head>
<body>
  <script>
    (async function() {
      var config = ${configJSON};
      var baseUrl = '${appBaseUrl}';
      var res = await fetch(baseUrl + '/worlds/${worldHtmlFile}');
      var html = await res.text();

      // Inject config before module script so it is available at parse time
      var tag = '<scr' + 'ipt>window.__worldConfig=' + JSON.stringify(config) +
        ';window.DURATION=${scene.duration ?? 10};window.SCENE_ID="${escapeJsString(scene.id)}";</scr' + 'ipt>';
      var idx = html.indexOf('<script type="module">');
      if (idx !== -1) html = html.slice(0, idx) + tag + '\\n' + html.slice(idx);
      html = html.replace('<head>', '<head>\\n<base href="' + baseUrl + '/">');

      // Render via blob URL in iframe — preserves importmap support
      var blob = new Blob([html], { type: 'text/html' });
      var frame = document.createElement('iframe');
      frame.src = URL.createObjectURL(blob);
      frame.style.cssText = 'border:none;width:${W}px;height:${H}px;';
      document.body.appendChild(frame);

      // Bridge WVC globals from iframe to parent
      frame.addEventListener('load', function() {
        var w = frame.contentWindow;
        window.__updateScene = function(t) { if (w.__updateScene) w.__updateScene(t); };
        if (w.__sceneReady) window.__sceneReady = w.__sceneReady;
        if (w.__tl) window.__tl = w.__tl;
      });
    })();
  </script>
</body>
</html>`
}

// ── Avatar Scene (full-scene presenter mode) ───────────────────────────────

function generateAvatarSceneHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const audioHTML = generateAudioHTML(scene.audioLayer)
  const panelFontStack = sceneFontCssStack(style.font)

  // Find the avatar layer to get config
  const avatarLayer = scene.aiLayers?.find((l) => l.type === 'avatar') as AvatarLayer | undefined
  const asc = avatarLayer?.avatarSceneConfig
  const contentPanels = asc?.contentPanels ?? []
  const backdrop = asc?.backdrop ?? style.bgColor
  const avatarPosition = asc?.avatarPosition ?? 'left'
  const avatarSize = asc?.avatarSize ?? 40 // percentage of viewport

  // The presenter is the avatar provider's rendered video; legacy local-model layers get a placeholder.
  const avatarHTML = !avatarLayer
    ? ''
    : usesRemovedLocalAvatar(avatarLayer)
      ? removedLocalAvatarPlaceholderHTML()
      : avatarLayer.videoUrl
        ? `<video id="avatar-video" src="${escapeAttr(avatarLayer.videoUrl)}" playsinline muted style="width:100%;height:100%;object-fit:cover;"></video>`
        : ''
  const avatarStartAt = avatarLayer?.startAt ?? 0

  // Avatar container CSS based on position
  const avatarCSS =
    avatarPosition === 'center'
      ? `position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:${avatarSize}%;height:100%;`
      : avatarPosition === 'right'
        ? `position:absolute;right:0;bottom:0;width:${avatarSize}%;height:100%;`
        : `position:absolute;left:0;bottom:0;width:${avatarSize}%;height:100%;`

  // Content panel on opposite side
  const contentSide = avatarPosition === 'right' ? 'left' : 'right'
  const contentCSS = `position:absolute;${contentSide}:60px;top:50%;transform:translateY(-50%);width:${100 - avatarSize - 10}%;max-width:800px;z-index:10;`

  // Generate content panel HTML
  const panelsHTML = contentPanels
    .map((panel, i) => {
      const panelStyle = panel.style
        ? Object.entries(panel.style)
            .map(([k, v]) => `${k}:${escapeAttr(v)}`)
            .join(';')
        : ''
      const safeId = String(panel.id || i).replace(/[^a-zA-Z0-9\-_]/g, '')
      return `<div id="panel-${safeId}" class="content-panel" style="opacity:0;${panelStyle}">${panel.html}</div>`
    })
    .join('\n    ')

  // Generate master-timeline (anime.js) code for content panels
  const panelAnimCode = contentPanels
    .map((panel, i) => {
      // Sanitize ID to alphanumeric + hyphens only
      const rawId = String(panel.id || i).replace(/[^a-zA-Z0-9\-_]/g, '')
      const id = `panel-${rawId}`
      const enterTime = panel.revealAt === 'start' ? 0 : parseFloat(panel.revealAt) || i * 3 + 2
      const exitTime = panel.exitAt ? parseFloat(panel.exitAt) : undefined
      let code = `window.__tl.add(document.getElementById('${id}'), { opacity: [0, 1], y: [20, 0], duration: 0.6, ease: 'outCubic' }, ${enterTime});`
      if (exitTime != null) {
        code += `\n      window.__tl.add(document.getElementById('${id}'), { opacity: [1, 0], y: [0, -20], duration: 0.4, ease: 'outQuad' }, ${exitTime});`
      }
      return code
    })
    .join('\n      ')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${buildSceneFontLinks(style)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${backdrop}; }
    .content-panel {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 40px;
      border: 1px solid rgba(255,255,255,0.1);
      transform: translateY(20px);
      font-family: ${panelFontStack}, system-ui, sans-serif;
      color: ${style.palette[0] === '#ffffff' || style.palette[0] === '#fff' ? '#1a1a2e' : '#f0f0f0'};
    }
    .content-panel h2 { font-size: 32px; margin-bottom: 16px; }
    .content-panel p { font-size: 20px; line-height: 1.6; opacity: 0.85; }
    .content-panel ul { font-size: 20px; line-height: 2; padding-left: 24px; }
  </style>
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
      document.body.style.transformOrigin = 'top left';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  </script>
</head>
<body>
  <div id="scene-camera" style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;">

  <!-- Scene backdrop -->
  <div id="scene-backdrop" style="position:absolute;inset:0;z-index:0;background:${backdrop};"></div>

  <!-- Content panels -->
  <div id="scene-content" style="${contentCSS}">
    ${panelsHTML}
  </div>

  <!-- Avatar container -->
  <div id="avatar-container" style="${avatarCSS}z-index:5;">${avatarHTML}</div>

  ${audioHTML}

  <script>
    var SCENE_ID = '${escapeJsString(scene.id)}';
    var PALETTE = ${JSON.stringify(style.palette)};
    var DURATION = ${scene.duration};
    var WIDTH = ${W};
    var HEIGHT = ${H};
    var FONT = '${resolveSceneFontFamily(style.font).replace(/'/g, "\\'")}';
    var BODY_FONT = '${resolveSceneFontFamily(style.bodyFont || style.font).replace(/'/g, "\\'")}';
  </script>

  <!-- playback-controller-slot -->

  <script>
    window.addEventListener('load', function() {
      if (!window.__tl) return;
      ${panelAnimCode}
      var v = document.getElementById('avatar-video');
      if (v) {
        window.__tl.call(function() { if (window.__clock && window.__clock.isActive()) v.play(); }, ${avatarStartAt});
      }
    });
  </script>

  ${generateAILayersHTML(
    scene.aiLayers?.filter((l) => l.type !== 'avatar'),
    audioSettings,
    dims,
  )}

  </div><!-- /scene-camera -->
</body>
</html>`
}

/**
 * Normalize a React scene's JSX so the bootstrapper can always find the component.
 *
 * The bootstrapper wraps the transpiled code in a CommonJS closure and reads
 * `module.exports.default` / `module.exports.Scene` after execution. That only
 * gets populated when the source has an ES export statement. Authors (and
 * agents) routinely write `function Scene() { ... }` and forget the export,
 * which silently produces a blank iframe.
 *
 * This helper appends `export default Scene;` (or the right export for whatever
 * top-level component they defined) when no export is present. If no recognizable
 * component is found, the source is returned unchanged — the bootstrapper's
 * existing error message will fire.
 */
export function normalizeReactSceneExport(src: string): string {
  if (!src || typeof src !== 'string') return src
  // Fast path: any existing export statement means the author was explicit.
  if (
    /\bexport\s+default\b/.test(src) ||
    /\bmodule\.exports\s*=/.test(src) ||
    /\bexports\.[A-Za-z_$][\w$]*\s*=/.test(src) ||
    /\bexport\s*\{[^}]+\}/.test(src)
  ) {
    return src
  }
  // Look for a recognizable top-level component declaration. Prefer "Scene";
  // fall back to other conventional names.
  const CANDIDATES = ['Scene', 'Main', 'App', 'Root', 'Composition', 'VideoScene']
  for (const name of CANDIDATES) {
    const re = new RegExp(
      `(^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\b|` + `(^|\\n)\\s*(?:const|let|var)\\s+${name}\\s*=`,
    )
    if (re.test(src)) {
      return `${src.replace(/\s+$/, '')}\n\nexport default ${name};\n`
    }
  }
  return src
}

function generateReactHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  // React scenes store JSX in reactCode; fall back to sceneCode for compat
  const reactCode = scene.reactCode || scene.sceneCode || ''
  const sceneStyles = scene.sceneStyles || ''
  const audioHTML = generateAudioHTML(scene.audioLayer)
  const palette = style.palette ?? ['#1a1a2e', '#16213e', '#0f3460', '#e94560']
  const duration = scene.duration ?? 8
  const textOverlaysHTML = renderTextOverlaysHTML(scene.textOverlays ?? [])
  // fps default matches DreambyteReact runtime default. Plumb through scene
  // mp4Settings later if 60fps presets become common.
  const motionRuntimeHTML = generateMotionRuntimeScript(scene.aiLayers, 30)

  // Background video layer (set_video_layer). React scenes previously ignored
  // this entirely — only generateSVGHTML rendered #video-layer — so a video set
  // on a (default) react scene exported/previewed BLACK. Render it behind the
  // transparent #react-root, mirroring the proven inline-<video autoPlay muted>
  // path: muted autoplay decodes frames in the offscreen export window so the
  // composite host's frame-seek (currentTime=t) actually paints.
  const vl = scene.videoLayer
  const vlSrc = (vl?.src ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const videoLayerHTML =
    vl?.enabled && vlSrc
      ? `<div id="video-layer"><video src="${vlSrc}" autoplay muted playsinline preload="auto" data-scene-video style="width:100%;height:100%;object-fit:cover;opacity:${vl.opacity ?? 1};"></video></div>`
      : ''
  const videoLayerScript =
    vl?.enabled && vlSrc
      ? `<script>document.addEventListener('DOMContentLoaded',function(){var v=document.querySelector('#video-layer video');if(v)v.currentTime=${vl.trimStart ?? 0};});<\/script>`
      : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${buildSceneFontLinks(style)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      transform-origin: top left;
      ${buildBgStyleCSS(style)}
    }
    #scene-camera {
      position: absolute; inset: 0;
      width: ${W}px; height: ${H}px;
      transform-origin: center center;
      will-change: transform, filter;
    }
    #video-layer {
      position: absolute; inset: 0;
      width: ${W}px; height: ${H}px;
      z-index: 0;
    }
    #react-root {
      position: absolute; inset: 0;
      width: ${W}px; height: ${H}px;
      overflow: hidden;
      z-index: 1;
    }
    ${TEXT_OVERLAY_CSS}
    ${sanitizeCssBlock(sceneStyles)}
  </style>
  <script>
    function fitToViewport() {
      var s = Math.min(window.innerWidth / ${W}, window.innerHeight / ${H});
      document.body.style.transform = 'scale(' + s + ')';
      document.body.style.transformOrigin = 'top left';
    }
    window.addEventListener('resize', fitToViewport);
    document.addEventListener('DOMContentLoaded', fitToViewport);
  <\/script>
  <!-- React 18 UMD -->
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"><\/script>
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"><\/script>
  <!-- Babel standalone: in-browser JSX transpilation (bundled locally to avoid CDN failures) -->
  <script src="/sdk/babel.min.js"><\/script>
  <!-- lottie-web: required by LottieLayer bridge and DreambyteMotion.lottieSync -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js"><\/script>
</head>
<body>
  <div id="scene-camera">
    ${videoLayerHTML}
    <div id="react-root"></div>
    ${textOverlaysHTML}
    ${audioHTML}
    ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}
  </div>
  ${videoLayerScript}
  ${motionRuntimeHTML}

  <script>
    var SCENE_ID     = '${escapeJsString(scene.id)}';
    var PALETTE      = ${JSON.stringify(palette)};
    var DURATION     = ${duration};
    var ROUGHNESS    = ${style.roughnessLevel};
    var FONT         = '${style.font}';
    var BODY_FONT    = '${style.bodyFont || style.font}';
    var STROKE_COLOR = '${style.strokeColor}';
    var BG_COLOR     = '${style.bgColor}';
    var WIDTH        = ${W};
    var HEIGHT       = ${H};
    // Scene variables (reactive via useVariable hook)
    window.__DREAMBYTE_VARIABLES = ${JSON.stringify(
      Object.fromEntries(
        (scene.variables ?? []).map((v) => [
          v.name,
          v.defaultValue ?? (v.type === 'number' ? 0 : v.type === 'boolean' ? false : ''),
        ]),
      ),
    )};
  <\/script>

  <!-- playback-controller-slot -->

  <!-- Three.js r160 UMD (exposes window.THREE) + D3 v7 (available for bridge components) -->
  <script src="https://unpkg.com/three@0.160.0/build/three.min.js"><\/script>
  <script src="/vendor/three-sky.js"><\/script>
  <!-- Three.js addons in classic-script form (use window.THREE, no importmap needed) -->
  <script src="/vendor/three-addons-160/GLTFLoader.js"><\/script>
  <script src="/vendor/three-addons-160/SVGLoader.js"><\/script>
  <script src="/vendor/three-addons-160/FontLoader.js"><\/script>
  <script src="/vendor/three-addons-160/TextGeometry.js"><\/script>
  <script src="/vendor/three-addons-160/Water.js"><\/script>
  <!-- camera-controls: smooth programmatic camera (StudioCamera.fitTo, buildCameraControls) -->
  <script src="/vendor/camera-controls.min.js"><\/script>
  <script>if (window.CameraControls && window.THREE) { try { window.CameraControls.install({ THREE: window.THREE }); } catch(e) {} }<\/script>
  <!-- Shader/material extension libs -->
  <script src="/vendor/three-custom-shader-material.js"><\/script>
  <script src="/vendor/enhance-shader-lighting.js"><\/script>
  <script src="/vendor/three-csm.js"><\/script>
  <script>
    // Expose top-level globals from IIFE bundles
    if (window.ThreeCSM && window.ThreeCSM.default) window.CustomShaderMaterial = window.ThreeCSM.default;
    else if (window.ThreeCSM) window.CustomShaderMaterial = window.ThreeCSM;
    if (window.EnhanceShaderLighting && window.EnhanceShaderLighting.default) window.enhanceShaderLighting = window.EnhanceShaderLighting.default;
    else if (window.EnhanceShaderLighting) window.enhanceShaderLighting = window.EnhanceShaderLighting;
    if (window.ThreeCSMLib && window.ThreeCSMLib.CSM) window.CSM = window.ThreeCSMLib.CSM;
  <\/script>
  <!-- InfiniteGridHelper + Studio3D SDK -->
  <script src="/vendor/infinite-grid-helper.js"><\/script>
  <script src="/sdk/dreambyte-studio3d.js?v=${Date.now()}"><\/script>
  <!-- Troika SDF text (async module — available as window._troika shortly after load) -->
  <script type="module">
    try {
      var imp = await import('/vendor/troika-three-text.esm.js');
      window._troika = { Text: imp.Text, preloadFont: imp.preloadFont };
    } catch(e) { /* optional — buildText3D falls back to canvas text */ }
  <\/script>
  <script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"><\/script>
  <script>
  // buildStudio(THREE, scene, camera, renderer, style) — sets up studio environment inside ThreeJSLayer
  // Adds: sky gradient sphere (128 segments), infinite grid, white floor, 3-point lighting, env map
  // floorMode: 'infinite' (default, extends to horizon with fog), 'circle' (radial fade), 'none'
  // floorColor: override floor color (hex string), null = use style default
  window.buildStudio = function(T, scene, camera, renderer, style, opts) {
    style = style || 'white';
    opts = opts || {};
    var floorMode = opts.floorMode || 'infinite';
    var floorColorOverride = opts.floorColor || null;
    var configs = {
      white:     { floorY: -2.5, skyTop: '#999999', skyBot: '#ffffff', floorCol: '#ffffff', gridCol: '#d0cdc8', offset: 50, exponent: 0.6, ambientI: 0.3, keyI: 1.0, useSky: false, noFog: true, useShaderFloor: true },
      corporate: { floorY: -2.5, skyTop: '#b0b0b0', skyBot: '#ffffff', floorCol: '#ffffff', gridCol: '#d0cdc8', offset: 50, exponent: 0.6, ambientI: 0.4, keyI: 1.0, useSky: false },
      playful:   { floorY: -2,   skyTop: '#908880', skyBot: '#ffffff', floorCol: '#ffffff', gridCol: '#c8c4be', offset: 50, exponent: 0.6, ambientI: 0.3, keyI: 1.0, useSky: false },
      cinematic: { floorY: -3,   skyTop: '#020204', skyBot: '#0e0c14', floorCol: '#0e0c14', gridCol: '#1a1828', offset: 30, exponent: 0.5, ambientI: 0.08, keyI: 0.8, useSky: false },
      showcase:  { floorY: -3,   skyTop: '#06050a', skyBot: '#18141e', floorCol: '#18141e', gridCol: '#221e2a', offset: 30, exponent: 0.5, ambientI: 0.08, keyI: 0.8, useSky: false },
      tech:      { floorY: -3,   skyTop: '#020204', skyBot: '#080810', floorCol: '#080810', gridCol: '#1a1a28', offset: 30, exponent: 0.5, ambientI: 0.08, keyI: 0.8, useSky: false },
      sky:       { floorY: -2.5, skyTop: null, skyBot: '#c0d8f0', floorCol: null, gridCol: '#a0b098', offset: 33, exponent: 0.6, ambientI: 0.4, keyI: 1.2, useSky: true },
    };
    var c = configs[style] || configs.corporate;
    var isLight = (style === 'white' || style === 'corporate' || style === 'playful');
    // Override renderer settings — the bridge creates with alpha:true which makes bg transparent
    renderer.setClearColor(isLight ? 0xffffff : 0x060510, 1);
    renderer.toneMapping = 1; // LinearToneMapping = 1
    renderer.toneMappingExposure = c.useSky ? 0.5 : 1.0;
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = 'srgb';
    // Sky background
    if (c.useSky && T.Sky) {
      // Real THREE.Sky atmospheric scattering — outdoor look
      var skySun = new T.Sky();
      skySun.scale.setScalar(450000);
      scene.add(skySun);
      var u = skySun.material.uniforms;
      u['turbidity'].value = 10;
      u['rayleigh'].value = 2;
      u['mieCoefficient'].value = 0.005;
      u['mieDirectionalG'].value = 0.8;
      u['sunPosition'].value.set(400000, 400000, 400000);
      renderer.toneMappingExposure = 0.5;
    } else if (c.useSky) {
      // Fallback if Sky not loaded: blue gradient
      var skyGeo = new T.SphereGeometry(5000, 32, 128);
      var skyVS = 'varying vec3 vWorldPosition; void main() { vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
      var skyFS = 'uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main() { float h = normalize(vWorldPosition + offset).y; gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0); }';
      scene.add(new T.Mesh(skyGeo, new T.ShaderMaterial({ uniforms: { topColor: {value: new T.Color('#3060a0')}, bottomColor: {value: new T.Color('#b8d4f0')}, offset: {value: 33}, exponent: {value: 0.6} }, vertexShader: skyVS, fragmentShader: skyFS, side: T.BackSide, depthWrite: false })));
    } else {
      // Gradient sky sphere (128 vertical segments = smooth, no banding)
      var skyGeo = new T.SphereGeometry(5000, 32, 128);
      var skyVS = 'varying vec3 vWorldPosition; void main() { vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
      var skyFS = 'uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main() { float h = normalize(vWorldPosition + offset).y; gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0); }';
      scene.add(new T.Mesh(skyGeo, new T.ShaderMaterial({ uniforms: { topColor: {value: new T.Color(c.skyTop)}, bottomColor: {value: new T.Color(c.skyBot)}, offset: {value: c.offset}, exponent: {value: c.exponent} }, vertexShader: skyVS, fragmentShader: skyFS, side: T.BackSide, depthWrite: false })));
    }
    // Infinite grid
    var gridGeo = new T.PlaneGeometry(2, 2, 1, 1);
    var gridVS = 'varying vec3 worldPosition; uniform float uDistance; void main() { vec3 pos = position.xzy * uDistance; pos.xz += cameraPosition.xz; worldPosition = pos; gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0); }';
    var gridFS = 'varying vec3 worldPosition; uniform float uSize1; uniform float uSize2; uniform vec3 uColor; uniform float uDistance; float getGrid(float size) { vec2 r = worldPosition.xz / size; vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r); float line = min(grid.x, grid.y); return 1.0 - min(line, 1.0); } void main() { float d = 1.0 - min(distance(cameraPosition.xz, worldPosition.xz) / uDistance, 1.0); float g1 = getGrid(uSize1); float g2 = getGrid(uSize2); gl_FragColor = vec4(uColor.rgb, mix(g2, g1, g1) * pow(d, 3.0)); gl_FragColor.a = mix(0.5 * gl_FragColor.a, gl_FragColor.a, g2); if (gl_FragColor.a <= 0.0) discard; }';
    var grid = new T.Mesh(gridGeo, new T.ShaderMaterial({ side: T.DoubleSide, transparent: true, uniforms: { uSize1: {value:10}, uSize2: {value:100}, uColor: {value: new T.Color(c.gridCol)}, uDistance: {value:3000} }, vertexShader: gridVS, fragmentShader: gridFS, extensions: { derivatives: true } }));
    grid.frustumCulled = false; grid.position.y = c.floorY; scene.add(grid);
    // Floor — mode: 'infinite' (fog blend), 'circle' (radial fade), 'none'
    // If floorCol is null (sky style), skip colored floor — just add shadow catcher
    if (!c.floorCol && !floorColorOverride) { floorMode = 'none'; }
    // White studio default: use ShaderMaterial circle floor (renders at exact color, unaffected by lighting)
    if (c.useShaderFloor && floorMode === 'infinite') { floorMode = 'circle'; }
    var actualFloorCol = floorColorOverride ? new T.Color(floorColorOverride) : (c.floorCol ? new T.Color(c.floorCol) : new T.Color('#ffffff'));
    if (floorMode === 'circle') {
      var circRadius = opts.floorRadius || 80;
      var circGeo = new T.CircleGeometry(circRadius, 128);
      var circFS = 'uniform vec3 uColor; uniform float uRadius; varying vec3 vWorldPos; void main() { float dist = length(vWorldPos.xz); float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius * 0.95, dist); gl_FragColor = vec4(uColor, fade); }';
      var circVS = 'varying vec3 vWorldPos; void main() { vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
      var circMat = new T.ShaderMaterial({ uniforms: { uColor: {value: actualFloorCol}, uRadius: {value: circRadius} }, vertexShader: circVS, fragmentShader: circFS, transparent: true, side: T.DoubleSide, depthWrite: false });
      var circFloor = new T.Mesh(circGeo, circMat);
      circFloor.rotation.x = -Math.PI / 2; circFloor.position.y = c.floorY - 0.01; scene.add(circFloor);
      // Shadow catcher
      var shadowFloor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.ShadowMaterial({ opacity: 0.15 }));
      shadowFloor.rotation.x = -Math.PI / 2; shadowFloor.position.y = c.floorY - 0.005; shadowFloor.receiveShadow = true; scene.add(shadowFloor);
    } else if (floorMode !== 'none') {
      // Infinite floor — large plane + fog to blend with sky at horizon
      var infFloor = new T.Mesh(new T.PlaneGeometry(10000, 10000), new T.MeshStandardMaterial({ color: actualFloorCol, roughness: 1.0, metalness: 0, envMapIntensity: 0 }));
      infFloor.rotation.x = -Math.PI / 2; infFloor.position.y = c.floorY - 0.01; infFloor.receiveShadow = true; scene.add(infFloor);
      if (!c.noFog) scene.fog = new T.FogExp2(new T.Color(c.skyBot), 0.003);
    }
    // Always add a shadow catcher
    if (floorMode === 'none') {
      var shFloor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.ShadowMaterial({ opacity: 0.15 }));
      shFloor.rotation.x = -Math.PI / 2; shFloor.position.y = c.floorY - 0.005; shFloor.receiveShadow = true; scene.add(shFloor);
    }
    // 3-point lighting
    scene.add(new T.AmbientLight(isLight ? 0xffffff : 0x111122, c.ambientI));
    var keyL = new T.DirectionalLight(isLight ? 0xfff6e0 : 0xffffff, c.keyI);
    keyL.position.set(-5, 8, 5); keyL.castShadow = true; keyL.shadow.mapSize.set(2048, 2048);
    keyL.shadow.camera.left = -15; keyL.shadow.camera.right = 15; keyL.shadow.camera.top = 15; keyL.shadow.camera.bottom = -15; keyL.shadow.bias = -0.001;
    scene.add(keyL);
    scene.add(new T.DirectionalLight(isLight ? 0xd0e8ff : 0x4444aa, isLight ? 0.35 : 0.2).translateX(6).translateY(2).translateZ(4));
    scene.add(new T.DirectionalLight(isLight ? 0xffe0d0 : 0xff6040, isLight ? 0.5 : 0.35).translateY(4).translateZ(-9));
    // Env map
    try {
      var pmrem = new T.PMREMGenerator(renderer);
      var envScene = new T.Scene();
      var envSkyGeo = new T.SphereGeometry(50, 32, 16);
      var envSkyMat = new T.ShaderMaterial({ side: T.BackSide, uniforms: { topColor: {value: new T.Color(0xddeeff)}, bottomColor: {value: new T.Color(0xfff8f0)} }, vertexShader: 'varying vec3 vWP; void main(){vec4 wp=modelMatrix*vec4(position,1.0);vWP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}', fragmentShader: 'uniform vec3 topColor;uniform vec3 bottomColor;varying vec3 vWP;void main(){float h=normalize(vWP).y*0.5+0.5;gl_FragColor=vec4(mix(bottomColor,topColor,h),1.0);}' });
      envScene.add(new T.Mesh(envSkyGeo, envSkyMat));
      var p = new T.Mesh(new T.PlaneGeometry(8,4), new T.MeshBasicMaterial({color:0xffffff,side:T.DoubleSide}));
      p.position.set(-6,8,5); p.lookAt(0,0,0); envScene.add(p);
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      pmrem.dispose();
    } catch(e) {}
    return { floorY: c.floorY };
  };
  <\/script>
  <!-- DreambyteReact SDK: frame-based hooks + bridge components -->
  <script src="/sdk/dreambyte-react/dreambyte-react-runtime.js?v=${Date.now()}"><\/script>
  <script src="/sdk/dreambyte-react/dreambyte-react-bridges-v2.js?v=${Date.now()}"><\/script>
  <!-- DreambyteMotion + DreambyteCamera (shared with other scene types) -->
  <script src="/sdk/dreambyte-motion.js"><\/script>
  <script src="/sdk/dreambyte-camera.js"><\/script>

  <script id="scene-jsx" type="text/dreambyte-jsx">
${normalizeReactSceneExport(reactCode).replace(/<\/script/gi, '<\\/script')}
  <\/script>

  <script>
  // DreambyteReact bootstrapper: transpile JSX and mount the exported scene component.
  // The scene code runs in the same sandboxed iframe as all other scene types.
  (function() {
    var jsxSrc = document.getElementById('scene-jsx').textContent;
    if (!jsxSrc || !jsxSrc.trim()) return;

    // Transpile JSX to JS via Babel standalone
    var js;
    try {
      js = Babel.transform(jsxSrc, {
        presets: [['react', { runtime: 'classic' }]],
        plugins: ['transform-modules-commonjs'],
      }).code;
    } catch (e) {
      console.error('DreambyteReact: JSX transpilation failed', e);
      var errDiv = document.getElementById('react-root');
      if (errDiv) errDiv.textContent = 'JSX Error: ' + e.message;
      // Route through the head beacon's hook instead of posting '*' directly:
      // same rate limit, and published embeds (beacon stripped) silently
      // no-op instead of leaking error text to the third-party host page.
      // Kind 'jsx' is accepted at the IPC boundary
      // and the preview host normalizes it into the same pipe.
      try {
        if (window.__dreambyteReportSceneError) window.__dreambyteReportSceneError('jsx', e.message);
      } catch(ignore) {}
      return;
    }

    // Inject transpiled code as a script element (same pattern as other scene types
    // which embed AI-generated JS directly in inline script tags)
    var scriptEl = document.createElement('script');
    scriptEl.textContent = '(function(useCurrentFrame,useVideoConfig,interpolate,spring,Sequence,AbsoluteFill,Easing,Canvas2DLayer,ThreeJSLayer,D3Layer,SVGLayer,LottieLayer,useVariable,useInteraction,useTrigger,useDreambyteSeek,useDreambyteTime,interpolateColors,measureSpring,random,Series,Loop,Freeze,measureText,fitText){var module={exports:{}};var exports=module.exports;'
      + 'var require=function(mod){var _r={useCurrentFrame:useCurrentFrame,useVideoConfig:useVideoConfig,interpolate:interpolate,interpolateColors:interpolateColors,spring:spring,measureSpring:measureSpring,random:random,Sequence:Sequence,Series:Series,Loop:Loop,Freeze:Freeze,AbsoluteFill:AbsoluteFill,Easing:Easing,measureText:measureText,fitText:fitText};var m={"react":React,"three":typeof THREE!=="undefined"?THREE:{},"d3":typeof d3!=="undefined"?d3:{},"animejs":typeof anime!=="undefined"?anime:{},"anime":typeof anime!=="undefined"?anime:{},"remotion":_r,"@remotion/core":_r};if(m[mod]!==undefined)return m[mod];console.warn("DreambyteReact: unknown module "+mod);return {};};'
      // Top-level throws during module eval (e.g. "undefined.foo" at module scope)
      // run BEFORE root.render, so the React ErrorBoundary (render-phase only)
      // never sees them — the audience gets a blank #react-root. Wrap the user
      // module so a module-eval throw paints a visible error and reports 'runtime'
      // through the same beacon hook as the jsx transpile path above.
      + 'try{'
      + js
      + '\\n;window.__DreambyteSceneExports=module.exports;'
      + '}catch(__sceneErr){'
      + 'var __msg=(__sceneErr&&__sceneErr.message)||String(__sceneErr);'
      + 'console.error("DreambyteReact: scene module eval failed",__sceneErr);'
      + 'var __r=document.getElementById("react-root");'
      + 'if(__r){__r.style.position="absolute";__r.style.inset="0";__r.style.display="flex";__r.style.alignItems="center";__r.style.justifyContent="center";__r.style.flexDirection="column";__r.style.gap="12px";__r.style.background="#1a1a2e";__r.style.color="#e84545";__r.style.fontFamily="monospace";__r.style.padding="40px";__r.textContent="Scene error: "+__msg;}'
      + 'try{if(window.__dreambyteReportSceneError)window.__dreambyteReportSceneError("runtime",__msg);}catch(__ignore){}'
      + 'window.__DreambyteSceneEvalFailed=true;'
      + '}'
      + '})(DreambyteReact.useCurrentFrame,DreambyteReact.useVideoConfig,DreambyteReact.interpolate,DreambyteReact.spring,DreambyteReact.Sequence,DreambyteReact.AbsoluteFill,DreambyteReact.Easing,DreambyteReact.Canvas2DLayer,DreambyteReact.ThreeJSLayer,DreambyteReact.D3Layer,DreambyteReact.SVGLayer,DreambyteReact.LottieLayer,DreambyteReact.useVariable,DreambyteReact.useInteraction,DreambyteReact.useTrigger,DreambyteReact.useDreambyteSeek,DreambyteReact.useDreambyteTime,DreambyteReact.interpolateColors,DreambyteReact.measureSpring,DreambyteReact.random,DreambyteReact.Series,DreambyteReact.Loop,DreambyteReact.Freeze,DreambyteReact.measureText,DreambyteReact.fitText);';
    document.body.appendChild(scriptEl);

    // If the module body threw during eval, the catch above already painted a
    // visible "Scene error" into #react-root and reported it — stop here so the
    // "No component exported" path below doesn't overwrite that message.
    if (window.__DreambyteSceneEvalFailed) return;

    // Resolve the exported component
    var exp = window.__DreambyteSceneExports || {};
    var SceneComponent = exp.default || exp.Scene || (typeof exp === 'function' ? exp : null);
    if (typeof SceneComponent !== 'function') {
      // Self-diagnose: look at the source to hint what's missing.
      var hint = 'Add "export default Scene;" at the end of the scene code.';
      if (/function\\s+(Scene|Main|App|Root)\\b/.test(jsxSrc) && !/export\\s+default/.test(jsxSrc)) {
        hint = 'Found a component but no "export default" statement. Scene renders blank without it. Add: "export default Scene;" at the end.';
      } else if (!/function|const|let|var/.test(jsxSrc)) {
        hint = 'No component declaration found in scene source.';
      }
      console.error('DreambyteReact: No component exported. ' + hint);
      var root = document.getElementById('react-root');
      if (root) root.textContent = 'Scene error: ' + hint;
      return;
    }

    // Error boundary to catch runtime errors in scene code
    var ErrorBoundary = (function() {
      function EB(props) { this.state = { error: null }; }
      EB.prototype = Object.create(React.Component.prototype);
      EB.prototype.constructor = EB;
      EB.getDerivedStateFromError = function(err) { return { error: err }; };
      EB.prototype.componentDidCatch = function(err, info) {
        console.error('DreambyteReact scene error:', err, info);
      };
      EB.prototype.render = function() {
        if (this.state.error) {
          return React.createElement('div', {
            style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexDirection: 'column', gap: '12px',
              background: '#1a1a2e', color: '#e84545', fontFamily: 'monospace', padding: '40px' }
          },
            React.createElement('div', { style: { fontSize: '18px', fontWeight: 700 } }, 'Scene Error'),
            React.createElement('pre', { style: { fontSize: '13px', color: '#ccc', maxWidth: '80%',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(this.state.error.message || this.state.error))
          );
        }
        return this.props.children;
      };
      return EB;
    })();

    // Mount inside DreambyteComposition with Error Boundary
    var fps = 30;
    var root = ReactDOM.createRoot(document.getElementById('react-root'));
    root.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(DreambyteReact.DreambyteComposition, {
          fps: fps,
          width: WIDTH,
          height: HEIGHT,
          durationInFrames: Math.round(DURATION * fps),
        }, React.createElement(SceneComponent))
      )
    );

    // Apply element overrides (non-destructive visual tweaks from the inspector).
    //
    // These have to outlive the render loop. DreambyteComposition re-renders on
    // every frame from useCurrentFrame(), so React rewrites any inline style it
    // owns — the old one-shot rAF+setTimeout(50) wrote overrides straight onto
    // el.style and the next frame wiped them. A user tweaking an ANIMATED
    // property watched their edit revert; only props React never touched stuck.
    //
    // So styles go in as a stylesheet with !important, which outranks the inline
    // styles React writes and costs nothing per frame. Text has no CSS
    // equivalent, so it is re-asserted each frame — guarded by a compare, so we
    // only touch the DOM on the frames React actually clobbered it.
    var __overrides = ${JSON.stringify(scene.elementOverrides ?? {})};
    if (Object.keys(__overrides).length > 0) {
      var __kebab = function(p) { return p.replace(/[A-Z]/g, function(c) { return '-' + c.toLowerCase(); }); };
      var __css = '';
      var __texts = [];
      Object.keys(__overrides).forEach(function(id) {
        var props = __overrides[id];
        var decls = '';
        Object.keys(props).forEach(function(prop) {
          var val = props[prop];
          if (prop === 'text') { __texts.push({ id: id, text: String(val) }); return; }
          decls += __kebab(prop) + ':' + ((typeof val === 'number') ? (val + 'px') : String(val)) + ' !important;';
        });
        // Attribute selector + escaped quotes: ids are generated, not authored,
        // so they are not guaranteed to be bare CSS identifiers.
        if (decls) __css += '[id="' + String(id).replace(/["\\\\]/g, '\\\\$&') + '"]{' + decls + '}';
      });
      if (__css) {
        var __styleEl = document.createElement('style');
        __styleEl.textContent = __css;
        document.head.appendChild(__styleEl);
      }
      if (__texts.length > 0) {
        // A plain rAF loop, not a MutationObserver — it is the same
        // clock the animation runs on, and the compare makes it a no-op on
        // frames that did not clobber. Swap it if text overrides ever get big.
        var __applyText = function() {
          for (var i = 0; i < __texts.length; i++) {
            var el = document.getElementById(__texts[i].id);
            if (el && el.textContent !== __texts[i].text) el.textContent = __texts[i].text;
          }
          requestAnimationFrame(__applyText);
        };
        requestAnimationFrame(__applyText);
      }
    }
  })();
  <\/script>
</body>
</html>`
}
/**
 * Scene HTML generated before the anime.js runtime (still on disk in old
 * projects) loads the removed runtime with a CDN fallback. Every path that
 * renders, exports, publishes or verifies STORED scene HTML passes it through
 * here, so an old file becomes the "regenerate" placeholder instead of pulling
 * that runtime from a CDN. Current HTML is returned unchanged.
 */
export function rebuildLegacySceneHtml(html: string): string {
  const legacy = legacyPlaceholderFromHtml(html)
  if (!legacy) return html
  const { scene, width, height } = legacy
  const dims = width && height ? { width, height } : undefined
  return generateSceneHTML(scene, undefined, undefined, undefined, dims)
}

export function generateSceneHTML(
  scene: Scene,
  globalStyle?: GlobalStyle,
  watermark?: (WatermarkConfig & { publicUrl: string }) | null,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const { width: W, height: H } = dims ?? DEFAULT_DIMENSIONS
  // Pre-removal scenes written for the old animation runtime can't run on
  // anime.js: render a visible "regenerate" card instead of a blank frame.
  scene = withLegacyPlaceholder(scene)
  // Use scene-level style override if present, otherwise fall back to global
  const hasOverride = scene.styleOverride != null && Object.keys(scene.styleOverride).length > 0
  const style =
    hasOverride && globalStyle
      ? resolveSceneStyle(scene.styleOverride, globalStyle)
      : resolveStyleFromGlobal(globalStyle)

  // Scene-level bgColor overrides the preset when explicitly set
  if (scene.bgColor) {
    style.bgColor = scene.bgColor
  }

  const _dims = { width: W, height: H }
  let html: string
  if (scene.sceneType === 'canvas2d') html = generateCanvasHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'motion') html = generateMotionHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'd3') html = generateD3HTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'three') html = generateThreeHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'lottie') html = generateLottieHTML(scene, audioSettings, _dims)
  else if (scene.sceneType === 'zdog') html = generateZdogHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === '3d_world') html = generateWorldHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'avatar_scene') html = generateAvatarSceneHTML(scene, style, audioSettings, _dims)
  else if (scene.sceneType === 'react') html = generateReactHTML(scene, style, audioSettings, _dims)
  else html = generateSVGHTML(scene, style, audioSettings, _dims)

  // Inject <base> + anime.js + playback controller into <head>
  // <base> ensures relative asset URLs (/uploads/..., /generated/...) resolve
  // correctly even when the render server loads the HTML from a different origin.
  // The playback error beacon rides the SAME universal injection so EVERY
  // renderer (React, motion, d3, three, …) gets it — a renderer without it
  // would report a silent false-clean. Installed before
  // anime.js and any scene script so even syntax errors in later scripts are caught.
  // Inert in top-level windows (offscreen verifier, tier3 export): parent ===
  // window and nothing listens. Source: src/lib/agents/error-capture-shared.ts.
  const appBaseUrl = getAppBaseUrl()
  // data-dreambyte-error-beacon marks the script so the publish path strips it
  // : in a hosted embed the parent is a third-party page, and the beacon's
  // postMessage('*') would broadcast scene error strings to the host.
  // CSP: inject FIRST in <head>, before <base> and any
  // script, so it governs every network connection the scene makes. The same
  // policy is also set as a dreambyte:// response header in src/electron/main.ts;
  // this in-HTML mirror is what covers the export `srcdoc` path (which gets no
  // response headers). data-dreambyte-csp marks it so the publish path can strip
  // it (published embeds are a web-only, user-hosted surface — different threat
  // model). See src/lib/security/scene-csp.ts.
  const cspMeta = SCENE_CSP_META.replace('<meta ', '<meta data-dreambyte-csp ')
  html = html.replace(
    '<head>',
    `<head>\n  ${cspMeta}\n  <base href="${appBaseUrl}/">\n  <script data-dreambyte-error-beacon>${buildErrorCaptureScript(scene.id)}</script>` +
      ANIME_HEAD,
  )

  // Inject playback controller BEFORE closing </body> (after globals, before scene code runs)
  // The controller creates window.__tl which scene code uses
  const controllerScript = `<script>${PLAYBACK_CONTROLLER}<\/script>`
  const registryScript = `<script>${ELEMENT_REGISTRY}<\/script>`
  // Insert before the first scene-specific <script> block after globals
  // Fallback: insert before </body>
  // Element registry goes right after playback controller
  const canvasBgUserCode = scene.canvasBackgroundCode?.trim() ?? ''
  const canvasBgScript =
    canvasBgUserCode && ['motion', 'd3', 'svg', 'react'].includes(scene.sceneType ?? '')
      ? `<script>\n${canvasBgUserCode}\n<\/script>`
      : ''

  if (html.includes('<!-- playback-controller-slot -->')) {
    html = html.replace(
      '<!-- playback-controller-slot -->',
      controllerScript + '\n' + registryScript + (canvasBgScript ? `\n${canvasBgScript}` : ''),
    )
  } else {
    html = html.replace('</body>', controllerScript + '\n' + registryScript + '\n</body>')
  }

  // Inject camera motion calls before </body> (after playback controller + scene code)
  if (scene.cameraMotion && scene.cameraMotion.length > 0) {
    const cameraScript = generateCameraMotionScript(scene.cameraMotion)
    html = html.replace('</body>', cameraScript + '\n</body>')
  }

  // Inject watermark overlay before </body> if configured
  if (watermark?.publicUrl) {
    const baseUrl = getAppBaseUrl()
    const wmUrl = watermark.publicUrl.startsWith('http') ? watermark.publicUrl : `${baseUrl}${watermark.publicUrl}`
    const posCSS = getWatermarkPositionCSS(watermark.position)
    const wmHTML = `<div style="position:fixed;${posCSS};opacity:${watermark.opacity};pointer-events:none;z-index:9999;">
  <img src="${escapeAttr(wmUrl)}" style="width:${watermark.sizePercent}vw;height:auto;" />
</div>`
    html = html.replace('</body>', wmHTML + '\n</body>')
  }

  return html
}

function getWatermarkPositionCSS(position: WatermarkConfig['position']): string {
  switch (position) {
    case 'top-left':
      return 'top:2vw;left:2vw'
    case 'top-right':
      return 'top:2vw;right:2vw'
    case 'bottom-left':
      return 'bottom:2vw;left:2vw'
    case 'bottom-right':
      return 'bottom:2vw;right:2vw'
    default:
      return 'bottom:2vw;right:2vw'
  }
}

// ── Text overlay renderer (shared: used by SVG + React templates) ────────────

function renderTextOverlaysHTML(textOverlays: Array<import('./types').TextOverlay>): string {
  if (!textOverlays?.length) return ''
  const animMap: Record<string, string> = {
    'fade-in': 'fadeInOverlay',
    'slide-up': 'slideUpOverlay',
    typewriter: 'fadeInOverlay',
  }
  return textOverlays
    .map((t) => {
      const weight = t.weight ?? 400
      const lineHeight = t.lineHeight ?? 1.2
      const letterSpacing = t.letterSpacing ?? 0
      return `<div class="text-overlay" style="left:${t.x}%;top:${t.y}%;font-family:${t.font};font-size:${t.size}px;font-weight:${weight};line-height:${lineHeight};letter-spacing:${letterSpacing}em;color:${t.color};animation:${animMap[t.animation] ?? 'fadeInOverlay'} ${t.duration}s ease ${t.delay}s forwards;">${t.content}</div>`
    })
    .join('\n  ')
}

const TEXT_OVERLAY_CSS = `
  .text-overlay {
    position: absolute;
    z-index: 3;
    opacity: 0;
    white-space: pre-wrap;
    pointer-events: none;
  }
  @keyframes fadeInOverlay {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes slideUpOverlay {
    from { opacity: 0; transform: translateY(30px); }
    to { opacity: 1; transform: translateY(0); }
  }
`

function generateSVGHTML(
  scene: Scene,
  style: ResolvedStyle,
  audioSettings?: AudioSettings | null,
  dims?: ProjectDimensions,
): string {
  const W = dims?.width ?? 1920
  const H = dims?.height ?? 1080
  const { svgContent = '', videoLayer, textOverlays = [], svgObjects = [], primaryObjectId = null } = scene

  // New scenes: primary SVG is already in svgObjects, no need for #svg-layer
  const hasPrimaryObject = !!primaryObjectId && svgObjects.some((o) => o.id === primaryObjectId)

  const svgObjectsHTML = svgObjects
    .map((obj) =>
      obj.svgContent
        ? `<div class="svg-object" id="obj-${obj.id}" style="position:absolute;left:${obj.x}%;top:${obj.y}%;width:${obj.width}%;opacity:${obj.opacity};z-index:${obj.zIndex};pointer-events:none;">${obj.svgContent}</div>`
        : '',
    )
    .join('\n  ')

  const textOverlaysHTML = renderTextOverlaysHTML(textOverlays)

  const videoDisplay = videoLayer?.enabled ? 'block' : 'none'
  const videoOpacity = videoLayer?.opacity ?? 1
  // Escape for the <video src="..."> attribute context so a src containing a
  // quote/angle-bracket can't break out into markup (defense in
  // depth alongside the scheme check in set_video_layer).
  const videoSrc = (videoLayer?.src ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const videoTrimStart = videoLayer?.trimStart ?? 0
  // Grade CSS (style-block context — strip chars that could break out of the rule)
  const videoGradeSvg = gradeSvgFilterMarkup(videoLayer?.colorGrade, 'grade-video-layer')
  const videoFilter = gradeToCssChain(videoLayer?.colorGrade, {
    lookCss: videoLayer?.filter ?? '',
    svgFilterId: videoGradeSvg ? 'grade-video-layer' : null,
  })
    .replace(/[<>{}]/g, '')
    .trim()

  const audioHTML = generateAudioHTML(scene.audioLayer)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${buildSceneFontLinks(style)}
  ${style.roughnessLevel > 0.2 ? '<script src="https://unpkg.com/roughjs@4.6.6/bundled/rough.js"></script>' : ''}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; animation-play-state: paused; }
    body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.bgColor};
      --bg-color: ${style.bgColor};
      ${buildBgStyleCSS(style)}
    }

    #video-layer {
      position: absolute; inset: 0;
      opacity: ${videoOpacity};
      z-index: 1;
      display: ${videoDisplay};
    }
    #video-layer video { width: 100%; height: 100%; object-fit: cover;${videoFilter ? ` filter: ${videoFilter};` : ''} }

    #svg-layer {
      position: absolute; inset: 0;
      z-index: 2;
    }
    #svg-layer svg { width: 100%; height: 100%; }

    .text-overlay {
      position: absolute;
      z-index: 3;
      opacity: 0;
      white-space: pre-wrap;
    }

    .svg-object svg { width: 100%; height: auto; display: block; background: transparent; }

    /* Stroke animation */
    .stroke {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: var(--len, 1000);
      stroke-dashoffset: var(--len, 1000);
      animation: draw var(--dur, 1s) ease-in-out var(--delay, 0s) forwards;
    }
    .fadein {
      opacity: 0;
      animation: pop var(--dur, 0.4s) ease var(--delay, 0s) forwards;
    }
    @keyframes draw      { to { stroke-dashoffset: 0; } }
    @keyframes pop       { to { opacity: 1; } }
    @keyframes scaleIn   { from { opacity: 0; transform: scale(0); } to { opacity: 1; transform: scale(1); } }
    @keyframes slideUp   { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideLeft { from { opacity: 0; transform: translateX(50px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes bounceIn  { 0% { opacity: 0; transform: scale(0); } 60% { opacity: 1; transform: scale(1.15); } 100% { opacity: 1; transform: scale(1); } }
    @keyframes rotateIn  { from { opacity: 0; transform: rotate(-15deg); } to { opacity: 1; transform: rotate(0deg); } }
    @keyframes fadeInOverlay { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUpOverlay {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .scale {
      opacity: 0; transform-origin: center center;
      animation: scaleIn var(--dur, 0.4s) ease var(--delay, 0s) forwards;
    }
    .slide-up {
      opacity: 0;
      animation: slideUp var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }
    .slide-left {
      opacity: 0;
      animation: slideLeft var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }
    .bounce {
      opacity: 0; transform-origin: center center;
      animation: bounceIn var(--dur, 0.6s) cubic-bezier(0.34, 1.56, 0.64, 1) var(--delay, 0s) forwards;
    }
    .rotate {
      opacity: 0; transform-origin: center center;
      animation: rotateIn var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }
  </style>
</head>
<body>

  <div id="scene-camera" style="position:absolute;inset:0;transform-origin:center center;will-change:transform,filter;">

  ${sceneUsesCanvasBackground(scene) ? canvasBgTag(W, H) : ''}

  ${videoGradeSvg ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${videoGradeSvg}</svg>` : ''}
  <div id="video-layer">
    ${vignetteOverlayHTML(videoLayer?.colorGrade)}
    ${videoLayer?.enabled && videoSrc ? `<video src="${videoSrc}" autoplay muted playsinline preload="auto" data-scene-video></video>` : ''}
  </div>

  ${hasPrimaryObject ? '' : `<div id="svg-layer">${svgContent}</div>`}

  ${audioHTML}

  ${svgObjectsHTML}

  ${textOverlaysHTML}

  ${generateAILayersHTML(scene.aiLayers, audioSettings, dims)}

  </div><!-- /scene-camera -->

  <script>
    // ── Scene globals ─────────────────────────────────────
    var SCENE_ID     = '${escapeJsString(scene.id)}';
    var PALETTE      = ${JSON.stringify(style.palette)};
    var DURATION     = ${scene.duration};
    var ROUGHNESS    = ${style.roughnessLevel};
    var FONT         = '${style.font}';
    var BODY_FONT    = '${style.bodyFont || style.font}';
    var STROKE_COLOR = '${style.strokeColor}';
    var BG_COLOR     = '${style.bgColor}';
    var WIDTH        = ${W};
    var HEIGHT       = ${H};

    document.addEventListener('DOMContentLoaded', () => {
      // Auto-calculate stroke-dasharray lengths (legacy CSS animation scenes)
      document.querySelectorAll('.stroke').forEach(el => {
        if (el.getTotalLength) {
          el.style.setProperty('--len', el.getTotalLength());
        }
      });

      const video = document.querySelector('#video-layer video');
      if (video) video.currentTime = ${videoTrimStart};

      // Audio volume is handled by the playback controller
    });
  </script>

  <!-- playback-controller-slot -->
</body>
</html>`
}
