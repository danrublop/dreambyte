/**
 * Transcript-driven cuts — "delete the part where I say X."
 *
 * Pipeline, reusing the existing seams end-to-end:
 *   1. transcribe via the configured caption transcriber → SRT (same engine
 *      add_captions uses; cloud Whisper or local whisper.cpp per privacy mode)
 *   2. parse cues (srt.ts) and find every non-overlapping occurrence of the
 *      requested text — token-normalized so punctuation/case/line breaks in
 *      the transcript don't break matching, and matches may SPAN cues
 *   3. matched cue ranges → clip-relative time spans (source→clip mapping
 *      honors trimStart + speed, clamped to the clip), padded slightly so
 *      word edges don't clip
 *   4. spans → the same split/ripple-delete plan auto_cut_silence uses
 *      (silenceSpansToActions), with its preview/apply contract
 *
 * Precision honesty: matches resolve to whole-CUE boundaries (SRT has no
 * word timestamps). A match in the middle of a long cue removes that cue's
 * full span. Word-level precision needs word-timestamped transcription —
 * documented follow-up, not silently faked.
 */

import type { Clip } from '@/lib/types'
import { parseSRT, type SrtCue } from './srt'
import { getCaptionTranscriber, type TranscribeOptions, type TranscriptWord } from './caption-transcriber'
import { silenceSpansToActions, type SilenceCutPlan, type SilenceSpanForCut } from './silence-actions'

export interface TranscriptCutArgs {
  clip: Clip
  /** Source URI the transcriber understands. */
  sourceUri: string
  /** The spoken text to remove (matched against the transcript). */
  text: string
  transcribeOptions?: TranscribeOptions
  /** Seconds of padding around each matched span. Default 0.05. */
  padSeconds?: number
}

export interface TranscriptMatch {
  /** The matched cues, in order. */
  cues: SrtCue[]
  /** Clip-relative span covering the match (padded, clamped). */
  span: SilenceSpanForCut
}

export interface TranscriptCutResult {
  matches: TranscriptMatch[]
  plan: SilenceCutPlan
  language?: string
  /** Total cues in the transcript — lets the caller report match context. */
  cueCount: number
  /** 'word' when the transcriber provided word timestamps (precise spans);
   *  'cue' when matches resolve to whole caption-cue boundaries. */
  precision: 'word' | 'cue'
}

/** Lowercase, strip punctuation, split on whitespace. Exported for tests. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Find every non-overlapping occurrence of `queryTokens` in the cue stream.
 * Returns cue index ranges [firstCue, lastCue] per match.
 */
export function findCueRanges(cues: SrtCue[], query: string): Array<{ first: number; last: number }> {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  // Flatten cues to a token stream remembering each token's cue index.
  const stream: Array<{ token: string; cueIdx: number }> = []
  cues.forEach((cue, cueIdx) => {
    for (const token of tokenize(cue.text)) stream.push({ token, cueIdx })
  })

  const ranges: Array<{ first: number; last: number }> = []
  let i = 0
  while (i <= stream.length - queryTokens.length) {
    let ok = true
    for (let j = 0; j < queryTokens.length; j++) {
      if (stream[i + j].token !== queryTokens[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      ranges.push({ first: stream[i].cueIdx, last: stream[i + queryTokens.length - 1].cueIdx })
      i += queryTokens.length // non-overlapping
    } else {
      i++
    }
  }
  return ranges
}

/** Source-relative seconds → clip-relative, honoring trim + speed. */
function sourceToClipTime(clip: Clip, sourceSec: number): number {
  const speed = clip.speed > 0 ? clip.speed : 1
  return (sourceSec - (clip.trimStart ?? 0)) / speed
}

/**
 * Find every non-overlapping occurrence of the query over a WORD stream
 * (word-timestamped transcribers). Each match's span covers exactly the
 * matched words — true word precision, no whole-cue removal.
 */
export function findWordRanges(words: TranscriptWord[], query: string): Array<{ first: number; last: number }> {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []
  // A whisper "word" can carry punctuation/spacing; normalize each the same
  // way the query is. Words that normalize to nothing (pure punctuation)
  // keep their slot but can never match.
  const norm = words.map((w) => tokenize(w.word)[0] ?? '')
  const ranges: Array<{ first: number; last: number }> = []
  let i = 0
  while (i <= norm.length - queryTokens.length) {
    let ok = true
    for (let j = 0; j < queryTokens.length; j++) {
      if (norm[i + j] !== queryTokens[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      ranges.push({ first: i, last: i + queryTokens.length - 1 })
      i += queryTokens.length
    } else {
      i++
    }
  }
  return ranges
}

export async function cutByTranscriptForClip(args: TranscriptCutArgs): Promise<TranscriptCutResult> {
  const transcriber = getCaptionTranscriber()
  const { srt, language, words } = await transcriber.transcribe(args.sourceUri, args.transcribeOptions)
  const cues = parseSRT(srt)
  const pad = args.padSeconds ?? 0.05

  // Source-time spans for each match, by the best precision available.
  const useWords = !!words && words.length > 0
  const sourceSpans: Array<{ start: number; end: number; cues: SrtCue[] }> = []
  if (useWords) {
    for (const r of findWordRanges(words, args.text)) {
      const start = words[r.first].start
      const end = words[r.last].end
      // Attribute the overlapping cues for the match summary (best-effort).
      const overlapping = cues.filter((c) => c.end > start && c.start < end)
      sourceSpans.push({ start, end, cues: overlapping })
    }
  } else {
    for (const r of findCueRanges(cues, args.text)) {
      const matched = cues.slice(r.first, r.last + 1)
      sourceSpans.push({ start: matched[0].start, end: matched[matched.length - 1].end, cues: matched })
    }
  }

  const matches: TranscriptMatch[] = []
  for (const s of sourceSpans) {
    const rawStart = sourceToClipTime(args.clip, s.start) - pad
    const rawEnd = sourceToClipTime(args.clip, s.end) + pad
    // Clamp to the clip; a match entirely outside the trimmed window drops.
    const start = Math.max(0, rawStart)
    const end = Math.min(args.clip.duration, rawEnd)
    if (end <= start) continue
    matches.push({ cues: s.cues, span: { start, end } })
  }

  const plan = silenceSpansToActions(
    args.clip,
    matches.map((m) => m.span),
  )
  return { matches, plan, language, cueCount: cues.length, precision: useWords ? 'word' : 'cue' }
}
