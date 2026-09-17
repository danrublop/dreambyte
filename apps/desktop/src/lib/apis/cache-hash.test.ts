import { describe, it, expect } from 'vitest'
import { computeCacheHash, canonicalJson } from './cache-hash'

describe('computeCacheHash', () => {
  it('is independent of top-level key order', () => {
    const a = computeCacheHash({ prompt: 'x', model: 'flux', aspectRatio: '1:1' })
    const b = computeCacheHash({ aspectRatio: '1:1', model: 'flux', prompt: 'x' })
    expect(a).toBe(b)
  })

  // The core T5 fix: nested fields must affect the hash. The old top-level-only replacer
  // dropped them, so these two collided → false cache hit returning the wrong asset.
  it('distinguishes requests that differ only in a NESTED field', () => {
    const base = { prompt: 'x', model: 'flux' }
    const a = computeCacheHash({ ...base, camera: { type: 'dolly-in', intensity: 0.3 } })
    const b = computeCacheHash({ ...base, camera: { type: 'dolly-in', intensity: 0.9 } })
    expect(a).not.toBe(b)
  })

  it('is independent of nested key order', () => {
    const a = computeCacheHash({ camera: { type: 'orbit', intensity: 0.5 } })
    const b = computeCacheHash({ camera: { intensity: 0.5, type: 'orbit' } })
    expect(a).toBe(b)
  })

  it('treats array order as significant (refAssetIds)', () => {
    const a = computeCacheHash({ refAssetIds: ['a', 'b'] })
    const b = computeCacheHash({ refAssetIds: ['b', 'a'] })
    expect(a).not.toBe(b)
  })

  it('distinguishes i2i strength (the cache-correctness regression case)', () => {
    const base = { prompt: 'x', model: 'flux-1.1-pro', referenceImageUrl: '/uploads/a.png' }
    expect(computeCacheHash({ ...base, strength: 0.3 })).not.toBe(computeCacheHash({ ...base, strength: 0.9 }))
  })

  it('uses the full sha256 (no 64-bit truncation)', () => {
    expect(computeCacheHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('canonicalJson sorts deeply and preserves arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}')
  })

  it('throws on a circular params object instead of recursing forever', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => computeCacheHash(a)).toThrow(/too deep|cycle/)
  })
})
