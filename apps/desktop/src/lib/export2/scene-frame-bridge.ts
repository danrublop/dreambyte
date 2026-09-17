/**
 * Isolated scene frame for the pixi MP4 export.
 *
 * Scene code is untrusted (LLM-generated, or from an imported project). The
 * export renders it inside the app window, so the frame must never share the
 * app's origin: a `srcdoc` (or about:blank / blob:) iframe with `allow-same-origin`
 * inherits `dreambyte://app` and can reach `window.parent.dreambyteApi` (full IPC).
 *
 * The frame is therefore a `data:` URL — always its own OPAQUE origin — that
 * receives the scene HTML over postMessage and document.write()s it into itself
 * (no URL length limit, origin unchanged). It can't touch the parent window, its
 * DOM, or the preload APIs. The sandbox keeps `allow-same-origin` only so the
 * frame keeps that opaque origin instead of a fresh one per child: html2canvas
 * clones the page into a child about:blank iframe and must be able to read it.
 * (A plain `allow-scripts` sandbox isolates too, but breaks every DOM capture.)
 *
 * Without same-origin access the parent can't read the frame's canvases/DOM, so
 * a small capture agent is injected into the scene HTML. The parent drives it
 * over postMessage:
 *   probe        → { childCount }   (-1 when the scene has no __clock)
 *   frame(time)  → { bitmap }       __clock.seek(t) + WAAPI seek, then the same
 *                                   per-type capture
 *                                   (canvas copy / SVG raster / html2canvas),
 *                                   returned as a transferred ImageBitmap.
 * Frames are requested one at a time and awaited, so capture stays frame-exact.
 * Replies are accepted only from this iframe's window and only as ImageBitmaps,
 * so a scene can at worst corrupt its own frames.
 */

/** Sandbox tokens for the export frame. Safe ONLY with the data: loader below — never with srcdoc. */
export const EXPORT_FRAME_SANDBOX = 'allow-scripts allow-same-origin'

/** The export frame's URL: an opaque-origin page that writes the scene HTML it is sent into itself. */
export const EXPORT_FRAME_LOADER_URL =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!DOCTYPE html><script>addEventListener('message', function (e) {
  var d = e.data;
  if (e.source !== parent || !d || d.target !== 'dreambyte-export' || d.type !== 'load') return;
  document.open(); document.write(d.html); document.close();
});</script>`,
  )

/** Loaded inside the scene frame (resolved against the scene's <base href>). */
const HTML2CANVAS_SRC = '/vendor/html2canvas/html2canvas.min.js'

function captureAgent(width: number, height: number, sceneType: string, captureScale: number): string {
  return `(function () {
  var W = ${width}, H = ${height}, TYPE = ${JSON.stringify(sceneType)}, SCALE = ${captureScale};
  var h2c = null;
  // The playback controller queues timers / rAF while paused (always, during export).
  // html2canvas needs real ones, so capture runs with the natives captured here
  // (this agent runs before any scene script) and the scene's versions are restored after.
  var TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'];
  var NATIVE = {};
  TIMERS.forEach(function (k) { NATIVE[k] = window[k]; });
  async function withNativeTimers(fn) {
    var scene = {};
    TIMERS.forEach(function (k) { scene[k] = window[k]; window[k] = NATIVE[k]; });
    try { return await fn(); } finally { TIMERS.forEach(function (k) { window[k] = scene[k]; }); }
  }
  // Assets live on other origins now (dreambyte://app, uploads …, all served with
  // ACAO *). Request scripted images with CORS so a scene that draws one into its
  // canvas doesn't taint it — a tainted frame can't be posted back to the exporter.
  // Covers img.src set from script (canvas/three loaders); parser-created
  // <img> taint only if drawn to a canvas, DOM capture refetches via html2canvas useCORS.
  try {
    var imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: imgSrc.enumerable, get: imgSrc.get,
      set: function (v) {
        if (this.getAttribute('crossorigin') === null && !/^(data|blob):/i.test(String(v))) this.crossOrigin = 'anonymous';
        imgSrc.set.call(this, v);
      }
    });
  } catch (e) {}
  function loadHtml2canvas() {
    if (!h2c) {
      h2c = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = ${JSON.stringify(HTML2CANVAS_SRC)};
        s.onload = function () { resolve(window.html2canvas || null); };
        s.onerror = function () { resolve(null); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return h2c;
  }
  function inlineComputedStyles(clone, source) {
    try {
      var computed = getComputedStyle(source);
      for (var i = 0; i < computed.length; i++) clone.style.setProperty(computed[i], computed.getPropertyValue(computed[i]));
    } catch (e) {}
    var sc = source.children, cc = clone.children;
    for (var j = 0; j < cc.length && j < sc.length; j++) inlineComputedStyles(cc[j], sc[j]);
  }
  async function captureDom(ctx) {
    var html2canvas = await loadHtml2canvas();
    if (!html2canvas) throw new Error('html2canvas failed to load');
    if (!document.body) return false;
    var result = await html2canvas(document.body, {
      scale: SCALE, width: W, height: H, useCORS: true, allowTaint: true, backgroundColor: null, logging: false
    });
    ctx.drawImage(result, 0, 0, W, H);
    return true;
  }
  function captureD3(ctx) {
    var chartCanvas = document.querySelector('#chart canvas');
    if (chartCanvas) { ctx.drawImage(chartCanvas, 0, 0, W, H); return Promise.resolve(true); }
    var chart = document.getElementById('chart');
    if (!chart) return Promise.resolve(false);
    var svg = chart.querySelector('svg');
    if (!svg) return captureDom(ctx);
    var clone = svg.cloneNode(true);
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(W));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(H));
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    inlineComputedStyles(clone, svg);
    var url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url); resolve(true); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(false); };
      img.src = url;
    });
  }
  async function frame(t) {
    var clock = window.__clock;
    if (clock) {
      var seekTime = clock.seek(Math.max(0, Math.min(t, clock.duration())));
      // WebGL needs a tick for the GPU to finish rendering after seek
      if (TYPE === 'three' || TYPE === 'zdog' || TYPE === '3d_world') await new Promise(function (r) { NATIVE.setTimeout.call(window, r, 5); });
      try {
        document.getAnimations().forEach(function (a) { a.currentTime = seekTime * 1000; a.pause(); });
      } catch (e) {}
    }
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var bg = document.body ? getComputedStyle(document.body).backgroundColor : '';
    if (bg && bg !== 'rgba(0, 0, 0, 0)') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    var captured = false, error = null;
    try {
      if (TYPE === 'canvas2d') {
        var c = document.getElementById('c');
        if (c) { ctx.drawImage(c, 0, 0, W, H); captured = true; }
        else captured = await withNativeTimers(function () { return captureDom(ctx); }); // e.g. the regenerate placeholder (a DOM scene)
      } else if (TYPE === 'three' || TYPE === 'zdog') {
        var g = document.querySelector('canvas');
        if (g) { ctx.drawImage(g, 0, 0, W, H); captured = true; }
        else captured = await withNativeTimers(function () { return captureDom(ctx); });
      } else if (TYPE === 'd3') {
        captured = await withNativeTimers(function () { return captureD3(ctx); });
      } else {
        captured = await withNativeTimers(function () { return captureDom(ctx); });
      }
    } catch (e) { error = String(e); }
    return { bitmap: await createImageBitmap(out), captured: captured, error: error };
  }
  function reply(msg, transfer) {
    msg.source = 'dreambyte-export';
    try {
      window.parent.postMessage(msg, '*', transfer || []);
    } catch (e) {
      // e.g. DataCloneError for a canvas tainted by a non-CORS asset: answer
      // anyway so the exporter logs a failed frame instead of waiting it out.
      window.parent.postMessage({ source: 'dreambyte-export', type: msg.type, id: msg.id, bitmap: null, captured: false, error: String(e) }, '*');
    }
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.source !== window.parent || !d || d.target !== 'dreambyte-export') return;
    if (d.type === 'probe') {
      reply({ type: 'probe', id: d.id, childCount: window.__clock ? window.__clock.childCount() : -1 });
    } else if (d.type === 'frame') {
      frame(d.time).then(
        function (r) { reply({ type: 'frame', id: d.id, bitmap: r.bitmap, captured: r.captured, error: r.error }, [r.bitmap]); },
        function (e) { reply({ type: 'frame', id: d.id, bitmap: null, captured: false, error: String(e) }); }
      );
    }
  });
})();`
}

/** Scene HTML with the capture agent injected first in <head> (before any scene script), else prepended. */
export function withCaptureAgent(html: string, width: number, height: number, sceneType: string, captureScale: number) {
  const tag = `<script data-dreambyte-export-agent>${captureAgent(width, height, sceneType, captureScale)}</script>`
  const m = /<head\b[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html
}

export interface SceneFrameBridge {
  /** Timeline child count, or -1 when the scene exposes no __clock. */
  childCount(): Promise<number>
  /** Seek to `timeSec` and capture the frame (null if the frame didn't answer). */
  capture(timeSec: number): Promise<{ bitmap: ImageBitmap | null; captured: boolean; error?: string }>
  dispose(): void
}

export async function openSceneFrameBridge(opts: {
  html: string
  width: number
  height: number
  sceneType: string
  sceneId?: string
  captureScale: number
  readyTimeoutMs: number
}): Promise<SceneFrameBridge> {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.left = '-20000px'
  iframe.style.top = '0'
  iframe.style.width = `${opts.width}px`
  iframe.style.height = `${opts.height}px`
  iframe.style.opacity = '0'
  iframe.style.pointerEvents = 'none'
  iframe.setAttribute('sandbox', EXPORT_FRAME_SANDBOX)
  iframe.src = EXPORT_FRAME_LOADER_URL

  let nextId = 0
  const request = <T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T | null> =>
    new Promise((resolve) => {
      const id = ++nextId
      const done = (value: T | null) => {
        clearTimeout(timer)
        window.removeEventListener('message', onMsg)
        resolve(value)
      }
      const onMsg = (ev: MessageEvent) => {
        const d = ev.data
        if (ev.source !== iframe.contentWindow || !d || d.source !== 'dreambyte-export' || d.id !== id) return
        done(d as T)
      }
      const timer = window.setTimeout(() => done(null), timeoutMs)
      window.addEventListener('message', onMsg)
      iframe.contentWindow?.postMessage({ target: 'dreambyte-export', id, ...msg }, '*')
    })

  const ready = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`${opts.sceneType} iframe ready timeout`))
    }, opts.readyTimeoutMs)
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data
      if (ev.source !== iframe.contentWindow || !d || d.source !== 'dreambyte-scene' || d.type !== 'ready') return
      if (opts.sceneId && d.sceneId && d.sceneId !== opts.sceneId) return
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
    }
    window.addEventListener('message', onMsg)
  })
  iframe.addEventListener(
    'load',
    () =>
      iframe.contentWindow?.postMessage(
        {
          target: 'dreambyte-export',
          type: 'load',
          html: withCaptureAgent(opts.html, opts.width, opts.height, opts.sceneType, opts.captureScale),
        },
        '*',
      ),
    { once: true },
  )
  document.body.appendChild(iframe)
  try {
    await ready
  } catch (err) {
    iframe.remove()
    throw err
  }

  return {
    async childCount() {
      const r = await request<{ childCount: number }>({ type: 'probe' }, 2000)
      return r ? r.childCount : -1
    },
    async capture(timeSec) {
      // Generous per-frame cap; a wedged frame yields a blank frame, not a hung export.
      const r = await request<{ bitmap: unknown; captured: boolean; error?: string | null }>(
        { type: 'frame', time: timeSec },
        30000,
      )
      const bitmap = r && typeof ImageBitmap !== 'undefined' && r.bitmap instanceof ImageBitmap ? r.bitmap : null
      const error = r ? (r.error ?? undefined) : 'frame did not answer'
      return { bitmap, captured: !!(r && r.captured && bitmap), error }
    },
    dispose() {
      try {
        iframe.remove()
      } catch {}
    },
  }
}
