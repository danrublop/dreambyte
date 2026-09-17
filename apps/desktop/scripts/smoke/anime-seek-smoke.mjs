// Headless Electron smoke for the anime.js scene runtime: renders REAL
// generateSceneHTML output (vendored anime.js + playback controller) in an
// offscreen window, drives window.__clock.seek(t) to specific frames and
// captures pixels (the desktop CSP meta is stripped because the smoke serves
// the scene over a local http origin instead of dreambyte://). Passes when:
//   - frames at different times differ (the animation actually moves),
//   - the same time captured in forward order and in a shuffled order is
//     pixel-identical (seek is deterministic / frame-exact),
//   - a pre-removal GSAP scene renders the "regenerate" placeholder, not blank,
//   - through the pixi exporter's isolated frame bridge (src/lib/export2/scene-frame-bridge.ts)
//     the scene can't reach the host's window.dreambyteApi / electronAPI / DOM, and
//     bridge captures stay frame-exact (forward vs shuffled).
//
//   Run: npx electron scripts/smoke/anime-seek-smoke.mjs
import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const W = 640
const H = 360

const SCENES = {
  motion: {
    sceneType: 'motion',
    sceneHTML: `<div id="stage" style="position:absolute;inset:0;background:#0b1020">
  <h1 id="title" style="position:absolute;left:60px;top:40px;margin:0;font:700 72px system-ui;color:#fff">Frame exact</h1>
  <div class="bar" style="position:absolute;left:60px;top:200px;width:80px;height:80px;background:#f5a524"></div>
  <div class="bar" style="position:absolute;left:180px;top:200px;width:80px;height:80px;background:#17c964"></div>
  <div class="bar" style="position:absolute;left:300px;top:200px;width:80px;height:80px;background:#006fee"></div>
  <svg style="position:absolute;left:420px;top:180px" width="200" height="140"><path id="line" d="M10 120 C 60 0, 140 0, 190 120" stroke="#f31260" stroke-width="8" fill="none"/></svg>
</div>`,
    sceneCode: `
const tl = window.__tl;
const { chars } = anime.text.split('#title', { chars: true });
tl.add(chars, { opacity: [0, 1], y: [40, 0], duration: 0.4, ease: 'outExpo', delay: anime.stagger(0.05) }, 0.2);
tl.add('.bar', { scale: [0, 1], rotate: [-90, 0], duration: 0.8, ease: 'outBack(1.7)', delay: anime.stagger(0.2) }, 1);
const [line] = anime.svg.createDrawable('#line');
tl.add(line, { draw: ['0 0', '0 1'], duration: 1.5, ease: 'inOutQuad' }, 1.5);
tl.add('.bar', { y: -60, duration: 0.6, ease: 'inCubic' }, 3.2);`,
  },
  canvas2d: {
    sceneType: 'canvas2d',
    canvasCode: `
const c = document.getElementById('c') || document.querySelector('canvas');
const ctx = c.getContext('2d');
const state = { t: 0 };
function render(t) {
  ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#ff5a5f';
  ctx.beginPath(); ctx.arc(100 + (c.width - 200) * (t / DURATION), c.height / 2, 80, 0, Math.PI * 2); ctx.fill();
}
window.__tl.add(state, { t: [0, DURATION], duration: DURATION, ease: 'linear', onUpdate: () => render(state.t) }, 0);
render(0);`,
  },
  legacy: {
    sceneType: 'motion',
    sceneHTML: '<div id="t" style="color:#fff;font-size:80px">old</div>',
    sceneCode: "gsap.to('#t', { y: 100, duration: 1 })",
  },
}

// Export-bridge probe: the motion scene plus code that tries to reach the embedder.
SCENES.probe = {
  ...SCENES.motion,
  sceneCode:
    SCENES.motion.sceneCode +
    `
const reach = (f) => { try { const v = f(); return v === undefined ? 'undefined' : 'REACHED'; } catch (e) { return 'threw'; } };
window.parent.postMessage({ source: 'smoke-probe', api: reach(() => window.parent.dreambyteApi), electron: reach(() => window.parent.electronAPI), doc: reach(() => window.parent.document.body) }, '*');`,
}

const TIMES = [0, 0.5, 1.2, 2.1, 3.0, 3.6]

// The export bridge, bundled for the host page (a stand-in for the app window).
const BRIDGE_JS = buildSync({
  entryPoints: [path.join(ROOT, 'src/lib/export2/scene-frame-bridge.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'SceneFrameBridge',
  write: false,
}).outputFiles[0].text
const HOST_HTML = `<!DOCTYPE html><html><head></head><body>
<script>window.dreambyteApi = { secret: 1 }; window.electronAPI = { secret: 1 };</script>
<script src="/__bridge.js"></script></body></html>`

// Generate scene HTML with the real template (TS) via tsx.
function generate(port) {
  const code = `
    import { generateSceneHTML } from './src/lib/sceneTemplate'
    import { stripSceneCsp } from './src/lib/security/scene-csp'
    const scenes = ${JSON.stringify(SCENES)}
    const base = { name: 's', prompt: '', duration: 4, svgContent: '', svgObjects: [], aiLayers: [], interactions: [], variables: [], textOverlays: [], styleOverride: {}, sceneStyles: '', sceneCode: '', sceneHTML: '', canvasCode: '', canvasBackgroundCode: '', reactCode: '' }
    const out = {}
    for (const [id, s] of Object.entries(scenes)) out[id] = stripSceneCsp(generateSceneHTML({ ...base, id, ...s } as any, undefined, null, null, { width: ${W}, height: ${H} }))
    process.stdout.write(JSON.stringify(out))`
  const file = path.join(ROOT, '.anime-seek-smoke-gen.ts')
  fs.writeFileSync(file, code)
  try {
    return JSON.parse(
      execFileSync('npx', ['tsx', file], {
        cwd: ROOT,
        env: { ...process.env, DREAMBYTE_APP_URL_BASE: `http://127.0.0.1:${port}` },
        maxBuffer: 64 * 1024 * 1024,
      }).toString(),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  let pages = {}
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    res.setHeader('access-control-allow-origin', '*') // as the dreambyte:// protocol does
    if (url === '/__host') {
      res.setHeader('content-type', 'text/html')
      return res.end(HOST_HTML)
    }
    if (url === '/__bridge.js') {
      res.setHeader('content-type', 'text/javascript')
      return res.end(BRIDGE_JS)
    }
    if (url.startsWith('/scene/')) {
      res.setHeader('content-type', 'text/html')
      return res.end(pages[url.slice(7)] ?? '')
    }
    const f = path.join(ROOT, 'public', url)
    if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) {
      res.statusCode = 404
      return res.end()
    }
    res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
    res.end(fs.readFileSync(f))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  pages = generate(port)

  const win = new BrowserWindow({ show: false, width: W, height: H, webPreferences: { offscreen: true } })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || process.env.SMOKE_VERBOSE) console.log(`  [scene console] ${e.message}`)
  })
  const capture = async (t) => {
    await win.webContents.executeJavaScript(`window.__clock.seek(${t}); true`)
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 120))
    const img = await win.webContents.capturePage()
    return crypto.createHash('sha1').update(img.toBitmap()).digest('hex')
  }
  const load = async (id) => {
    await win.loadURL(`http://127.0.0.1:${port}/scene/${id}`)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const ok = await win.webContents
        .executeJavaScript(`!!(window.__clock && (window.__clock.childCount() > 0 || document.body.innerText.length))`)
        .catch(() => false)
      if (ok) break
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 400)) // fonts/layout settle
  }

  try {
    for (const id of ['motion', 'canvas2d']) {
      await load(id)
      const kids = await win.webContents.executeJavaScript('window.__clock.childCount()')
      check(`${id}: scene registered timeline children`, kids > 0, `childCount=${kids}`)
      const forward = {}
      for (const t of TIMES) forward[t] = await capture(t)
      const distinct = new Set(Object.values(forward)).size
      check(`${id}: frames change over time`, distinct >= TIMES.length - 1, `${distinct} distinct of ${TIMES.length}`)
      // Reload fresh and capture in a shuffled order: must match pixel-for-pixel.
      await load(id)
      const shuffled = [3.0, 0, 3.6, 1.2, 1.2, 0.5, 2.1]
      let same = true
      const mismatches = []
      for (const t of shuffled) {
        const h = await capture(t)
        if (h !== forward[t]) {
          same = false
          mismatches.push(t)
        }
      }
      check(`${id}: shuffled seeks reproduce identical frames`, same, mismatches.length ? `mismatch at t=${mismatches.join(',')}` : '')
      // Real playback: the clock advances on its own and pauses on command.
      await win.webContents.executeJavaScript(`window.__clock.seek(0); window.postMessage({ target: 'dreambyte-scene', type: 'play' }, '*'); true`)
      await new Promise((r) => setTimeout(r, 1200))
      const playing = await win.webContents.executeJavaScript(
          `(function(){ var t = window.__clock.time(); window.postMessage({ target: 'dreambyte-scene', type: 'pause' }, '*'); return t; })()`)
      await new Promise((r) => setTimeout(r, 300))
      const paused1 = await win.webContents.executeJavaScript('window.__clock.time()')
      await new Promise((r) => setTimeout(r, 400))
      const paused2 = await win.webContents.executeJavaScript('window.__clock.time()')
      check(`${id}: play advances the clock, pause holds it`, playing > 0.5 && paused1 === paused2, `t@1.2s=${playing} paused=${paused1}/${paused2}`)
    }

    // Export bridge: isolation + frame-exact capture through postMessage.
    for (const id of ['probe', 'canvas2d']) {
      await win.loadURL(`http://127.0.0.1:${port}/__host`)
      const r = await win.webContents.executeJavaScript(`(async () => {
        const probe = new Promise((res) => addEventListener('message', (e) => { if (e.data && e.data.source === 'smoke-probe') res(e.data) }))
        const html = await (await fetch('/scene/${id}')).text()
        const b = await SceneFrameBridge.openSceneFrameBridge({ html, width: ${W}, height: ${H}, sceneType: ${JSON.stringify(SCENES[id].sceneType)}, sceneId: '${id}', captureScale: 1, readyTimeoutMs: 8000 })
        const reach = ${id === 'probe'} ? await Promise.race([probe, new Promise((res) => setTimeout(() => res(null), 4000))]) : null
        let kids = await b.childCount()
        for (let i = 0; i < 50 && kids === 0; i++) { await new Promise((res) => setTimeout(res, 100)); kids = await b.childCount() }
        await new Promise((res) => setTimeout(res, 400))
        const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H}
        const ctx = c.getContext('2d', { willReadFrequently: true })
        const hash = async (t) => {
          const { bitmap, captured, error } = await b.capture(t)
          if (!bitmap || !captured) return 'no-frame' + (error ? ': ' + error : '')
          ctx.clearRect(0, 0, ${W}, ${H}); ctx.drawImage(bitmap, 0, 0); bitmap.close()
          const d = await crypto.subtle.digest('SHA-1', ctx.getImageData(0, 0, ${W}, ${H}).data)
          return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('')
        }
        const forward = {}
        for (const t of ${JSON.stringify(TIMES)}) forward[t] = await hash(t)
        const mismatches = []
        for (const t of [3.0, 0, 3.6, 1.2, 1.2, 0.5, 2.1]) if ((await hash(t)) !== forward[t]) mismatches.push(t)
        b.dispose()
        return { reach, kids, forward, mismatches, frameInDom: !!document.querySelector('iframe') }
      })()`)
      if (id === 'probe') {
        const blocked = (v) => v === 'undefined' || v === 'threw'
        check(
          'export bridge: scene cannot reach parent dreambyteApi / electronAPI / DOM',
          !!r.reach && blocked(r.reach.api) && blocked(r.reach.electron) && blocked(r.reach.doc),
          JSON.stringify(r.reach),
        )
      }
      const hashes = Object.values(r.forward)
      check(`export bridge ${id}: timeline children via postMessage`, r.kids > 0, `childCount=${r.kids}`)
      check(`export bridge ${id}: every frame captured`, !hashes.some((h) => h.startsWith('no-frame')), JSON.stringify(r.forward))
      check(`export bridge ${id}: frames change over time`, new Set(hashes).size >= TIMES.length - 1, `${new Set(hashes).size} distinct`)
      check(`export bridge ${id}: shuffled seeks reproduce identical frames`, r.mismatches.length === 0, r.mismatches.join(','))
      check(`export bridge ${id}: frame disposed`, !r.frameInDom)
    }

    await load('legacy')
    const text = await win.webContents.executeJavaScript('document.body.innerText')
    check('legacy GSAP scene shows the regenerate placeholder', /GSAP, which was removed/.test(text), text.slice(0, 80))
  } catch (e) {
    check('smoke run', false, e.stack || String(e))
  }
  server.close()
  const ok = results.every(Boolean)
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`)
  app.exit(ok ? 0 : 1)
})
