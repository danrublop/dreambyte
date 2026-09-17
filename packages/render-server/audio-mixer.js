import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import { buildSceneAudioFilter } from './audio-filter.js'
import { findFfmpeg, FFMPEG_MISSING_MESSAGE } from './ffmpeg-path.js'

const execFileAsync = promisify(execFile)

/**
 * Mix audio tracks with a scene video using FFmpeg.
 *
 * @param {string} videoPath - Path to the silent (or existing) scene video
 * @param {Object} audioTracks - Audio track configuration
 * @param {Object} [audioTracks.tts] - { path: string } - TTS narration file path (local)
 * @param {Array}  [audioTracks.sfx] - [{ path: string, triggerAt: number, volume: number }]
 * @param {Object} [audioTracks.music] - { path: string, volume: number, loop: boolean, duckDuringTTS: boolean, duckLevel: number }
 * @param {number} duration - Scene duration in seconds
 * @param {string} outputPath - Output file path
 * @param {object|null} [resolved] - Resolved E1 mix settings (gains + ducking params)
 *   from src/lib/audio/audio-processing.ts resolveAudioProcessing(). NULL ⇒ pre-E1
 *   byte-identical behavior. Normalization is NOT applied here (post-stitch).
 * @returns {Promise<string>} Output file path
 */
// `runner` (optional): when provided, runs ffmpeg via the caller's mechanism
// (the Electron app injects a utilityProcess runner — a direct execFile from the
// Electron MAIN process can SIGSEGV ffmpeg on a filter_complex). The
// web render-server passes nothing and uses execFileAsync.
export async function mixAudioTracks(
  videoPath,
  audioTracks,
  duration,
  outputPath,
  resolved = null,
  runner = null,
  sceneMix = null,
  sfxIds = [],
) {
  // The per-scene filtergraph (gain + ducking + mix) is built by the shared pure
  // builder. `resolved` (from src/lib/audio/audio-processing.ts resolveAudioProcessing)
  // carries the agent's mix settings; NULL ⇒ byte-identical to pre-E1 behavior.
  // `sceneMix` carries the timeline mixer controls (track volume/mute/solo/pan +
  // project master) per category; NULL ⇒ unity. Loudness normalization is NOT
  // applied here — it's a single post-stitch loudnorm pass on the final video.
  const built = buildSceneAudioFilter(audioTracks, duration, resolved, sceneMix, sfxIds)

  // ── No audio tracks → just copy the video file ────────────────────────────
  if (!built) {
    fs.copyFileSync(videoPath, outputPath)
    return outputPath
  }

  const FFMPEG_BIN = findFfmpeg()
  if (!FFMPEG_BIN) throw new Error(FFMPEG_MISSING_MESSAGE)

  const inputs = ['-i', videoPath] // Input 0: video
  for (const p of built.audioInputPaths) inputs.push('-i', p)

  const args = [
    ...inputs,
    '-filter_complex', built.filterComplex,
    '-map', '0:v',                 // Video from input 0
    '-map', `[${built.audioOutLabel}]`, // Mixed audio output
    '-c:v', 'copy',                // Copy video codec (no re-encode)
    '-c:a', 'aac',                 // Encode audio as AAC
    '-b:a', '192k',                // Audio bitrate
    '-t', String(duration),        // Limit output to scene duration
    '-y',                          // Overwrite output
    outputPath,
  ]

  console.log(`[audio-mixer] FFmpeg command: ${FFMPEG_BIN} ${args.join(' ')}`)

  try {
    if (runner) await runner(FFMPEG_BIN, args)
    else await execFileAsync(FFMPEG_BIN, args, { maxBuffer: 50 * 1024 * 1024 })
    console.log(`[audio-mixer] Audio mix complete: ${outputPath}`)
    return outputPath
  } catch (err) {
    console.error('[audio-mixer] FFmpeg audio mix failed:', err.stderr || err.message)
    throw new Error(`Audio mixing failed: ${err.message}`)
  }
}
