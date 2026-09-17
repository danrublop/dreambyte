// Locates the user's FFmpeg install. Dreambyte does not bundle FFmpeg: the common
// static builds are configured with --enable-gpl --enable-nonfree and cannot be
// redistributed with the app, so export uses whatever FFmpeg the user installed.
//
// Plain JS with no dependencies so the packaged render-server modules
// (stitcher.js, audio-mixer.js) and the esbuild-bundled Electron main process
// share one resolver.
//
// Lookup order: DREAMBYTE_FFMPEG_PATH, FFMPEG_PATH, then on macOS Homebrew's
// keg-only ffmpeg-full (preferred over plain `ffmpeg`, which lacks libass and so
// the `subtitles` filter caption burn-in needs), then every PATH entry, then the
// Homebrew bin dirs on macOS (apps launched from Finder don't inherit the shell
// PATH, so /opt/homebrew/bin is usually missing from process.env.PATH).
// Resolved on every call (a few stat()s) so installing FFmpeg while the app is
// running takes effect without a restart.

import fs from 'node:fs'
import path from 'node:path'

/** Homebrew prefixes: Apple Silicon, then Intel. */
export const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local']

export const FFMPEG_MISSING_MESSAGE =
  'FFmpeg is required for MP4 export — install it with `brew install ffmpeg-full` (macOS) or from ffmpeg.org, or set DREAMBYTE_FFMPEG_PATH to the ffmpeg binary.'

/** @param {string} p */
function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Absolute path of `ffmpeg` (or `ffprobe`), or null when none is installed.
 * An override pointing at ffmpeg also locates the ffprobe next to it.
 *
 * @param {'ffmpeg' | 'ffprobe'} [name]
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @param {string[]} [brewPrefixes]
 * @returns {string | null}
 */
export function findFfmpeg(
  name = 'ffmpeg',
  env = process.env,
  platform = process.platform,
  brewPrefixes = HOMEBREW_PREFIXES,
) {
  const exe = platform === 'win32' ? `${name}.exe` : name
  const override = env.DREAMBYTE_FFMPEG_PATH || env.FFMPEG_PATH
  const dirs = []
  if (override) {
    if (name === 'ffmpeg' && isExecutableFile(override)) return override
    dirs.push(path.dirname(override))
  }
  const darwin = platform === 'darwin'
  if (darwin) dirs.push(...brewPrefixes.map((p) => path.join(p, 'opt', 'ffmpeg-full', 'bin')))
  dirs.push(...(env.PATH || '').split(path.delimiter).filter(Boolean))
  if (darwin) dirs.push(...brewPrefixes.map((p) => path.join(p, 'bin')))
  for (const dir of dirs) {
    const candidate = path.join(dir, exe)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}
