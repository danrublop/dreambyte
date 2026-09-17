// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { arrayBufferToBase64 } from './base64'

describe('arrayBufferToBase64', () => {
  it('encodes an empty buffer to an empty string', () => {
    expect(arrayBufferToBase64(new Uint8Array(0).buffer)).toBe('')
  })

  it('matches Buffer base64 for a small buffer', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    expect(arrayBufferToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('round-trips byte-for-byte ACROSS the 0x8000 chunk boundary (the reason it is chunked)', () => {
    // Cross two chunk boundaries + a non-aligned tail so a chunk-edge bug would show.
    const bytes = new Uint8Array(0x8000 * 2 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const b64 = arrayBufferToBase64(bytes.buffer)
    // Equality with Node's decoder proves no bytes were dropped/duplicated at the seams.
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes))
    expect(b64).toBe(Buffer.from(bytes).toString('base64'))
  })
})
