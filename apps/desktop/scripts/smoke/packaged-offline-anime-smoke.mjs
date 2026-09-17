#!/usr/bin/env node
// Packaged-build offline animation-runtime smoke test — drives the packaged Dreambyte.app via CDP.
//
// Scene HTML loads anime.js from the LOCAL vendored copy first
// (src="/vendor/animejs/anime.umd.min.js" onerror→CDN). Offline, the local path
// MUST resolve over the dreambyte:// protocol so `anime` is defined and the
// playback controller can run — otherwise nothing plays.
//
// This proves the offline guarantee by construction: if the vendored bundle and
// every /sdk/* file return 200 over the protocol, the onerror CDN fallback never
// fires. It also instantiates anime from the vendored bundle (not a 200 HTML
// error page) and checks a seconds-unit timeline seeks frame-exactly.
//
// Usage: node scripts/smoke/packaged-offline-anime-smoke.mjs <path-to-Dreambyte.app> [userDataDir]
// Exit 0 = all checks pass.

import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const appPath = process.argv[2]
const userDataOverride = process.argv[3]
if (!appPath) {
  console.error('usage: node scripts/smoke/packaged-offline-anime-smoke.mjs <Dreambyte.app> [userDataDir]')
  process.exit(2)
}

const PORT = 9334 // distinct from packaged-generated-media-smoke's 9333 so the two can't collide

// Must match src/lib/scene-html/anime-head.ts (vendored bundle + the /sdk set).
const ANIME_FILE = '/vendor/animejs/anime.umd.min.js'
const SDK_FILES = ['dreambyte-motion.js', 'dreambyte-camera.js', 'interaction-components.js']

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json${p}`)
  return res.json()
}

// Evaluate an expression in the app renderer via CDP (raw WebSocket, no deps).
async function rendererEval(wsUrl, expression) {
  const { default: WebSocketImpl } = await import('ws').catch(() => ({ default: globalThis.WebSocket }))
  const WS = WebSocketImpl || globalThis.WebSocket
  const ws = new WS(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP eval timeout')), 20000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        resolve(msg)
      }
    }
  })
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  )
  const msg = await reply
  ws.close()
  if (msg.result?.exceptionDetails) {
    throw new Error(
      `renderer eval threw: ${JSON.stringify(
        msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text,
      )}`,
    )
  }
  return msg.result?.result?.value
}

const binary = path.join(appPath, 'Contents/MacOS/Dreambyte')
const args = [`--remote-debugging-port=${PORT}`]
if (userDataOverride) args.push(`--user-data-dir=${userDataOverride}`)

console.log(`launching ${binary} ${args.join(' ')}`)
const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
let appLog = ''
child.stdout.on('data', (d) => (appLog += d))
child.stderr.on('data', (d) => (appLog += d))

let exitCode = 1
try {
  // Wait for CDP to come up
  let targets = null
  for (let i = 0; i < 60; i++) {
    try {
      targets = await cdpJson('/list')
      if (targets?.length) break
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) throw new Error(`app exited early (code ${child.exitCode})\n${appLog.slice(-2000)}`)
  }
  if (!targets?.length) throw new Error(`CDP never came up\n${appLog.slice(-2000)}`)

  const appTarget =
    targets.find((t) => t.type === 'page' && t.url.startsWith('dreambyte://app')) ||
    targets.find((t) => t.type === 'page')
  check(
    'packaged app boots with dreambyte://app renderer',
    !!appTarget && appTarget.url.startsWith('dreambyte://app'),
    appTarget?.url,
  )
  const wsUrl = appTarget.webSocketDebuggerUrl

  // Helper: fetch a renderer-relative URL, return {status, len, head}
  const probe = (url) =>
    rendererEval(
      wsUrl,
      `(async()=>{try{const r=await fetch(${JSON.stringify(
        url,
      )});const t=await r.text();return {status:r.status,len:t.length,head:t.slice(0,40)};}catch(e){return {status:-1,len:0,head:'ERR:'+e.message};}})()`,
    )

  // 1. The vendored bundle serves 200 over the protocol (renderer-relative form =
  //    exactly what the scene <script src> requests). A JS payload (not an HTML
  //    error page) is required: byte length sane + not <html.
  const lib = await probe(ANIME_FILE)
  check(
    `${ANIME_FILE} serves JS offline (CDN onerror never fires)`,
    lib.status === 200 && lib.len > 500 && !String(lib.head).toLowerCase().includes('<html'),
    `status=${lib.status} len=${lib.len}`,
  )

  // 2. Absolute protocol form also resolves (scene <base> / scene-frame path).
  const abs = await probe(`dreambyte://app${ANIME_FILE}`)
  check(`absolute dreambyte://app${ANIME_FILE} resolves`, abs.status === 200 && abs.len > 500, `status=${abs.status} len=${abs.len}`)

  // 3. The /sdk/* local scripts the head also loads serve offline.
  let allSdk = true
  for (const f of SDK_FILES) {
    const r = await probe(`/sdk/${f}`)
    const ok = r.status === 200 && r.len > 100
    if (!ok) allSdk = false
    check(`  /sdk/${f} serves offline`, ok, `status=${r.status} len=${r.len}`)
  }
  check('ALL 3 local /sdk scripts serve over dreambyte://', allSdk)

  // 4. The vendored bundle is a VALID anime.js: load it in the renderer, switch to
  //    seconds like the scene head does, and seek a paused timeline frame-exactly.
  const init = await rendererEval(
    wsUrl,
    `(async()=>{
      try{
        if(!window.anime){
          await new Promise((res,rej)=>{
            const s=document.createElement('script');
            s.src=${JSON.stringify(ANIME_FILE)};
            s.onload=res; s.onerror=()=>rej(new Error('script onerror — local vendor failed to load'));
            document.head.appendChild(s);
          });
        }
        anime.engine.timeUnit='s';
        const o={v:0};
        const tl=anime.createTimeline({autoplay:false});
        tl.add(o,{v:[0,100],duration:2,ease:'linear'},1);
        tl.seek(2);
        return {type: typeof anime.createTimeline, svg: typeof (anime.svg&&anime.svg.createDrawable), split: typeof (anime.text&&anime.text.split), v:o.v};
      }catch(e){ return {type:'load-failed', err:e.message}; }
    })()`,
  )
  check(
    'vendored anime.js initializes offline and seeks a seconds timeline exactly',
    init && init.type === 'function' && init.svg === 'function' && init.split === 'function' && init.v === 50,
    JSON.stringify(init),
  )

  exitCode = results.every((r) => r.ok) ? 0 : 1
} catch (err) {
  console.error('SMOKE ERROR:', err.message)
  exitCode = 1
} finally {
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 3000).unref()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
process.exit(exitCode)
