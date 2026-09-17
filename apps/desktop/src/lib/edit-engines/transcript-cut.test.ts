// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { cutByTranscriptForClip, findCueRanges, tokenize } from './transcript-cut'
import { setCaptionTranscriber } from './caption-transcriber'
import { parseSRT } from './srt'
import type { Clip } from '@/lib/types'

afterEach(() => setCaptionTranscriber(null))

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'C1',
    trackId: 'T1',
    sourceType: 'video',
    sourceId: '/media/talk.mp4',
    label: 'Talk',
    startTime: 0,
    duration: 30,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  } as Clip
}

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello everyone, welcome back.

2
00:00:03,500 --> 00:00:06,000
Today we look at, um, the quarterly numbers.

3
00:00:06,500 --> 00:00:09,000
The numbers are strong this quarter.
`

function stubTranscriber(srt = SRT) {
  setCaptionTranscriber({ transcribe: async () => ({ srt, language: 'en' }) })
}

describe('tokenize / findCueRanges', () => {
  it('matches across punctuation and case', () => {
    const cues = parseSRT(SRT)
    expect(findCueRanges(cues, 'WELCOME back')).toEqual([{ first: 0, last: 0 }])
  })

  it('matches a phrase spanning two cues', () => {
    const cues = parseSRT(SRT)
    // "...quarterly numbers. The numbers are..." crosses cue 2 → 3.
    expect(findCueRanges(cues, 'quarterly numbers the numbers')).toEqual([{ first: 1, last: 2 }])
  })

  it('finds multiple non-overlapping occurrences', () => {
    const cues = parseSRT(SRT)
    expect(findCueRanges(cues, 'numbers')).toEqual([
      { first: 1, last: 1 },
      { first: 2, last: 2 },
    ])
  })

  it('no match → empty; empty query → empty', () => {
    const cues = parseSRT(SRT)
    expect(findCueRanges(cues, 'not in the talk')).toEqual([])
    expect(findCueRanges(cues, '  …  ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })
})

describe('cutByTranscriptForClip', () => {
  it('maps a matched cue to a padded clip-relative span and a cut plan', async () => {
    stubTranscriber()
    const result = await cutByTranscriptForClip({ clip: clip(), sourceUri: 'x', text: 'um the quarterly numbers' })
    expect(result.matches).toHaveLength(1)
    const span = result.matches[0].span
    // Cue 2 is 3.5–6.0s, padded by 0.05.
    expect(span.start).toBeCloseTo(3.45, 2)
    expect(span.end).toBeCloseTo(6.05, 2)
    expect(result.plan.actions.length).toBeGreaterThan(0)
    expect(result.plan.savedSeconds).toBeCloseTo(2.6, 1)
    expect(result.language).toBe('en')
    expect(result.cueCount).toBe(3)
  })

  it('honors trimStart and speed when mapping source → clip time', async () => {
    stubTranscriber()
    // trimStart 2s, 2x speed: cue 2 (3.5–6.0 source) → (0.75–2.0 clip).
    const c = clip({ trimStart: 2, speed: 2, duration: 10 })
    const result = await cutByTranscriptForClip({ clip: c, sourceUri: 'x', text: 'quarterly', padSeconds: 0 })
    expect(result.matches[0].span.start).toBeCloseTo(0.75, 2)
    expect(result.matches[0].span.end).toBeCloseTo(2.0, 2)
  })

  it('drops matches that fall outside the trimmed clip window', async () => {
    stubTranscriber()
    // trimStart 10s: every cue (1–9s source) is before the clip's window.
    const c = clip({ trimStart: 10, duration: 5 })
    const result = await cutByTranscriptForClip({ clip: c, sourceUri: 'x', text: 'numbers' })
    expect(result.matches).toHaveLength(0)
    expect(result.plan.actions).toHaveLength(0)
  })

  it('no transcript match → empty plan, never a guess', async () => {
    stubTranscriber()
    const result = await cutByTranscriptForClip({ clip: clip(), sourceUri: 'x', text: 'never said this' })
    expect(result.matches).toHaveLength(0)
    expect(result.plan.savedSeconds).toBe(0)
  })
})

// ── Word-level precision (when the transcriber provides word timestamps) ─────

describe('word-level cuts', () => {
  const WORDS = [
    { word: 'Hello', start: 1.0, end: 1.4 },
    { word: 'everyone,', start: 1.4, end: 1.9 },
    { word: 'welcome', start: 1.9, end: 2.4 },
    { word: 'back.', start: 2.4, end: 2.9 },
    { word: 'Today', start: 3.5, end: 3.9 },
    { word: 'we', start: 3.9, end: 4.0 },
    { word: 'look', start: 4.0, end: 4.3 },
    { word: 'at', start: 4.3, end: 4.4 },
    { word: 'the', start: 4.4, end: 4.5 },
    { word: 'quarterly', start: 4.5, end: 5.2 },
    { word: 'numbers.', start: 5.2, end: 5.8 },
  ]

  it('spans cover exactly the matched words, not whole cues', async () => {
    setCaptionTranscriber({ transcribe: async () => ({ srt: SRT, language: 'en', words: WORDS }) })
    const result = await cutByTranscriptForClip({
      clip: clip(),
      sourceUri: 'x',
      text: 'quarterly numbers',
      padSeconds: 0,
    })
    expect(result.precision).toBe('word')
    expect(result.matches).toHaveLength(1)
    // 4.5–5.8s — the two words, NOT cue 2's full 3.5–6.0s span.
    expect(result.matches[0].span.start).toBeCloseTo(4.5, 3)
    expect(result.matches[0].span.end).toBeCloseTo(5.8, 3)
  })

  it('falls back to cue precision when words are absent (unchanged behavior)', async () => {
    setCaptionTranscriber({ transcribe: async () => ({ srt: SRT, language: 'en' }) })
    const result = await cutByTranscriptForClip({ clip: clip(), sourceUri: 'x', text: 'quarterly', padSeconds: 0 })
    expect(result.precision).toBe('cue')
    expect(result.matches[0].span.start).toBeCloseTo(3.5, 2) // whole cue
  })

  it('punctuation on whisper words does not break matching', async () => {
    setCaptionTranscriber({ transcribe: async () => ({ srt: SRT, words: WORDS }) })
    const result = await cutByTranscriptForClip({
      clip: clip(),
      sourceUri: 'x',
      text: 'welcome back',
      padSeconds: 0,
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].span.start).toBeCloseTo(1.9, 3)
    expect(result.matches[0].span.end).toBeCloseTo(2.9, 3)
  })
})
