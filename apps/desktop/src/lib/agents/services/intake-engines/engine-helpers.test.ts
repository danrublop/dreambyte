// @vitest-environment node
/** Unit tests for pure intake-engine helpers (no provider/Ollama calls). */

import { describe, it, expect } from 'vitest'
import { parseImageJson } from './image-engine'
import { srtToTranscript } from './audio-engine'
import { guessMimeFromPath, isSafeMediaUri } from './media-source'

describe('parseImageJson', () => {
  it('parses a fenced JSON block', () => {
    const out = parseImageJson('```json\n{"caption":"a cat","palette":["#fff"]}\n```')
    expect(out?.caption).toBe('a cat')
    expect(out?.palette).toEqual(['#fff'])
  })
  it('parses JSON embedded in prose', () => {
    const out = parseImageJson('Here you go: {"caption":"dog"} hope that helps')
    expect(out?.caption).toBe('dog')
  })
  it('returns null on garbage', () => {
    expect(parseImageJson('not json at all')).toBeNull()
  })
})

describe('srtToTranscript', () => {
  it('strips indices/timestamps and extracts cue events', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:02,500',
      'Hello there.',
      '',
      '2',
      '00:00:02,500 --> 00:00:05,000',
      'Welcome to the show.',
      '',
    ].join('\n')
    const { transcript, events } = srtToTranscript(srt)
    expect(transcript).toBe('Hello there. Welcome to the show.')
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ start: 0, end: 2.5, description: 'Hello there.' })
    expect(events[1].start).toBe(2.5)
  })
  it('handles empty input', () => {
    expect(srtToTranscript('').transcript).toBe('')
  })
})

describe('isSafeMediaUri', () => {
  it('allows clean dreambyte:// and file:// / absolute paths', () => {
    expect(isSafeMediaUri('dreambyte://uploads/projects/abc/x.png')).toBe(true)
    expect(isSafeMediaUri('file:///Users/me/Downloads/clip.mp4')).toBe(true)
    expect(isSafeMediaUri('/tmp/x.pdf')).toBe(true)
  })
  it('rejects parent-dir traversal (incl. encoded)', () => {
    expect(isSafeMediaUri('dreambyte://uploads/../../../../etc/passwd')).toBe(false)
    expect(isSafeMediaUri('file:///app/%2e%2e/%2e%2e/etc/passwd')).toBe(false)
  })
  it('rejects http(s) (SSRF via ffmpeg/remote fetch)', () => {
    expect(isSafeMediaUri('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isSafeMediaUri('https://evil.example/x.mp4')).toBe(false)
  })
  it('rejects empty/non-string', () => {
    expect(isSafeMediaUri('')).toBe(false)
    expect(isSafeMediaUri(undefined as unknown as string)).toBe(false)
  })
})

describe('guessMimeFromPath', () => {
  it('maps common extensions', () => {
    expect(guessMimeFromPath('/x/a.png')).toBe('image/png')
    expect(guessMimeFromPath('/x/a.mp3')).toBe('audio/mpeg')
    expect(guessMimeFromPath('/x/a.pdf')).toBe('application/pdf')
    expect(guessMimeFromPath('/x/a.unknown')).toBe('application/octet-stream')
  })
})
