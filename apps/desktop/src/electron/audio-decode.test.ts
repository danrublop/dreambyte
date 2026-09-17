// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

// Stub `electron` so importing the real `./paths` doesn't blow up in node.
vi.mock('electron', () => ({
  app: {
    getPath: (_kind: string) => '/tmp/dreambyte-test-userdata',
    isPackaged: false,
  },
}))

import { resolveSourceForFfmpeg } from './audio-decode'

describe('resolveSourceForFfmpeg', () => {
  it('passes through file:// URIs', () => {
    expect(resolveSourceForFfmpeg('file:///tmp/x.wav')).toBe('file:///tmp/x.wav')
  })

  it('passes through http(s) URLs', () => {
    expect(resolveSourceForFfmpeg('https://example.com/x.mp3')).toBe('https://example.com/x.mp3')
    expect(resolveSourceForFfmpeg('http://example.com/x.mp3')).toBe('http://example.com/x.mp3')
  })

  it('passes through absolute paths', () => {
    expect(resolveSourceForFfmpeg('/Users/x/y.wav')).toBe('/Users/x/y.wav')
  })

  it('resolves dreambyte://uploads/... to the user-data uploads dir', () => {
    expect(resolveSourceForFfmpeg('dreambyte://uploads/clip-1.wav')).toBe('/tmp/dreambyte-test-userdata/uploads/clip-1.wav')
  })

  it('resolves dreambyte://audio/... to the user-data audio dir', () => {
    expect(resolveSourceForFfmpeg('dreambyte://audio/tts.mp3')).toBe('/tmp/dreambyte-test-userdata/audio/tts.mp3')
  })

  it('rejects unsupported dreambyte:// hosts', () => {
    expect(() => resolveSourceForFfmpeg('dreambyte://scenes/0.html')).toThrow(/Unsupported dreambyte:\/\/ host/)
  })

  it('rejects relative paths', () => {
    expect(() => resolveSourceForFfmpeg('relative/x.wav')).toThrow(/relative path/)
  })

  // Security review F16: decodeURIComponent turns %2e%2e%2f into ../, which
  // without a containment check escapes the uploads/audio mount and the bytes
  // get read + POSTed to the transcription endpoint (arbitrary file read).
  it('rejects path traversal that escapes the uploads dir', () => {
    expect(() =>
      resolveSourceForFfmpeg('dreambyte://uploads/..%2f..%2f..%2f..%2fetc%2fpasswd'),
    ).toThrow(/escapes uploads/)
  })

  it('rejects path traversal that escapes the audio dir', () => {
    expect(() => resolveSourceForFfmpeg('dreambyte://audio/..%2f..%2fsecrets.txt')).toThrow(/escapes audio/)
  })

  it('neutralizes literal ../ (URL normalizes it back inside the base before decode)', () => {
    // The URL parser collapses literal `../` in the pathname, so this never
    // escapes — it resolves to a path inside uploads. The dangerous form is
    // percent-encoded (%2f), which survives URL parsing; see the cases above.
    expect(resolveSourceForFfmpeg('dreambyte://uploads/../../etc/passwd')).toBe(
      '/tmp/dreambyte-test-userdata/uploads/etc/passwd',
    )
  })

  it('still allows legitimate nested subdirectories', () => {
    expect(resolveSourceForFfmpeg('dreambyte://uploads/2026/clip-1.wav')).toBe(
      '/tmp/dreambyte-test-userdata/uploads/2026/clip-1.wav',
    )
  })
})

