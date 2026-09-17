/**
 * Verify the exported MP4 is a real, playable artifact.
 *
 * Control flow alone (ffmpeg exited 0, no step threw) doesn't prove an export
 * worked: a render can still produce a 0-byte, header-only, or truncated MP4.
 * These checks look at the file itself before success is reported to the user
 * or the agent.
 *
 * This module is deliberately electron-free and pure so the same checks run in
 * unit tests AND against real ffmpeg output (see the .integration.test.ts) —
 * the same split as program-audio-overlay.ts.
 *
 * `ffmpeg -i` + a stderr parse, NOT ffprobe. Reasons, in order:
 * export-tier3's hasAudioStream already does exactly this, ffprobe isn't
 * guaranteed to sit next to the user's ffmpeg, and main-process
 * ffmpeg must go through the utility runner anyway. One binary, one policy.
 */

/** Below this, an "MP4" is a header stub or nothing at all. A 1-frame 320x180
 *  h264 file is ~1.5 kB, so this only rejects genuinely empty output. */
export const MIN_EXPORT_BYTES = 1024

export interface ExportProbe {
  hasVideo: boolean
  hasAudio: boolean
  /** Container duration in seconds, or null when ffmpeg printed none (N/A). */
  durationSec: number | null
}

/**
 * Parse `ffmpeg -i <file>` stderr. ffmpeg with no output file always exits
 * non-zero and prints the container/stream dump to stderr — so the exit code
 * is meaningless here and only the text matters.
 */
export function parseFfmpegProbe(stderr: string): ExportProbe {
  const dur = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr)
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null
  return {
    hasVideo: /Stream #\d+:\d+.*: Video:/.test(stderr),
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    durationSec: durationSec != null && Number.isFinite(durationSec) ? durationSec : null,
  }
}

/**
 * Duration tolerance: the composite encoder writes exactly round(d*fps) frames,
 * and the overlay/normalize passes can nudge the container by a frame or two —
 * so drift is small. A truncated render is not subtle (seconds out of minutes).
 * Generous on purpose: this must never fail a good export.
 */
export function durationTolerance(expectedSeconds: number): number {
  return Math.max(1, expectedSeconds * 0.25)
}

export type ArtifactVerdict = { ok: true; warnings: string[] } | { ok: false; reason: string }

/**
 * Decide whether the produced file counts as a successful export.
 * `sizeBytes: null` means the file does not exist.
 * `probe: null` means the probe could not run (no ffmpeg) — we then verify only
 * what we can (existence + size) rather than failing a good export on a missing
 * binary, and say so in `warnings`.
 */
export function checkExportArtifact(opts: {
  sizeBytes: number | null
  probe: ExportProbe | null
  expectedSeconds?: number | null
}): ArtifactVerdict {
  const { sizeBytes, probe } = opts
  if (sizeBytes == null) return { ok: false, reason: 'the output file does not exist' }
  if (sizeBytes < MIN_EXPORT_BYTES) {
    return { ok: false, reason: `the output file is ${sizeBytes} bytes — the render produced no usable video` }
  }
  if (!probe) return { ok: true, warnings: ['could not probe the export (no ffmpeg); checked size only'] }
  if (!probe.hasVideo) return { ok: false, reason: 'the output file has no video stream' }
  if (probe.durationSec == null) {
    return { ok: false, reason: 'the output file reports no duration — it is truncated or its index is missing' }
  }
  if (probe.durationSec <= 0) return { ok: false, reason: 'the output file is 0 seconds long' }

  const expected = opts.expectedSeconds
  if (typeof expected === 'number' && Number.isFinite(expected) && expected > 0) {
    const drift = Math.abs(probe.durationSec - expected)
    if (drift > durationTolerance(expected)) {
      return {
        ok: false,
        reason:
          `the output file is ${probe.durationSec.toFixed(1)}s but the timeline is ${expected.toFixed(1)}s — ` +
          `the render was truncated`,
      }
    }
  }
  return { ok: true, warnings: [] }
}

/** One-line message for the thrown Error / log. */
export function artifactFailureMessage(outputPath: string, reason: string): string {
  return `export verification failed: ${reason} (${outputPath}). Nothing usable was produced — do not report this export as complete.`
}
