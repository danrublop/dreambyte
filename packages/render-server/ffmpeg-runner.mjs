// Runs ffmpeg in a clean Electron utilityProcess — a separate process from the
// main process. FFmpeg (seen with static builds) can SIGSEGV at filtergraph init when a
// `-filter_complex` is spawned directly from the Electron MAIN process (any of
// spawn/execFile/fluent-ffmpeg crash identically), but runs fine from a normal
// Node process. utilityProcess.fork() gives us exactly that.
//
// Protocol: parent posts { ffmpegBin, args }; we reply { ok } or { ok:false,
// error } with the tail of ffmpeg's stderr.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CAP = 64 * 1024

process.parentPort.on('message', async (e) => {
  const { ffmpegBin, args } = e.data || {}
  if (!ffmpegBin || !Array.isArray(args) || args.length === 0) {
    process.parentPort.postMessage({ ok: false, error: `bad message: bin=${ffmpegBin} argc=${args?.length}` })
    return
  }
  try {
    // ffmpeg writes progress + loudnorm JSON to stderr; return its tail so the
    // caller can parse measurement passes (e.g. two-pass loudnorm).
    const { stderr } = await execFileAsync(ffmpegBin, args, { maxBuffer: 64 * 1024 * 1024 })
    process.parentPort.postMessage({ ok: true, stderr: (stderr || '').slice(-CAP) })
  } catch (err) {
    const full = err.stderr || ''
    const tail = full.split('\n').filter((l) => /error|invalid|fail|no such|unable|cannot/i.test(l))
    process.parentPort.postMessage({
      ok: false,
      error: (tail.join(' | ') || err.message || 'unknown').slice(-1200),
      stderr: full.slice(-CAP),
    })
  }
})
