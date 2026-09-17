// @vitest-environment node

import { describe, it, expect } from 'vitest'

import { parseSRT } from './srt'

describe('parseSRT', () => {
  it('parses a basic three-cue file', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,500',
      'Hello',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      'World',
      '',
      '3',
      '00:00:07,250 --> 00:00:09,750',
      'Goodbye',
    ].join('\n')
    const cues = parseSRT(srt)
    expect(cues.length).toBe(3)
    expect(cues[0]).toEqual({ index: 1, start: 1.0, end: 3.5, text: 'Hello' })
    expect(cues[1].start).toBe(4)
    expect(cues[2].text).toBe('Goodbye')
  })

  it('accepts "." as the millisecond separator (ffmpeg / Whisper API output)', () => {
    const srt = '1\n00:00:01.000 --> 00:00:02.000\nDot ms'
    const cues = parseSRT(srt)
    expect(cues[0]).toEqual({ index: 1, start: 1, end: 2, text: 'Dot ms' })
  })

  it('joins multi-line bodies with a single space', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two'
    expect(parseSRT(srt)[0].text).toBe('Line one Line two')
  })

  it('strips BOM and normalises CRLF', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nBom test\r\n'
    expect(parseSRT(srt)[0].text).toBe('Bom test')
  })

  it('assigns fallback indices when the source omits them', () => {
    const srt = ['00:00:01,000 --> 00:00:02,000', 'A', '', '00:00:03,000 --> 00:00:04,000', 'B'].join('\n')
    const cues = parseSRT(srt)
    expect(cues.map((c) => c.index)).toEqual([1, 2])
  })

  it('returns [] on empty input', () => {
    expect(parseSRT('')).toEqual([])
    expect(parseSRT('   \n\n   ')).toEqual([])
  })

  it('throws on a malformed timestamp line', () => {
    expect(() => parseSRT('1\n00:00:bad --> 00:00:00,000\nBody')).toThrow(/SRT parse error/)
  })

  it('skips blocks with no body text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nKeep'
    const cues = parseSRT(srt)
    expect(cues.length).toBe(1)
    expect(cues[0].text).toBe('Keep')
  })
})
