import { describe, it, expect } from 'vitest'
import { parseSrt, parseSrtTimestamp } from './srt'

describe('parseSrtTimestamp', () => {
  it('parses HH:MM:SS,mmm to ms', () => {
    expect(parseSrtTimestamp('00:00:04,250')).toBe(4250)
    expect(parseSrtTimestamp('01:02:03,004')).toBe((3600 + 120 + 3) * 1000 + 4)
  })
  it('accepts a dot separator and short fractional', () => {
    expect(parseSrtTimestamp('00:00:01.5')).toBe(1500)
    expect(parseSrtTimestamp('00:00:00,1')).toBe(100)
  })
  it('returns NaN on a malformed stamp', () => {
    expect(Number.isNaN(parseSrtTimestamp('garbage'))).toBe(true)
    expect(Number.isNaN(parseSrtTimestamp('00:00'))).toBe(true)
  })
})

describe('parseSrt', () => {
  const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:04,500 --> 00:00:07,200
Second
line

3
00:00:08,000 --> 00:00:10,000
Third`

  it('parses cues into ordered timed segments, collapsing multi-line text', () => {
    const segs = parseSrt(SRT)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ index: 1, startMs: 1000, endMs: 4000, text: 'Hello world' })
    expect(segs[1].text).toBe('Second line') // newline within a cue collapsed to a space
    expect(segs[2].text).toBe('Third')
  })

  it('handles CRLF and a missing trailing newline', () => {
    const crlf = '1\r\n00:00:00,000 --> 00:00:02,000\r\nHi'
    expect(parseSrt(crlf)).toEqual([{ index: 1, startMs: 0, endMs: 2000, text: 'Hi' }])
  })

  it('drops cues with end <= start, empty text, or an unparseable timing line', () => {
    const bad = `1
00:00:05,000 --> 00:00:05,000
zero window

2
00:00:06,000 --> 00:00:07,000


3
not a timing line
orphan text

4
00:00:08,000 --> 00:00:09,000
keep me`
    const segs = parseSrt(bad)
    expect(segs.map((s) => s.text)).toEqual(['keep me'])
  })

  it('sorts out-of-order cues by start time', () => {
    const ooo = `1
00:00:09,000 --> 00:00:10,000
late

2
00:00:01,000 --> 00:00:02,000
early`
    expect(parseSrt(ooo).map((s) => s.text)).toEqual(['early', 'late'])
  })

  it('returns [] for empty/blank input', () => {
    expect(parseSrt('')).toEqual([])
    expect(parseSrt('   \n  ')).toEqual([])
  })
})
