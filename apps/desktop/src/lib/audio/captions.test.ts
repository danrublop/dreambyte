import { describe, it, expect } from 'vitest'
import {
  buildCaptionBundle,
  buildNaiveCaptions,
  buildSrt,
  charAlignmentToWords,
  groupWordsIntoCues,
  mergeProjectCaptions,
} from './captions'

function mkAlignment(pairs: Array<[string, number, number]>) {
  return {
    characters: pairs.map((p) => p[0]),
    character_start_times_seconds: pairs.map((p) => p[1]),
    character_end_times_seconds: pairs.map((p) => p[2]),
  }
}

describe('charAlignmentToWords', () => {
  it('splits characters into words on whitespace', () => {
    const words = charAlignmentToWords(
      mkAlignment([
        ['H', 0.0, 0.05],
        ['i', 0.05, 0.1],
        [' ', 0.1, 0.12],
        ['t', 0.12, 0.15],
        ['h', 0.15, 0.18],
        ['e', 0.18, 0.2],
        ['r', 0.2, 0.23],
        ['e', 0.23, 0.25],
      ]),
    )
    expect(words).toEqual([
      { text: 'Hi', start: 0.0, end: 0.1 },
      { text: 'there', start: 0.12, end: 0.25 },
    ])
  })

  it('returns [] on empty input', () => {
    expect(
      charAlignmentToWords({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }),
    ).toEqual([])
  })

  it('handles consecutive whitespace without misaligning the next word', () => {
    const words = charAlignmentToWords(
      mkAlignment([
        ['H', 0.0, 0.1],
        ['i', 0.1, 0.2],
        [' ', 0.2, 0.22],
        [' ', 0.22, 0.24],
        [' ', 0.24, 0.26],
        ['b', 0.26, 0.34],
        ['y', 0.34, 0.4],
        ['e', 0.4, 0.45],
      ]),
    )
    expect(words).toEqual([
      { text: 'Hi', start: 0.0, end: 0.2 },
      { text: 'bye', start: 0.26, end: 0.45 },
    ])
  })

  it('skips leading whitespace', () => {
    const words = charAlignmentToWords(
      mkAlignment([
        [' ', 0.0, 0.05],
        ['h', 0.05, 0.1],
        ['i', 0.1, 0.15],
      ]),
    )
    expect(words).toEqual([{ text: 'hi', start: 0.05, end: 0.15 }])
  })

  it('handles single long word without whitespace', () => {
    const words = charAlignmentToWords(
      mkAlignment([
        ['a', 0.0, 0.1],
        ['b', 0.1, 0.2],
        ['c', 0.2, 0.3],
      ]),
    )
    expect(words).toEqual([{ text: 'abc', start: 0.0, end: 0.3 }])
  })
})

describe('groupWordsIntoCues', () => {
  it('breaks cues at the max word count', () => {
    const words = Array.from({ length: 15 }).map((_, i) => ({
      text: `w${i}`,
      start: i * 0.2,
      end: i * 0.2 + 0.18,
    }))
    const cues = groupWordsIntoCues(words, { maxWordsPerCue: 5, maxSecondsPerCue: 99 })
    expect(cues).toHaveLength(3)
    expect(cues[0].text.split(' ')).toHaveLength(5)
  })

  it('breaks cues after sentence-ending punctuation', () => {
    const words = [
      { text: 'Hello.', start: 0, end: 0.5 },
      { text: 'World', start: 0.6, end: 1.0 },
    ]
    const cues = groupWordsIntoCues(words, { maxWordsPerCue: 10, maxSecondsPerCue: 99 })
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('Hello.')
    expect(cues[1].text).toBe('World')
  })
})

describe('buildNaiveCaptions', () => {
  it('distributes words evenly across the given duration', () => {
    const bundle = buildNaiveCaptions('one two three four', 4)
    expect(bundle.words).toHaveLength(4)
    expect(bundle.words[0].start).toBeCloseTo(0)
    expect(bundle.words[0].end).toBeCloseTo(1)
    expect(bundle.words[3].start).toBeCloseTo(3)
    expect(bundle.words[3].end).toBeCloseTo(4)
  })

  it('returns empty output for empty text', () => {
    const bundle = buildNaiveCaptions('', 5)
    expect(bundle.words).toHaveLength(0)
    expect(bundle.srt).toBe('')
  })

  it('returns empty output for non-positive duration', () => {
    expect(buildNaiveCaptions('hello', 0).words).toHaveLength(0)
    expect(buildNaiveCaptions('hello', -1).words).toHaveLength(0)
  })
})

describe('mergeProjectCaptions', () => {
  it('offsets scene words to an absolute project timeline', () => {
    const bundle = mergeProjectCaptions([
      { startSeconds: 0, words: [{ text: 'hi', start: 0, end: 0.5 }] },
      { startSeconds: 3, words: [{ text: 'bye', start: 0, end: 0.5 }] },
    ])
    expect(bundle.cues.map((c) => ({ text: c.text, start: c.start, end: c.end }))).toEqual([
      { text: 'hi', start: 0, end: 0.5 },
      { text: 'bye', start: 3, end: 3.5 },
    ])
  })

  it('keeps cues sorted by start time even if scenes are passed out of order', () => {
    const bundle = mergeProjectCaptions([
      { startSeconds: 5, words: [{ text: 'late', start: 0, end: 0.5 }] },
      { startSeconds: 0, words: [{ text: 'early', start: 0, end: 0.5 }] },
    ])
    expect(bundle.cues[0].text).toBe('early')
    expect(bundle.cues[1].text).toBe('late')
  })
})

describe('buildCaptionBundle', () => {
  it('produces SRT and VTT with matching cue counts', () => {
    const bundle = buildCaptionBundle(
      mkAlignment([
        ['H', 0.0, 0.1],
        ['i', 0.1, 0.2],
        [' ', 0.2, 0.22],
        ['b', 0.22, 0.3],
        ['y', 0.3, 0.35],
        ['e', 0.35, 0.4],
      ]),
    )
    expect(bundle.srt.startsWith('1\n')).toBe(true)
    expect(bundle.vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(bundle.srt).toContain('00:00:00,000 --> 00:00:00,400')
    expect(bundle.vtt).toContain('00:00:00.000 --> 00:00:00.400')
    expect(bundle.words.map((w) => w.text)).toEqual(['Hi', 'bye'])
  })
})

describe('formatSrtTimestamp rounding (via buildSrt)', () => {
  it('carries ms rounding into seconds instead of emitting ,1000', () => {
    // 0.9996s rounds to 1000ms — the old fraction-only rounding emitted
    // `00:00:00,1000` (4-digit ms, no carry), which libass rejects on burn-in.
    const srt = buildSrt([{ text: 'edge', start: 0.9996, end: 2.9995 }])
    expect(srt).toContain('00:00:01,000 --> 00:00:03,000')
    expect(srt).not.toContain(',1000')
  })

  it('clamps non-finite timestamps to zero instead of NaN garbage', () => {
    const srt = buildSrt([{ text: 'bad', start: NaN, end: Infinity }])
    expect(srt).toContain('00:00:00,000 -->')
    expect(srt).not.toContain('NaN')
  })
})
