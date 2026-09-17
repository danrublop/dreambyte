/**
 * Caption burn-in pass: hardcode the project's TTS captions into the
 * final MP4's pixels. One ffmpeg re-encode over the finished file — shared by
 * every export path (tier3 runs it inline after stitching; the renderer's
 * mixed/legacy paths call it via the `dreambyte:export.burnCaptions` IPC).
 *
 * Runs BEFORE loudness normalization in tier3 (normalize uses -c:v copy, so
 * the burned video survives it untouched). x264 settings mirror the
 * stitcher's final pass so the burn re-encode doesn't soften the export.
 */

import type { IpcMain } from 'electron'
import fs from 'node:fs/promises'
import { createLogger } from '../../lib/logger'
import { buildSubtitlesFilterArg } from '../../lib/export/caption-burnin'
import { X264_QUALITY_PARAMS } from '../../lib/export/x264'
import { resolveExportFfmpegBin, runFfmpeg } from './audio-normalize'

const log = createLogger('export.caption-burn')

/** Full-program video re-encode — give it real headroom (long exports). */
const BURN_TIMEOUT_FLOOR_MS = 30 * 60 * 1000
const BURN_TIMEOUT_CEIL_MS = 4 * 60 * 60 * 1000
/** Worst-case encode budget per 1080p frame at preset slow (very generous). */
const BURN_MS_PER_1080P_FRAME = 150

/**
 * Scale the burn timeout with the actual work (frames × pixel area) instead
 * of a fixed wall-clock cap — a long 4K export legitimately needs more than
 * 30 minutes, and a SIGKILLed burn silently ships an unburned file.
 */
export function burnTimeoutMs(width: number, height: number, totalSeconds?: number, fps?: number): number {
  if (!totalSeconds || !fps || !Number.isFinite(totalSeconds) || !Number.isFinite(fps)) return BURN_TIMEOUT_FLOOR_MS
  const frames = totalSeconds * fps
  const pixelRatio = (width * height) / (1920 * 1080)
  const budget = Math.ceil(frames * BURN_MS_PER_1080P_FRAME * Math.max(1, pixelRatio))
  return Math.min(BURN_TIMEOUT_CEIL_MS, Math.max(BURN_TIMEOUT_FLOOR_MS, budget))
}

/**
 * Burn `srtText` into `filePath` in place. Returns true when applied, false
 * when skipped (non-fatal — the export ships unburned rather than dying at
 * the last step; callers log/surface the miss).
 */
export async function burnCaptionsIntoFinal(
  filePath: string,
  srtText: string,
  width: number,
  height: number,
  ffmpegBin?: string,
  opts?: { totalSeconds?: number; fps?: number },
): Promise<boolean> {
  if (!srtText.trim()) return false
  const bin = ffmpegBin ?? (await resolveExportFfmpegBin())

  // Unique sibling names, APPENDED (never regex-replaced — see the loudnorm
  // tmp-name note: a failed `.replace(/\.mp4$/)` can alias the real file).
  const stamp = `${process.pid}.${Date.now()}`
  const srtPath = `${filePath}.captions.${stamp}.srt`
  const tmp = `${filePath}.captions.${stamp}.mp4`

  try {
    await fs.writeFile(srtPath, srtText, 'utf-8')
    const res = await runFfmpeg(
      bin,
      [
        '-i', filePath,
        '-vf', buildSubtitlesFilterArg(srtPath, width, height),
        // Mirror the stitcher's final-pass x264 settings (quality parity) —
        // X264_QUALITY_PARAMS is the same string the stitcher + tier3 encoder
        // use (drift-guarded by src/lib/export/x264.test.ts). Preset matches the
        // tier3 quality preset ('slow'; the xfade stitch uses 'slower').
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '16',
        '-x264-params', X264_QUALITY_PARAMS,
        '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709',
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', tmp,
      ],
      burnTimeoutMs(width, height, opts?.totalSeconds, opts?.fps),
    )
    if (res.code !== 0) {
      log.warn('caption burn-in failed; keeping unburned export', { extra: { stderr: res.stderr.slice(-400) } })
      await fs.rm(tmp, { force: true }).catch(() => {})
      return false
    }
    await fs.rename(tmp, filePath)
    log.info('captions burned into final export', { extra: { width, height } })
    return true
  } finally {
    await fs.rm(srtPath, { force: true }).catch(() => {})
  }
}

/**
 * NOT registered via src/electron/ipc/index.ts: this handler is a write-authorization-gated
 * write primitive (it writes `${filePath}.captions.*` siblings and renames
 * over `filePath`), so it registers inside main.ts `setupIpc` next to
 * `dreambyte:writeFile` / `dreambyte:concatMp4`, where the private
 * `isWriteAuthorized` allowlist closure lives. The renderer can only burn
 * into paths the MAIN process itself vended through its save/choose dialogs.
 */
export function register(ipcMain: IpcMain, isWriteAuthorized: (target: string) => boolean): void {
  // Renderer-driven paths (mixed / legacy) burn after their own concat.
  ipcMain.handle(
    'dreambyte:export.burnCaptions',
    async (
      _event,
      args: { filePath: string; srt: string; width: number; height: number; totalSeconds?: number; fps?: number },
    ) => {
      const { filePath, srt, width, height, totalSeconds, fps } = args ?? {}
      if (typeof filePath !== 'string' || !filePath || typeof srt !== 'string') {
        throw new Error('burnCaptions requires filePath and srt')
      }
      if (!isWriteAuthorized(filePath)) {
        throw new Error('Path not authorized for writing')
      }
      const w = Number(width)
      const h = Number(height)
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        throw new Error('burnCaptions requires positive width/height')
      }
      // Optional timeout-scaling hints — ignored unless both are sane.
      const secs = Number(totalSeconds)
      const f = Number(fps)
      const hints = Number.isFinite(secs) && secs > 0 && Number.isFinite(f) && f > 0
        ? { totalSeconds: secs, fps: f }
        : undefined
      const ok = await burnCaptionsIntoFinal(filePath, srt, w, h, undefined, hints)
      return { ok }
    },
  )
}
