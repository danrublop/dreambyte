// The REAL-PIXEL executor-parity harness. The plan-level test
// (src/lib/timeline/composite-parity.test.ts) proves both sides consume the same pure
// `planCompositeFrame` plan; it CANNOT prove a renderer paints that plan to the
// expected pixels. This harness does, by driving ONE plan into TWO offscreen
// BrowserWindows and asserting their capturePage() output matches within tolerance.
//
//   EXPORT window  = the REAL export host  : buildCompositeHostHtml +
//                    __composite.renderFrameAt(planToInstructions(plan))   — the
//                    production export executor (src/electron/ipc/composite-host.ts).
//   PREVIEW window = the REAL production MEDIA executor for media layers — the
//                    `PreviewMediaPool` (src/lib/compositor/preview-media-pool.ts), the
//                    same class PreviewMediaLayer mounts in the app — plus scene
//                    iframes, all styled by the SAME compositeLayerToElementStyle.
//
// SCOPE — read before trusting a PASS:
//   • What this DOES lock (faithful): the export host's MEDIA rendering
//     (transform/filter/blend/opacity/seek of a <video>/<img>) against the
//     production PreviewMediaPool, plus the gap (black) and the host's compositing
//     of scene iframes incl. the crossfade. A color-grade tone-curve that the
//     export host's filterCss path drops, or a host mount/seek/style bug, diverges
//     here. This is the residual bug-class the plan-level test is blind to.
//   • Preview↔export FADE is logic-unified: PreviewPlayer derives scene
//     visibility/z/opacity + the crossfade from the SAME planCompositeFrame({fade})
//     the export consumes (sceneLayerById), so they share ONE fade path. The
//     crossfade sample therefore validates that the EXPORT HOST executor renders
//     that shared plan correctly; the plan-level test locks that preview + export
//     consume the identical plan.
//   • The harness's preview window reuses the real production PreviewMediaPool for
//     media; its scene-iframe mount is a faithful stand-in for PreviewPlayer's
//     (full-frame iframe, z/opacity from the plan) — it does NOT run React, so a
//     PreviewPlayer-specific wiring bug is out of scope (covered by app QA).
//
// (Verified empirically that a bare z-index stacking-context wrapper — the app's
// `z-[2]` media overlay — does NOT isolate mix-blend-mode, so media-over-scene
// blend reaches the scene in BOTH the host and the pool; the blend sample is
// faithful for the media-above-scene config it uses.)
//
// Build the bundles, then run under Electron:
//   node_modules/.bin/esbuild scripts/smoke/_smoke-t2-deps.ts --bundle --platform=node \
//     --format=cjs --tsconfig=tsconfig.json --external:electron --outfile=/tmp/smoke-t2.cjs
//   node_modules/.bin/esbuild scripts/smoke/_parity-preview-deps.ts --bundle --format=iife \
//     --platform=browser --tsconfig=tsconfig.json --outfile=/tmp/parity-preview.js
//   npx electron scripts/smoke/composite-parity-pixel-smoke.mjs
//
// (scripts/smoke/run-parity-pixel-smoke.sh does all three.)
//
// SAMPLES (plan §"the real-pixel half"): a plain scene, a media clip stacked over a
// scene with transform+opacity+filter+blend (the media executor surface), a true
// gap (assert BOTH pure black), and a crossfade mid-ramp (two stacked scene
// iframes at partial alpha — the applyFadeTransition layer-doubling). Media is
// served over a Range-aware (206) server: a Range-less server FREEZES Chromium
// <video> on frame 0 (memory: "Export test-harness Range gotcha"), which would make
// BOTH windows freeze identically and hide a real seek-divergence behind a false
// match. The moving R/G/B clip + paused-at-seek (below) makes the seek-time itself
// part of the comparison, not just the styling.
import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { planCompositeFrame, buildCompositeHostHtml, planToInstructions } = require('/tmp/smoke-t2.cjs')
const PREVIEW_BUNDLE = '/tmp/parity-preview.js'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'

const W = 240
const H = 160
const FPS = 10
// Downscale-grid for the pixel compare: averages AA/codec noise into blocks while
// still localizing a mispositioned/misstyled layer (a 120px-wide media block over
// a 240px frame survives a 24×16 grid). Tolerances are generous enough for
// sub-pixel AA at rotated-clip edges, tight enough to fail a real divergence (a
// dropped filter, a wrong transform, a half-applied opacity all move many blocks
// far past these bars).
const GRID_W = 24
const GRID_H = 16
const TOL_MAX = 30 // max per-channel abs diff at any grid block
const TOL_MEAN = 7 // mean per-channel abs diff across the whole grid

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-px-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (m) => {
  console.log('SMOKE_RESULT: FAIL — ' + m)
  app.exit(1)
}

if (!fs.existsSync('/tmp/smoke-t2.cjs')) fail('missing /tmp/smoke-t2.cjs — build it first (see header)')
if (!fs.existsSync(PREVIEW_BUNDLE)) fail('missing ' + PREVIEW_BUNDLE + ' — build it first (see header)')

// ── Scene fixtures: static solid colors with the deterministic __clock the host
// + preview both drive. Static-on-purpose: a scene pixel is seek-invariant, so this
// harness compares scene COMPOSITING (z-order, opacity, the fade alpha ramp) without
// entangling it in scene-clock parity (which the per-renderer scene smokes own).
const sceneHtml = (color) =>
  `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:${color}}</style></head>` +
  `<body><script>window.__clock={seek(t){return t},time(){return 0},duration(){return 20}};</script></body></html>`
fs.writeFileSync(path.join(dir, 'host.html'), buildCompositeHostHtml(W, H))
fs.writeFileSync(path.join(dir, 's1.html'), sceneHtml('rgb(220,20,20)')) // red   V1
fs.writeFileSync(path.join(dir, 's2.html'), sceneHtml('rgb(20,200,20)')) // green V1 (fades into s3)
fs.writeFileSync(path.join(dir, 's3.html'), sceneHtml('rgb(20,20,220)')) // blue  V1

// ── Media fixture: a MOVING 3s clip (red[0,1) green[1,2) blue[2,3)) so the seek
// TIME is part of the comparison (a solid clip would match even if one side seeked
// wrong). Mutually-exclusive channel conditions so a seek that lands on a band
// boundary is unambiguous. -g 1 + faststart = frame-exact seeking.
const clipMp4 = path.join(dir, 'clip.mp4')
spawnSync(
  FFMPEG,
  [
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=3:r=${FPS}`,
    '-vf', "geq=r='if(lt(T,1),255,0)':g='if(gte(T,1)*lt(T,2),255,0)':b='if(gte(T,2),255,0)'",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '1', '-preset', 'ultrafast', '-movflags', '+faststart', clipMp4,
  ],
  { stdio: 'ignore' },
)
fs.copyFileSync(PREVIEW_BUNDLE, path.join(dir, 'parity-preview.js'))

// Preview window page: the REAL PreviewMediaPool for media + scene iframes,
// exposing window.__preview.renderFrameAt(layers, isPlaying). Mirrors what the
// production preview (PreviewPlayer + PreviewMediaPool) does: scene iframes are
// full-frame (identity transform), z/opacity from the plan; media goes through the
// pool, which applies compositeLayerToElementStyle — the SAME resolver the export
// host uses. Offscreen <video> needs nudging to decode, so we re-sync until the
// element is ready + settled at its seek time before resolving.
const previewHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;width:${W}px;height:${H}px;overflow:hidden;}
#stage{position:absolute;top:0;left:0;width:${W}px;height:${H}px;background:#000;}
#stage iframe{position:absolute;top:0;left:0;width:${W}px;height:${H}px;border:0;background:transparent;}
</style></head><body><div id="stage"></div>
<script src="parity-preview.js"></script>
<script>
(function(){
  var stage = document.getElementById('stage');
  var pool = new window.__parityDeps.PreviewMediaPool(stage);
  var scenes = {}; // sceneId -> { el, ready }
  function mountScene(key, url){
    var f = document.createElement('iframe');
    f.setAttribute('scrolling','no');
    f.style.visibility = 'hidden';
    var rec = { el: f, ready: null };
    rec.ready = new Promise(function(resolve){
      var deadline = Date.now() + 12000;
      (function poll(){
        var w=null; try{ w=f.contentWindow; }catch(e){}
        var bridged=false; try{ bridged=!!(w && w.__clock); }catch(e){}
        if (bridged || Date.now() > deadline){ resolve(); return; }
        setTimeout(poll, 60);
      })();
    });
    f.src = url;
    stage.appendChild(f);
    scenes[key] = rec;
    return rec.ready;
  }
  function seekScene(rec, t){
    try{ var w=rec.el.contentWindow; if (w && w.__clock){ var d=w.__clock.duration(); w.__clock.seek(Math.max(0,Math.min(t,d))); } }catch(e){}
  }
  window.__preview = { renderFrameAt: async function(layers, isPlaying){
    var activeScenes = {};
    for (var i=0;i<layers.length;i++){
      var L = layers[i];
      if (L.kind !== 'scene') continue;
      activeScenes[L.layerKey] = 1;
      var rec = scenes[L.layerKey];
      if (!rec){ await mountScene(L.layerKey, L.url); rec = scenes[L.layerKey]; }
      else { await rec.ready; }
      rec.el.style.zIndex = String(L.z);
      rec.el.style.opacity = String(L.opacity);
      rec.el.style.visibility = 'visible';
      seekScene(rec, L.localT);
    }
    for (var id in scenes){ if(!activeScenes[id]) scenes[id].el.style.visibility = 'hidden'; }
    // Media via the REAL production pool (applies the shared element style + drift seek).
    var media = layers.filter(function(l){ return l.kind !== 'scene'; });
    var deadline = Date.now() + 5000;
    var ready = media.length === 0;
    for(;;){
      pool.sync(media, isPlaying);
      var vids = Array.prototype.slice.call(stage.querySelectorAll('video'));
      ready = vids.length > 0 && vids.every(function(v){ return v.readyState >= 2 && !v.seeking; });
      if (ready || media.length === 0 || Date.now() > deadline) break;
      await new Promise(function(r){ setTimeout(r, 50); });
    }
    // Report readiness so the harness FAILS honestly on an undecoded frame instead
    // of capturing black + (worst case) matching a black export → a false PASS.
    return { rendered: layers.length, mediaReady: media.length === 0 ? true : ready };
  }};
})();
</script></body></html>`
fs.writeFileSync(path.join(dir, 'preview.html'), previewHtml)

// ── Timeline (built first; the media src is patched to the served URL once the
// server has a port). V1 spine with a fade; V2 a styled media clip over s1.
const aclip = (over) => ({
  sourceType: 'scene', label: over.id, startTime: 0, duration: 4, trimStart: 0, trimEnd: null,
  speed: 1, opacity: 1, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, filters: [], keyframes: [],
  ...over,
})
const timeline = {
  tracks: [
    {
      id: 'v1', name: 'V1', type: 'video', position: 0,
      clips: [
        aclip({ id: 's1', sourceId: 's1', trackId: 'v1', startTime: 0, duration: 3 }), // [0,3) red
        // GAP [3,4)
        aclip({ id: 's2', sourceId: 's2', trackId: 'v1', startTime: 4, duration: 5, transition: { type: 'fade', duration: 1 } }), // [4,9) green, fades into s3 over [8,9)
        aclip({ id: 's3', sourceId: 's3', trackId: 'v1', startTime: 9, duration: 3 }), // [9,12) blue
      ],
    },
    {
      id: 'v2', name: 'V2', type: 'video', position: 1,
      clips: [
        aclip({
          id: 'vid', sourceType: 'video', sourceId: 'PATCH', trackId: 'v2', startTime: 5, duration: 2,
          opacity: 0.6, position: { x: 90, y: 30 }, scale: { x: 0.5, y: 0.5 }, rotation: 12,
          filters: [{ type: 'brightness', value: 1.3 }], blendMode: 'screen',
        }), // [5,7) over the GREEN scene s2 — its RED band (localT 0.5 at t=5.5) screen-
        // blends to a strong yellow, so the media's pixel contribution is large enough
        // that a dropped filter/transform/opacity would fail the compare, not hide
        // under tolerance (red-band-over-red-scene was near-invisible — a weak surface).
      ],
    },
  ],
}

// Sample plan: each [global t, label, flags]. Media-over-scene at t=5.5 (vid localT
// 0.5 → RED band over GREEN s2 → high contrast); mid-fade at t=8.5 (s2 ramping out,
// s3 ramping in). `media:true` runs an extra power-check that the media sample
// differs MATERIALLY from the bare scene (else the test couldn't catch a no-op
// media executor); `black:true` asserts both windows are pure black.
const SAMPLES = [
  [0.5, 'plain scene s1 (red)', {}],
  [3.5, 'true gap (BOTH pure black)', { black: true }],
  [5.5, 'media over scene (transform+opacity+filter+blend, red-over-green)', { media: true }],
  [8.5, 'crossfade mid-ramp s2→s3 (shared planCompositeFrame fade; host renders the doubled layer set)', {}],
  [10.0, 'plain scene s3 (blue)', {}],
]

const CT = { '.html': 'text/html', '.mp4': 'video/mp4', '.png': 'image/png', '.js': 'text/javascript' }
// Range-aware (206) server — mandatory for <video>; a 200-only server freezes
// Chromium's media stack on frame 0 (and would freeze BOTH windows identically,
// masking a seek divergence behind a false match).
const server = http.createServer((req, res) => {
  const f = path.join(dir, req.url === '/' ? 'host.html' : req.url.slice(1))
  try {
    const stat = fs.statSync(f)
    const ct = CT[path.extname(f)] ?? 'application/octet-stream'
    const range = req.headers.range
    if (range && /bytes=/.test(range)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start, end
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, stat.size - parseInt(m[2]))
        end = stat.size - 1
      } else {
        start = m[1] ? parseInt(m[1]) : 0
        end = m[2] ? Math.min(parseInt(m[2]), stat.size - 1) : stat.size - 1
      }
      if (!(start <= end) || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Type': ct,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      fs.createReadStream(f, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
      fs.createReadStream(f).pipe(res)
    }
  } catch {
    res.statusCode = 404
    res.end()
  }
})

// capturePage(win) → a GRID_W×GRID_H rgb24 grid (Uint8) via ffmpeg downscale.
async function captureGrid(win, tag) {
  const png = path.join(dir, `cap-${tag}.png`)
  fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG())
  const raw = path.join(dir, `grid-${tag}.rgb`)
  await new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-y', '-i', png, '-vf', `scale=${GRID_W}:${GRID_H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], {
      stdio: 'ignore',
    })
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg grid ' + c))))
  })
  return fs.readFileSync(raw)
}

function compareGrids(a, b) {
  const n = Math.min(a.length, b.length)
  let max = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > max) max = d
    sum += d
  }
  return { max, mean: sum / Math.max(1, n) }
}

function isBlack(grid) {
  for (let i = 0; i < grid.length; i++) if (grid[i] > 18) return false
  return true
}

async function installController(win, base, url, globalName) {
  await win.loadURL(url)
  for (let i = 0; i < 120; i++) {
    const ok = await win.webContents.executeJavaScript(`!!window.${globalName}`).catch(() => false)
    if (ok) return true
    await sleep(60)
  }
  return false
}

app.commandLine.appendSwitch('disable-gpu')
;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  // Patch the media src to the served absolute URL (the preview pool reads
  // layer.src directly; the export resolve maps it 1:1).
  timeline.tracks[1].clips[0].sourceId = `${base}/clip.mp4`

  await app.whenReady()
  const mk = () =>
    new BrowserWindow({
      width: W, height: H, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false },
    })
  const exportWin = mk()
  const previewWin = mk()
  exportWin.webContents.setFrameRate(60)
  previewWin.webContents.setFrameRate(60)
  const kill = setTimeout(() => fail('timeout'), 90000)

  if (!(await installController(exportWin, base, `${base}/host.html`, '__composite')))
    return fail('export host controller never installed')
  if (!(await installController(previewWin, base, `${base}/preview.html`, '__preview')))
    return fail('preview controller never installed')

  const sceneUrl = { s1: `${base}/s1.html`, s2: `${base}/s2.html`, s3: `${base}/s3.html` }
  const resolveExport = (layer) =>
    layer.kind === 'scene'
      ? { url: sceneUrl[layer.sceneId], isVideoScene: false }
      : { url: layer.src, isVideoScene: false }

  const renderExport = async (instructions) =>
    exportWin.webContents.executeJavaScript(`window.__composite.renderFrameAt(${JSON.stringify(instructions)})`).catch(() => {})

  console.log(`SMOKE: comparing ${SAMPLES.length} samples, grid ${GRID_W}x${GRID_H}, tol max=${TOL_MAX} mean=${TOL_MEAN}`)
  let allOk = true
  for (const [t, label, flags] of SAMPLES) {
    const plan = planCompositeFrame(timeline, t, { fade: true })

    // EXPORT: the real host controller over the instruction stream.
    const instr = planToInstructions(plan, resolveExport)
    await renderExport(instr)

    // PREVIEW: the real pool + scene iframes over the SAME plan layers (scene
    // layers carry their resolved url; media carries its absolute src already).
    const previewLayers = plan.layers.map((l) => (l.kind === 'scene' ? { ...l, url: sceneUrl[l.sceneId] } : l))
    const prevStatus = await previewWin.webContents
      .executeJavaScript(`window.__preview.renderFrameAt(${JSON.stringify(previewLayers)}, false)`)
      .catch(() => null)

    // Settle: flush paint on both. Pause export-host <video> (it autoplays, so it
    // would drift off the seek during the settle and disagree with the paused
    // preview pool) so BOTH sit on the exact seeked frame.
    await exportWin.webContents.executeJavaScript(
      `(function(){var v=document.querySelectorAll('video');for(var i=0;i<v.length;i++){try{v[i].pause();}catch(e){}}})()`,
    ).catch(() => {})
    exportWin.webContents.invalidate()
    previewWin.webContents.invalidate()
    await sleep(220)

    // FAIL HONESTLY on an undecoded media frame: if either side never reached a
    // ready <video>, a black capture could falsely match a black export. Confirm
    // both the preview pool (reported) and the export host (queried) decoded.
    let notReady = ''
    if (flags.media) {
      const prevReady = prevStatus && prevStatus.mediaReady === true
      const expReady = await exportWin.webContents
        .executeJavaScript(
          `(function(){var v=document.querySelectorAll('video');return v.length>0&&Array.prototype.every.call(v,function(e){return e.readyState>=2&&!e.seeking;});})()`,
        )
        .catch(() => false)
      if (!prevReady || !expReady) notReady = ` UNDECODED(prev=${prevReady} exp=${expReady})`
    }

    const tag = String(t).replace(/[^0-9]/g, '_')
    const ge = await captureGrid(exportWin, `exp-${tag}`)
    const gp = await captureGrid(previewWin, `prev-${tag}`)
    fs.copyFileSync(path.join(dir, `cap-exp-${tag}.png`), `/tmp/parity-exp-${tag}.png`)
    fs.copyFileSync(path.join(dir, `cap-prev-${tag}.png`), `/tmp/parity-prev-${tag}.png`)

    const { max, mean } = compareGrids(ge, gp)
    let pass = max <= TOL_MAX && mean <= TOL_MEAN && notReady === ''
    let extra = notReady
    if (flags.black) {
      const be = isBlack(ge)
      const bp = isBlack(gp)
      pass = pass && be && bp
      extra = ` blackExport=${be} blackPreview=${bp}`
    }
    if (flags.media) {
      // POWER CHECK: re-render the EXPORT window with the SAME plan minus the media
      // layers, and confirm the full frame differs MATERIALLY from scene-only. If
      // the media contributed < tolerance (the red-on-red trap), the parity match
      // above would be meaningless — a no-op media executor would also "pass". The
      // media must move the picture well past the divergence bar for this sample to
      // actually exercise the transform/filter/blend/opacity surface.
      const sceneOnly = planToInstructions({ ...plan, layers: plan.layers.filter((l) => l.kind === 'scene') }, resolveExport)
      await renderExport(sceneOnly)
      exportWin.webContents.invalidate()
      await sleep(180)
      const gScene = await captureGrid(exportWin, `scene-${tag}`)
      const contribution = compareGrids(ge, gScene)
      const exercised = contribution.max > TOL_MAX
      pass = pass && exercised
      extra = ` mediaContribΔmax=${contribution.max}(>${TOL_MAX}=${exercised})`
    }
    allOk = allOk && pass
    console.log(`  t=${t}s ${label}: maxΔ=${max} meanΔ=${mean.toFixed(2)}${extra} → ${pass ? 'OK' : 'DIVERGED'}`)
  }

  clearTimeout(kill)
  console.log(
    allOk
      ? 'SMOKE_RESULT: PASS — export-host pixels == production media-pool pixels across media/gap/crossfade (preview + export share one planCompositeFrame fade path — see header SCOPE)'
      : 'SMOKE_RESULT: FAIL — a sample diverged or a media frame was undecoded; see /tmp/parity-{exp,prev}-*.png',
  )
  app.exit(allOk ? 0 : 1)
})().catch((e) => fail(String(e)))
