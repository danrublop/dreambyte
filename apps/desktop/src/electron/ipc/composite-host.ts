/**
 * Composite host page + host-driven seek for the single-stream export. The
 * foundation the export capture loop stands on.
 *
 * The export renders the timeline like the preview: ONE offscreen BrowserWindow
 * loads a HOST page that stacks one <iframe> per active scene, z-ordered by track.
 * Each frame, the main process computes a plan via planCompositeFrame() and calls
 * `window.__composite.renderFrameAt(layers)`; the controller mounts/seeks/opacity-
 * sets each active iframe and resolves. The main process then `invalidate()`s +
 * settles + `capturePage()`s the composited result (NO requestAnimationFrame).
 *
 *   main: planCompositeFrame(t) ─▶ wc.executeJavaScript(__composite.renderFrameAt(layers))
 *                                       │  per layer: mount → seek (host-driven)
 *                                       ▼
 *                          wc.invalidate() + sleep(settle) ─▶ capturePage() ─▶ ffmpeg
 *
 * TWO hard lessons baked in here:
 *
 *  1. NO requestAnimationFrame. An OFFSCREEN GPU BrowserWindow does not reliably
 *     fire rAF (it starves unless frames are pumped), so an rAF-based paint-ack
 *     hangs every frame. The proven captureSceneToVideo path never uses rAF — it
 *     flushes paint with webContents.invalidate() + a short main-process sleep.
 *     We do the same; renderFrameAt returns as soon as the seek calls are issued.
 *
 *  2. NO eval into the scene iframe. Generated scene HTML can carry a CSP that
 *     blocks eval(), so injecting a seek agent is unreliable. Instead the host
 *     (same-origin: host + scenes both load from dreambyte://scenes) drives each
 *     scene's clock DIRECTLY via `iframe.contentWindow.__clock.seek(t)` + the same
 *     hooks export-tier3's seekExpr uses. Same-origin property access needs no eval.
 *
 *  And: mount() must NOT gate on the iframe 'load' event — a scene module that
 *  await-imports its runtime from a CDN delays/never-fires 'load'. We poll the
 *  scene window for window.__clock directly with a deadline (like waitForSceneReady).
 */

import type { CompositeFramePlan, CompositeLayer, CompositeLayerKind } from '@/lib/timeline/composite-frame'
import { compositeLayerToElementStyle } from '@/lib/timeline/composite-frame'
import { buildGradeGLPayload, type GradeGLPayload } from '@/lib/compositor/grade-gl'
import { GRADE_VERTEX_SHADER, GRADE_FRAGMENT_SHADER } from '@/lib/compositor/grade-shaders'

/**
 * The host-page controller (runs in the host window). Builds an iframe pool keyed
 * by sceneId (mirrors the preview's sourceId-keyed pool) and exposes:
 *   - `mount(sceneId, url)`   → pre-mount + wait (deadline) for the scene's
 *                               playback bridge (window.__clock / __updateScene).
 *   - `renderFrameAt(layers)` → z/opacity/seek each active layer (host-driven,
 *                               no eval), hide the rest, resolve. A <video> scene
 *                               also awaits its `seeked` event with a 400ms
 *                               capture-anyway timeout. No rAF.
 */
const COMPOSITE_CONTROLLER_SRC = `
(function(){
  var stage = document.getElementById('stage');
  var pool = {}; // layerKey -> { el, kind, ready }  (scene→iframe, video→<video>, image→<img>)
  // Shared <svg> defs for injected color-grade <filter>s (CSS tier). The layer's
  // CSS filter references these via url(#clip-grade-<id>). Keyed by the filter id so
  // a re-grade replaces, not duplicates. Markup is self-generated from numeric params.
  var gradeDefs = null;
  function injectGradeSvg(markup){
    if (!markup) return;
    if (!gradeDefs){
      gradeDefs = document.createElementNS('http://www.w3.org/2000/svg','svg');
      gradeDefs.setAttribute('width','0'); gradeDefs.setAttribute('height','0');
      gradeDefs.style.cssText='position:absolute;width:0;height:0';
      document.body.appendChild(gradeDefs);
    }
    try {
      var doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">'+markup+'</svg>','image/svg+xml');
      var f = doc.querySelector('filter');
      if (f){
        var id = f.getAttribute('id');
        if (id){ var prev = gradeDefs.querySelector('#'+(window.CSS&&CSS.escape?CSS.escape(id):id)); if (prev) prev.remove(); }
        gradeDefs.appendChild(document.importNode(f, true));
      }
    } catch(e){}
  }
  // ── Tier-B clip grade (LUT / hue curves) ──────────────────────────────────
  // ONE shared WebGL2 context grades the seeked source frame through the SAME shader
  // + uniforms as the preview pool (src/lib/compositor/grade-gl.ts), then the result is
  // copied onto a per-layer 2D <canvas>. A single context (not one per clip) stays
  // under Chromium's WebGL context cap. preview == export by construction: same
  // GRADE_FRAGMENT_SHADER (window.__GRADE_SHADERS), same buildGradeUniforms payload,
  // same parseCubeLut'd LUT (registered once by url from the main process).
  var grader = null;       // { gl, canvas, program, locs, ...tex, lutUrl }  (gl=null = unsupported)
  var registeredLuts = {}; // url -> { n, data: Float32Array }
  function registerLut(url, n, data){ try { registeredLuts[url] = { n: n, data: new Float32Array(data) }; } catch(e){} }
  function compileSh(gl, type, src){ var s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); return gl.getShaderParameter(s,gl.COMPILE_STATUS) ? s : null; }
  function getGrader(){
    if (grader) return grader;
    var S = window.__GRADE_SHADERS;
    var canvas = document.createElement('canvas');
    var gl = null; try { gl = canvas.getContext('webgl2', { premultipliedAlpha:false, alpha:true, preserveDrawingBuffer:true }); } catch(e){}
    if (!gl || !S) { grader = { gl: null }; return grader; }
    var vs = compileSh(gl, gl.VERTEX_SHADER, S.vert), fs = compileSh(gl, gl.FRAGMENT_SHADER, S.frag);
    if (!vs || !fs) { grader = { gl: null }; return grader; }
    var p = gl.createProgram(); gl.attachShader(p,vs); gl.attachShader(p,fs); gl.bindAttribLocation(p,0,'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { grader = { gl: null }; return grader; }
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    function mk(filter){ var t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); return t; }
    gl.useProgram(p); var locs = {};
    ['uImage','uChannelCurve','uHueCurve','uLut','uLutSize','uLutIntensity','uHasChannelCurve','uHasHueCurve','uExposure','uContrast','uSaturation','uWbGain'].forEach(function(n){ locs[n]=gl.getUniformLocation(p,n); });
    gl.uniform1i(locs.uImage,0); gl.uniform1i(locs.uChannelCurve,1); gl.uniform1i(locs.uHueCurve,2); gl.uniform1i(locs.uLut,3);
    grader = { gl: gl, canvas: canvas, program: p, locs: locs, imageTex: mk(gl.LINEAR), channelTex: mk(gl.LINEAR), hueTex: mk(gl.LINEAR), lutTex: mk(gl.NEAREST), lutUrl: null };
    return grader;
  }
  function ensureLut(G, url){
    if (!url || G.lutUrl === url) return;
    var rec = registeredLuts[url]; if (!rec) return;
    var gl = G.gl; gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, G.lutTex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F, rec.n, rec.n*rec.n, 0, gl.RGBA, gl.FLOAT, rec.data);
    G.lutUrl = url;
  }
  // Grade the source frame -> returns the grader canvas, or null when GL is
  // unavailable / the source isn't decodable yet (caller shows the raw element).
  function renderGrade(source, P, w, h){
    var G = getGrader(); if (!G || !G.gl) return null;
    var gl = G.gl;
    if (G.canvas.width !== w) G.canvas.width = w;
    if (G.canvas.height !== h) G.canvas.height = h;
    gl.viewport(0,0,w,h); gl.useProgram(G.program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE, source); } catch(e){ gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); return null; }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (P.channelCurve){ gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,G.channelTex); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(P.channelCurve)); gl.uniform1i(G.locs.uHasChannelCurve,1); } else { gl.uniform1i(G.locs.uHasChannelCurve,0); }
    if (P.hueCurve){ gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,G.hueTex); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(P.hueCurve)); gl.uniform1i(G.locs.uHasHueCurve,1); } else { gl.uniform1i(G.locs.uHasHueCurve,0); }
    ensureLut(G, P.lutUrl);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, G.lutTex);
    var lutSize = (P.lutUrl && registeredLuts[P.lutUrl]) ? P.lutSize : 0;
    gl.uniform1f(G.locs.uLutSize, lutSize); gl.uniform1f(G.locs.uLutIntensity, P.lutIntensity);
    gl.uniform1f(G.locs.uExposure, P.exposure); gl.uniform1f(G.locs.uContrast, P.contrast); gl.uniform1f(G.locs.uSaturation, P.saturation);
    gl.uniform3fv(G.locs.uWbGain, P.wbGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return G.canvas;
  }
  // Draw a graded source onto the layer's visible 2D canvas (created lazily, pooled
  // on the media record). Hides the raw element; on any failure the element stays shown.
  function applyGrade(rec, L){
    if (!rec) return false;
    var src = rec.el;
    var w = (rec.kind === 'video') ? src.videoWidth : src.naturalWidth;
    var h = (rec.kind === 'video') ? src.videoHeight : src.naturalHeight;
    if (!w || !h) return false;
    var graded = renderGrade(src, L.gradeGL, w, h);
    if (!graded) return false;
    if (!rec.glOut){
      var c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;transform-origin:0 0;';
      rec.glOut = c; rec.glOutCtx = c.getContext('2d'); stage.appendChild(c);
    }
    if (rec.glOut.width !== w) rec.glOut.width = w;
    if (rec.glOut.height !== h) rec.glOut.height = h;
    try { rec.glOutCtx.clearRect(0,0,w,h); rec.glOutCtx.drawImage(graded, 0, 0, w, h); } catch(e){ return false; }
    rec.glOut.style.transform = L.transform || '';
    rec.glOut.style.filter = L.filter || '';
    rec.glOut.style.mixBlendMode = L.mixBlendMode || '';
    rec.glOut.style.opacity = String(L.opacity);
    rec.glOut.style.zIndex = String(L.z);
    rec.glOut.style.visibility = 'visible';
    rec.el.style.visibility = 'hidden';
    return true;
  }
  function mountScene(key, url){
    var f = document.createElement('iframe');
    f.setAttribute('scrolling','no');
    f.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:transparent;visibility:hidden;';
    var rec = { el: f, kind: 'scene', ready: null };
    rec.ready = new Promise(function(resolve){
      var deadline = Date.now() + 12000;
      (function poll(){
        var win = null; try { win = f.contentWindow; } catch(e){}
        var bridged = false; try { bridged = !!(win && (win.__clock || win.__updateScene)); } catch(e){}
        if (bridged || Date.now() > deadline) { resolve(); return; }
        setTimeout(poll, 80);
      })();
    });
    f.src = url;
    stage.appendChild(f);
    pool[key] = rec;
    return rec.ready;
  }
  // Bare video clip → a top-level <video>. DECODE-READINESS GATE (OV-4): unlike a
  // scene iframe (which polls __clock for 12s before any seek), a freshly-mounted
  // <video> is readyState 0/1, so seeking + capturePage would grab a BLACK frame.
  // We resolve ready only at readyState >= HAVE_CURRENT_DATA (2). Muted autoplay
  // is what actually decodes frames in the offscreen GPU window (the Problem-A lesson).
  function mountVideo(key, url){
    var v = document.createElement('video');
    v.muted = true; v.autoplay = true; v.setAttribute('playsinline',''); v.preload = 'auto';
    v.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;transform-origin:0 0;visibility:hidden;';
    var rec = { el: v, kind: 'video', ready: null };
    rec.ready = new Promise(function(resolve){
      var deadline = Date.now() + 12000; var done = false;
      function ok(){ if(done) return; done = true; resolve(); }
      v.addEventListener('loadeddata', ok, { once: true });
      (function poll(){ if (done) return; if (v.readyState >= 2 || Date.now() > deadline) { ok(); return; } setTimeout(poll, 50); })();
    });
    v.src = url;
    stage.appendChild(v);
    pool[key] = rec;
    return rec.ready;
  }
  function mountImage(key, url){
    var img = document.createElement('img');
    img.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;transform-origin:0 0;visibility:hidden;';
    var rec = { el: img, kind: 'image', ready: null };
    rec.ready = new Promise(function(resolve){
      var deadline = Date.now() + 12000; var done = false;
      function ok(){ if(done) return; done = true; resolve(); }
      img.addEventListener('load', ok, { once: true });
      img.addEventListener('error', ok, { once: true });
      (function poll(){ if (done) return; if ((img.complete && img.naturalWidth > 0) || Date.now() > deadline) { ok(); return; } setTimeout(poll, 50); })();
    });
    img.src = url;
    stage.appendChild(img);
    pool[key] = rec;
    return rec.ready;
  }
  function mount(key, url, kind){
    if (pool[key]) return pool[key].ready;
    if (kind === 'video') return mountVideo(key, url);
    if (kind === 'image') return mountImage(key, url);
    return mountScene(key, url);
  }
  // Seek a top-level media <video> directly (await 'seeked' + 400ms capture-anyway).
  function seekMediaVideo(v, t){
    try {
      if (Math.abs((v.currentTime||0) - t) < 0.01) return Promise.resolve();
      return new Promise(function(res){
        var done = false;
        var to = setTimeout(function(){ if(!done){ done = true; res(); } }, 400);
        function h(){ if(done) return; done = true; clearTimeout(to); v.removeEventListener('seeked', h); res(); }
        v.addEventListener('seeked', h);
        try { v.currentTime = t; } catch(e){ if(!done){ done = true; clearTimeout(to); res(); } }
      });
    } catch(e){ return Promise.resolve(); }
  }
  // Drive the scene's deterministic clock directly from the host (same-origin) —
  // the same hooks as export-tier3 seekExpr, no eval into the iframe.
  function seekWindow(win, t, isVideo){
    try {
      if (win.__clock) {
        // timeline + tick subscribers + draw(t) + __updateScene(t) + seek callbacks
        var st = win.__clock.seek(Math.max(0, Math.min(t, win.__clock.duration())));
        if (win.document.getAnimations) { try { win.document.getAnimations().forEach(function(a){ try { a.currentTime = st*1000; a.pause(); } catch(e){} }); } catch(e){} }
      } else if (typeof win.__updateScene === 'function') {
        try { win.__updateScene(t); } catch(e){}
      }
    } catch(e){}
    if (!isVideo) return Promise.resolve();
    var vids; try { vids = win.document.querySelectorAll('video'); } catch(e){ return Promise.resolve(); }
    if (!vids || !vids.length) return Promise.resolve();
    var proms = [];
    for (var i=0;i<vids.length;i++){
      (function(v){
        try {
          if (Math.abs((v.currentTime||0) - t) < 0.01) return;
          proms.push(new Promise(function(res){
            var done = false;
            var to = setTimeout(function(){ if(!done){ done = true; res(); } }, 400); // D2 capture-anyway
            function h(){ if(done) return; done = true; clearTimeout(to); v.removeEventListener('seeked', h); res(); }
            v.addEventListener('seeked', h);
            try { v.currentTime = t; } catch(e){ if(!done){ done = true; clearTimeout(to); res(); } }
          }));
        } catch(e){}
      })(vids[i]);
    }
    return Promise.all(proms);
  }
  async function renderFrameAt(layers){
    var active = {};
    for (var i=0;i<layers.length;i++){
      var L = layers[i];
      active[L.layerKey] = 1;
      await mount(L.layerKey, L.url, L.kind);
      var el = pool[L.layerKey].el;
      el.style.zIndex = String(L.z);
      el.style.opacity = String(L.opacity);
      el.style.visibility = 'visible';
      // Resolved element style — media only; scene iframes stay full-frame
      // untouched (keeps the validated scene path byte-identical). transform carries
      // keyframe-evaluated translate/rotate/scale; filter + mix-blend-mode are the
      // CSS filter/blend. All precomputed by compositeLayerToElementStyle.
      if (L.kind !== 'scene') {
        if (L.gradeSvg) injectGradeSvg(L.gradeSvg);
        el.style.transform = L.transform || '';
        el.style.filter = L.filter || '';
        el.style.mixBlendMode = L.mixBlendMode || '';
      } else {
        // A graded media-asset scene: a WebGL pass can't sample an iframe, so the
        // CSS+SVG grade tier is applied to the iframe itself (LUT/hue are media-only).
        // Scenes keep their full-frame transform/blend untouched. Always assign so a
        // pooled iframe reused for an ungraded frame clears any stale filter.
        if (L.gradeSvg) injectGradeSvg(L.gradeSvg);
        el.style.filter = L.filter || '';
      }
      try {
        if (L.kind === 'video') { await seekMediaVideo(el, L.localT); }
        else if (L.kind === 'image') { /* still image, no seek */ }
        else { await seekWindow(el.contentWindow, L.localT, !!L.isVideoScene); }
      } catch(e){}
      // Tier-B grade: now the source is seeked, draw it through the shader onto the
      // layer's 2D canvas and show that. On no-GL / undecoded source, applyGrade
      // returns false and the raw element stays visible (honest fallback).
      if (L.kind !== 'scene'){
        var rec = pool[L.layerKey];
        if (L.gradeGL){
          if (!applyGrade(rec, L) && rec && rec.glOut) rec.glOut.style.visibility = 'hidden';
        } else if (rec && rec.glOut){
          rec.glOut.style.visibility = 'hidden'; // grade cleared → show the raw element
        }
      }
    }
    // Inactive layers: scenes stay POOLED (sourceId-keyed, bounded by scene count,
    // cheap to re-seek). Media is clipId-keyed and UNBOUNDED — a still-mounted
    // <video> keeps a live decoder + autoplay keeps advancing currentTime, so a
    // footage-heavy timeline would exhaust Chromium's decoder cap / OOM. EVICT
    // inactive media (pause + remove + drop from pool) to bound the live set to
    // what's on screen; a clip's active range is contiguous so it won't remount.
    var toEvict = [];
    for (var id in pool){
      if (active[id]) continue;
      var rec = pool[id];
      if (rec.kind === 'scene') { rec.el.style.visibility = 'hidden'; continue; }
      try { if (rec.kind === 'video' && typeof rec.el.pause === 'function') rec.el.pause(); } catch(e){}
      try { rec.el.removeAttribute('src'); } catch(e){}
      try { if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); } catch(e){}
      try { if (rec.glOut && rec.glOut.parentNode) rec.glOut.parentNode.removeChild(rec.glOut); } catch(e){}
      toEvict.push(id);
    }
    for (var j=0;j<toEvict.length;j++) delete pool[toEvict[j]];
    // NO rAF paint-ack: the main process flushes via invalidate() + settle sleep.
    return layers.length; // 0 = gap (all hidden → black stage shows through)
  }
  window.__composite = { mount: mount, renderFrameAt: renderFrameAt, registerLut: registerLut, _pool: pool };
})();
`

/** One layer as the host controller consumes it (a CompositeLayer + how to load + seek it). */
export interface CompositeLayerInstruction {
  /** scene → iframe; video → `<video>`; image → `<img>`. */
  kind: CompositeLayerKind
  /** Host pool key (scene→sceneId, media→clipId) — mirrors CompositeLayer.layerKey. */
  layerKey: string
  /** dreambyte://scenes/<file> for scenes, or the resolved media file URL for video/image. */
  url: string
  localT: number
  z: number
  opacity: number
  /** Scene-only: the scene HTML contains a `<video>` to frame-seek. Ignored for media. */
  isVideoScene: boolean
  /** Resolved element style (A3, media only) — from `compositeLayerToElementStyle`. */
  transform: string
  filter: string
  mixBlendMode: string
  /** Color-grade <filter> markup to inject once (CSS tier) so `filter`'s url(#id) resolves. '' = none. */
  gradeSvg: string
  /**
   * Tier-B grade (LUT / hue curves): the serializable shader uniform payload. Present
   * only for `tier === 'webgl'` layers; the host grades the seeked source frame through
   * the GPU and shows the result. Absent for css/none (the common path stays untouched).
   * The LUT is registered once by url (`registerLut`) and referenced via `gradeGL.lutUrl`.
   */
  gradeGL?: GradeGLPayload
}

/**
 * Build the offscreen host page. Black background so true gaps (empty layer set)
 * and partially-covered frames composite over black, never transparent. Media
 * elements fill the stage (object-fit:fill = the Pixi stretch) and the controller
 * applies their per-clip transform from `transform-origin:0 0`.
 */
export function buildCompositeHostHtml(width: number, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#000;width:${width}px;height:${height}px;overflow:hidden;}
  #stage{position:absolute;top:0;left:0;width:${width}px;height:${height}px;background:#000;}
  #stage iframe{position:absolute;top:0;left:0;width:${width}px;height:${height}px;}
  #stage video,#stage img,#stage canvas{position:absolute;top:0;left:0;width:${width}px;height:${height}px;object-fit:fill;transform-origin:0 0;}
  </style></head><body><div id="stage"></div>` +
    // Tier-B grade shaders, injected once so the controller's single GL context grades
    // LUT/hue-curve clips with the SAME source as the preview pool (preview == export).
    `<script>window.__GRADE_SHADERS=${JSON.stringify({ vert: GRADE_VERTEX_SHADER, frag: GRADE_FRAGMENT_SHADER })};</script>` +
    `<script>${COMPOSITE_CONTROLLER_SRC}</script></body></html>`
}

/**
 * Resolve a composite frame plan into host-controller layer instructions. Pure:
 * `resolve(layer)` returns the load URL (scene HTML for scenes, media file for
 * video/image) + whether a scene contains a `<video>`. A layer that doesn't
 * resolve is dropped. Returns [] for a gap.
 */
export function planToInstructions(
  plan: CompositeFramePlan,
  resolve: (layer: CompositeLayer) => { url: string; isVideoScene: boolean } | null,
): CompositeLayerInstruction[] {
  if (plan.isGap) return []
  const out: CompositeLayerInstruction[] = []
  for (const layer of plan.layers) {
    const r = resolve(layer)
    if (!r) continue
    const style = compositeLayerToElementStyle(layer)
    out.push({
      kind: layer.kind,
      layerKey: layer.layerKey,
      url: r.url,
      localT: layer.localT,
      z: layer.z,
      opacity: layer.opacity,
      isVideoScene: r.isVideoScene,
      transform: style.transform,
      filter: style.filter,
      mixBlendMode: style.mixBlendMode,
      gradeSvg: style.grade?.tier === 'css' ? style.grade.svgFilterMarkup : '',
      // Tier-B grades carry their GPU uniform payload; everything else omits the field.
      ...(style.grade?.tier === 'webgl' ? { gradeGL: buildGradeGLPayload(style.grade.raw) } : {}),
    })
  }
  return out
}
