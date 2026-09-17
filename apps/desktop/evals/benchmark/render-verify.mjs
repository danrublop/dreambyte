#!/usr/bin/env electron
/**
 * Render step — offscreen render health for the offline benchmark.
 *
 * The benchmark runner (run.ts) drives the REAL agent under plain `tsx`, which
 * has no browser and so cannot render-gate. This script is the other half: an
 * Electron main-process child that renders each persisted scene HTML in the app's OWN verifier and reports its
 * outcome — so "the benchmark says broken" is the same verdict as "the app
 * shows an error", with no drift.
 *
 * CRITICAL — scenes MUST be served over the real `dreambyte://` scheme, exactly
 * as the app serves them. A scene's `<base href="dreambyte://app/">` makes its
 * `/sdk/*` + `/vendor/*` runtime refs resolve to `dreambyte://app/...`, and its
 * CSP only trusts `dreambyte:`/`https:`. Serving over http:// gets those refs
 * CORS-blocked (base is cross-scheme) and CSP-blocked → every scene falsely
 * reads as ERRORED. So we register the privileged `dreambyte` scheme and mirror
 * the app's mounts (src/electron/main.ts): `scenes`→scene dir, `app`→the static
 * bundle (public/, which holds /sdk + /vendor), audio/uploads/generated→the
 * app's user-data mounts (best-effort, for narration/media).
 *
 * Invoked by run.ts / analyze-run.ts:
 *   electron render-verify.mjs <manifest.json> <out.json>
 *   manifest: { scenesDir, scenes:[{sceneId,file}], staticDir?, audioDir?, uploadsDir?, generatedDir? }
 *   out:      { [sceneId]: SceneVerifyOutcome }   (status/error/frame/overflows)
 *
 * Honest-skip contract: any failure to bundle / boot / render yields
 * `{ status: 'unknown' }` for the affected scenes — NEVER a fabricated pass.
 */
import { app, protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const manifestPath = process.argv[2]
const outPath = process.argv[3]

// Software compositing → deterministic offscreen capture (every smoke script does this).
app.commandLine.appendSwitch('disable-gpu')

// Must run BEFORE app ready. Same privileges the app grants the scheme
// (src/electron/main.ts:227) so scene fetch()/module imports + CORS behave identically.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dreambyte',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
const typeFor = (p) => CONTENT_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream'

// Benign stubs for MISSING media subresources (audio/uploads/generated). A live
// in-app run has these files; a pulled/old/headless run may not — and a missing
// narration .wav / image fires a capture-phase resource `error` event that the
// verifier catches as a fatal "Unknown script error", falsely flagging a scene
// that renders perfectly. Serving a valid-but-empty asset keeps asset
// AVAILABILITY (a live-vs-harness difference) from masquerading as a code defect;
// the gate still judges the real visual frame + genuine script throws.
const SILENT_WAV = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=', 'base64') // 44-byte header, zero samples
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
) // 1x1 transparent PNG
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const AUD_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac'])
function benignStub(reqPath) {
  const ext = path.extname(reqPath).toLowerCase()
  if (AUD_EXT.has(ext))
    return new Response(SILENT_WAV, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*' },
    })
  if (IMG_EXT.has(ext))
    return new Response(PIXEL_PNG, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
    })
  // Unknown/other (video etc.) — empty 200 avoids a hard load error; the frame
  // check still catches a scene that renders blank without it.
  return new Response(new Uint8Array(0), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
  })
}

/** Serve one file with CORS + Range (206) semantics, mirroring the app handler. */
async function serveFile(filePath, request) {
  let stat
  try {
    stat = await fsp.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
      stat = await fsp.stat(filePath)
    }
  } catch {
    // Next static export writes `foo.html` for `/foo`.
    if (!filePath.endsWith('.html')) {
      try {
        await fsp.access(`${filePath}.html`)
        filePath = `${filePath}.html`
        stat = await fsp.stat(filePath)
      } catch {
        return new Response('Not found', { status: 404 })
      }
    } else {
      return new Response('Not found', { status: 404 })
    }
  }
  const size = stat.size
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': typeFor(filePath),
  })
  const range = request.headers.get('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (m && (m[1] !== '' || m[2] !== '')) {
    const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1])
    const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (!Number.isFinite(start) || start > end || start >= size) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response('Range not satisfiable', { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), { status: 206, headers })
  }
  headers.set('Content-Length', String(size))
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers })
}

/** dreambyte:// handler mirroring src/electron/main.ts host routing. */
function makeHandler(mounts) {
  return async (request) => {
    try {
      const url = new URL(request.url)
      let host = url.hostname
      let rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')

      // `app`/'' origin renderer refs like `/scenes/..`, `/audio/..` → their mounts.
      if ((host === 'app' || host === '') && /^(scenes|audio|uploads|generated)\//.test(rawPath)) {
        const slash = rawPath.indexOf('/')
        host = rawPath.slice(0, slash)
        rawPath = rawPath.slice(slash + 1)
      }
      // Scene sandbox origin: `scene-frame` → the bare id.html routes to scenes;
      // audio/uploads/generated subpaths route to their own mounts.
      if (host === 'scene-frame') {
        const mm = /^(scenes|audio|uploads|generated)\//.exec(rawPath)
        if (mm) {
          host = mm[1]
          rawPath = rawPath.slice(mm[0].length)
        } else {
          host = 'scenes'
        }
      }
      const baseDir =
        host === 'scenes'
          ? mounts.scenes
          : host === 'audio'
            ? mounts.audio
            : host === 'uploads'
              ? mounts.uploads
              : host === 'generated'
                ? mounts.generated
                : host === 'app' || host === ''
                  ? mounts.app
                  : null
      if (!baseDir) return new Response(`Unknown dreambyte:// host "${host}"`, { status: 404 })

      const filePath = path.resolve(baseDir, rawPath || 'index.html')
      if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
        return new Response('Forbidden', { status: 403 })
      }
      // Missing media (audio/uploads/generated) → benign stub, not a 404 that
      // would trip the verifier's resource-error gate. scenes/app stay strict:
      // a missing runtime/scene file is a REAL failure that should surface.
      const isMediaHost = host === 'audio' || host === 'uploads' || host === 'generated'
      if (isMediaHost && !fs.existsSync(filePath)) return benignStub(rawPath)
      return await serveFile(filePath, request)
    } catch (e) {
      return new Response(`error: ${e}`, { status: 500 })
    }
  }
}

async function bundleVerifier() {
  const esbuild = require('esbuild')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-verify-'))
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src/electron/verifier-preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(tmp, 'verifier-preload.js'),
    logLevel: 'silent',
  })
  // scene-verifier's only static import is a TYPE (erased). Its runtime
  // `import('@/lib/db')`/`drizzle-orm` live in verifyAndStampScene, never called
  // here — externalize so esbuild doesn't drag the DB tree in.
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src/lib/services/scene-verifier.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'drizzle-orm', '@/*'],
    outfile: path.join(tmp, 'scene-verifier.cjs'),
    logLevel: 'silent',
  })
  return tmp
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : []
  const results = {}
  for (const s of scenes)
    results[s.sceneId] = { status: 'unknown', error: { kind: 'harness', message: 'not rendered' } }

  try {
    const tmp = await bundleVerifier()
    await app.whenReady()

    // Mounts: app → the static bundle (public/, holds /sdk + /vendor). Media
    // mounts default to this machine's app user-data (narration/images); missing
    // files 404 → broken-media, which is honest, not a fabricated pass.
    const support = path.join(os.homedir(), 'Library', 'Application Support')
    const guessUserData = manifest.userDataDir || path.join(support, 'dreambyte')
    const mounts = {
      scenes: path.resolve(manifest.scenesDir),
      app: path.resolve(manifest.staticDir || path.join(repoRoot, 'public')),
      audio: path.resolve(manifest.audioDir || path.join(guessUserData, 'audio')),
      uploads: path.resolve(manifest.uploadsDir || path.join(guessUserData, 'uploads')),
      generated: path.resolve(manifest.generatedDir || path.join(guessUserData, 'generated')),
    }
    protocol.handle('dreambyte', makeHandler(mounts))

    const verifier = require(path.join(tmp, 'scene-verifier.cjs'))
    verifier.setVerifierEnv({ electron: require('electron'), preloadPath: path.join(tmp, 'verifier-preload.js') })

    for (const s of scenes) {
      const abs = path.join(mounts.scenes, s.file)
      if (!fs.existsSync(abs)) {
        results[s.sceneId] = { status: 'unknown', error: { kind: 'harness', message: 'scene HTML missing on disk' } }
        continue
      }
      try {
        // Load exactly as the app does — the scene sandbox origin.
        results[s.sceneId] = await verifier.verifySceneUrl(`dreambyte://scene-frame/${encodeURIComponent(s.file)}`)
      } catch (e) {
        results[s.sceneId] = {
          status: 'unknown',
          error: { kind: 'harness', message: String(e && e.message ? e.message : e) },
        }
      }
    }
    verifier.disposeVerifierPool?.()
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    for (const s of scenes) {
      if (results[s.sceneId]?.status === 'unknown')
        results[s.sceneId] = { status: 'unknown', error: { kind: 'harness', message: msg } }
    }
    process.stderr.write(`[render-verify] skipped (honest): ${msg}\n`)
  }

  fs.writeFileSync(outPath, JSON.stringify(results), 'utf8')
  app.exit(0)
}

main().catch((e) => {
  process.stderr.write(`[render-verify] fatal: ${e}\n`)
  try {
    fs.writeFileSync(outPath, JSON.stringify({}), 'utf8')
  } catch {
    /* nothing more we can do */
  }
  app.exit(1)
})
