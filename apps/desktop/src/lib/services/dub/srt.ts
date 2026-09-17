// SRT parsing for the dubbing pipeline (Tier 3 — video dubbing/translation).
// Whisper (src/lib/edit-engines/caption-transcriber) returns raw SRT; we parse it into timed segments
// so each cue can be translated + re-spoken + time-fit to its window (segment-level dubbing).

export interface DubSegment {
  /** 1-based cue index from the SRT. */
  index: number
  /** Cue start / end in milliseconds from the clip start. */
  startMs: number
  endMs: number
  /** Source-language text of this cue (newlines collapsed to spaces). */
  text: string
}

/** `00:00:04,250` (or `.` as the ms separator) → milliseconds. Returns NaN on a malformed stamp. */
export function parseSrtTimestamp(stamp: string): number {
  const m = stamp.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) return NaN
  const [, hh, mm, ss, ms] = m
  // Pad/truncate the fractional part to exactly 3 digits (".5" → 500ms, ",1234" → 123ms).
  const msNorm = Number((ms + '000').slice(0, 3))
  return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + msNorm
}

/**
 * Parse SRT text into ordered, valid timed segments. Tolerant of CRLF, blank-line spacing,
 * missing trailing newline, and a missing numeric index (falls back to running order). Cues with an
 * unparseable timestamp line, empty text, or end <= start are dropped (never emit a zero/negative
 * window — the timing planner divides by the window). Output is sorted by startMs.
 */
export function parseSrt(srt: string): DubSegment[] {
  if (!srt || !srt.trim()) return []
  const blocks = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n{2,}/)
  const segments: DubSegment[] = []
  let fallbackIndex = 0
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    fallbackIndex += 1
    // First line may be the numeric index; the timing line contains '-->'.
    let idx = fallbackIndex
    let timingLineAt = 0
    if (/^\d+$/.test(lines[0].trim())) {
      idx = Number(lines[0].trim())
      timingLineAt = 1
    }
    const timingLine = lines[timingLineAt]
    if (!timingLine || !timingLine.includes('-->')) continue
    const [rawStart, rawEnd] = timingLine.split('-->')
    if (rawEnd === undefined) continue
    const startMs = parseSrtTimestamp(rawStart)
    // The end stamp may carry trailing position metadata (X1:.. etc) — take the first token.
    const endMs = parseSrtTimestamp(rawEnd.trim().split(/\s+/)[0] ?? '')
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const text = lines
      .slice(timingLineAt + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    segments.push({ index: idx, startMs, endMs, text })
  }
  return segments.sort((a, b) => a.startMs - b.startMs)
}
