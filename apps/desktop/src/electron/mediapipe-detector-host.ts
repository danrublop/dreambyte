/**
 * Offscreen MediaPipe detector host.
 *
 * Manages a hidden Electron BrowserWindow that runs the MediaPipe
 * face/pose detector page. Main-process callers (auto_reframe,
 * remove_background) get a transport function they can hand to
 * `createMediaPipeFrameDetector` — this file is the only place that
 * knows about Electron + the offscreen window.
 *
 * Lifecycle:
 *   - First `executeDetect` call creates the window (lazy boot — saves
 *     ~50MB until the user actually invokes a tool that needs it).
 *   - The same window is reused across calls. MediaPipe init is the
 *     expensive bit; keeping the page alive amortizes that cost.
 *   - `dispose()` (called from main `before-quit`) destroys the window.
 *
 * The page itself is `dist-electron/mediapipe-detector.html`. It's a
 * stub today — returns empty detections. The actual MediaPipe load
 * (face / pose) lands when the page's script is replaced; the IPC
 * contract here doesn't change.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLogger } from '@/lib/logger'
import type {
  MediaPipeDetectRequest,
  MediaPipeDetectResponse,
} from '@/lib/services/mediapipe-frame-detector'

const log = createLogger('mediapipe-detector-host')

interface ElectronModule {
  BrowserWindow: typeof import('electron').BrowserWindow
}

let cachedElectron: ElectronModule | null = null
function loadElectron(): ElectronModule | null {
  if (cachedElectron) return cachedElectron
  try {
    cachedElectron = require('electron') as ElectronModule
    return cachedElectron
  } catch (err) {
    log.warn('electron module unavailable; MediaPipe detector is no-op', { error: err })
    return null
  }
}

let activeWindow: import('electron').BrowserWindow | null = null
let pageReadyPromise: Promise<void> | null = null

/**
 * Path to the page HTML. Bundled by `scripts/build/build-electron.mjs` as a static
 * asset under `dist-electron/`. In a packaged build this resolves
 * inside `app.asar`, which Electron handles transparently for `file://`.
 */
function getPageUrl(): string {
  const distElectron = path.resolve(__dirname)
  const pagePath = path.join(distElectron, 'mediapipe-detector.html')
  return pathToFileURL(pagePath).toString()
}

async function ensureWindow(): Promise<import('electron').BrowserWindow | null> {
  if (activeWindow && !activeWindow.isDestroyed()) return activeWindow
  const e = loadElectron()
  if (!e) return null

  const win = new e.BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.setAudioMuted(true)

  pageReadyPromise = new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      reject(new Error(`MediaPipe detector page failed to load: ${desc}`))
    })
  })
  await win.loadURL(getPageUrl()).catch((err) => {
    log.warn('loadURL threw', { error: err })
  })
  try {
    await pageReadyPromise
  } catch (err) {
    log.warn('MediaPipe detector page did not finish loading', { error: err })
    win.destroy()
    activeWindow = null
    throw err
  }

  activeWindow = win
  return win
}

/**
 * Production transport: ships the request to the offscreen page and
 * returns its response. The page exposes `window.__dreambyteDetect(req)`
 * which returns a `Promise<MediaPipeDetectResponse>`.
 */
export async function executeDetect(request: MediaPipeDetectRequest): Promise<MediaPipeDetectResponse> {
  const win = await ensureWindow()
  if (!win) {
    // Electron unavailable (test env) — return an empty detection set so
    // callers degrade to "no reframe" rather than crashing.
    return { detections: [], sourceWidth: 0, sourceHeight: 0 }
  }

  // executeJavaScript serializes args via JSON; pass the request as a
  // single argument and let the page do the heavy lifting.
  const serialized = JSON.stringify(request).replace(/</g, '\\u003c')
  const script = `(async () => {
    if (typeof window.__dreambyteDetect !== 'function') {
      throw new Error('MediaPipe page did not expose __dreambyteDetect — page script may have failed to load')
    }
    return await window.__dreambyteDetect(${serialized})
  })()`

  try {
    const result = (await win.webContents.executeJavaScript(script, true)) as MediaPipeDetectResponse
    if (
      !result ||
      !Array.isArray(result.detections) ||
      typeof result.sourceWidth !== 'number' ||
      typeof result.sourceHeight !== 'number'
    ) {
      throw new Error('MediaPipe page returned a malformed response')
    }
    return result
  } catch (err) {
    log.warn('MediaPipe executeJavaScript failed', { extra: { source: request.source }, error: err })
    throw err
  }
}

/** Dispose the offscreen window. Called from main's `before-quit`. */
export function dispose(): void {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.destroy()
  }
  activeWindow = null
  pageReadyPromise = null
}
