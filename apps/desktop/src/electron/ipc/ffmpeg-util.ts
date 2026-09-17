/**
 * ffmpeg-util — run ffmpeg from the Electron main process WITHOUT crashing.
 *
 * FFmpeg (seen with static builds) can SIGSEGV at filtergraph init when a `-filter_complex`
 * is launched directly from the MAIN process (spawn / execFile / fluent-ffmpeg
 * all crash identically). A utilityProcess is a clean Node process where it runs
 * fine. This is the SINGLE ffmpeg entry point for every main-process filtergraph
 * job: the program-audio overlay, per-scene audio mixing, and loudness
 * normalization all go through here so none of them can hit the crash.
 */

import { utilityProcess } from 'electron'
import path from 'node:path'
import { getRenderServerDir } from '../paths'

/** ffmpeg jobs are best-effort: a wedged ffmpeg must never hang an export.
 *  Same invariant (and value) as the watchdog the old audio-normalize spawn
 *  path enforced before it migrated here. */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000

/** Run ffmpeg in a utilityProcess and return its result (never rejects). `ok`
 *  is true on exit 0; `stderr` is the captured tail (loudnorm JSON, errors).
 *  A watchdog kills the runner after FFMPEG_TIMEOUT_MS so a stuck filtergraph
 *  resolves as a failure instead of hanging the export forever. */
export function runFfmpegInUtilityCapture(
  ffmpegBin: string,
  args: string[],
): Promise<{ ok: boolean; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const runnerPath = path.join(getRenderServerDir(), 'ffmpeg-runner.mjs')
    const child = utilityProcess.fork(runnerPath, [], { stdio: 'ignore' })
    let settled = false
    const finish = (r: { ok: boolean; stderr: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve(r)
    }
    const watchdog = setTimeout(
      () => finish({ ok: false, stderr: '', error: `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s` }),
      FFMPEG_TIMEOUT_MS,
    )
    child.on('message', (msg: { ok: boolean; error?: string; stderr?: string }) =>
      finish({ ok: !!msg?.ok, stderr: msg?.stderr ?? '', error: msg?.error }),
    )
    child.on('exit', (code) => {
      if (!settled) finish({ ok: code === 0, stderr: '', error: `runner exited ${code}` })
    })
    child.postMessage({ ffmpegBin, args })
  })
}

/** Run ffmpeg in a utilityProcess; resolve on success, reject with stderr tail. */
export async function runFfmpegInUtility(ffmpegBin: string, args: string[]): Promise<void> {
  const r = await runFfmpegInUtilityCapture(ffmpegBin, args)
  if (!r.ok) throw new Error(`ffmpeg: ${r.error ?? 'unknown'}`)
}
