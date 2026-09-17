#!/usr/bin/env node
// Packaged-build generated-media smoke test — drives the packaged Dreambyte.app via CDP.
//
// Verifies the generated-media mount end-to-end in a REAL packaged build
// (asar, no Next server):
//   1. <userData>/generated is created at startup (registerDreambyteProtocol)
//   2. a file written there is served via dreambyte://generated/<name>
//   3. the renderer-relative form /generated/<name> (app-host rewrite) works
//   4. path traversal out of the mount is rejected (403/404, not file content)
//   5. the asar's public/ premise: out/ ships read-only inside app.asar
//
// Usage: node scripts/smoke/packaged-generated-media-smoke.mjs <path-to-Dreambyte.app> [userDataDir]
// Exit 0 = all checks pass.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const appPath = process.argv[2]
const userDataOverride = process.argv[3]
if (!appPath) {
  console.error('usage: node scripts/smoke/packaged-generated-media-smoke.mjs <Dreambyte.app> [userDataDir]')
  process.exit(2)
}

const PORT = 9333
const SMOKE_NAME = `generated-media-smoke-${process.pid}.txt`
const SMOKE_BODY = `generated-media packaged smoke ${new Date().toISOString()}`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json${p}`)
  return res.json()
}

// Evaluate an expression in the app renderer via CDP (no extra deps: raw WebSocket).
async function rendererEval(wsUrl, expression) {
  const { default: WebSocketImpl } = await import('ws').catch(() => ({ default: globalThis.WebSocket }))
  const WS = WebSocketImpl || globalThis.WebSocket
  const ws = new WS(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP eval timeout')), 15000)
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
    throw new Error(`renderer eval threw: ${JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text)}`)
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
  check('packaged app boots with dreambyte://app renderer', !!appTarget && appTarget.url.startsWith('dreambyte://app'), appTarget?.url)

  // Resolve userData: ask the renderer's origin? We know the default location.
  const userData = userDataOverride || path.join(os.homedir(), 'Library/Application Support/Dreambyte')
  const generatedDir = path.join(userData, 'generated')

  // 1. mount dir created at startup
  let mountExists = false
  for (let i = 0; i < 15 && !mountExists; i++) {
    mountExists = await fs.stat(generatedDir).then((s) => s.isDirectory()).catch(() => false)
    if (!mountExists) await new Promise((r) => setTimeout(r, 1000))
  }
  check('<userData>/generated mount created at startup', mountExists, generatedDir)

  // 2+3+4. write a file into the mount, serve it through both URL forms, reject traversal
  await fs.writeFile(path.join(generatedDir, SMOKE_NAME), SMOKE_BODY, 'utf8')

  const wsUrl = appTarget.webSocketDebuggerUrl
  const absolute = await rendererEval(
    wsUrl,
    `fetch('dreambyte://generated/${SMOKE_NAME}').then(r => r.text()).catch(e => 'FETCH_ERR:' + e.message)`,
  )
  check('dreambyte://generated/<file> serves from userData mount', absolute === SMOKE_BODY, String(absolute).slice(0, 80))

  const relative = await rendererEval(
    wsUrl,
    `fetch('/generated/${SMOKE_NAME}').then(r => r.text()).catch(e => 'FETCH_ERR:' + e.message)`,
  )
  check('renderer-relative /generated/<file> rewrite serves same file', relative === SMOKE_BODY, String(relative).slice(0, 80))

  const traversal = await rendererEval(
    wsUrl,
    `fetch('dreambyte://generated/..%2f..%2fdreambyte.env').then(r => r.status).catch(e => 'FETCH_ERR:' + e.message)`,
  )
  check('traversal out of generated mount rejected', traversal === 403 || traversal === 404, `status=${traversal}`)

  // 5. EROFS premise: the packaged bundle is read-only (asar) — a cwd-relative
  // public/generated write target does not exist anywhere writable in the bundle.
  const resourcesDir = path.join(appPath, 'Contents/Resources')
  const asarExists = await fs.stat(path.join(resourcesDir, 'app.asar')).then((s) => s.isFile()).catch(() => false)
  const publicInBundle = await fs
    .stat(path.join(resourcesDir, 'app.asar.unpacked', 'public'))
    .then(() => true)
    .catch(() => false)
  check('bundle is asar-packed with no writable public/ dir', asarExists && !publicInBundle, `app.asar=${asarExists}, unpacked public/=${publicInBundle}`)

  exitCode = results.every((r) => r.ok) ? 0 : 1
} catch (err) {
  console.error('SMOKE ERROR:', err.message)
  exitCode = 1
} finally {
  // cleanup: remove smoke file, quit the app we spawned
  try {
    const userData = userDataOverride || path.join(os.homedir(), 'Library/Application Support/Dreambyte')
    await fs.rm(path.join(userData, 'generated', SMOKE_NAME), { force: true })
  } catch {}
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 3000).unref()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
process.exit(exitCode)
