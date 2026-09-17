/**
 * Native music composer — shared Magenta-in-Node worker harness.
 *
 * Both ML workers (melody = ImprovRNN, drums = GrooVAE) run Magenta.js in an
 * ISOLATED child process so the unavoidable hacks below never touch the Electron
 * main process. This module is the ONE place those hacks live; each worker is a
 * thin entry that calls runWorker() with its own model handler:
 *   - `tone` is stubbed (only Magenta's playback Player needs it; we render via
 *     spessasynth, never play in-process).
 *   - `node-fetch` + global `fetch` are shimmed to serve the LOCAL cached
 *     checkpoint (config.json / weights_manifest.json / weight shards) — offline, $0.
 *   - pure `@tensorflow/tfjs` CPU backend (no native tfjs-node compile, so no
 *     node-gyp / .node to unpack from the asar in a packaged build).
 *
 * Protocol: read ONE JSON request from stdin, write ONE JSON response to stdout.
 *   request:  { checkpointDir, ...model-specific }
 *   response: { ok: true, ...handler payload } | { ok: false, error }
 *
 * The handler must `require('@magenta/music/node/<module>')` LAZILY (inside the
 * handler), never at the top of its file — the offline fetch shim has to be
 * installed before Magenta loads, and the full `@magenta/music` index eagerly
 * builds an audio context that throws "Cannot use offline audio context in Node.js".
 */
const fs = require('node:fs')
const path = require('node:path')

/** tfjs/magenta print banners + warnings to stdout via console.*. Redirect ALL
 *  console output to stderr so stdout carries ONLY the JSON response. */
function redirectConsoleToStderr() {
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    console[m] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
  }
}

/** Serve only the local checkpoint files; reject anything else so this shim can't
 *  accidentally swallow unrelated requests. Returns the localFetch for reuse. */
function installOfflineShims(checkpointDir) {
  const localFetch = (url) => {
    const name = String(url).split('/').pop()
    const buf = fs.readFileSync(path.join(checkpointDir, name))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString()),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      text: async () => buf.toString(),
    })
  }
  const Module = require('node:module')
  const orig = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'tone') return new Proxy({}, { get: () => function () {} })
    if (request === 'node-fetch') {
      const w = (u) => localFetch(u)
      w.default = w
      return w
    }
    return orig.call(this, request, ...rest)
  }
  globalThis.fetch = localFetch
  return localFetch
}

/**
 * Run a Magenta worker. Wires the console redirect + the stdin→handler→stdout JSON
 * protocol; installs the offline shims (from req.checkpointDir) and loads tfjs
 * BEFORE calling the handler. `handler(req)` returns the success payload object,
 * which is merged with `{ ok: true }`; throwing yields `{ ok: false, error }`.
 */
function runWorker(handler) {
  redirectConsoleToStderr()
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (input += d))
  // Exit only AFTER stdout flushes. `process.exit()` drops un-flushed pipe-buffered
  // bytes, so `write(big); exit()` truncates a >64KB-ish response at the buffer
  // boundary (caught with GrooVAE's multi-segment output — melody's was small
  // enough to fit). The write callback fires once the data is handed to the OS.
  const writeThenExit = (obj) => process.stdout.write(JSON.stringify(obj), () => process.exit(0))
  process.stdin.on('end', () => {
    main().catch((e) => writeThenExit({ ok: false, error: e && e.message ? e.message : String(e) }))
  })
  async function main() {
    const req = JSON.parse(input)
    installOfflineShims(req.checkpointDir)
    require('@tensorflow/tfjs')
    const payload = await handler(req)
    writeThenExit({ ok: true, ...payload })
  }
}

module.exports = { runWorker }
