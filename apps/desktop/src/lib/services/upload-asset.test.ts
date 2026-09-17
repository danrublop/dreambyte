// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { __testVerifyMagicBytes as verifyMagicBytes } from './upload-asset'

/**
 * H1 — Magic-byte verifier (v0.3.1 security gate).
 *
 * Defends against the rename-`evil.exe`-to-`evil.mp4` attack and reduces the
 * blast radius of any future ffprobe/ffmpeg parser CVE: malformed content is
 * rejected at the door before being handed to a decoder.
 *
 * These tests pin the byte-level contract so a future refactor can't silently
 * weaken validation. Every accepted format gets a positive test (real magic
 * bytes pass) and a negative test (wrong bytes for the same MIME fail).
 */

function bytes(...values: number[]): Buffer {
  return Buffer.from(values)
}

function withFiller(magic: number[], targetLen = 64): Buffer {
  // Pad up to targetLen with 0x00 so functions that read past the magic header
  // still see realistic input.
  const buf = Buffer.alloc(targetLen)
  magic.forEach((b, i) => {
    buf[i] = b
  })
  return buf
}

describe('verifyMagicBytes — accepted formats', () => {
  it('accepts a valid JPEG (FF D8 FF)', () => {
    expect(verifyMagicBytes('image/jpeg', withFiller([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
  })

  it('accepts a valid PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    expect(verifyMagicBytes('image/png', withFiller([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  })

  it('accepts GIF87a and GIF89a', () => {
    // "GIF87a"
    expect(verifyMagicBytes('image/gif', withFiller([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe(true)
    // "GIF89a"
    expect(verifyMagicBytes('image/gif', withFiller([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true)
  })

  it('accepts WebP (RIFF....WEBP)', () => {
    const buf = withFiller([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00, // (file size — not checked)
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
    ])
    expect(verifyMagicBytes('image/webp', buf)).toBe(true)
  })

  it('accepts SVG starting with <svg>', () => {
    const buf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8')
    expect(verifyMagicBytes('image/svg+xml', buf)).toBe(true)
  })

  it('accepts SVG with leading <?xml declaration', () => {
    const buf = Buffer.from('<?xml version="1.0"?><svg></svg>', 'utf-8')
    expect(verifyMagicBytes('image/svg+xml', buf)).toBe(true)
  })

  it('accepts SVG with leading whitespace + BOM', () => {
    const buf = Buffer.from('﻿  \n<svg></svg>', 'utf-8')
    expect(verifyMagicBytes('image/svg+xml', buf)).toBe(true)
  })

  it('accepts MP4 (....ftyp at offset 4)', () => {
    const buf = withFiller([
      0x00,
      0x00,
      0x00,
      0x20, // box size (any 4 bytes)
      0x66,
      0x74,
      0x79,
      0x70, // "ftyp"
      0x69,
      0x73,
      0x6f,
      0x6d, // brand "isom"
    ])
    expect(verifyMagicBytes('video/mp4', buf)).toBe(true)
  })

  it('accepts MOV (same ftyp container as MP4)', () => {
    const buf = withFiller([
      0x00,
      0x00,
      0x00,
      0x14,
      0x66,
      0x74,
      0x79,
      0x70,
      0x71,
      0x74,
      0x20,
      0x20, // brand "qt  "
    ])
    expect(verifyMagicBytes('video/quicktime', buf)).toBe(true)
  })

  it('accepts WebM (EBML 1A 45 DF A3)', () => {
    expect(verifyMagicBytes('video/webm', withFiller([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true)
  })

  it('accepts a PDF ("%PDF")', () => {
    expect(verifyMagicBytes('application/pdf', Buffer.concat([Buffer.from('%PDF-1.7', 'utf-8'), Buffer.alloc(64)]))).toBe(
      true,
    )
  })

  it('accepts text/markdown/csv/json permissively (no reliable magic bytes)', () => {
    const md = Buffer.from('# Heading\n', 'utf-8')
    expect(verifyMagicBytes('text/markdown', md)).toBe(true)
    expect(verifyMagicBytes('text/plain', md)).toBe(true)
    expect(verifyMagicBytes('text/csv', md)).toBe(true)
    expect(verifyMagicBytes('application/json', md)).toBe(true)
    // Even a zero buffer passes for text — content is never decoded, only stored.
    expect(verifyMagicBytes('text/plain', Buffer.alloc(64))).toBe(true)
  })

  it('rejects a PDF that does not start with "%PDF"', () => {
    expect(verifyMagicBytes('application/pdf', Buffer.alloc(64))).toBe(false)
  })
})

describe('verifyMagicBytes — rejected as MIME spoofing', () => {
  it('rejects an EXE renamed as MP4 (MZ header)', () => {
    // PE/COFF: starts with "MZ" (0x4D 0x5A)
    const buf = withFiller([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
    expect(verifyMagicBytes('video/mp4', buf)).toBe(false)
  })

  it('rejects a PDF renamed as PNG', () => {
    // PDF: "%PDF-"
    const buf = Buffer.concat([Buffer.from('%PDF-1.4', 'utf-8'), Buffer.alloc(64)])
    expect(verifyMagicBytes('image/png', buf)).toBe(false)
  })

  it('rejects a JPEG buffer when the declared MIME is PNG', () => {
    const jpegBuf = withFiller([0xff, 0xd8, 0xff, 0xe0])
    expect(verifyMagicBytes('image/png', jpegBuf)).toBe(false)
  })

  it('rejects a zero-filled buffer for every accepted format', () => {
    const zeros = Buffer.alloc(64)
    expect(verifyMagicBytes('image/jpeg', zeros)).toBe(false)
    expect(verifyMagicBytes('image/png', zeros)).toBe(false)
    expect(verifyMagicBytes('image/gif', zeros)).toBe(false)
    expect(verifyMagicBytes('image/webp', zeros)).toBe(false)
    expect(verifyMagicBytes('video/mp4', zeros)).toBe(false)
    expect(verifyMagicBytes('video/webm', zeros)).toBe(false)
  })

  it('rejects WebP with valid RIFF but wrong format ID', () => {
    // RIFF .... WAVE (audio container) declared as image/webp
    const buf = withFiller([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE", not "WEBP"
    ])
    expect(verifyMagicBytes('image/webp', buf)).toBe(false)
  })

  it('rejects MP4 with valid box size but no "ftyp" marker', () => {
    const buf = withFiller([
      0x00,
      0x00,
      0x00,
      0x20,
      0x6d,
      0x6f,
      0x6f,
      0x76, // "moov" — valid MP4 box but not the start
    ])
    expect(verifyMagicBytes('video/mp4', buf)).toBe(false)
  })

  it('rejects unsupported MIMEs (default fallthrough)', () => {
    expect(verifyMagicBytes('application/zip', withFiller([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
    expect(verifyMagicBytes('application/octet-stream', withFiller([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toBe(false)
    expect(verifyMagicBytes('', Buffer.alloc(64))).toBe(false)
  })
})

describe('verifyMagicBytes — edge cases', () => {
  it('handles short buffers (<8 bytes) without crashing', () => {
    // Short JPEG header — first 3 bytes match, rest is missing.
    const shortJpeg = bytes(0xff, 0xd8, 0xff)
    expect(verifyMagicBytes('image/jpeg', shortJpeg)).toBe(true)
  })

  it('handles empty buffer for SVG (text-based path)', () => {
    expect(verifyMagicBytes('image/svg+xml', Buffer.alloc(0))).toBe(false)
  })

  it('handles empty buffer for binary formats', () => {
    expect(verifyMagicBytes('image/png', Buffer.alloc(0))).toBe(false)
    expect(verifyMagicBytes('video/mp4', Buffer.alloc(0))).toBe(false)
  })

  it('SVG with leading garbage (not text-starting) is rejected', () => {
    // Binary-looking buffer that COULD decode as UTF-8 nonsense but doesn't
    // start with `<`.
    const buf = Buffer.from('not-svg-content<svg>', 'utf-8')
    expect(verifyMagicBytes('image/svg+xml', buf)).toBe(false)
  })
})

describe('verifyMagicBytes — audio formats (library audio support)', () => {
  it('mp3: ID3 tag and bare frame sync both pass', () => {
    expect(verifyMagicBytes('audio/mpeg', Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]))).toBe(true)
    expect(verifyMagicBytes('audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).toBe(true)
    expect(verifyMagicBytes('audio/mpeg', Buffer.from([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0]))).toBe(false)
  })

  it('wav: RIFF....WAVE', () => {
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(verifyMagicBytes('audio/wav', wav)).toBe(true)
    // RIFF but WEBP payload must not pass as wav
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect(verifyMagicBytes('audio/wav', webp)).toBe(false)
  })

  it('m4a (ISO BMFF), ogg, flac', () => {
    const m4a = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])
    expect(verifyMagicBytes('audio/mp4', m4a)).toBe(true)
    expect(verifyMagicBytes('audio/ogg', Buffer.from('OggS\0\0\0\0'))).toBe(true)
    expect(verifyMagicBytes('audio/flac', Buffer.from('fLaC\0\0\0\0'))).toBe(true)
    expect(verifyMagicBytes('audio/flac', Buffer.from('OggS\0\0\0\0'))).toBe(false)
  })

  it('exe bytes renamed to mp3 are rejected', () => {
    expect(verifyMagicBytes('audio/mpeg', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0]))).toBe(false)
  })
})
