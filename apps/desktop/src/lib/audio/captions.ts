// ── SRT / VTT caption emission from TTS timestamps ──────────────────────────
//
// Takes per-character or per-word alignment returned by a TTS provider (e.g.
// ElevenLabs `/with-timestamps`) and converts it into standard subtitle files.
// The cues are grouped into short readable chunks (~7 words or ~3 seconds)
// so export and publish surfaces can attach captions without post-processing.

export interface WordSegment {
  text: string
  start: number
  end: number
}

export interface CharAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/** Convert ElevenLabs-style character alignment into word-level segments. */
export function charAlignmentToWords(align: CharAlignment): WordSegment[] {
  const words: WordSegment[] = []
  const n = align.characters.length
  if (n === 0) return words

  let buf = ''
  let start = align.character_start_times_seconds[0]
  let end = align.character_end_times_seconds[0]

  const flush = () => {
    const trimmed = buf.trim()
    if (trimmed.length > 0) {
      words.push({ text: trimmed, start, end })
    }
    buf = ''
  }

  for (let i = 0; i < n; i++) {
    const ch = align.characters[i]
    const charStart = align.character_start_times_seconds[i]
    const charEnd = align.character_end_times_seconds[i]

    if (/\s/.test(ch)) {
      flush()
      // Reset start/end for the next word to the NEXT non-space char's times;
      // we'll overwrite on the first non-space.
      start = charEnd
      end = charEnd
      continue
    }

    if (buf.length === 0) {
      start = charStart
      end = charEnd
    } else {
      end = charEnd
    }
    buf += ch
  }

  flush()
  return words
}

export interface GroupOptions {
  /** Maximum words per caption cue. Defaults to 7. */
  maxWordsPerCue?: number
  /** Maximum cue duration in seconds. Defaults to 3.5. */
  maxSecondsPerCue?: number
  /** Start a new cue when the gap between words exceeds this. Defaults to 0.5s. */
  maxGapSeconds?: number
}

/** Group word segments into cue-sized chunks suitable for on-screen captions. */
export function groupWordsIntoCues(words: WordSegment[], opts: GroupOptions = {}): WordSegment[] {
  const maxWords = opts.maxWordsPerCue ?? 7
  const maxSeconds = opts.maxSecondsPerCue ?? 3.5
  const maxGap = opts.maxGapSeconds ?? 0.5
  const cues: WordSegment[] = []

  let current: WordSegment | null = null
  let wordCount = 0

  for (const w of words) {
    if (!current) {
      current = { ...w }
      wordCount = 1
      continue
    }

    const wouldExceedWords = wordCount + 1 > maxWords
    const wouldExceedTime = w.end - current.start > maxSeconds
    const wouldExceedGap = w.start - current.end > maxGap
    const endsSentence = /[.!?]$/.test(current.text)

    if (wouldExceedWords || wouldExceedTime || wouldExceedGap || endsSentence) {
      cues.push(current)
      current = { ...w }
      wordCount = 1
    } else {
      current.text += ` ${w.text}`
      current.end = w.end
      wordCount += 1
    }
  }
  if (current) cues.push(current)
  return cues
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0')
}

function formatSrtTimestamp(seconds: number): string {
  const raw = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  // Round to whole milliseconds FIRST, then split — rounding the fractional
  // part separately emits `,1000` (4-digit ms with no carry into seconds) for
  // any timestamp whose fraction is ≥ .9995, which libass rejects when the
  // SRT is burned in (and confuses players on sidecars).
  const totalMs = Math.round(raw * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const mins = Math.floor((totalMs % 3_600_000) / 60_000)
  const secs = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  return `${pad(hours, 2)}:${pad(mins, 2)}:${pad(secs, 2)},${pad(ms, 3)}`
}

function formatVttTimestamp(seconds: number): string {
  return formatSrtTimestamp(seconds).replace(',', '.')
}

export function buildSrt(cues: WordSegment[]): string {
  return (
    cues
      .map((cue, i) => `${i + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`)
      .join('\n\n') + '\n'
  )
}

export function buildVtt(cues: WordSegment[]): string {
  const body = cues
    .map((cue) => `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

export interface CaptionBundle {
  srt: string
  vtt: string
  words: WordSegment[]
  cues: WordSegment[]
}

/** One-shot helper: character alignment → grouped cues + SRT + VTT strings. */
export function buildCaptionBundle(align: CharAlignment, opts?: GroupOptions): CaptionBundle {
  const words = charAlignmentToWords(align)
  const cues = groupWordsIntoCues(words, opts)
  return {
    srt: buildSrt(cues),
    vtt: buildVtt(cues),
    words,
    cues,
  }
}

/** Fallback when the TTS provider didn't return character/word alignment.
 *  Distributes the source text evenly across `durationSeconds` by word count.
 *  Not perfectly sync'd, but produces usable captions for any TTS provider. */
export function buildNaiveCaptions(text: string, durationSeconds: number, opts?: GroupOptions): CaptionBundle {
  const tokens = text.split(/\s+/).filter((w) => w.length > 0)
  if (tokens.length === 0 || !isFinite(durationSeconds) || durationSeconds <= 0) {
    return { srt: '', vtt: 'WEBVTT\n\n', words: [], cues: [] }
  }
  const perWord = durationSeconds / tokens.length
  const words: WordSegment[] = tokens.map((t, i) => ({
    text: t,
    start: i * perWord,
    end: (i + 1) * perWord,
  }))
  const cues = groupWordsIntoCues(words, opts)
  return {
    srt: buildSrt(cues),
    vtt: buildVtt(cues),
    words,
    cues,
  }
}

export interface SceneCaptionInput {
  /** Absolute start time of this scene in the final project timeline. */
  startSeconds: number
  /** Word-level segments for this scene's narration (scene-relative times). */
  words: WordSegment[]
}

/** Merge per-scene caption segments into a single project-level SRT + VTT,
 *  offsetting each scene's words to the project timeline. */
export function mergeProjectCaptions(scenes: SceneCaptionInput[], opts?: GroupOptions): CaptionBundle {
  const merged: WordSegment[] = []
  for (const s of scenes) {
    for (const w of s.words) {
      merged.push({ text: w.text, start: w.start + s.startSeconds, end: w.end + s.startSeconds })
    }
  }
  merged.sort((a, b) => a.start - b.start)
  const cues = groupWordsIntoCues(merged, opts)
  return {
    srt: buildSrt(cues),
    vtt: buildVtt(cues),
    words: merged,
    cues,
  }
}
