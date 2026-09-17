/**
 * SRT parser.
 *
 * Permissive enough to handle the variations Whisper / Anthropic Files /
 * whisper.cpp tend to produce:
 *   - CRLF or LF line endings
 *   - BOM prefix
 *   - `,` or `.` as the millisecond separator (the spec says comma, but
 *     OpenAI's API and ffmpeg both emit period)
 *   - Multi-line text bodies (joined with newline → space, callers can
 *     swap to `<br>` if they want)
 *
 * Pure — no IO, no dependencies. Returns ordered cues; raises on a
 * timestamp line that can't be parsed.
 */

export interface SrtCue {
  /** 1-based index from the source file (or our own counter when missing). */
  index: number
  /** Seconds from the start of the source media. */
  start: number
  /** Seconds; > start, may equal start + 0.001 for instant cues. */
  end: number
  /** Body text — multi-line bodies are joined with a single space. */
  text: string
}

const TIMESTAMP_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

/** "01:23:45,678" → seconds as a float. */
function tsToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

export function parseSRT(input: string): SrtCue[] {
  if (!input) return []

  // Strip BOM (U+FEFF) and normalise line endings. The regex uses
  // escape rather than a literal byte-order-mark char to satisfy
  // no-irregular-whitespace.
  const text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text.length === 0) return []

  // Cue blocks are separated by one or more blank lines.
  const blocks = text.split(/\n{2,}/)
  const cues: SrtCue[] = []
  let fallbackIndex = 1

  for (const raw of blocks) {
    const lines = raw.split('\n').filter((l) => l.length > 0)
    if (lines.length === 0) continue

    // The first line may be an index. Some emitters skip it.
    let firstLineIdx = 0
    let index = fallbackIndex
    const maybeIdx = lines[0].trim()
    if (/^\d+$/.test(maybeIdx) && lines.length >= 2 && TIMESTAMP_RE.test(lines[1])) {
      index = Number(maybeIdx)
      firstLineIdx = 1
    }

    const tsLine = lines[firstLineIdx]
    const m = tsLine.match(TIMESTAMP_RE)
    if (!m) {
      throw new Error(`SRT parse error: expected timestamp line, got "${tsLine}"`)
    }
    const start = tsToSeconds(m[1], m[2], m[3], m[4])
    const end = tsToSeconds(m[5], m[6], m[7], m[8])

    const bodyLines = lines.slice(firstLineIdx + 1)
    const body = bodyLines.join(' ').trim()
    if (body.length === 0) continue

    cues.push({ index, start, end, text: body })
    fallbackIndex = index + 1
  }

  return cues
}
