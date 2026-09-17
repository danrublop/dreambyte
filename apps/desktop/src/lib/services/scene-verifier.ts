/**
 * Scene verifier.
 *
 * After a scene HTML file is written to <userData>/scenes/{id}.html, the
 * Electron main process loads it in an offscreen BrowserWindow and reports
 * back one of:
 *
 *   verified  — script evaluated cleanly AND the page either ticked at least
 *               one animation frame OR reached document.readyState='complete'
 *               with no JS at all (CSS-only scenes are valid).
 *   errored   — script threw at eval, raised an uncaught error/rejection
 *               during the warm-up window, or hit the wall-clock timeout.
 *   unknown   — verifier infrastructure was unavailable (dreambyte:// not yet
 *               registered, no Electron app context, or it raised). Caller
 *               must NOT block on `unknown`; treat as "couldn't verify".
 *
 * Pool: at most `MAX_CONCURRENT` (default 2) hidden BrowserWindows are alive
 * at once. New verify calls queue. Each window is destroyed and recreated
 * when it hits the wall-clock timeout (the only way to recover from a
 * `while(true)` script).
 *
 * The window is loaded with a verifier preload (src/electron/verifier-preload.ts)
 * which installs `window.__dreambyteVerify = { ticks, error }`. The verifier
 * polls those counters via executeJavaScript.
 */

import path from 'node:path'

import type { SceneVerifyError } from '@/lib/db/schema'

export type SceneVerifyStatus = 'unknown' | 'pending' | 'verifying' | 'verified' | 'errored'

/**
 * A single text run that spills outside the scene frame at the settled frame.
 * `id` is a human identifier (tag + truncated text), `edges` are the sides it
 * exceeds, `overflowPx` is the largest spill past any edge (rounded).
 *
 * Future: this advisory channel could later carry contrast / animation-map
 * findings too. Contrast is intentionally out of scope here — it needs pixel
 * sampling over canvas/gradient backgrounds (high false-positive risk).
 */
export interface SceneOverflow {
  id: string
  edges: Array<'left' | 'right' | 'top' | 'bottom'>
  overflowPx: number
}

/**
 * Pixel-truth signal for the settled frame. Unlike overflow (a DOM-geometry
 * advisory), this is the one BLOCKING render check: it answers "did the scene
 * actually draw anything, and did its images load?" — the class of failure
 * where the code runs cleanly (status `verified`) but the audience sees a blank
 * or broken frame. Captured via the offscreen window's rendered pixels, so it
 * works for canvas/three/react/motion alike (no single canvas to read).
 *
 * - `nonblankRatio`: fraction of sampled pixels that differ from the dominant
 *   (background) color, 0..1. A real render has content pixels; a failed render
 *   is a single uniform color → ratio ≈ 0.
 * - `brokenImages` / `totalImages`: <img> elements that are `complete &&
 *   naturalWidth === 0` (load failed) vs. how many exist.
 *
 * The consumer (tool-executor post-tool gate) applies the block policy; this
 * module only measures. Omitted when measurement couldn't run (no Electron, an
 * empty capture, or a thrown probe) so an inability to measure NEVER blocks.
 */
export interface SceneFrameTruth {
  nonblankRatio: number
  /** Quantized colors holding ≥0.1% of samples. The content-presence signal:
   *  a blank/failed render is 1 uniform color; a minimal real scene is ≥2. */
  distinctColors?: number
  brokenImages: number
  totalImages: number
}

export interface SceneVerifyOutcome {
  status: SceneVerifyStatus
  error: SceneVerifyError | null
  verifiedAt: number
  durationMs: number
  /**
   * Leaf text runs that overflow the frame at the settled hold frame. Present
   * (possibly empty) only when the scene VERIFIED and the in-page measurement
   * ran cleanly. Omitted (undefined) when the scene didn't verify, when there's
   * no Electron context, or when the measurement itself failed — exactly like
   * the existing graceful degradation. Advisory only: this NEVER changes
   * `status`. A scene with overflowing text still verifies (it ran) — overflow
   * is a quality signal, not an error.
   */
  overflows?: SceneOverflow[]
  /**
   * Pixel-truth of the settled frame (blank / broken-image detection). Present
   * (possibly with `nonblankRatio` ≈ 0) only when the scene VERIFIED and the
   * capture+probe ran. Omitted when it couldn't be measured. The post-tool gate
   * turns a confident blank/all-broken reading into a hard failure; everything
   * else here is informational. NEVER changes `status` (status = "did it run").
   */
  frame?: SceneFrameTruth
}

interface VerifyOptions {
  /** Max wall-clock the entire verify can take. Default 5000ms. */
  timeoutMs?: number
  /** Time to wait for the first RAF tick before falling back to the no-JS path. Default 1000ms. */
  rafWaitMs?: number
  /** Total warm-up before declaring "verified" if no error fired. Default 2000ms. */
  warmupMs?: number
}

const MAX_CONCURRENT = 2
// G3 pre-ship gate (v0.3.0): bumped timeouts to accommodate scenes with
// expensive first-paint (ThreeJS HDRI environment, large React trees,
// data-fetching D3 charts). The verifier short-circuits on first RAF tick
// when one fires, so these are upper bounds for slow scenes — fast scenes
// still verify quickly.
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_RAF_WAIT_MS = 3000
const DEFAULT_WARMUP_MS = 3000
const POLL_INTERVAL_MS = 100

interface ProbeSnapshot {
  ticks: number
  error: SceneVerifyError | null
  readyState: DocumentReadyState
  installed: boolean
}

// We import Electron lazily so this module loads cleanly under Node tests
// without dragging the whole runtime in. Tests inject a mock via setVerifierEnv.
type ElectronModule = typeof import('electron')

interface VerifierEnv {
  electron: ElectronModule | null
  preloadPath: string | null
}

let env: VerifierEnv | null = null

function loadEnv(): VerifierEnv {
  if (env) return env
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as ElectronModule
    // verifier-preload.js sits next to main.js inside dist-electron/. The
    // bundler emits both, and __dirname at runtime is the directory of the
    // executing main.js bundle.
    const preloadPath = path.join(__dirname, 'verifier-preload.js')
    env = { electron, preloadPath }
  } catch {
    env = { electron: null, preloadPath: null }
  }
  return env
}

/**
 * Test seam: inject a mock Electron module + preload path. Tests pass `null`
 * to simulate "no Electron available", which forces the verifier to return
 * `unknown` without ever opening a window. Also drains the live pool so the
 * next test starts with a clean slate (the pool would otherwise hold a
 * window built against the previous test's fake).
 */
export function setVerifierEnv(next: VerifierEnv | null): void {
  env = next
  while (pool.length) pool.pop()
  waiters.length = 0
}

interface PooledWindow {
  win: import('electron').BrowserWindow
  inUse: boolean
}

const pool: PooledWindow[] = []
const waiters: Array<(slot: PooledWindow) => void> = []

function createWindow(): PooledWindow | null {
  const e = loadEnv()
  if (!e.electron || !e.preloadPath) return null
  const win = new e.electron.BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      preload: e.preloadPath,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  // Suppress devtools popups, surrender video / audio playback.
  win.webContents.setAudioMuted(true)
  const slot: PooledWindow = { win, inUse: false }
  pool.push(slot)
  return slot
}

async function acquireSlot(): Promise<PooledWindow | null> {
  for (const slot of pool) {
    if (!slot.inUse && !slot.win.isDestroyed()) {
      slot.inUse = true
      return slot
    }
  }
  if (pool.filter((s) => !s.win.isDestroyed()).length < MAX_CONCURRENT) {
    const slot = createWindow()
    if (!slot) return null
    slot.inUse = true
    return slot
  }
  return new Promise<PooledWindow | null>((resolve) => {
    waiters.push((slot) => {
      slot.inUse = true
      resolve(slot)
    })
  })
}

function releaseSlot(slot: PooledWindow): void {
  slot.inUse = false
  const waiter = waiters.shift()
  if (waiter) waiter(slot)
}

function destroyAndReplace(slot: PooledWindow): void {
  const idx = pool.indexOf(slot)
  if (idx !== -1) pool.splice(idx, 1)
  if (!slot.win.isDestroyed()) slot.win.destroy()
  // Don't eagerly recreate; next acquireSlot call will spin up a fresh one.
  const waiter = waiters.shift()
  if (!waiter) return
  const next = createWindow()
  if (next) waiter(next)
  else waiters.unshift(waiter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readProbe(slot: PooledWindow): Promise<ProbeSnapshot | null> {
  if (slot.win.isDestroyed()) return null
  try {
    return (await slot.win.webContents.executeJavaScript(
      `(function() {
        var p = window.__dreambyteVerify;
        return {
          ticks: p ? p.ticks : 0,
          error: p ? p.error : null,
          readyState: document.readyState,
          installed: !!p,
        };
      })()`,
      true,
    )) as ProbeSnapshot
  } catch {
    return null
  }
}

/** Cap on how many overflow entries we surface — the agent only needs the worst. */
const MAX_OVERFLOWS = 10
/** Tolerance (px in frame coords) before a spill counts — kills sub-pixel/rounding noise. */
const OVERFLOW_TOLERANCE_PX = 8

/**
 * In-page script (string) that seeks the master timeline to the settled hold
 * frame, then measures every LEAF TEXT element against the scene root's frame
 * box and returns the ones that spill past an edge by more than the tolerance.
 *
 * Why a settled frame: entrance animations legitimately park elements off-frame
 * early, so measuring at t=0 produces false positives. Per the timing rules,
 * content is in its hold state at ~80-100% of DURATION; we seek to 85%.
 *
 * Why the root's getBoundingClientRect as the frame box: the offscreen window
 * may apply a CSS transform-scale, which would skew document/WIDTH coords.
 * Reading the root's own rect keeps the comparison scale-invariant. If no root
 * is found we fall back to {0,0,WIDTH,HEIGHT} document coords.
 *
 * The whole body is wrapped in try/catch and returns [] on any failure so a
 * measurement error can NEVER break verification.
 */
const OVERFLOW_PROBE_JS = `(function() {
  try {
    var clock = window.__clock;
    if (clock) {
      try {
        clock.pause();
        var dur = clock.duration() || window.DURATION || 5;
        clock.seek(Math.max(0, dur * 0.85));
      } catch (e) {}
    }
    // Force a synchronous reflow so the seeked frame's layout is committed.
    void document.body.offsetHeight;

    var W = (typeof window.WIDTH === 'number' ? window.WIDTH : 0) || window.innerWidth || 0;
    var H = (typeof window.HEIGHT === 'number' ? window.HEIGHT : 0) || window.innerHeight || 0;

    // Find the scene root container: prefer well-known ids, else the body's
    // first sized element child. Its rect is the scale-invariant frame box.
    var root = document.getElementById('scene-root')
      || document.getElementById('react-root')
      || document.getElementById('root');
    if (!root) {
      var kids = document.body ? document.body.children : [];
      for (var i = 0; i < kids.length; i++) {
        var r0 = kids[i].getBoundingClientRect();
        if (r0.width > 0 && r0.height > 0) { root = kids[i]; break; }
      }
    }
    var frame;
    if (root) {
      var rr = root.getBoundingClientRect();
      frame = { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom };
    } else {
      // Document-coordinate fallback.
      frame = { left: 0, top: 0, right: W, bottom: H };
    }

    var TOL = ${OVERFLOW_TOLERANCE_PX};
    var out = [];
    var all = document.body ? document.body.querySelectorAll('*') : [];
    // Bound the scan: a clean scene never short-circuits on out.length, so cap
    // the per-element style+rect work on huge Three/D3 DOMs (one-shot, offscreen).
    var LIMIT = Math.min(all.length, 4000);
    for (var j = 0; j < LIMIT && out.length < ${MAX_OVERFLOWS}; j++) {
      var el = all[j];
      // Measure any element with DIRECT text content (a non-empty text node
      // child), not just leaves — so multi-run headings like
      // <h1>The <span>Big</span> Title</h1> (element children + their own text
      // runs) are still checked. That styled-title case is the most common
      // overflow, and a leaf-only filter silently missed it.
      var hasDirectText = false;
      var cn = el.childNodes;
      for (var k = 0; k < cn.length; k++) {
        if (cn[k].nodeType === 3 && (cn[k].nodeValue || '').trim()) { hasDirectText = true; break; }
      }
      if (!hasDirectText) continue;
      var text = (el.textContent || '').trim();
      if (!text) continue;

      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity || '1') === 0) continue;

      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // not visible / zero-size

      var edges = [];
      var maxPx = 0;
      var dl = frame.left - r.left;   if (dl > TOL) { edges.push('left'); if (dl > maxPx) maxPx = dl; }
      var dr = r.right - frame.right; if (dr > TOL) { edges.push('right'); if (dr > maxPx) maxPx = dr; }
      var dt = frame.top - r.top;     if (dt > TOL) { edges.push('top'); if (dt > maxPx) maxPx = dt; }
      var db = r.bottom - frame.bottom; if (db > TOL) { edges.push('bottom'); if (db > maxPx) maxPx = db; }
      if (edges.length === 0) continue;

      var tag = (el.tagName || 'el').toLowerCase();
      var snippet = text.length > 32 ? text.slice(0, 32) + '\\u2026' : text;
      out.push({ id: tag + ':"' + snippet + '"', edges: edges, overflowPx: Math.round(maxPx) });
    }
    return out;
  } catch (e) {
    return [];
  }
})()`

/**
 * Run the one-shot overflow measurement in the already-loaded, verified scene.
 * Best-effort: any failure (destroyed window, executeJavaScript throw) returns
 * `undefined` so the caller omits `overflows` and degrades gracefully —
 * NEVER let measurement affect the verify status.
 */
async function measureOverflows(slot: PooledWindow): Promise<SceneOverflow[] | undefined> {
  if (slot.win.isDestroyed()) return undefined
  try {
    const raw = (await slot.win.webContents.executeJavaScript(OVERFLOW_PROBE_JS, true)) as unknown
    if (!Array.isArray(raw)) return undefined
    const overflows: SceneOverflow[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const o = item as Partial<SceneOverflow>
      if (typeof o.id !== 'string' || !Array.isArray(o.edges) || typeof o.overflowPx !== 'number') continue
      overflows.push({ id: o.id, edges: o.edges as SceneOverflow['edges'], overflowPx: o.overflowPx })
      if (overflows.length >= MAX_OVERFLOWS) break
    }
    return overflows
  } catch {
    return undefined
  }
}

/**
 * In-page probe (string): count broken <img> elements and read the per-scene
 * blank opt-out. A scene that legitimately renders near-uniform (rare) can set
 * `window.__dreambyteAllowBlank = true` to suppress the blank gate.
 */
const FRAME_DOM_PROBE_JS = `(function() {
  try {
    var imgs = document.images ? Array.prototype.slice.call(document.images) : [];
    var total = imgs.length, broken = 0;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.complete && im.naturalWidth === 0) broken++;
    }
    return { total: total, broken: broken, allowBlank: !!window.__dreambyteAllowBlank };
  } catch (e) {
    return { total: 0, broken: 0, allowBlank: false };
  }
})()`

/** Below this fraction of non-background pixels, the frame is treated as blank. */
const BLANK_FRAME_RATIO = 0.02
/** Cap on sampled pixels so the scan is cheap regardless of capture size. */
const MAX_PIXEL_SAMPLES = 5000

/**
 * Fraction of sampled pixels that differ from the dominant (modal) color.
 * The modal color is the background; a real render adds content pixels on top of
 * it, so a higher ratio means "something was drawn". A failed/blank render is a
 * single uniform color → ratio ≈ 0. Colors are quantized to 4 bits/channel so
 * anti-aliasing and gradients don't shatter the histogram. Pure function +
 * exported for unit tests (no Electron needed). `bitmap` is BGRA (Electron
 * NativeImage.getBitmap() order); the channel order does not affect the result.
 */
/** A quantized color holding at least this fraction of samples counts as a
 *  "significant" color — enough to be intentional content, not noise. 0.1%. */
const SIGNIFICANT_COLOR_FRACTION = 0.001

/**
 * Histogram stats over the frame: `nonblankRatio` (see computeNonblankRatio) and
 * `distinctColors` (how many quantized colors each hold ≥0.1% of samples). The
 * color count is the content-presence signal: a failed/blank render is ONE
 * uniform color (1); a minimal-but-real scene — a title card of solid
 * background + one headline — has the background plus a distinct text color
 * (≥2), even when 4-bit quantization folds the anti-aliased edges into the
 * background bucket and pushes nonblankRatio below the blank threshold.
 * Pure + exported for unit tests.
 */
export function computeFrameStats(bitmap: Buffer | Uint8Array): { nonblankRatio: number; distinctColors: number } {
  // Derive the pixel count from the BUFFER, never a passed width×height. Electron's
  // NativeImage.getSize() reports DIP while toBitmap() returns PHYSICAL pixels, so on
  // a 2× display width*height is 1/4 of the real pixel count — iterating that many
  // pixels samples only the top quarter of the frame and reads a bottom-weighted
  // scene as "blank" (false block). The histogram is order-independent, so layout
  // dims are irrelevant: treat every 4 bytes as one BGRA pixel.
  const px = Math.floor(bitmap.length / 4)
  if (px <= 0) return { nonblankRatio: 1, distinctColors: 0 }
  const stride = Math.max(1, Math.floor(px / MAX_PIXEL_SAMPLES))
  const counts = new Map<number, number>()
  let sampled = 0
  for (let i = 0; i < px; i += stride) {
    const o = i * 4
    const c0 = bitmap[o] >> 4
    const c1 = bitmap[o + 1] >> 4
    const c2 = bitmap[o + 2] >> 4
    const key = (c2 << 8) | (c1 << 4) | c0
    counts.set(key, (counts.get(key) ?? 0) + 1)
    sampled++
  }
  if (sampled === 0) return { nonblankRatio: 1, distinctColors: 0 }
  const minSignificant = sampled * SIGNIFICANT_COLOR_FRACTION
  let modal = 0
  let distinctColors = 0
  for (const c of counts.values()) {
    if (c > modal) modal = c
    if (c >= minSignificant) distinctColors++
  }
  return { nonblankRatio: 1 - modal / sampled, distinctColors }
}

export function computeNonblankRatio(bitmap: Buffer | Uint8Array): number {
  return computeFrameStats(bitmap).nonblankRatio
}

/** Representative HOLD times (as fractions of DURATION) sampled by the frame-truth
 *  capture. A valid scene animates in from opacity 0, so it is blank at t=0 but
 *  full by mid-scene; we measure the most-populated sample. Ordered
 *  most-likely-populated-first so the common (valid) case early-exits after the
 *  FIRST capture — same cost as the old single capture. A genuinely broken scene
 *  is blank at every sample and still blocks. */
export const FRAME_SAMPLE_FRACTIONS = [0.5, 0.75, 0.3]

/**
 * In-page script (string) that drives the scene to a representative HOLD time —
 * `window.DURATION * fraction` seconds — before the frame is captured. Capturing
 * the window's DEFAULT frame (t=0) read every animate-in scene as a false "blank
 * frame" and flipped it to failure; seeking past the entrance fixes that.
 *
 * Drives BOTH renderer kinds:
 *  - Controller scenes: `__clock.seek(t)` — renders the master timeline AND
 *    fires the onTick subscribers (the React bridge), so the React frame moves.
 *  - Pure-React (`useCurrentFrame`) scenes without the controller: when there is
 *    no `__clock`, push the frame directly via `__dreambyteSetFrame` (the hook the
 *    export path uses). fps is unknown in-page; 30 is the scene default and this
 *    fallback only runs when `__clock` is absent.
 * Best-effort: wrapped in try/catch, returns true/false, never throws.
 */
export function buildSeekProbeJs(fraction: number): string {
  return `(function(){
  try {
    var frac = ${fraction};
    var dur = (typeof window.DURATION === 'number' && window.DURATION) || 5;
    var t = Math.max(0, dur * frac);
    var clock = window.__clock;
    if (clock) {
      try { clock.pause(); } catch (e) {}
      try { clock.seek(t); } catch (e) {}
    } else if (typeof window.__dreambyteSetFrame === 'function') {
      try { window.__dreambyteSetFrame(Math.round(t * 30)); } catch (e) {}
    }
    // Belt-and-suspenders: nudge the scrub registry too, so a paused React scene
    // that subscribes via __dreambyte.onSeek updates even without a clock tick.
    try { if (window.__dreambyte && typeof window.__dreambyte.seek === 'function') window.__dreambyte.seek(t); } catch (e) {}
    void (document.body && document.body.offsetHeight);
    return true;
  } catch (e) { return false; }
})()`
}

/**
 * Measure pixel-truth of the (already verified) scene: nonblank ratio from the
 * captured frame + broken-image count from the DOM. Best-effort: any failure
 * (destroyed window, empty capture, probe throw) returns `undefined` so the
 * caller omits `frame` and NEVER blocks on an inability to measure. An explicit
 * `__dreambyteAllowBlank` opt-out forces a non-blank reading.
 */
async function measureFrameTruth(slot: PooledWindow): Promise<SceneFrameTruth | undefined> {
  if (slot.win.isDestroyed()) return undefined
  let total = 0
  let broken = 0
  let allowBlank = false
  try {
    const dom = (await slot.win.webContents.executeJavaScript(FRAME_DOM_PROBE_JS, true)) as {
      total?: number
      broken?: number
      allowBlank?: boolean
    } | null
    if (dom && typeof dom.total === 'number') {
      total = dom.total
      broken = typeof dom.broken === 'number' ? dom.broken : 0
      allowBlank = !!dom.allowBlank
    }
  } catch {
    // DOM probe failed — fall through with zero image counts.
  }
  let nonblankRatio = 1
  let distinctColors = 1
  if (!allowBlank) {
    // Sample a few representative HOLD frames (see FRAME_SAMPLE_FRACTIONS) and
    // keep the most-populated one. Seeking past the entrance is what stops a
    // valid animate-in scene from reading as a false blank; the multi-sample is
    // the safety net for scenes only briefly populated. Genuinely broken scenes
    // are blank at every sample and still block.
    let best: { nonblankRatio: number; distinctColors: number } | null = null
    for (const frac of FRAME_SAMPLE_FRACTIONS) {
      try {
        // Drive the scene to this hold time (covers timeline-DOM and pure-React).
        try {
          // Bounded: a scene whose seek handler stalls must not hang the verify.
          await Promise.race([
            slot.win.webContents.executeJavaScript(buildSeekProbeJs(frac), true),
            new Promise((r) => setTimeout(r, 1500)),
          ])
        } catch {
          // Seek failed for this sample — capture whatever is showing anyway.
        }
        // Offscreen GPU BrowserWindows do not reliably paint on their own, so a
        // bare capturePage() returns the still-unpainted surface and reports a
        // FALSE blank. The export/composite path flushes paint with invalidate()
        // + a short settle before capturing (src/electron/ipc/composite-host.ts);
        // mirror it here. The settle also gives React time to re-render after the
        // seek's setState.
        try {
          slot.win.webContents.invalidate()
        } catch {
          // window may be gone — capture below will no-op safely
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        // Bound capturePage — offscreen GPU captures can stall, and this runs on
        // every scene mutation's verify; an unbounded await let patch_layer_code
        // exceed the MCP client timeout. null on timeout → treated as a miss.
        const img = await Promise.race([
          slot.win.webContents.capturePage(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ])
        if (img && !img.isEmpty()) {
          const { width, height } = img.getSize()
          const bitmap = img.toBitmap()
          if (bitmap && bitmap.length > 0 && width > 0 && height > 0) {
            const stats = computeFrameStats(bitmap)
            if (!best || stats.nonblankRatio > best.nonblankRatio || stats.distinctColors > best.distinctColors) {
              best = stats
            }
            // This sample alone clears the blank gate (ratio OR ≥2 colors —
            // mirrors evaluateRenderBlock's pass test); stop, the scene is real.
            if (stats.nonblankRatio >= BLANK_FRAME_RATIO || stats.distinctColors >= 2) break
          }
        }
      } catch {
        // Capture unavailable for this sample — try the next fraction.
      }
    }
    // Adopt measured values only when a capture succeeded; otherwise leave the
    // non-blank defaults so we NEVER block on a measurement we couldn't take.
    if (best) {
      nonblankRatio = best.nonblankRatio
      distinctColors = best.distinctColors
    }
  }
  return { nonblankRatio, distinctColors, brokenImages: broken, totalImages: total }
}

/**
 * Run both post-verify quality measurements (overflow + frame-truth) on the
 * loaded window and return whichever succeeded. Single call site keeps the three
 * `verified` return paths DRY. Either field is omitted on a measurement miss.
 */
async function measureSceneQuality(
  slot: PooledWindow,
): Promise<{ overflows?: SceneOverflow[]; frame?: SceneFrameTruth }> {
  const overflows = await measureOverflows(slot)
  const frame = await measureFrameTruth(slot)
  return { ...(overflows ? { overflows } : {}), ...(frame ? { frame } : {}) }
}

export { BLANK_FRAME_RATIO }

export type RenderBlockKind = 'blank' | 'broken-images'

export interface RenderBlock {
  kind: RenderBlockKind
  /** Human-readable reason, safe to surface to the agent and user. */
  reason: string
  /** Concrete next step for the agent's corrective pass. */
  hint: string
}

/**
 * Policy: turn a pixel-truth reading into a BLOCKING verdict, or `null` when the
 * frame is fine. This is the one hard render gate. It blocks ONLY on the
 * unambiguous cases — an essentially blank frame, or every image failed to load
 * — per the chosen veto posture. Overflow, determinism, and the slop rubric are
 * handled elsewhere as advisory signals. Pure + exported for unit tests.
 */
export function evaluateRenderBlock(frame: SceneFrameTruth): RenderBlock | null {
  // Block as blank ONLY when the frame is both sparse AND essentially
  // single-color. A minimal-but-real scene (a title card: solid background +
  // one headline) has the background plus a distinct text color (≥2 significant
  // colors), so it escapes even though its non-background pixel ratio sits below
  // the threshold — the false-veto-on-title-cards class the audit flagged. A
  // failed/blank render is one uniform color (≤1). When the color signal is
  // absent (measurement gap) default to single-color so the ratio gate still
  // applies — never weaker than before.
  const sparse = frame.nonblankRatio < BLANK_FRAME_RATIO
  const singleColor = (frame.distinctColors ?? 1) < 2
  if (sparse && singleColor) {
    return {
      kind: 'blank',
      reason: `Scene rendered an essentially blank frame (only ${(frame.nonblankRatio * 100).toFixed(1)}% of pixels show content, one uniform color).`,
      hint: 'The code ran but produced no visible output. Check that elements are inside the frame, not transparent or zero-size, and actually drawn. Fix with patch_layer_code or regenerate_layer, then verify. If the scene is intentionally near-uniform, set window.__dreambyteAllowBlank = true.',
    }
  }
  if (frame.totalImages > 0 && frame.brokenImages >= frame.totalImages) {
    return {
      kind: 'broken-images',
      reason: `All ${frame.totalImages} image(s) in the scene failed to load.`,
      hint: 'Replace the broken image URL(s) with a reachable https/data URL, or generate the image, then verify.',
    }
  }
  return null
}

/**
 * Verify a scene by URL (typically `dreambyte://scenes/{id}.html`) or by absolute
 * file path. Returns an outcome the IPC layer can stamp onto the scenes row.
 */
export async function verifySceneUrl(sceneUrl: string, options: VerifyOptions = {}): Promise<SceneVerifyOutcome> {
  const start = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const rafWaitMs = options.rafWaitMs ?? DEFAULT_RAF_WAIT_MS
  const warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS

  const e = loadEnv()
  if (!e.electron || !e.preloadPath) {
    return {
      status: 'unknown',
      error: null,
      verifiedAt: start,
      durationMs: 0,
    }
  }

  const slot = await acquireSlot()
  if (!slot) {
    return { status: 'unknown', error: null, verifiedAt: start, durationMs: 0 }
  }

  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
  }, timeoutMs)

  try {
    let consoleError: SceneVerifyError | null = null
    let didFailLoad: SceneVerifyError | null = null

    const onConsole = (_evt: unknown, level: number, message: string, line: number, source: string) => {
      // Electron level 3 = error. Capture only the first.
      if (level !== 3 || consoleError) return
      const isSyntax = /SyntaxError|Unexpected token|Unexpected identifier/.test(message)
      consoleError = {
        kind: isSyntax ? 'syntax' : 'runtime',
        message,
        line: typeof line === 'number' ? line : undefined,
        source: typeof source === 'string' ? source : undefined,
      }
    }
    const onFailLoad = (
      _evt: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || didFailLoad) return
      didFailLoad = {
        kind: 'asset',
        message: errorDescription || `Load failed (${errorCode})`,
        source: validatedURL,
      }
    }
    slot.win.webContents.on('console-message', onConsole)
    slot.win.webContents.on('did-fail-load', onFailLoad)

    let loadError: SceneVerifyError | null = null
    try {
      await slot.win.loadURL(sceneUrl)
    } catch (err) {
      const e2 = (err ?? {}) as { message?: string }
      loadError = {
        kind: 'asset',
        message: e2.message ?? 'Failed to load scene HTML',
        source: sceneUrl,
      }
    }

    if (loadError ?? didFailLoad) {
      slot.win.webContents.off('console-message', onConsole)
      slot.win.webContents.off('did-fail-load', onFailLoad)
      return {
        status: 'errored',
        error: loadError ?? didFailLoad,
        verifiedAt: Date.now(),
        durationMs: Date.now() - start,
      }
    }

    // Poll until: timeout / RAF tick / probe error / readyState complete + no JS.
    const rafDeadline = start + rafWaitMs
    const warmupDeadline = start + warmupMs

    while (!timedOut) {
      const probe = await readProbe(slot)
      if (timedOut) break
      const now = Date.now()

      if (probe) {
        if (probe.error) {
          const captured = probe.error
          slot.win.webContents.off('console-message', onConsole)
          slot.win.webContents.off('did-fail-load', onFailLoad)
          return {
            status: 'errored',
            error: captured,
            verifiedAt: now,
            durationMs: now - start,
          }
        }

        if (probe.ticks >= 1) {
          // Continue past first tick to give script-eval errors a chance to
          // surface, but no longer than warmupMs.
          if (now >= warmupDeadline) {
            slot.win.webContents.off('console-message', onConsole)
            slot.win.webContents.off('did-fail-load', onFailLoad)
            const quality = await measureSceneQuality(slot)
            return {
              status: 'verified',
              error: null,
              verifiedAt: now,
              durationMs: now - start,
              ...quality,
            }
          }
        } else if (probe.readyState === 'complete' && now >= rafDeadline) {
          // CSS-only / no-JS scene — never RAFs but is a valid render.
          slot.win.webContents.off('console-message', onConsole)
          slot.win.webContents.off('did-fail-load', onFailLoad)
          const quality = await measureSceneQuality(slot)
          return {
            status: 'verified',
            error: null,
            verifiedAt: now,
            durationMs: now - start,
            ...quality,
          }
        }
      }

      if (consoleError) {
        slot.win.webContents.off('console-message', onConsole)
        slot.win.webContents.off('did-fail-load', onFailLoad)
        return {
          status: 'errored',
          error: consoleError,
          verifiedAt: Date.now(),
          durationMs: Date.now() - start,
        }
      }

      await sleep(POLL_INTERVAL_MS)
    }

    slot.win.webContents.off('console-message', onConsole)
    slot.win.webContents.off('did-fail-load', onFailLoad)

    if (timedOut) {
      // Hung infinite loop — only safe escape is to kill the renderer.
      destroyAndReplace(slot)
      return {
        status: 'errored',
        error: {
          kind: 'timeout',
          message: `Scene exceeded ${timeoutMs}ms wall-clock timeout`,
        },
        verifiedAt: Date.now(),
        durationMs: timeoutMs,
      }
    }

    const quality = await measureSceneQuality(slot)
    return {
      status: 'verified',
      error: null,
      verifiedAt: Date.now(),
      durationMs: Date.now() - start,
      ...quality,
    }
  } finally {
    clearTimeout(timeoutHandle)
    if (!slot.win.isDestroyed()) releaseSlot(slot)
  }
}

/** Disposes the entire pool. Called from app `before-quit`. */
export function disposeVerifierPool(): void {
  while (pool.length) {
    const slot = pool.pop()
    if (slot && !slot.win.isDestroyed()) slot.win.destroy()
  }
  waiters.length = 0
}

/**
 * Verify a scene by id and stamp the outcome onto the scenes row. Safe to
 * call from any scene-write path; the DB stamp is best-effort (a missing
 * row from an orphan write is logged at debug, not raised).
 *
 * Returns the outcome unchanged so callers can also surface it to the
 * renderer / agent in the same response.
 */
export async function verifyAndStampScene(sceneId: string): Promise<SceneVerifyOutcome> {
  // G3 pre-ship gate (v0.3.0): timeouts are now bumped globally in the
  // module-level defaults (DEFAULT_TIMEOUT_MS / DEFAULT_RAF_WAIT_MS /
  // DEFAULT_WARMUP_MS). Scenes that RAF quickly still verify quickly —
  // the bump only affects how long we tolerate slow first-paint before
  // declaring no-JS or timing out.
  const outcome = await verifySceneUrl(`dreambyte://scenes/${sceneId}.html`)
  try {
    // Lazy import so tests / non-Electron consumers don't drag the DB in.
    const { db } = await import('@/lib/db')
    const schema = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const verifiedAt = new Date(outcome.verifiedAt)
    await db
      .update(schema.scenes)
      .set({
        verifyStatus: outcome.status,
        verifyError: outcome.error,
        verifiedAt: outcome.status === 'verified' || outcome.status === 'errored' ? verifiedAt : null,
        updatedAt: verifiedAt,
      })
      .where(eq(schema.scenes.id, sceneId))
  } catch {
    // Orphan HTML write (no scenes row) or DB unavailable in this context.
    // Outcome still returns to the caller for renderer / agent feedback.
  }
  return outcome
}
