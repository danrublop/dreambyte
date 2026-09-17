/**
 * Program loudness normalization (post-stitch, two-pass FFmpeg loudnorm).
 *
 * Shared by BOTH export finalize paths so normalization is engine-agnostic:
 *   - Tier-3 (offscreen-render) → runTier3Export (src/electron/ipc/export-tier3.ts)
 *   - Pixi/WebCodecs (primary in-app) → the dreambyte:concatMp4 handler (src/electron/main.ts)
 *
 * Applied ONCE to the final concatenated video — never per scene (per-scene
 * targets don't survive stitch/crossfade). Two-pass (measure → apply) actually
 * hits the target where single-pass drifts. Non-fatal by contract: any failure
 * leaves the un-normalized file in place rather than deleting audio.
 */
import { findFfmpeg, FFMPEG_MISSING_MESSAGE } from '@dreambyte/render-server/ffmpeg-path.js'
import { runFfmpegInUtilityCapture } from './ffmpeg-util'
import { createLogger } from '../../lib/logger'
import {
  buildLoudnormMeasureFilter,
  buildLoudnormApplyFilter,
  parseLoudnormJson,
} from '../../lib/audio/audio-processing'

const log = createLogger('audio-normalize')

/** Resolve the user's installed ffmpeg; rejects with the install hint when none is found. */
export async function resolveExportFfmpegBin(): Promise<string> {
  const bin = findFfmpeg()
  if (!bin) throw new Error(FFMPEG_MISSING_MESSAGE)
  return bin
}

/** Normalization is best-effort: a wedged ffmpeg must not hang the whole export. */
const NORMALIZE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Shared by the loudnorm passes here and the caption burn-in pass
 * (src/electron/ipc/caption-burn.ts).
 *
 * Runs via the utilityProcess runner — a direct execFile/spawn of
 * ffmpeg from the Electron MAIN process can SIGSEGV (same class as the
 * overlay/scene-mixer filtergraph crash), which would silently skip
 * normalization. The runner has its own internal watchdog; `timeoutMs` is an
 * additional OUTER bound so long passes (4K caption burns) stay bounded by
 * the caller's estimate.
 */
export function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  timeoutMs: number = NORMALIZE_TIMEOUT_MS,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { code: number; stderr: string }) => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      resolve(r)
    }
    const killer = setTimeout(
      () => done({ code: -1, stderr: `ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s (outer bound)` }),
      timeoutMs,
    )
    runFfmpegInUtilityCapture(ffmpegBin, args).then((r) => done({ code: r.ok ? 0 : -1, stderr: r.stderr }))
  })
}

/**
 * Normalize `filePath` in place to `targetLufs` (two-pass loudnorm). Returns true
 * when normalization was applied, false when it was skipped (non-fatal). `fsMod`
 * is the caller's fs/promises (passed so this module stays decoupled from a
 * specific import style).
 */
export async function normalizeFinalAudio(
  filePath: string,
  targetLufs: number,
  fsMod: { rename: (a: string, b: string) => Promise<void>; rm: (p: string, o: { force: boolean }) => Promise<void> },
  ffmpegBin?: string,
): Promise<boolean> {
  const bin = ffmpegBin ?? (await resolveExportFfmpegBin())

  const measure = await runFfmpeg(bin, ['-i', filePath, '-af', buildLoudnormMeasureFilter(targetLufs), '-f', 'null', '-'])
  const measured = parseLoudnormJson(measure.stderr)
  if (!measured) {
    log.warn('loudnorm measure produced no JSON; leaving audio un-normalized', {
      extra: { stderr: measure.stderr.slice(-400) },
    })
    return false
  }

  // Unique temp name, APPENDED (not regex-replaced): a `.replace(/\.mp4$/...)`
  // would equal filePath when the output isn't lowercase `.mp4` (`.MP4`, no ext),
  // and the failure-path rm(tmp) would then delete the real export. Appending a
  // suffix + `.mp4` is always distinct from filePath and keeps a valid container
  // extension for ffmpeg. The pid+timestamp also avoids concurrent-export races.
  const tmp = `${filePath}.norm.${process.pid}.${Date.now()}.mp4`
  const apply = await runFfmpeg(bin, [
    '-i', filePath,
    '-af', buildLoudnormApplyFilter(targetLufs, measured),
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    // Re-muxing drops the input's faststart layout unless we re-request it —
    // without this, a tier3 export that burns captions (which sets +faststart)
    // and THEN normalizes ships with the moov atom at the end (no progressive
    // playback). Cheap on remux; always correct for our MP4 deliverables.
    '-movflags', '+faststart',
    '-y', tmp,
  ])
  if (apply.code !== 0) {
    log.warn('loudnorm apply failed; keeping un-normalized', { extra: { stderr: apply.stderr.slice(-400) } })
    await fsMod.rm(tmp, { force: true }).catch(() => {})
    return false
  }
  await fsMod.rename(tmp, filePath)
  log.info('loudness normalized', { extra: { targetLufs } })
  return true
}
