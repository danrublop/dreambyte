import { app } from 'electron'
import fsSync from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { findFfmpeg, FFMPEG_MISSING_MESSAGE } from '@dreambyte/render-server/ffmpeg-path.js'

/**
 * Runtime-writable user data directories. Kept in one place so the
 * `dreambyte://` protocol handler in main.ts and the IPC modules that
 * write to these dirs agree on the layout.
 */

export function getUserScenesDir(): string {
  return path.join(app.getPath('userData'), 'scenes')
}

export function getUserUploadsDir(): string {
  return path.join(app.getPath('userData'), 'uploads')
}

export function getUserAudioDir(): string {
  return path.join(app.getPath('userData'), 'audio')
}

export function getUserGeneratedDir(): string {
  return path.join(app.getPath('userData'), 'generated')
}

/**
 * Per-project state directory: WAL + (later) blob store live here.
 * Returns `<userData>/projects/{projectId}` and ensures the folder exists.
 * Caller is responsible for passing a sanitized projectId — we still pin
 * the path under `projects/` so a hand-crafted id can't escape via `..`.
 */
export function getProjectDataDir(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`)
  }
  const base = path.join(app.getPath('userData'), 'projects', projectId)
  return base
}

export function getStaticAppDir(): string {
  // `__dirname` is `<Resources>/app.asar/dist-electron` in packaged builds
  // and `<repo>/dist-electron` in dev — both resolve `../out` correctly.
  return path.join(__dirname, '..', 'out')
}

// ── Export stitching dependencies (FFmpeg + stitcher.js) ─────────────────
// Packaged installs bundle packages/render-server/stitcher.js and its node modules into
// <Resources>/render-server via electron-builder's `extraResources`; dev reads
// the same files from the repo. FFmpeg itself is NOT bundled — it is the
// user's install, found by packages/render-server/ffmpeg-path.js. Validate the whole
// chain up front so users see a clear error instead of a cryptic stack.

export function getRenderServerDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'render-server') : path.join(__dirname, '..', '..', '..', 'packages', 'render-server')
}

/** Node resolution from `dir` (walks up node_modules: the packaged render-server copy, or the workspace root in dev). */
function resolveFrom(dir: string, request: string): string {
  try {
    return createRequire(path.join(dir, 'noop.js')).resolve(request)
  } catch {
    return path.join(dir, 'node_modules', request)
  }
}

export function getStitcherPath(): string {
  return path.join(getRenderServerDir(), 'stitcher.js')
}

export type ExportDepsStatus =
  | { ok: true }
  | { ok: false; missing: string[]; message: string; ffmpegMissing: boolean }

let cachedFiles: string[] | null = null

/**
 * The bundled files are checked once (they can't appear at runtime); FFmpeg is
 * looked up on every call so installing it doesn't require restarting the app.
 */
export function validateExportDeps(forceRefresh = false): ExportDepsStatus {
  const renderServer = getRenderServerDir()
  if (!cachedFiles || forceRefresh) {
    const required: Array<{ label: string; abs: string }> = [
      { label: 'stitcher.js', abs: getStitcherPath() },
      { label: 'ffmpeg-path.js', abs: path.join(renderServer, 'ffmpeg-path.js') },
      { label: 'fluent-ffmpeg', abs: resolveFrom(renderServer, 'fluent-ffmpeg/package.json') },
    ]
    cachedFiles = required.filter((r) => !fsSync.existsSync(r.abs)).map((r) => r.label)
  }
  const ffmpegMissing = !findFfmpeg()
  if (cachedFiles.length === 0 && !ffmpegMissing) return { ok: true }

  const missing = ffmpegMissing ? [...cachedFiles, 'ffmpeg'] : cachedFiles
  const messages: string[] = []
  if (cachedFiles.length > 0) {
    const hint = app.isPackaged
      ? 'The Dreambyte installation appears incomplete. Reinstalling the app from the original download should restore it.'
      : `Run \`npm ci\` at the repository root to install the export dependencies. (expected at ${renderServer})`
    messages.push(`Export dependencies missing: ${cachedFiles.join(', ')}.\n\n${hint}`)
  }
  if (ffmpegMissing) messages.push(FFMPEG_MISSING_MESSAGE)
  return { ok: false, missing, message: messages.join('\n\n'), ffmpegMissing }
}
