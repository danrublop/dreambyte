// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { decodeClipDataUri, CLIP_DATAURI_MAX_CHARS } from './clip-datauri'

// Minimal valid ISO-BMFF (mp4) header: 4-byte box size, then "ftyp" at offset 4,
// then a brand + a little payload so it clears the 12-byte minimum.
const MP4_HEADER = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00]
// WebM/Matroska EBML magic.
const WEBM_HEADER = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
const dataUri = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

describe('decodeClipDataUri', () => {
  it('decodes a valid mp4 data URI to bytes + mime', () => {
    const r = decodeClipDataUri(dataUri('video/mp4', MP4_HEADER))
    expect(Array.from(r.bytes)).toEqual(MP4_HEADER)
    expect(r.mimeType).toBe('video/mp4')
  })

  it('accepts a webm container', () => {
    expect(decodeClipDataUri(dataUri('video/webm', WEBM_HEADER)).mimeType).toBe('video/webm')
  })

  it('throws on a missing / malformed dataUri', () => {
    expect(() => decodeClipDataUri(undefined)).toThrow(/invalid clip dataUri/i)
    expect(() => decodeClipDataUri('not-a-data-uri')).toThrow(/invalid clip dataUri/i)
  })

  it('throws when the payload decodes to zero bytes', () => {
    expect(() => decodeClipDataUri('data:video/mp4;base64,')).toThrow(/invalid clip dataUri/i)
  })

  it('rejects non-video bytes even when the mime claims video (magic-byte sniff)', () => {
    expect(() => decodeClipDataUri(dataUri('video/mp4', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(
      /not a recognized video container/i,
    )
  })

  it('rejects an oversize dataUri BEFORE decoding (memory-amplification guard)', () => {
    const huge = 'data:video/mp4;base64,' + 'A'.repeat(CLIP_DATAURI_MAX_CHARS + 1)
    expect(() => decodeClipDataUri(huge)).toThrow(/exceeds the inline size limit/i)
  })

  it('clamps a non-allowlisted mime to video/mp4 (no renderer-supplied mime trust)', () => {
    // Valid mp4 bytes, but the declared mime is bogus — mime is clamped, bytes still pass the sniff.
    const r = decodeClipDataUri(dataUri('text/html', MP4_HEADER))
    expect(r.mimeType).toBe('video/mp4')
  })

  it('keeps an allowlisted non-mp4 mime', () => {
    const r = decodeClipDataUri(dataUri('video/webm', WEBM_HEADER))
    expect(r.mimeType).toBe('video/webm')
  })
})
