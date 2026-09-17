/**
 * Silence detector.
 *
 * Pure RMS-window analysis over PCM samples. Returns the [start, end]
 * second-pairs where the signal stays below a dB threshold for at least
 * `minSilenceMs`. No Electron / ffmpeg / Web Audio dependency — the
 * decode step lives upstream (see `src/electron/ipc/edit-ai.ts` once it lands).
 *
 *   detectSilenceSpans(samples, 48000, { dbThreshold: -40, minSilenceMs: 250 })
 *     → [{ start: 0.3, end: 0.85 }, { start: 4.1, end: 5.2 }]
 *
 * Pure means: same inputs → byte-identical outputs. Tested with synthetic
 * sine + silence PCM in `silence-detector.test.ts`. The threshold and
 * window are tunable by the caller because different content (vocal vs
 * music-bed vs ambient) needs different defaults — pick once, log it.
 */

export interface SilenceSpan {
  /** Start of the silent region in seconds, relative to the input clip's start. */
  start: number
  /** End of the silent region in seconds (exclusive). */
  end: number
}

export interface DetectSilenceOptions {
  /**
   * Loudness threshold in dBFS. Samples below this for `minSilenceMs`
   * are flagged as silent. Editors commonly default to roughly -40 dB; very quiet
   * podcasts may want -50, music tracks -30.
   */
  dbThreshold?: number
  /**
   * Minimum span length (ms) before we call it silence. Filters out single-
   * frame drops between syllables. 250 ms = ~one short pause.
   */
  minSilenceMs?: number
  /**
   * Sliding RMS window (ms). Smaller windows catch shorter pauses but get
   * noisier on transient peaks; 20 ms is a sane voice default.
   */
  windowMs?: number
}

const DEFAULT_DB_THRESHOLD = -40
const DEFAULT_MIN_SILENCE_MS = 250
const DEFAULT_WINDOW_MS = 20

/**
 * Detect silence spans in a PCM buffer.
 *
 * @param samples       Mono float32 PCM (range roughly [-1, 1]). For stereo,
 *                      callers should average channels upstream so RMS
 *                      doesn't double-count.
 * @param sampleRate    Hz; e.g. 48000 / 44100 / 22050.
 * @param options       See `DetectSilenceOptions`.
 */
export function detectSilenceSpans(
  samples: Float32Array | number[],
  sampleRate: number,
  options: DetectSilenceOptions = {},
): SilenceSpan[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`detectSilenceSpans: sampleRate must be > 0 (got ${sampleRate})`)
  }
  if (!samples || samples.length === 0) return []

  const dbThreshold = options.dbThreshold ?? DEFAULT_DB_THRESHOLD
  const minSilenceMs = options.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS

  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const minSilenceWindows = Math.max(1, Math.ceil(((minSilenceMs / 1000) * sampleRate) / windowSize))
  // Convert dBFS threshold to linear amplitude. dB = 20·log10(amp); amp = 10^(dB/20).
  const ampThreshold = Math.pow(10, dbThreshold / 20)

  // Walk the buffer in non-overlapping windows. Each window's RMS gets
  // compared to ampThreshold; runs of below-threshold windows become spans.
  const spans: SilenceSpan[] = []
  let runStart: number | null = null
  let windowIdx = 0
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    let sumSq = 0
    for (let j = 0; j < windowSize; j++) {
      const s = samples[i + j]
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / windowSize)
    const isSilent = rms <= ampThreshold

    if (isSilent) {
      if (runStart === null) runStart = windowIdx
    } else {
      if (runStart !== null) {
        const length = windowIdx - runStart
        if (length >= minSilenceWindows) {
          spans.push({
            start: (runStart * windowSize) / sampleRate,
            end: (windowIdx * windowSize) / sampleRate,
          })
        }
        runStart = null
      }
    }
    windowIdx++
  }
  // Close an open run that runs to the end of the buffer.
  if (runStart !== null) {
    const length = windowIdx - runStart
    if (length >= minSilenceWindows) {
      spans.push({
        start: (runStart * windowSize) / sampleRate,
        end: (windowIdx * windowSize) / sampleRate,
      })
    }
  }

  return spans
}
