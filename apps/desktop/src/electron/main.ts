import path from 'path'
import { app, BrowserWindow, ipcMain, clipboard, dialog, Menu, protocol, screen, session, shell } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import { pathToFileURL } from 'url'
import { Readable } from 'node:stream'
import { config as loadDotenv } from 'dotenv'
import { registerAllIpc } from './ipc'
import {
  sweepExportOrphans,
  captureSceneFrameTier3,
  captureSceneFramesTier3,
  overlayProgramAudio,
  assertExportArtifact,
  type Tier3ProgramAudioClip,
} from './ipc/export-tier3'
import { normalizeFinalAudio, resolveExportFfmpegBin } from './ipc/audio-normalize'
import { exportTimelineToFcpxmlFile } from './ipc/export-fcpxml'
import { resolveProjectDimensions, type AspectRatio } from '@/lib/dimensions'
import os from 'os'
import * as captionBurn from './ipc/caption-burn'
// Path helpers live in `./paths.ts` so `src/electron/ipc/*.ts` can reuse them
// without creating circular imports with main.ts.
import {
  getUserScenesDir,
  getUserUploadsDir,
  getUserAudioDir,
  getUserGeneratedDir,
  getStaticAppDir,
  getStitcherPath,
  validateExportDeps,
} from './paths'
import { createLogger } from '../lib/logger'
import { initAutoUpdater, checkForUpdatesInteractive } from './auto-updater'
import { runMigrations } from '../lib/db/migrate'
import { track as telemetryTrack, shutdown as telemetryShutdown } from '../lib/telemetry'
import { initCrashReporter, shutdownCrashReporter } from '../lib/crash-telemetry'
import { flushAllPendingVersions } from '../lib/db/queries/scene-versions'
import { hydrateEnvFromKeyring } from './provider-keys'
import { setMcpHostConfig } from '../lib/agents/mcp-host-config'
import { startMcpBridge, writeBridgeDiscoveryFile, deleteBridgeDiscoveryFile } from './mcp-bridge'
import { instanceIdFor, instanceSocketPath, writeInstanceManifest, removeInstanceDir } from '../lib/mcp/instance-registry'
import {
  setRendererNotifier,
  setExportRunner,
  setCaptureRunner,
  setMultiCaptureRunner,
  setEditorStateReader,
  setMcpHumanConfirmer,
  type McpEditorState,
} from '../lib/agents/mcp-handler'
import { validateExportSettings } from '../lib/export/export-settings-validation'
import { buildExportPath } from '../lib/export/export-path'
import { SCENE_CSP } from '../lib/security/scene-csp'
import { rebuildLegacySceneHtml } from '../lib/sceneTemplate'
import { startMcpServerProcess } from './mcp-server-manager'

const log = createLogger('electron.main')

// ── .env loading ────────────────────────────────────────────────────────────
// The main process does not inherit the Next.js auto-dotenv behavior. Without
// this, `process.env.DATABASE_URL`, `ANTHROPIC_API_KEY`, etc. are empty in the
// packaged `.dmg` (no shell env) and `dreambyte:settings.listProviders` /
// `dreambyte:conversations.*` both fail immediately.
//
// Resolution order:
//   1. Dev: `<repoRoot>/.env.local`, then `<repoRoot>/.env`.
//   2. Packaged: `<userData>/dreambyte.env` (user-provided keys), then
//      `<Resources>/.env.defaults` (bundled defaults, if any).
// `.env.local` overrides `.env` the same way Next.js orders them.
function loadEnvFiles(): void {
  const attempted: string[] = []
  const tryLoad = (p: string) => {
    attempted.push(p)
    if (fsSync.existsSync(p)) {
      loadDotenv({ path: p, override: false })
    }
  }
  if (app.isPackaged) {
    tryLoad(path.join(app.getPath('userData'), 'dreambyte.env'))
    tryLoad(path.join(process.resourcesPath, '.env.defaults'))
  } else {
    const repoRoot = path.resolve(__dirname, '..')
    tryLoad(path.join(repoRoot, '.env.local'))
    tryLoad(path.join(repoRoot, '.env'))
  }
}
// Back-compat for installs created under the app's pre-rename name ("cench"):
// their data lives in a different `userData` dir. If such an install exists and
// has not been migrated yet, copy it over and rename the db/env files. Best-effort — never blocks boot. Runs before env load
// and DB resolution (both read userData). Old `cench://` asset URLs in the
// migrated DB keep resolving via the dual-scheme protocol handler below.
function migrateLegacyDreambyteData(): void {
  try {
    const userData = app.getPath('userData')
    if (!fsSync.existsSync(path.join(userData, 'dreambyte.db'))) {
      const parent = path.dirname(userData)
      const oldDir = ['cench-studio', 'Cench Studio', 'cench', 'Cench']
        .map((n) => path.join(parent, n))
        .find(
          (d) =>
            d !== userData &&
            (fsSync.existsSync(path.join(d, 'cench.db')) || fsSync.existsSync(path.join(d, 'dreambyte.db'))),
        )
      if (oldDir) {
        fsSync.mkdirSync(userData, { recursive: true })
        fsSync.cpSync(oldDir, userData, { recursive: true, force: false, errorOnExist: false })
        const ren = (a: string, b: string) => {
          const A = path.join(userData, a)
          const B = path.join(userData, b)
          if (fsSync.existsSync(A) && !fsSync.existsSync(B)) fsSync.renameSync(A, B)
        }
        // Rename the SQLite DB and its WAL sidecars together, plus the env file.
        ren('cench.db', 'dreambyte.db')
        ren('cench.db-wal', 'dreambyte.db-wal')
        ren('cench.db-shm', 'dreambyte.db-shm')
        ren('cench.env', 'dreambyte.env')
        console.log(`[dreambyte] migrated legacy data from ${oldDir}`)
      }
    }
    // MCP bridge/socket dir.
    const home = app.getPath('home')
    const oldHome = path.join(home, '.cench')
    const newHome = path.join(home, '.dreambyte')
    if (fsSync.existsSync(oldHome) && !fsSync.existsSync(newHome)) {
      fsSync.renameSync(oldHome, newHome)
    }
  } catch (e) {
    console.error('[dreambyte] legacy data migration failed:', e)
  }
}
migrateLegacyDreambyteData()
loadEnvFiles()

// Standalone mode treats an unpackaged dev launch the same as a packaged build:
// load the renderer from the static `out/` bundle via the dreambyte:// protocol
// handler instead of localhost:3000. Lets `npm run dev:electron` boot a real
// desktop app without needing a Next dev server running alongside it.
const STANDALONE_MODE = app.isPackaged || process.env.DREAMBYTE_FORCE_STATIC === '1'

// Tell runtime path resolvers (`src/lib/audio/paths.ts`, `src/lib/uploads/paths.ts`)
// where to write assets and which URL prefix to stamp into scene HTML.
// Must run before any IPC handler loads a provider or service module.
//   Next dev: public/<kind>    +  /<kind>/           (Next serves)
//   Standalone: <userData>/<kind> +  dreambyte://<kind>/ (protocol handler serves)
if (STANDALONE_MODE) {
  process.env.DREAMBYTE_AUDIO_DIR = getUserAudioDir()
  process.env.DREAMBYTE_AUDIO_URL_BASE = 'dreambyte://audio/'
  process.env.DREAMBYTE_UPLOADS_DIR = getUserUploadsDir()
  process.env.DREAMBYTE_UPLOADS_URL_BASE = 'dreambyte://uploads/'
  // Generated-media mount: media-cache.ts and friends write here —
  // `public/generated` is read-only inside app.asar. URLs stay
  // `/generated/...`; the protocol handler's app-host rewrite maps them
  // onto this mount, same as uploads.
  process.env.DREAMBYTE_GENERATED_DIR = getUserGeneratedDir()
  // Used by `src/lib/sceneTemplate.ts` and `src/lib/agents/context-builder.ts` when
  // baking absolute asset URLs into generated scene HTML and agent prompts.
  // Standalone mode has no HTTP server — every URL must resolve through the
  // `dreambyte://` protocol handler.
  process.env.DREAMBYTE_APP_URL_BASE = 'dreambyte://app/'
  // Writable scenes dir used by `src/lib/agents/mcp-handler.ts`. The bundled
  // `out/` directory lives under `app.asar` and is read-only.
  process.env.DREAMBYTE_SCENES_DIR = getUserScenesDir()
  // Published preview snapshots (publish IPC) — read/written by
  // `src/electron/ipc/publish.ts` and `projects.ts`. Keeps everything the
  // renderer writes inside `<userData>`, out of the asar bundle.
  process.env.DREAMBYTE_PUBLISHED_DIR = path.join(app.getPath('userData'), 'published')
}

// Tell telemetry where to find userData (for the device-id file + opt-out
// marker). Telemetry itself stays no-op until track() is called and a
// DREAMBYTE_TELEMETRY_URL is configured.
process.env.DREAMBYTE_USER_DATA_DIR = app.getPath('userData')
process.env.DREAMBYTE_APP_VERSION = app.getVersion()

// Crash + error reporting. No-ops unless DREAMBYTE_SENTRY_DSN is set AND the
// user hasn't opted out (shares src/lib/telemetry's opt-out signals). Init here —
// before any window — so boot-time crashes are captured. Fire-and-forget; the
// init itself never throws into boot.
void initCrashReporter()

// Resolve DATABASE_URL for the local SQLite database.
// libsql accepts file: / libsql: / ws: / wss: / http: / https:. Anything
// else — most often a leftover postgresql:// URL from the pre-SQLite days —
// would crash boot with URL_SCHEME_NOT_SUPPORTED. Fall back to the
// per-user SQLite file in those cases and warn loudly so the user can
// update their env.
{
  const dbFile = path.join(app.getPath('userData'), 'dreambyte.db')
  const defaultUrl = `file:${dbFile}`
  const current = process.env.DATABASE_URL
  if (!current) {
    process.env.DATABASE_URL = defaultUrl
  } else {
    const supported = /^(file|libsql|wss?|https?):/i.test(current)
    if (!supported) {
      log.warn('ignoring unsupported DATABASE_URL scheme; falling back to SQLite', {
        extra: { scheme: current.split(':')[0], fallback: defaultUrl },
      })
      process.env.DATABASE_URL = defaultUrl
    }
  }
}

function webZoomTargetWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

// Legacy `dev:electron:web` flow only. Standalone (packaged + dev:desktop)
// loads from `dreambyte://app/…` via the protocol handler registered below — no
// HTTP server is ever reached. There is no default HTTP URL; callers that want
// HTTP must set ELECTRON_START_URL explicitly.
const DEV_URL = process.env.ELECTRON_START_URL ?? null

// Runtime-writable user-data layout. In the packaged app, scenes and
// uploads cannot be written back into the read-only `out/` bundle, so:
//   dreambyte://app/...      → Next static export (read-only bundle)
//   dreambyte://scenes/...   → `<userData>/scenes`   (writable)
//   dreambyte://uploads/...  → `<userData>/uploads`  (writable)

// Privileged scheme must be registered synchronously before `app.ready`.
// `cench` is a back-compat scheme for pre-rename installs: registered with the
// same privileges so their persisted `cench://...` asset URLs keep resolving;
// the same handler serves both schemes (see below).
const ASSET_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'dreambyte', privileges: ASSET_SCHEME_PRIVILEGES },
  { scheme: 'cench', privileges: ASSET_SCHEME_PRIVILEGES },
])

/** Extension → Content-Type for the asset protocol (file serving is manual
 *  now — net.fetch is bypassed so Range semantics can be implemented). */
const PROTOCOL_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

function contentTypeFor(filePath: string): string {
  return PROTOCOL_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function registerDreambyteProtocol(): Promise<void> {
  const staticDir = path.resolve(getStaticAppDir())
  const scenesDir = path.resolve(getUserScenesDir())
  const uploadsDir = path.resolve(getUserUploadsDir())
  const audioDir = path.resolve(getUserAudioDir())
  const generatedDir = path.resolve(getUserGeneratedDir())
  await fs.mkdir(scenesDir, { recursive: true })
  await fs.mkdir(uploadsDir, { recursive: true })
  await fs.mkdir(audioDir, { recursive: true })
  await fs.mkdir(generatedDir, { recursive: true })

  // TODO 4: reap export temp orphans left by a crashed/killed render. Runs
  // before any export can start (this is part of startup) and is lock/age-safe
  // under concurrent instances. Fire-and-forget so it never delays launch.
  void sweepExportOrphans().catch(() => {})

  // Draft sweep: soft-hide provably-untouched empty drafts and
  // hard-purge drafts hidden for >7 days. Fire-and-forget so it never delays
  // launch; the classification is conservative (4-condition emptiness proof)
  // and soft-hide is reversible for the whole retention window.
  void import('../lib/db/queries/projects')
    .then(async ({ runDraftSweep }) => {
      // Purge through the SAME fs cleanup a manual delete uses, so a
      // swept draft frees scene HTML / published dir / project data dir — not
      // just the DB row. The sweep runs in main, so it has fs access.
      const { cleanupProjectFilesById } = await import('./ipc/projects')
      await runDraftSweep(Date.now(), cleanupProjectFilesById)
    })
    .catch(() => {})

  const handleAsset = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      let host = url.hostname
      let rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')

      // Renderer-side compat: components construct relative URLs like
      // `/scenes/<id>.html`, `/audio/<file>.wav`, `/uploads/<file>.png`.
      // In dev these are served by Next from `public/`. In packaged mode
      // the renderer's origin is `dreambyte://app/`, so a relative `/scenes/...`
      // resolves to `dreambyte://app/scenes/...` — pointing at the read-only
      // static bundle instead of the writable user data mount where new
      // user content lives. Rewrite the prefix so the existing dispatch
      // below routes to the right baseDir without every renderer call site
      // having to learn about the dreambyte:// host scheme. The anchored regex
      // requires a trailing slash so `app/scenesnotamatch` does not match.
      if ((host === 'app' || host === '') && /^(scenes|audio|uploads|generated)\//.test(rawPath)) {
        const slash = rawPath.indexOf('/')
        host = rawPath.slice(0, slash)
        rawPath = rawPath.slice(slash + 1)
      }

      // Scene sandbox origin. Scene previews load from a distinct
      // `dreambyte://scene-frame` host so the same-origin policy isolates
      // LLM-generated scene JS from the `dreambyte://app` renderer (it can no
      // longer reach `window.parent.dreambyteApi`). The scene HTML and any
      // relative assets still live in the scenes/audio/uploads user-data
      // mounts, so map this host onto them. The bare `<id>.html` request
      // routes to the scenes mount; `audio/…` and `uploads/…` subpaths route
      // to their own mounts. See src/lib/scene-url.ts.
      if (host === 'scene-frame') {
        const m = /^(scenes|audio|uploads|generated)\//.exec(rawPath)
        if (m) {
          host = m[1]
          rawPath = rawPath.slice(m[0].length)
        } else {
          host = 'scenes'
        }
      }

      let baseDir: string
      // Scene documents are served from the `scenes` mount (the `scene-frame`
      // preview host already rewrote to `scenes` above). They run model-authored
      // JS, so they get a strict CSP — the `app` static
      // bundle (the privileged renderer) must NOT, it needs broad network access.
      const isSceneHost = host === 'scenes'
      if (host === 'scenes') {
        baseDir = scenesDir
      } else if (host === 'uploads') {
        baseDir = uploadsDir
      } else if (host === 'audio') {
        baseDir = audioDir
      } else if (host === 'generated') {
        baseDir = generatedDir
      } else if (host === 'luts') {
        // 3D `.cube` LUTs for clip color grades. apply_color copies each picked LUT
        // into `~/.dreambyte/luts/`; the preview pool + export host fetch them here by
        // basename so the Tier-B grade reads identical bytes in both (preview == export).
        baseDir = path.join(app.getPath('home'), '.dreambyte', 'luts')
      } else if (host === 'app' || host === '') {
        baseDir = staticDir
      } else {
        return new Response(`Unknown dreambyte:// host "${host}"`, { status: 404 })
      }

      let filePath = path.resolve(baseDir, rawPath || 'index.html')
      if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
        return new Response('Forbidden', { status: 403 })
      }

      // Fall through to index.html for directory paths
      try {
        const stat = await fs.stat(filePath)
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html')
      } catch {
        // Next.js static export writes `foo.html` for `/foo` — try that too
        if (!filePath.endsWith('.html')) {
          const htmlVariant = `${filePath}.html`
          try {
            await fs.access(htmlVariant)
            filePath = htmlVariant
          } catch {}
        }
      }

      // Re-check after realpath so a symlink planted inside the
      // user-writable scenes directory cannot escape the mount root
      // (e.g., `dreambyte://scenes/evil` → `/etc/passwd`). The privileged
      // `secure: true` scheme means a renderer fetch on that URL would
      // otherwise read an arbitrary file through the Chromium net stack.
      try {
        const realPath = await fs.realpath(filePath)
        if (!realPath.startsWith(baseDir + path.sep) && realPath !== baseDir) {
          return new Response('Forbidden (symlink escape)', { status: 403 })
        }
        filePath = realPath
      } catch {
        // File may not exist yet (the stat below returns 404).
      }

      // Media files (audio/video) MUST be served with Range support:
      // Chromium's media stack probes with Range requests and fails the
      // element with MEDIA_ERR_SRC_NOT_SUPPORTED when a server answers a
      // ranged request with a full-body 200 and no Content-Length — which is
      // exactly what wrapping net.fetch produced. Serve files directly with
      // 206/Content-Range semantics instead.
      //
      // CORS note: dreambyte://uploads etc. are DIFFERENT origins from
      // dreambyte://app (host differs), and WebAudio's MediaElementSource
      // outputs SILENCE for tainted cross-origin media — the timeline audio
      // engine loads clips with crossOrigin="anonymous", which requires the
      // ACAO header. Local asset mounts only; '*' is safe here.
      let stat2
      try {
        stat2 = await fs.stat(filePath)
      } catch {
        return new Response('Not found', { status: 404 })
      }
      const size = stat2.size
      const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': contentTypeFor(filePath),
        'Last-Modified': stat2.mtime.toUTCString(),
      })
      // Strict CSP on scene HTML documents: cap where a
      // model-authored scene may open network connections so it cannot exfiltrate
      // timeline/project data to an arbitrary host. The same policy is mirrored as
      // a <meta> in the scene HTML (src/lib/sceneTemplate.ts) to cover the export
      // srcdoc path, which receives no response headers. See src/lib/security/scene-csp.ts.
      if (isSceneHost && filePath.endsWith('.html')) {
        headers.set('Content-Security-Policy', SCENE_CSP)
        // Every scene document (preview, verifier, tier-3 export + compositor
        // host, frame capture) is served here: HTML written before the anime.js
        // runtime is swapped for the regenerate placeholder so it never pulls the
        // removed runtime from its CDN fallback. Served whole (no Range) — HTML.
        const body = Buffer.from(rebuildLegacySceneHtml(await fs.readFile(filePath, 'utf8')), 'utf8')
        headers.set('Content-Length', String(body.length))
        return new Response(body, { status: 200, headers })
      }
      const rangeHeader = request.headers.get('range')
      const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
      if (m && (m[1] !== '' || m[2] !== '')) {
        let start: number
        let end: number
        if (m[1] === '') {
          // suffix range: last N bytes
          const n = Math.min(Number(m[2]), size)
          start = size - n
          end = size - 1
        } else {
          start = Number(m[1])
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          headers.set('Content-Range', `bytes */${size}`)
          return new Response('Range not satisfiable', { status: 416, headers })
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
        headers.set('Content-Length', String(end - start + 1))
        const stream = Readable.toWeb(fsSync.createReadStream(filePath, { start, end })) as unknown as ReadableStream
        return new Response(stream, { status: 206, headers })
      }
      headers.set('Content-Length', String(size))
      const stream = Readable.toWeb(fsSync.createReadStream(filePath)) as unknown as ReadableStream
      return new Response(stream, { status: 200, headers })
    } catch (err) {
      log.error('dreambyte-protocol: failed to serve', { extra: { url: request.url }, error: err })
      return new Response('Internal error', { status: 500 })
    }
  }

  protocol.handle('dreambyte', handleAsset)
  // Back-compat for pre-rename installs whose DB and scene HTML carry
  // `cench://...` URLs. New writes only ever emit `dreambyte://`.
  protocol.handle('cench', handleAsset)
}

function sanitizeFilename(hint: string, fallback = 'recording'): string {
  return (
    (hint || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || fallback
  )
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Offscreen scene windows (verifier, tier-3 export/compositor, frame capture) run
// untrusted scene code: no window in this app may spawn popups.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    backgroundColor: '#0b0b0f',
    titleBarStyle: 'hiddenInset',
    // Vertically centered in the 40px header so the dots line up with the
    // header buttons (which center ~y=20): (40 − 14)/2 ≈ 13.
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  const appUrl = STANDALONE_MODE ? 'dreambyte://app/index.html' : DEV_URL
  if (!appUrl) {
    throw new Error(
      'No renderer URL resolved. Standalone mode is off and ELECTRON_START_URL is unset — run `npm run dev:desktop` (dreambyte://) or set ELECTRON_START_URL explicitly for the legacy web dev flow.',
    )
  }
  win.loadURL(appUrl)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A scene frame (untrusted code) can try to navigate the top window; the app
  // window must never leave its own origin, or the page it lands on gets the preload APIs.
  // (URL.origin is "null" for custom schemes, so compare scheme + host.)
  const originOf = (u: string) => {
    const x = new URL(u)
    return `${x.protocol}//${x.host}`
  }
  const appOrigin = originOf(appUrl)
  win.webContents.on('will-navigate', (event, url) => {
    if (originOf(url) !== appOrigin) event.preventDefault()
  })

  // Surface an explicit DREAMBYTE_EXPORT_ENGINE override to the in-app export path
  // (the headless MCP path passes engine explicitly). Tier 3 is the default, so
  // this is mainly how `DREAMBYTE_EXPORT_ENGINE=legacy` forces the old pixi path.
  // Re-runs on each reload (watch builds reload the renderer).
  if (process.env.DREAMBYTE_EXPORT_ENGINE === 'tier3' || process.env.DREAMBYTE_EXPORT_ENGINE === 'legacy') {
    const engineOverride = process.env.DREAMBYTE_EXPORT_ENGINE
    win.webContents.on('did-finish-load', () => {
      win.webContents
        .executeJavaScript(`window.__DREAMBYTE_EXPORT_ENGINE = ${JSON.stringify(engineOverride)};`)
        .catch(() => {})
    })
  }

  // Wire up the MCP renderer notifier — when terminal Claude (MCP bridge)
  // writes scenes, the renderer's Zustand store reloads the project so the
  // timeline updates without requiring an app restart.
  setRendererNotifier((projectId: string) => {
    if (win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (() => {
        const store = window.__dreambyteStore;
        if (!store) return;
        const state = store.getState();
        const current = state.project && state.project.id;
        const target = ${JSON.stringify(projectId)};
        // If the MCP wrote to a DIFFERENT project than the window is showing,
        // switch to it — otherwise the agent's work is invisible (and on refresh
        // the window reloads the old project, so it looks like everything
        // "disappeared"). loadProject sets the active project, so the switch
        // persists across reloads. Same project ⇒ a refresh is enough.
        //
        // Switch-policy gate: never yank the window out from under active
        // work. Auto-switch only when nothing is lost by following the agent —
        // welcome screen, an untouched draft, or the window unfocused (user is
        // elsewhere). Mid-work (focused with scenes, or an in-window agent
        // run), surface an "Open" toast instead and let the user decide.
        if (current !== target && typeof state.loadProject === 'function') {
          const busy = state.isAgentRunning === true || state.isAgentRunningRemote === true;
          const untouched = !current || (state.scenes || []).length === 0;
          const away = !document.hasFocus();
          if (!busy && (untouched || away || state.appView !== 'project')) {
            state.loadProject(target).catch(() => {});
          } else if (typeof window.__dreambyteExternalProjectUpdate === 'function') {
            const list = Array.isArray(state.projectList) ? state.projectList : [];
            const name = list.find((p) => p.id === target)?.name;
            window.__dreambyteExternalProjectUpdate(target, name);
          } else {
            // Toast bridge not mounted (StrictMode/HMR remount window, or very
            // early boot). This branch is only reached when the gate said the
            // user is MID-WORK — yanking the window here is worse than a
            // missed toast, so do nothing; the agent's work is on disk and
            // appears on the next project-list refresh.
            console.warn('[mcp] project ' + target + ' updated externally; toast bridge unavailable');
          }
        } else if (typeof state.refreshProjectFromServer === 'function') {
          // refreshProjectFromServer pulls from ipc.get() without calling
          // saveProjectToDb first — safe after MCP writes because it won't
          // overwrite the DB with stale in-memory scene data.
          state.refreshProjectFromServer().catch(() => {});
        } else if (typeof state.loadProject === 'function') {
          state.loadProject(target).catch(() => {});
        }
      })()
    `).catch(() => {})
  })

  // Headless MP4 export for the MCP / external-agent path: run the renderer's
  // exportVideo() (Pixi/WebCodecs) in-place and resolve with the written path.
  // The MCP handler does NOT await this (the render takes minutes) — it tracks a
  // job and the agent polls get_export_status. We poll the renderer's
  // exportProgress here and forward it to onProgress so that poll has live data.
  // capture_frame: real headless single-frame capture via the
  // offscreen tier-3 engine. Unlike the export runner below, this does NOT touch
  // the editor window — it spins its own offscreen BrowserWindow — so capturing a
  // frame for an agent never hijacks the user's open project.
  setCaptureRunner((spec, timeSeconds, opts) => captureSceneFrameTier3(spec, timeSeconds, opts))
  // review_scene_motion: N timeline frames of one scene, one
  // offscreen window load. Same offscreen engine, no editor hijack.
  setMultiCaptureRunner((spec, times, opts) => captureSceneFramesTier3(spec, times, opts))

  // Human consent for the two MCP tools that can raise spend on the user's own
  // API keys (set_max_run_cost upward, approve_pending_generation grants).
  // Anything that can reach the MCP socket can call them, so the gate has to be
  // a real person, not a prompt instruction. A native modal is deliberate: it
  // cannot be driven by page content, and it defaults to "Cancel" so a dismissed
  // or timed-out dialog reads as a refusal.
  setMcpHumanConfirmer(async ({ title, body, confirmLabel }) => {
    if (win.isDestroyed()) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', confirmLabel],
      defaultId: 0,
      cancelId: 0,
      title,
      message: title,
      detail: body,
      noLink: true,
    })
    return response === 1
  })

  // read_editor_state: read the renderer's live Zustand store —
  // the user's current selection / playhead / zoom — so an MCP agent can act on
  // what the user is looking at. Returns null if the window is gone or the store
  // isn't mounted, so read_editor_state answers honestly.
  setEditorStateReader(async () => {
    if (win.isDestroyed()) return null
    try {
      return (await win.webContents.executeJavaScript(
        `(() => {
          const s = window.__dreambyteStore && window.__dreambyteStore.getState && window.__dreambyteStore.getState();
          if (!s) return null;
          const tt = s.timelineTransport || {};
          return {
            projectId: (s.project && s.project.id) || null,
            selectedSceneId: s.selectedSceneId || null,
            selectedClipIds: Array.isArray(s.selectedClipIds) ? s.selectedClipIds.slice() : [],
            currentTime: tt.globalTime || 0,
            isPlaying: !!tt.isPlaying,
            totalDuration: tt.totalDuration || 0,
            timelineZoom: s.timelineZoom || 0,
            capturedAt: new Date().toISOString(),
          };
        })()`,
      )) as McpEditorState | null
    } catch {
      return null
    }
  })

  setExportRunner(async (settings, projectId, onProgress) => {
    if (win.isDestroyed()) throw new Error('app window destroyed')
    // SECURITY: resolution/fps originate from an external agent's tool args and
    // get interpolated into executeJavaScript source below. validateExportSettings
    // returns a resolution from the allowlist and a finite integer fps, so a
    // crafted value can't inject code. Shared with the in-app path (AgentChat.tsx).
    const { resolution, fps } = validateExportSettings(settings)
    // Export engine for the headless path. Tier 3 (real-compositor capture) is
    // the default; DREAMBYTE_EXPORT_ENGINE=legacy forces the old pixi path. The
    // value is from a trusted env var (not the agent) and constrained to a
    // literal below, so it's safe to interpolate into executeJavaScript.
    const exportEngine = process.env.DREAMBYTE_EXPORT_ENGINE === 'legacy' ? 'legacy' : 'tier3'

    // Best-effort live progress: sample the store's exportProgress while the
    // render runs. Failures here never affect the render (the export promise is
    // the source of truth); progress is a nicety for the polling agent.
    let polling = true
    const pollProgress = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 600))
        if (!polling || win.isDestroyed()) break
        try {
          const p = (await win.webContents.executeJavaScript(
            `(() => { const s = window.__dreambyteStore && window.__dreambyteStore.getState().exportProgress; return s ? { progress: s.sceneProgress, currentScene: s.currentScene, totalScenes: s.totalScenes } : null; })()`,
          )) as { progress?: number; currentScene?: number; totalScenes?: number } | null
          if (p && onProgress) onProgress(p)
        } catch {
          // ignore — progress is best-effort
        }
      }
    }
    void pollProgress()

    try {
      // NOTE: an executeJavaScript rejection crosses the bridge as a bare
      // message string — custom error fields are dropped. The catch below
      // re-samples the renderer's exportProgress slot for the structured
      // failing-scene context (11b) and re-attaches it for the MCP job.
      const outputPath: string = await win.webContents.executeJavaScript(`
        (async () => {
          const store = window.__dreambyteStore;
          if (!store) throw new Error('editor store unavailable');
          // Render the agent-selected project, not whatever the editor has open.
          // projectId is interpolated as a JSON string literal (safe); loadProject
          // resolves it against the DB by id.
          const projectId = ${JSON.stringify(projectId)};
          // Remember what the user had open so an agent-triggered export of a
          // different project doesn't hijack their editor view permanently.
          const prevProjectId = store.getState().project?.id || null;
          let switched = false;
          if (projectId && prevProjectId !== projectId) {
            if (typeof store.getState().loadProject !== 'function') {
              throw new Error('cannot switch project for export (loadProject unavailable)');
            }
            await store.getState().loadProject(projectId);
            if (store.getState().project?.id !== projectId) {
              throw new Error('failed to load project ' + projectId + ' for export');
            }
            switched = true;
          }
          try {
            const dir = await window.electronAPI.getDefaultExportDir();
            if (!dir || !dir.dirPath) throw new Error('no export directory available');
            // Single source of truth for the filename (export item 10): the
            // injected source below IS src/lib/export/export-path.ts's
            // buildExportPath — toString() of a pure, self-contained function,
            // so this in-page copy can never drift semantically from the TS
            // one the in-app path uses. (export-path.test.ts pins the
            // standalone contract; build.mjs must not enable minify/keepNames
            // — see the helper's doc.)
            const buildExportPath = ${buildExportPath.toString()};
            const outputPath = buildExportPath(store.getState().project?.name, dir.dirPath, new Date());
            // exportVideo() now THROWS on render failure — a
            // throw here rejects this executeJavaScript promise, so the MCP job
            // is marked 'error' (not 'complete' with a path to a file that was
            // never written). The post-check below is defense-in-depth for an
            // interrupted run left at a non-'complete' phase without throwing.
            await store.getState().exportVideo({ resolution: ${JSON.stringify(resolution)}, fps: ${fps}, format: 'mp4', outputPath, engine: ${JSON.stringify(exportEngine)} });
            const prog = store.getState().exportProgress;
            if (!prog || prog.phase !== 'complete') {
              throw new Error((prog && prog.error) || 'export failed');
            }
            return outputPath;
          } finally {
            // Restore the user's prior project even if the export failed.
            // Best-effort: a failed restore must not mask the export's
            // real outcome (the original error already propagated); swallow it.
            if (switched && prevProjectId && store.getState().project?.id !== prevProjectId) {
              try { await store.getState().loadProject(prevProjectId); } catch (e) { /* restore is best-effort */ }
            }
          }
        })()
      `)
      return { outputPath }
    } catch (err) {
      // 11b: re-attach the structured failing-scene context the bridge
      // dropped. Best-effort — a destroyed window or a non-export error just
      // rethrows the original. NOTE: this sample runs AFTER the in-page
      // finally restored the user's prior project (loadProject) — it works
      // because loadProject never touches exportProgress; if project-switch
      // hygiene ever clears that slot, this re-sample silently loses the
      // scene context.
      try {
        if (!win.isDestroyed()) {
          const ctx = (await win.webContents.executeJavaScript(
            `(() => { const p = window.__dreambyteStore && window.__dreambyteStore.getState().exportProgress; return p && p.phase === 'error' ? { sceneIndex: p.errorSceneIndex ?? null, sceneId: p.errorSceneId ?? null } : null; })()`,
          )) as { sceneIndex: number | null; sceneId: string | null } | null
          if (ctx && (ctx.sceneIndex != null || ctx.sceneId)) {
            ;(err as Error & { sceneIndex?: number; sceneId?: string }).sceneIndex = ctx.sceneIndex ?? undefined
            ;(err as Error & { sceneIndex?: number; sceneId?: string }).sceneId = ctx.sceneId ?? undefined
          }
        }
      } catch {
        // context sampling is best-effort; the original error stands
      }
      throw err
    } finally {
      polling = false
    }
  })

  // In dev standalone mode, auto-reload when the renderer watch build finishes.
  // build-renderer.mjs --watch writes out/.renderer-watch-signal after each
  // successful rebuild (including the initial one); a reload then shows the new
  // bundle without a manual Cmd+R.
  //
  // We poll the signal FILE with fs.watchFile rather than fs.watch on the out/
  // directory. `next build` deletes and recreates out/ on every rebuild, which
  // invalidates a directory-level fs.watch handle (it stays bound to the old,
  // now-unlinked inode and never fires again). watchFile re-stats the path each
  // interval, so it survives the dir/file being replaced and reliably catches
  // the post-build signal (otherwise launches show the stale bundle).
  if (STANDALONE_MODE && !app.isPackaged) {
    const signalPath = path.join(getStaticAppDir(), '.renderer-watch-signal')
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    try {
      fsSync.watchFile(signalPath, { interval: 400 }, (curr, prev) => {
        // mtimeMs === 0 means the file is currently absent (mid-rebuild); wait
        // for the recreate. Only reload when the signal's mtime actually moved.
        if (curr.mtimeMs === 0 || curr.mtimeMs === prev.mtimeMs) return
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
          if (!win.isDestroyed()) win.webContents.reload()
        }, 300)
      })
    } catch {
      // Best-effort — no auto-reload if the watch can't be established.
    }
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (w)
              w.webContents.executeJavaScript(`
              (() => {
                const store = window.__dreambyteStore;
                if (store) { store.setState({ project: { ...store.getState().project, id: '' } }); window.location.href = '/'; }
              })()
            `)
          },
        },
        { type: 'separator' },
        {
          label: 'Export FCPXML…',
          // Interchange export for finishing in Final Cut Pro / DaVinci Resolve.
          // Reads the live timeline from the renderer store, then resolves real
          // file:// asset paths + writes the .fcpxml in the main process.
          click: async () => {
            const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (!w) return
            let raw: string | null = null
            try {
              // Format settings live on project.mp4Settings (aspectRatio / resolution
              // / fps) — the SAME source the agent-tool path reads via
              // world.mp4Settings (planning-export-tools.ts). The export-form draft
              // is a transient UI key (exportFormDraft) and may be null, so prefer
              // the persisted project settings and fall back to the draft.
              raw = await w.webContents.executeJavaScript(`(() => {
                const s = window.__dreambyteStore?.getState?.();
                const p = s?.project;
                if (!p || !p.timeline || !Array.isArray(p.timeline.tracks) || p.timeline.tracks.length === 0) return null;
                const m = p.mp4Settings || {};
                const draft = s?.exportFormDraft || {};
                return JSON.stringify({
                  timeline: p.timeline,
                  aspectRatio: m.aspectRatio || '16:9',
                  resolution: draft.resolution || m.resolution || '1080p',
                  fps: draft.fps || m.fps || 30,
                  name: p.name || 'Dreambyte Timeline',
                });
              })()`)
            } catch {
              raw = null
            }
            if (!raw) {
              await dialog.showMessageBox(w, {
                type: 'info',
                message: 'Nothing to export to FCPXML',
                detail:
                  'Open a project and add media clips (video / image / audio) to the timeline, then try again. Code-rendered scenes export only after they are rendered to MP4.',
              })
              return
            }
            const payload = JSON.parse(raw) as {
              timeline: import('@/lib/types').Timeline
              aspectRatio?: AspectRatio
              resolution?: '720p' | '1080p' | '4k'
              fps?: number
              name?: string
            }
            const dims = resolveProjectDimensions(payload.aspectRatio, payload.resolution)
            const res = await exportTimelineToFcpxmlFile(
              {
                timeline: payload.timeline,
                fps: payload.fps ?? 30,
                width: dims.width,
                height: dims.height,
                name: payload.name ?? 'Dreambyte Timeline',
                defaultFileName: `${(payload.name ?? 'dreambyte-timeline').replace(/[^a-zA-Z0-9._-]+/g, '-')}.fcpxml`,
              },
              w,
            )
            if (res.canceled) return
            if (res.error) {
              await dialog.showMessageBox(w, { type: 'error', message: 'FCPXML export failed', detail: res.error })
              return
            }
            const skippedScenes = (res.skipped ?? []).filter((s) => s.sourceType === 'scene').length
            const otherSkipped = (res.skipped ?? []).length - skippedScenes
            const notes: string[] = []
            if (skippedScenes > 0)
              notes.push(`${skippedScenes} code-rendered scene(s) were skipped — render them to MP4 first to include them.`)
            if (otherSkipped > 0) notes.push(`${otherSkipped} clip(s) had no resolvable media file.`)
            await dialog.showMessageBox(w, {
              type: 'info',
              message: `Exported ${res.clipCount ?? 0} clip(s) to FCPXML`,
              detail: [`Saved to ${res.path}`, ...notes].join('\n\n'),
            })
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => {
            const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (w)
              w.webContents.executeJavaScript(`
              (() => {
                const el = document.activeElement;
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
                  document.execCommand('undo');
                } else {
                  window.__dreambyteStore?.getState()?.undo?.();
                }
              })()
            `)
          },
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => {
            const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (w)
              w.webContents.executeJavaScript(`
              (() => {
                const el = document.activeElement;
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
                  document.execCommand('redo');
                } else {
                  window.__dreambyteStore?.getState()?.redo?.();
                }
              })()
            `)
          },
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin'
          ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }, { role: 'selectAll' as const }]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Preview Fullscreen',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (w)
              w.webContents.executeJavaScript(`
              (() => {
                const s = window.__dreambyteStore?.getState();
                if (s) s.setPreviewFullscreen(!s.isPreviewFullscreen);
              })()
            `)
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => {
            void checkForUpdatesInteractive(BrowserWindow.getFocusedWindow() ?? undefined)
          },
        },
        {
          label: 'Open User Data Folder',
          // The BYOK keychain file + SQLite DB + user scenes all live here.
          // Surfaces it in the menu so users have a path to clear state
          // (corrupt keyring, stale DB) without digging through Finder.
          click: () => {
            void shell.openPath(app.getPath('userData'))
          },
        },
        { type: 'separator' },
        {
          label: 'Report an Issue',
          click: () => {
            void shell.openExternal('https://github.com/danrublop/dreambyte/issues/new')
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Apply pending Drizzle migrations against the configured DATABASE_URL.
 * In dev the migrations live next to the source at `<repoRoot>/src/lib/db/migrations`;
 * in a packaged build they're bundled into `app.asar` so we resolve a path
 * inside it. Idempotent — Drizzle tracks applied migrations in
 * `__drizzle_migrations`, so running this on every launch is cheap.
 */
async function applyDbMigrations(): Promise<void> {
  const folder = app.isPackaged
    ? path.join(__dirname, '..', 'src', 'lib', 'db', 'migrations')
    : path.resolve(__dirname, '..', 'src', 'lib', 'db', 'migrations')
  await runMigrations({ migrationsFolder: folder })
}

app.whenReady().then(async () => {
  // Pull BYOK provider keys from the OS keychain into process.env now that
  // `app.whenReady` has resolved (Electron safeStorage requires it). Must run
  // before any IPC handler could invoke the agent runner, which reads
  // `process.env.ANTHROPIC_API_KEY` etc. when lazily creating provider clients.
  try {
    hydrateEnvFromKeyring()
  } catch (err) {
    log.warn('provider-keys hydration failed (continuing with dotenv + shell env only)', {
      error: err,
    })
  }

  // Research works out of the box via native model search + a keyless in-process
  // floor (no Docker, no key). Managed self-hosted SearXNG is OPT-IN
  // (DREAMBYTE_MANAGE_SEARXNG=1) — when set, this starts/health-checks a local
  // Docker instance. Fire-and-forget; never blocks the window.
  void import('./searxng-manager')
    .then(({ ensureSearxng }) => ensureSearxng())
    .catch((err) => log.warn('searxng manager failed (research falls back to native/keyless/Tavily)', { error: err }))

  // Tell the Claude Code / Codex providers how to launch the MCP server +
  // where its HTTP backend lives. STANDALONE_MODE (packaged OR the standalone
  // dev flow `DREAMBYTE_FORCE_STATIC=1`) has no Next server, so the CLI must
  // reach the in-process tool executor via our ephemeral 127.0.0.1 bridge.
  // `dev:electron:web` keeps falling back to `npx tsx` + localhost:3000.
  if (STANDALONE_MODE) {
    // Packaged: MCP bundle lives inside app.asar at
    //   <app.getAppPath()>/dist-electron/mcp-server.cjs
    // and `ELECTRON_RUN_AS_NODE=1` keeps Electron's asar filesystem patches
    // active so the subprocess can resolve dynamic `ajv-formats/*` /
    // `ajv/*/runtime` requires against the asar-scoped node_modules.
    //
    // Standalone dev: __dirname is dist-electron/ (Electron loaded main.js
    // from there), so the same `mcp-server.cjs` is one directory up from
    // main.js in the same tree. scripts/build/build-electron.mjs builds it on every run.
    const mcpServerPath = app.isPackaged
      ? path.join(app.getAppPath(), 'dist-electron', 'mcp-server.cjs')
      : path.join(__dirname, 'mcp-server.cjs')
    setMcpHostConfig({
      launch: {
        command: process.execPath,
        args: [mcpServerPath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      startBridge: () => startMcpBridge(),
    })
  } else if (process.env.DREAMBYTE_PACKAGED_SIMULATION === '1') {
    // Lets us exercise the bundled-MCP path during `dev:electron:web`
    // (Next + hot reload) without actually packaging. Useful for smoke-
    // testing the bridge when the standalone flow isn't what's desired.
    const mcpServerPath = path.join(__dirname, 'mcp-server.cjs')
    setMcpHostConfig({
      launch: {
        command: process.execPath,
        args: [mcpServerPath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      startBridge: () => startMcpBridge(),
    })
  }

  // Provision the DB before any IPC handler lands a query against it.
  // A failure here is fatal — fall through to a dialog so the user sees
  // something other than a hung blank window.
  const migrationStart = Date.now()
  try {
    await applyDbMigrations()
    telemetryTrack('app_launched', {
      packaged: app.isPackaged,
      migration_ms: Date.now() - migrationStart,
    })
    // PR-B taste loop: decay memory confidence once per launch (×0.95, prune
    // <0.05) so stale learned prefs fade unless re-reinforced. Self-swallows;
    // never blocks startup. Run after migrations so the project_id column /
    // scoped index exist.
    void (async () => {
      try {
        const { decayMemoriesOnLaunch } = await import('../lib/db/queries/user-memory')
        await decayMemoriesOnLaunch()
      } catch (err) {
        log.warn('memory decay on launch failed (non-fatal)', { error: err })
      }
    })()

    // Reactive generation jobs: the main process owns the poll loop (off the
    // agent). Wire the renderer-push sink and resume any generations that were in-flight when
    // the app last closed. Broadcast on a single-user desktop — the store filters by jobId.
    void (async () => {
      try {
        const { getMediaGenerationRunner, setGenerationUpdateEmitter } = await import(
          '../lib/services/media-generation-runner'
        )
        setGenerationUpdateEmitter((update) => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('dreambyte:generation.update', update)
          }
        })
        await getMediaGenerationRunner().recoverOnBoot()
      } catch (err) {
        log.warn('media-generation runner boot failed (non-fatal)', { error: err })
      }
    })()
  } catch (err) {
    telemetryTrack('app_launch_failed', {
      reason: 'migration_error',
      message: (err as Error).message?.slice(0, 200) ?? 'unknown',
    })
    // Best-effort flush before the dialog blocks the event loop.
    void telemetryShutdown()
    log.error('database migration failed at startup', { error: err })
    dialog.showErrorBox(
      'Dreambyte: database error',
      `Failed to initialize the database. Please file a bug.\n\n${(err as Error).message}`,
    )
    app.quit()
    return
  }

  // Start a persistent terminal bridge so Terminal Claude Code can reach the
  // in-process tool executor without being spawned by the app. Registers this
  // instance under ~/.dreambyte/instances/<id>/ (id = hash of the userData
  // path) so multiple worktree instances coexist; the legacy bridge.json +
  // mcp.sock are still maintained for older connectors. Cleaned up on quit
  // (ownership-checked — never severs another instance's MCP).
  if (STANDALONE_MODE) {
    try {
      const terminalBridge = await startMcpBridge()
      const userDataPath = app.getPath('userData')
      // repoPath: in dev the app path IS the worktree the instance was
      // launched from — the connector matches it against the terminal's cwd.
      // Packaged apps live inside the bundle; no repo to match.
      const repoPath = app.isPackaged ? null : app.getAppPath()
      // Identity = userData + repoPath: dev scripts launch bare `electron .`
      // (shared default userData across worktrees), so userData alone would
      // collapse concurrent worktree instances to one id.
      const instanceId = instanceIdFor(userDataPath, repoPath)
      const instanceSocket = instanceSocketPath(instanceId)
      await writeBridgeDiscoveryFile(terminalBridge.url, terminalBridge.token)
      await writeInstanceManifest({
        v: 1,
        instanceId,
        pid: process.pid,
        userDataPath,
        repoPath,
        socketPath: instanceSocket,
        url: terminalBridge.url,
        token: terminalBridge.token,
        startedAt: Date.now(),
      })
      app.on('before-quit', () => {
        void terminalBridge.close()
        void deleteBridgeDiscoveryFile()
        void removeInstanceDir(instanceId)
      })
      log.info('terminal MCP bridge ready', { extra: { url: terminalBridge.url, instanceId } })

      // Start the persistent MCP server daemon so Terminal Claude Code connects
      // via Unix socket instead of spawning a new process per session. The
      // connector at scripts/mcp/mcp-connect.js opens the socket in ~30ms — no
      // npx, no tsx startup race.
      const mcpServerPath = app.isPackaged
        ? path.join(app.getAppPath(), 'dist-electron', 'mcp-server.cjs')
        : path.join(__dirname, 'mcp-server.cjs')
      void startMcpServerProcess(mcpServerPath, terminalBridge.url, terminalBridge.token, {
        socketPath: instanceSocket,
        instanceId,
      }).catch((err) => log.warn('mcp-server daemon failed to start', { error: err }))
    } catch (err) {
      log.warn('terminal MCP bridge failed to start; Terminal Claude Code MCP unavailable', { error: err })
    }
  }

  // App-shell helpers for native polish (changelog overlay + feedback widget).
  ipcMain.handle('dreambyte:app.getVersion', () => {
    return { version: app.getVersion() }
  })

  // Native clipboard write. `navigator.clipboard` is unreliable in the renderer
  // under the custom `dreambyte://` scheme (Chromium can leave it undefined /
  // permission-gated even in a secure context), so copy actions route through
  // Electron's main-process clipboard, which always works. Renderer keeps a
  // navigator.clipboard fast-path and falls back to this — see src/lib/utils/copy-text.
  ipcMain.handle('dreambyte:app.copyText', (_event, text: unknown) => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
      return { ok: true as const }
    } catch {
      return { ok: false as const }
    }
  })

  ipcMain.handle('dreambyte:app.captureWindow', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return { dataUrl: null }
      const image = await win.webContents.capturePage()
      // Downscale so the feedback payload stays small (longest side capped at 1920).
      const size = image.getSize()
      const maxDim = 1920
      const scaled =
        size.width > maxDim || size.height > maxDim
          ? image.resize({ width: Math.min(size.width, maxDim) })
          : image
      return { dataUrl: scaled.toDataURL() }
    } catch {
      return { dataUrl: null }
    }
  })

  ipcMain.handle(
    'dreambyte:capturePage',
    async (_evt, args?: { rect?: { x: number; y: number; width: number; height: number } }) => {
      const win = webZoomTargetWindow()
      if (!win) return { ok: false as const, error: 'no window' }
      try {
        const image = args?.rect ? await win.webContents.capturePage(args.rect) : await win.webContents.capturePage()
        const dataUri = image.toDataURL()
        return { ok: true as const, dataUri, mimeType: 'image/png' }
      } catch (err) {
        return { ok: false as const, error: (err as Error).message }
      }
    },
  )

  // ── Filesystem write authorization ────────────────
  //
  // dreambyte:writeFile / dreambyte:concatMp4 are arbitrary write+delete primitives.
  // They're only reachable from the trusted main renderer today (scene
  // iframes are origin-isolated), but the read-only reveal handlers below
  // already enforce a path allowlist and these did not — an asymmetric gap a
  // future same-origin render path or renderer XSS could turn into "write to
  // ~/.ssh/authorized_keys". A hard directory allowlist would break exporting
  // to a user-chosen folder, so instead we authorize exactly the paths the
  // MAIN process itself vended through its save/choose dialogs, plus the
  // standard app dirs. The renderer can no longer name a destination main
  // never offered.
  const authorizedExportFiles = new Set<string>()
  const authorizedExportDirs = new Set<string>()
  const rememberExportFile = (p?: string | null) => {
    if (p) authorizedExportFiles.add(path.resolve(p))
  }
  const rememberExportDir = (p?: string | null) => {
    if (p) authorizedExportDirs.add(path.resolve(p))
  }
  const isWriteAuthorized = (target: string): boolean => {
    if (!target || typeof target !== 'string') return false
    const resolved = path.resolve(target)
    const within = (dir: string) => {
      const d = path.resolve(dir)
      return resolved === d || resolved.startsWith(d + path.sep)
    }
    const appDirs = [
      getUserScenesDir(),
      getUserUploadsDir(),
      getUserAudioDir(),
      app.getPath('downloads'),
      app.getPath('userData'),
    ]
    if (appDirs.some(within)) return true
    if ([...authorizedExportDirs].some(within)) return true
    // Exact saveDialog file, plus its `.scene-NNN.mp4` / `.part` siblings the
    // exporter derives from it (`${filePath}.scene-001.mp4`).
    for (const f of authorizedExportFiles) {
      if (resolved === f || resolved.startsWith(f + '.')) return true
    }
    return false
  }

  // Write-authorization-gated primitive (writes `${filePath}.captions.*` siblings and
  // renames over `filePath`) — registered here, not in ipc/index.ts, so it can
  // enforce the same allowlist as writeFile/concatMp4 below.
  captionBurn.register(ipcMain, isWriteAuthorized)

  ipcMain.handle('dreambyte:saveDialog', async (_evt, suggestedName?: string) => {
    const res = await dialog.showSaveDialog({
      title: 'Save exported video',
      defaultPath: suggestedName || `export-${Date.now()}.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    })
    rememberExportFile(res.filePath)
    return { canceled: res.canceled, filePath: res.filePath ?? null }
  })

  ipcMain.handle('dreambyte:chooseDirectory', async (_evt, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({
      title: 'Choose export folder',
      defaultPath: defaultPath || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    })
    const dirPath = res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    rememberExportDir(dirPath)
    return { canceled: res.canceled, dirPath }
  })

  ipcMain.handle('dreambyte:getDefaultExportDir', async () => {
    return { dirPath: app.getPath('downloads') }
  })

  ipcMain.handle('dreambyte:showItemInFolder', async (_evt, filePath: string) => {
    if (!filePath) return { ok: false as const, error: 'No file path provided' }
    // Only allow paths inside known writable dirs to prevent renderer-supplied
    // paths from revealing arbitrary filesystem locations.
    const resolved = path.resolve(filePath)
    const allowed = [getUserScenesDir(), getUserUploadsDir(), getUserAudioDir(), app.getPath('downloads'), app.getPath('userData')]
    if (!allowed.some((dir) => resolved === path.resolve(dir) || resolved.startsWith(path.resolve(dir) + path.sep))) {
      return { ok: false as const, error: 'Path not in allowed directories' }
    }
    shell.showItemInFolder(resolved)
    return { ok: true as const }
  })

  ipcMain.handle('dreambyte:openPath', async (_evt, filePath: string) => {
    if (!filePath) return { ok: false as const, error: 'No file path provided' }
    const resolved = path.resolve(filePath)
    const allowed = [getUserScenesDir(), getUserUploadsDir(), getUserAudioDir(), app.getPath('downloads'), app.getPath('userData')]
    if (!allowed.some((dir) => resolved === path.resolve(dir) || resolved.startsWith(path.resolve(dir) + path.sep))) {
      return { ok: false as const, error: 'Path not in allowed directories' }
    }
    const err = await shell.openPath(resolved)
    if (err) return { ok: false as const, error: err }
    return { ok: true as const }
  })

  ipcMain.handle('dreambyte:writeFile', async (_evt, args: { filePath: string; bytes: ArrayBuffer }) => {
    if (!isWriteAuthorized(args.filePath)) {
      return { ok: false as const, error: 'Path not authorized for writing' }
    }
    await fs.mkdir(path.dirname(args.filePath), { recursive: true })
    await fs.writeFile(args.filePath, Buffer.from(args.bytes))
    return { ok: true }
  })

  // Best-effort deletion of export artifacts left behind by a cancelled or
  // failed export. The renderer tracks every `.scene-NNN.mp4` part it
  // wrote and the exported output file, and asks main to remove them so a torn
  // run doesn't leave orphaned MP4s on disk. Strict containment: a path is only
  // deletable if it was a main-vended export destination (isWriteAuthorized) AND
  // it is either the exact authorized output file or a `.scene-NNN.mp4` part
  // derived from one. Never deletes scene HTML, project data, or arbitrary paths.
  ipcMain.handle('dreambyte:cleanupExportArtifacts', async (_evt, args: { paths: string[] }) => {
    const PART_RE = /\.scene-\d{3}\.mp4$/i
    const targets = Array.isArray(args?.paths) ? args.paths : []
    const deleted: string[] = []
    for (const raw of targets) {
      if (!raw || typeof raw !== 'string') continue
      const resolved = path.resolve(raw)
      if (!isWriteAuthorized(resolved)) continue
      // Must be an authorized output file itself, or a scene-part of one.
      const isExactOutput = [...authorizedExportFiles].some((f) => path.resolve(f) === resolved)
      const isScenePart =
        PART_RE.test(resolved) && [...authorizedExportFiles].some((f) => resolved.startsWith(path.resolve(f) + '.'))
      if (!isExactOutput && !isScenePart) continue
      await fs.unlink(resolved).catch(() => {})
      deleted.push(resolved)
    }
    return { ok: true as const, deleted }
  })

  ipcMain.handle(
    'dreambyte:saveRecording',
    async (_evt, args: { bytes: ArrayBuffer; extension?: string; nameHint?: string }) => {
      const extRaw = (args.extension || 'webm').toLowerCase().replace(/[^a-z0-9]/g, '')
      const ext = extRaw || 'webm'
      const dir = path.join(app.getPath('userData'), 'recordings')
      await fs.mkdir(dir, { recursive: true })
      const safeBase = sanitizeFilename(args.nameHint || '')
      const filePath = path.join(dir, `${safeBase}-${Date.now()}.${ext}`)
      await fs.writeFile(filePath, Buffer.from(args.bytes))
      const fileUrl = pathToFileURL(filePath).href
      return { ok: true, filePath, fileUrl }
    },
  )

  ipcMain.handle(
    'dreambyte:concatMp4',
    async (
      _evt,
      args: {
        inputs: string[]
        output: string
        cleanup?: boolean
        transitions?: Array<{ type: string; duration?: number }>
        /** Force a re-encode on the cuts path (mixed-engine parts can't stream-copy). */
        reencode?: boolean
        /** When set, run a post-stitch two-pass loudnorm on the final output. */
        normalizeTargetLufs?: number
        /**
         * Standalone timeline audio (files on audio tracks) to overlay onto
         * the stitched output. Runs BETWEEN stitch and loudnorm — the same ordering
         * the all-tier3 path uses (overlay → burn → normalize) so program audio is
         * normalized with the rest of the program, not after it.
         */
        timelineAudio?: Tier3ProgramAudioClip[]
        masterVolume?: number
      },
    ) => {
      const inputs = (args.inputs ?? []).filter(Boolean)
      if (inputs.length === 0) throw new Error('concatMp4: no input files')
      // Every input is read+deleted and the output is written — all must be
      // paths main authorized, not arbitrary renderer-named files.
      if (!isWriteAuthorized(args.output)) {
        throw new Error('concatMp4: output path not authorized')
      }
      for (const input of inputs) {
        if (!isWriteAuthorized(input)) {
          throw new Error('concatMp4: input path not authorized')
        }
      }
      // Overlay step shared by the single-input shortcut and the stitch path.
      // null = not requested; 'failed' = requested but the user's timeline audio
      // is NOT in the MP4 (overlay threw / no clip resolved) — the renderer
      // surfaces that as a visible export warning instead of a silent miss.
      // Clip paths are re-resolved inside overlayProgramAudio via the tier3
      // resolver's absolute-path security guard; ffmpeg runs in the utility
      // process (raw filter_complex from main can SIGSEGV ffmpeg).
      const overlayTimelineAudio = async (): Promise<'applied' | 'failed' | null> => {
        const clips = args.timelineAudio ?? []
        if (clips.length === 0) return null
        let audioTmpDir: string | null = null
        try {
          audioTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-concat-audio-'))
          const ffmpegBin = await resolveExportFfmpegBin()
          const master = Number.isFinite(args.masterVolume) ? Math.max(0, Math.min(2, args.masterVolume as number)) : 1
          const { overlaid } = await overlayProgramAudio(ffmpegBin, args.output, clips, master, audioTmpDir)
          return overlaid > 0 ? 'applied' : 'failed'
        } catch (err) {
          console.warn('[concatMp4] program-audio overlay failed; keeping scene-only audio', err)
          return 'failed'
        } finally {
          if (audioTmpDir) await fs.rm(audioTmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }
      // The pixi/WebCodecs path never looked at what it wrote either — it
      // returned ok:true if copyFile/stitchScenes didn't throw. Verify the real
      // artifact before claiming success. No timeline is passed here, so we
      // check existence + size + a video stream + a non-zero duration (the
      // tier3 path additionally checks duration against the timeline).
      const verifyOutput = async () => {
        const bin = await resolveExportFfmpegBin().catch(() => null)
        await assertExportArtifact(bin, args.output)
      }
      if (inputs.length === 1) {
        await fs.copyFile(inputs[0], args.output)
        if (args.cleanup) {
          await fs.unlink(inputs[0]).catch(() => {})
        }
        const programAudio = await overlayTimelineAudio()
        if (typeof args.normalizeTargetLufs === 'number') {
          await normalizeFinalAudio(args.output, args.normalizeTargetLufs, fs).catch(() => {})
        }
        await verifyOutput()
        return { ok: true, programAudio }
      }

      const deps = validateExportDeps()
      if (!deps.ok) throw new Error(deps.message)

      const transitions = args.transitions ?? []
      try {
        // stitcher.js is an ES module (packages/render-server/package.json has
        // `"type": "module"`), so require() throws ERR_REQUIRE_ESM. Use
        // dynamic `import(pathToFileURL(...))` instead. The path is resolved
        // in `./paths.ts` so dev + packaged layouts stay in sync with the
        // startup validator.
        const stitcherPath = getStitcherPath()
        const mod = (await import(pathToFileURL(stitcherPath).href)) as {
          stitchScenes?: (
            v: string[],
            t: Array<{ type: string; duration: number }>,
            o: string,
            opts?: { reencode?: boolean },
          ) => Promise<void>
        }
        const stitchScenes = mod?.stitchScenes
        if (typeof stitchScenes !== 'function') {
          throw new Error('stitchScenes() not found in packages/render-server/stitcher.js')
        }
        const stitchedTransitions = Array.from({ length: Math.max(0, inputs.length - 1) }, (_v, i) => ({
          type: transitions[i]?.type ?? 'none',
          duration: transitions[i]?.duration ?? 0.5,
        }))
        await stitchScenes(inputs, stitchedTransitions, args.output, { reencode: args.reencode })
      } finally {
        if (args.cleanup) {
          await Promise.all(inputs.map((p) => fs.unlink(p).catch(() => {})))
        }
      }
      // Overlay standalone timeline audio BEFORE loudnorm — mirrors the
      // all-tier3 ordering (overlay → normalize) so the user's music is
      // normalized with the program instead of escaping it.
      const programAudio = await overlayTimelineAudio()
      // Program loudness normalization on the final pixi/WebCodecs output,
      // mirroring the Tier-3 path so normalization is engine-agnostic.
      if (typeof args.normalizeTargetLufs === 'number') {
        await normalizeFinalAudio(args.output, args.normalizeTargetLufs, fs).catch(() => {})
      }
      await verifyOutput()
      return { ok: true, programAudio }
    },
  )

  // ── Desktop source enumeration ────────────────────────────────────
  // getSources removed — using getDisplayMedia() in renderer instead

  // ── Cursor telemetry ─────────────────────────────────────────────
  const MAX_CURSOR_SAMPLES = 36_000 // ~60 hours at 10 Hz
  let cursorInterval: ReturnType<typeof setInterval> | null = null
  let cursorSamples: Array<{ t: number; x: number; y: number }> = []
  let cursorStartTime = 0
  let cursorSourceDisplay: Electron.Display | null = null

  ipcMain.handle('dreambyte:startCursorTelemetry', (_evt, args?: { displayId?: string }) => {
    cursorSamples = []
    cursorStartTime = Date.now()
    // Resolve display once at start (avoid repeated lookups in interval)
    cursorSourceDisplay = null
    if (args?.displayId) {
      const numId = Number(args.displayId)
      const all = screen.getAllDisplays()
      cursorSourceDisplay = all.find((d) => d.id === numId || String(d.id) === args.displayId) ?? null
    }
    cursorInterval = setInterval(() => {
      const point = screen.getCursorScreenPoint()
      const display = cursorSourceDisplay ?? screen.getDisplayNearestPoint(point)
      const { x, y, width, height } = display.bounds
      // Clamp to [0, 1]
      const nx = Math.max(0, Math.min(1, (point.x - x) / width))
      const ny = Math.max(0, Math.min(1, (point.y - y) / height))
      if (cursorSamples.length >= MAX_CURSOR_SAMPLES) {
        cursorSamples.shift() // Circular buffer
      }
      cursorSamples.push({ t: Date.now() - cursorStartTime, x: nx, y: ny })
    }, 100) // 10 Hz
    return { ok: true as const }
  })

  ipcMain.handle('dreambyte:stopCursorTelemetry', () => {
    if (cursorInterval) {
      clearInterval(cursorInterval)
      cursorInterval = null
    }
    cursorSourceDisplay = null
    const samples = cursorSamples
    cursorSamples = []
    return { samples }
  })

  // ── Save recording session (screen + optional webcam) ────────────
  ipcMain.handle(
    'dreambyte:saveRecordingSession',
    async (_evt, args: { screenBytes: ArrayBuffer; webcamBytes?: ArrayBuffer; nameHint?: string }) => {
      // Validate screen recording is non-empty
      if (!args.screenBytes || args.screenBytes.byteLength === 0) {
        throw new Error('Screen recording is empty — nothing to save')
      }

      const dir = path.join(app.getPath('userData'), 'recordings')
      await fs.mkdir(dir, { recursive: true })
      const ts = Date.now()
      const safeBase = sanitizeFilename(args.nameHint || '')

      const writtenFiles: string[] = []
      try {
        const screenPath = path.join(dir, `${safeBase}-${ts}.webm`)
        await fs.writeFile(screenPath, Buffer.from(args.screenBytes))
        writtenFiles.push(screenPath)

        const result: any = {
          screenVideoPath: screenPath,
          screenVideoUrl: pathToFileURL(screenPath).href,
          createdAt: ts,
        }

        if (args.webcamBytes && args.webcamBytes.byteLength > 0) {
          const webcamPath = path.join(dir, `${safeBase}-${ts}-webcam.webm`)
          await fs.writeFile(webcamPath, Buffer.from(args.webcamBytes))
          writtenFiles.push(webcamPath)
          result.webcamVideoPath = webcamPath
          result.webcamVideoUrl = pathToFileURL(webcamPath).href
        }

        // Save session manifest
        const manifestPath = path.join(dir, `${safeBase}-${ts}.session.json`)
        await fs.writeFile(manifestPath, JSON.stringify(result, null, 2))

        return result
      } catch (err) {
        // Clean up partially written files on failure
        await Promise.all(writtenFiles.map((f) => fs.unlink(f).catch(() => {})))
        throw err
      }
    },
  )

  // ── Media permission handlers (required for recording sources) ────
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'microphone', 'videoCapture', 'camera']
    return allowed.includes(permission)
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'microphone', 'videoCapture', 'camera']
    callback(allowed.includes(permission))
  })

  await registerDreambyteProtocol()
  registerAllIpc(ipcMain)

  // Register the ffmpeg-backed PCM decoder so `auto_cut_silence`
  // can read real audio. FFmpeg is resolved per decode, so a user who installs
  // it later doesn't need a restart; without it the decode rejects with the
  // install hint.
  try {
    const { setPcmDecoder } = await import('@/lib/edit-engines/pcm-decoder')
    const { createFfmpegPcmDecoder } = await import('./audio-decode')
    setPcmDecoder(createFfmpegPcmDecoder())
  } catch (err) {
    log.warn('PCM decoder registration failed; auto_cut_silence will be unavailable', { error: err })
  }

  // Register the OpenAI Whisper transcriber.
  //
  // Three configurations:
  //   1. OPENAI_API_KEY set (no base override) → cloud OpenAI default
  //   2. WHISPER_ENDPOINT set → local OpenAI-compatible server (LM Studio,
  //      faster-whisper-server, Ollama). API key still optional — many local
  //      servers accept a sentinel like "sk-local". Bring-your-own
  //      server, no bundled whisper.cpp binary.
  //   3. Neither set → the seam stays on its throwing stub so `add_captions`
  //      surfaces a clear "configure key" error.
  //
  // WHISPER_ENDPOINT takes precedence over OPENAI_API_KEY when both are set,
  // since the local pick is the more deliberate choice (privacy mode).
  //
  // WHISPER_ENDPOINT is restricted to localhost
  // (127.0.0.1 / ::1 / localhost) by default. Setting it to an arbitrary
  // remote host would silently exfiltrate user audio. Users who genuinely
  // need a remote endpoint (corporate proxy, gateway) must opt in with
  // DREAMBYTE_ALLOW_REMOTE_WHISPER=1. We log and skip registration on a
  // remote endpoint without the opt-in — add_captions stays unavailable
  // rather than leaking audio to an unknown host.
  const whisperEndpoint = process.env.WHISPER_ENDPOINT
  const whisperModel = process.env.WHISPER_MODEL
  if (whisperEndpoint) {
    const isLocalhost = (() => {
      try {
        const url = new URL(whisperEndpoint)
        const host = url.hostname
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
      } catch {
        return false
      }
    })()
    const allowRemote = process.env.DREAMBYTE_ALLOW_REMOTE_WHISPER === '1'
    if (!isLocalhost && !allowRemote) {
      log.warn(
        'WHISPER_ENDPOINT points at a non-localhost host; refusing to register without DREAMBYTE_ALLOW_REMOTE_WHISPER=1. ' +
          'add_captions will fall back to the throwing stub. ' +
          'Set DREAMBYTE_ALLOW_REMOTE_WHISPER=1 to opt in to remote transcription.',
        { extra: { endpoint: whisperEndpoint } },
      )
      // Actually delete the env var so the registration block below skips it.
      // Note: `process.env.X = undefined` coerces to the STRING "undefined"
      // (Node.js mutates process.env to a string-only object), which is truthy
      // and would defeat the gate. `delete` is the only way to remove it.
      delete process.env.WHISPER_ENDPOINT
    }
  }
  const whisperEndpointFinal = process.env.WHISPER_ENDPOINT
  if (whisperEndpointFinal || process.env.OPENAI_API_KEY) {
    try {
      const { setCaptionTranscriber } = await import('@/lib/edit-engines/caption-transcriber')
      const { createWhisperApiTranscriber } = await import('./whisper-transcriber')
      setCaptionTranscriber(
        createWhisperApiTranscriber({
          ...(whisperEndpointFinal ? { endpoint: whisperEndpointFinal } : {}),
          ...(whisperModel ? { model: whisperModel } : {}),
          // For local endpoints, default the API key to a sentinel since most
          // OpenAI-compatible servers don't require auth but the multipart
          // request needs a Bearer header. Users can still set OPENAI_API_KEY
          // explicitly for proxies that gate on it.
          ...(whisperEndpointFinal && !process.env.OPENAI_API_KEY
            ? { resolveApiKey: () => 'sk-local' }
            : {}),
        }),
      )
      log.info('Whisper transcriber registered', {
        extra: { mode: whisperEndpointFinal ? 'local-endpoint' : 'openai-cloud', model: whisperModel ?? 'whisper-1' },
      })
    } catch (err) {
      log.warn('Whisper transcriber registration failed; add_captions will be unavailable', { error: err })
    }
  }

  // Phase 2 multimodal intake: register the media-source resolver so intake
  // engines can read `dreambyte://uploads/...` reference media off disk. Reuses the
  // same URI surface as the Whisper transcriber (resolveSourceForFfmpeg).
  try {
    const { setMediaResolver } = await import('@/lib/agents/services/intake-engines/media-source')
    const { resolveSourceForFfmpeg } = await import('./audio-decode')
    const { promises: fsp } = await import('node:fs')
    setMediaResolver(async (uri, mimeHint) => {
      const localPath = resolveSourceForFfmpeg(uri).replace(/^file:\/\//, '')
      const buf = await fsp.readFile(localPath)
      const { guessMimeFromPath } = await import('@/lib/agents/services/intake-engines/media-source')
      return { bytes: new Uint8Array(buf), localPath, mimeType: mimeHint ?? guessMimeFromPath(localPath) }
    })
    log.info('Media-source resolver registered (reference-media intake)')
  } catch (err) {
    log.warn('Media-source resolver registration failed; reference-media intake limited to file:// paths', { error: err })
  }

  // Phase 2.3: register the CUDA GPU probe so the capability registry can offer
  // the premium Marlin video backend only on NVIDIA hosts (always false on Mac).
  try {
    const { setGpuProbe } = await import('@/lib/agents/services/gpu-probe')
    const { detectCudaGpu } = await import('./gpu-detect')
    setGpuProbe(detectCudaGpu)
  } catch (err) {
    log.warn('GPU probe registration failed; premium GPU backends stay disabled', { error: err })
  }

  // Phase 2 multimodal intake: register the frame-vision VideoUnderstander so
  // reference videos can be understood locally (ffmpeg keyframes → VLM + Whisper)
  // when the chosen engine isn't Gemini-native-video. ffmpeg-backed extractor.
  try {
    const { setVideoUnderstander } = await import('@/lib/services/video-understander')
    const { createFrameVisionUnderstander } = await import('@/lib/services/frame-vision-understander')
    const { createFfmpegKeyframeExtractor } = await import('./video-keyframe-extractor')
    setVideoUnderstander(createFrameVisionUnderstander({ extractor: createFfmpegKeyframeExtractor() }))
    log.info('Frame-vision VideoUnderstander registered (reference-video intake)')
  } catch (err) {
    log.warn('VideoUnderstander registration failed; local video intake unavailable', { error: err })
  }

  // Phase 2.3 premium: register the Marlin-2B understander ONLY on a CUDA host
  // whose Python environment can run the sidecar. The environment check imports
  // torch, which is slow, so it runs in the background instead of holding up boot.
  // Until it passes (or when it fails) the registry reports Marlin unavailable
  // with the reason, and a forced pick falls back to another engine.
  void (async () => {
    try {
      const { detectCuda } = await import('@/lib/agents/services/gpu-probe')
      if (!(await detectCuda())) return
      const { setMarlinUnderstander, setMarlinUnavailableReason } = await import('@/lib/services/video-understander')
      const { createMarlinUnderstander } = await import('@/lib/services/marlin-understander')
      const { createMarlinSidecar, resolveMarlinScriptPath, checkMarlinRuntime } = await import('./marlin-sidecar-host')
      const scriptPath = resolveMarlinScriptPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleDir: __dirname,
      })
      setMarlinUnavailableReason('Checking the Marlin Python environment…')
      const check = await checkMarlinRuntime({ scriptPath })
      if (!check.ok) {
        setMarlinUnavailableReason(check.reason)
        log.warn(`Marlin-2B premium video backend disabled: ${check.reason}`)
        return
      }
      const sidecar = createMarlinSidecar({ scriptPath })
      setMarlinUnderstander(createMarlinUnderstander({ caption: (src, o) => sidecar.caption(src, o) }))
      app.on('before-quit', () => sidecar.dispose())
      log.info('Marlin-2B understander registered (CUDA + Python environment detected)')
    } catch (err) {
      log.warn('Marlin understander registration failed; premium video backend disabled', { error: err })
    }
  })()

  // Register the offscreen MediaPipe FrameDetector (used by auto_reframe). The
  // host page lives at `dist-electron/mediapipe-detector.html` and runs the
  // bundled FaceDetector model locally.
  try {
    const { setFrameDetector } = await import('@/lib/edit-engines/frame-detector')
    const { createMediaPipeFrameDetector } = await import('@/lib/services/mediapipe-frame-detector')
    const { executeDetect } = await import('./mediapipe-detector-host')
    setFrameDetector(createMediaPipeFrameDetector({ executeDetect }))
  } catch (err) {
    log.warn('MediaPipe FrameDetector registration failed; auto_reframe will be unavailable', { error: err })
  }

  // Wire Electron's OS-keychain encryption into the
  // git credential layer. Done lazily on first git_push/pull rather than
  // here so we don't pay the keychain prompt on app boot.
  try {
    const { safeStorage } = await import('electron')
    const { setSafeStorage } = await import('./git-credentials')
    setSafeStorage(safeStorage)
  } catch (err) {
    log.warn('safeStorage registration failed; remote push/pull will refuse to store tokens', { error: err })
  }

  // Crash-recovery: replay any WAL entries that didn't make it to action_log
  // before the previous shutdown. Load-bearing because the git commit→action
  // bridge assumes the log is durable. Best-effort: errors are logged but
  // don't block boot.
  void (async () => {
    try {
      const { replayAllProjectWals } = await import('@/lib/actions/wal-replay')
      const { appendActionRows } = await import('@/lib/db/queries/action-log')
      const { projectExists } = await import('@/lib/db/queries/projects')
      const { getProjectDataDir } = await import('./paths')
      const path = await import('node:path')
      const { app } = await import('electron')
      const projectsRoot = path.join(app.getPath('userData'), 'projects')
      const results = await replayAllProjectWals(projectsRoot, {
        resolveProjectDir: (projectId) => getProjectDataDir(projectId),
        appendActionRows: (projectId, actions, branchId) => appendActionRows(projectId, actions, branchId),
        // Skip orphan WAL dirs (deleted/uncommitted projects) instead of failing
        // every action_log insert against the project_id FK on each boot.
        projectExists: (projectId) => projectExists(projectId),
      })
      const total = results.reduce((sum, r) => sum + r.replayed, 0)
      const corrupted = results.reduce((sum, r) => sum + r.corruptedLines, 0)
      const skippedOrphans = results.filter((r) => r.skippedOrphan).length
      if (total || corrupted || skippedOrphans) {
        log.info('WAL replay complete', {
          extra: { projects: results.length, actionsReplayed: total, corruptedLines: corrupted, skippedOrphans },
        })
      }
      for (const r of results) {
        if (r.error) log.warn('WAL replay error for project', { extra: { projectId: r.projectId, error: r.error } })
      }
    } catch (err) {
      log.warn('WAL replay failed; action_log may be missing pre-crash rows', { error: err })
    }
  })()

  createWindow()

  // R3 (playback-telemetry residuals): orphan scene-HTML GC. Rollback and
  // agent persist leave dead `scenes/{id}.html` files behind — unlink only
  // ever happened on project delete — so the dir grows without bound across
  // build/rollback loops. Sweep in the background, well after boot/WAL
  // replay; the sweep itself refuses to run against an empty DB (fresh
  // install / migration race) and only touches scene-id-shaped .html files.
  setTimeout(() => {
    void (async () => {
      try {
        const { sweepOrphanSceneHtml, collectLiveSceneIds } = await import('@/lib/scene-html-gc')
        const { resolveScenesDir } = await import('@/lib/scene-html-paths')
        const result = await sweepOrphanSceneHtml({
          scenesDir: resolveScenesDir(),
          getLiveSceneIds: async () => {
            const { db } = await import('@/lib/db')
            const { scenes, projects } = await import('@/lib/db/schema')
            // collectLiveSceneIds parses legacy blobs STRICTLY — a malformed
            // blob throws here, which sweepOrphanSceneHtml treats as "abort,
            // delete nothing". (Deliberately NOT readProjectSceneBlob: it
            // swallows parse errors into {scenes: []}, which would have turned
            // a corrupt project's live files into orphans.)
            return collectLiveSceneIds(
              await db.select({ id: scenes.id }).from(scenes),
              await db.select({ description: projects.description }).from(projects),
            )
          },
        })
        if (result.deleted > 0 || result.skipped) {
          log.info('scene-HTML GC', { extra: { ...result } })
        }
      } catch (err) {
        log.warn('scene-HTML GC failed (non-fatal)', { error: err })
      }
    })()
  }, 30_000)

  // Pre-marker publish migration: published bundles
  // copied before the beacon marker existed still carry the unmarked beacon
  // (+ the legacy inline jsx-error post), broadcasting error strings to the
  // embedding host page on every load. One-shot sweep (marker-stamped) over
  // <userData>/published applying the strengthened strip; per-file errors
  // are swallowed and a partial pass retries next boot. Same off-the-boot-
  // path timing rationale as the scene-HTML GC above.
  setTimeout(() => {
    void (async () => {
      try {
        const { migratePublishedBeacons } = await import('@/lib/published-beacon-migration')
        const publishedDir = process.env.DREAMBYTE_PUBLISHED_DIR ?? path.join(app.getPath('userData'), 'published')
        const result = await migratePublishedBeacons({
          publishedDir,
          join: (...parts) => path.join(...parts),
          fs: {
            readdir: (d) => fs.readdir(d),
            readFile: (p) => fs.readFile(p, 'utf8'),
            writeFile: (p, c) => fs.writeFile(p, c, 'utf8'),
            exists: (p) =>
              fs.access(p).then(
                () => true,
                () => false,
              ),
            isDirectory: (p) =>
              fs.stat(p).then(
                (s) => s.isDirectory(),
                () => false,
              ),
          },
        })
        if (result.migrated > 0 || result.failed > 0) {
          log.info('published-beacon migration', { extra: { ...result } })
        }
      } catch (err) {
        log.warn('published-beacon migration failed (non-fatal)', { error: err })
      }
    })()
  }, 35_000)

  // Kick off a silent background update check. No-op in dev builds; when
  // packaged, downloads in the background and installs on quit. Interactive
  // "Check for Updates..." menu item in the Help menu gives the user a
  // manual trigger with explicit dialogs.
  initAutoUpdater().catch((err) => log.error('initAutoUpdater threw', { error: err }))

  // Surface a clear warning on boot if the packaged export stitcher files are
  // missing (a broken install). Non-fatal — the rest of the app still runs.
  // A missing user-installed FFmpeg is only logged here: export and the other
  // FFmpeg features show the install hint when they actually need it, so users
  // who never export aren't nagged on every launch.
  const deps = validateExportDeps()
  if (!deps.ok && deps.ffmpegMissing && deps.missing.length === 1) {
    log.warn('FFmpeg not found; MP4 export is unavailable until it is installed')
  } else if (!deps.ok) {
    log.error('export dependency check failed', { extra: { missing: deps.missing } })
    dialog.showMessageBox({
      type: 'warning',
      title: 'Export setup incomplete',
      message: 'MP4 export is unavailable',
      detail: deps.message,
      buttons: ['OK'],
      noLink: true,
    })
  }

  // ── Allow screen/window capture via getDisplayMedia in renderer ────
  // Use the native macOS system picker (desktopCapturer.getSources is broken in Electron 41)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    log.debug('setDisplayMediaRequestHandler', {
      extra: {
        video: !!request.videoRequested,
        audio: !!request.audioRequested,
        frame: request.frame?.url?.slice(0, 80),
      },
    })
    try {
      ;(callback as any)({}, { useSystemPicker: true })
      log.debug('display-media callback invoked with useSystemPicker')
    } catch (err: any) {
      log.error('display-media callback error', { error: err })
      ;(callback as any)(null)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Best-effort flush on quit so the launch event for the current session
// reaches the wire before the process exits. Async — Electron waits up to
// the timeout we set in `flush()` (5s) before terminating.
app.on('before-quit', async (event) => {
  // Only intercept the first quit so a second Cmd-Q force-quits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((app as any)._dreambyteTelemetryFlushed) return // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(app as any)._dreambyteTelemetryFlushed = true
  event.preventDefault()
  // FIRST, before any teardown: abort in-flight agent runs and wait for their
  // persist. Without this, quitting mid-run loses every scene the run had built
  // (runAgent never returns, so persistScenesFromAgentRun never runs) and
  // orphans the run-lease row, so the next launch refuses to start on that
  // branch for 30s. Abort is the correct path — the runner returns
  // stopReason:'aborted' and the service layer persists unconditionally — and
  // awaiting the run's finally also releases the lease. Bounded internally so a
  // wedged run can't block quit. Covers Windows/Linux `window-all-closed` too:
  // that calls app.quit(), which fires this same handler.
  try {
    const { abortActiveRunsForShutdown } = await import('./ipc/agent')
    await abortActiveRunsForShutdown()
  } catch (e) {
    log.warn('failed to drain agent runs on quit', { error: e })
  }
  // Best-effort chat flush: ask every renderer to persist its
  // in-flight streaming assistant message before we tear down. The incremental
  // seq-guarded write during SSE is the DURABLE path; this is a final safety
  // net for a Cmd-Q landed mid-stream. The renderer's flush enqueues an
  // upsert IPC synchronously, so a short settle window lets it reach SQLite.
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('dreambyte:app.flushBeforeQuit')
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } catch {
    // Never block shutdown on the flush nudge.
  }
  await Promise.allSettled([
    flushAllPendingVersions(),
    telemetryShutdown(),
    shutdownCrashReporter(),
  ])
  // Drop the offscreen verifier BrowserWindows so they don't keep the app
  // alive past `quit`. Best-effort: import is dynamic so a missing module
  // never blocks shutdown.
  try {
    const { disposeVerifierPool } = await import('@/lib/services/scene-verifier')
    disposeVerifierPool()
  } catch {
    // Verifier never opened; nothing to dispose.
  }
  try {
    const { dispose: disposeMediaPipe } = await import('./mediapipe-detector-host')
    disposeMediaPipe()
  } catch {
    // MediaPipe detector never opened; nothing to dispose.
  }
  app.quit()
})
