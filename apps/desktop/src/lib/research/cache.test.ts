import { describe, it, expect } from 'vitest'
import { TTLCache, withCache, normalizeKey } from './cache'

describe('normalizeKey', () => {
  it('lowercases, trims, drops trailing slashes', () => {
    expect(normalizeKey('  HTTPS://A.com/Path/  ')).toBe('https://a.com/path')
    expect(normalizeKey('x')).toBe('x')
  })
})

describe('TTLCache', () => {
  it('returns a cached value within the TTL', () => {
    let now = 0
    const c = new TTLCache<number>(100, 10, () => now)
    c.set('k', 42)
    now = 99
    expect(c.get('k')).toBe(42)
  })

  it('expires at/after the TTL', () => {
    let now = 0
    const c = new TTLCache<number>(100, 10, () => now)
    c.set('k', 42)
    now = 100
    expect(c.get('k')).toBeUndefined()
  })

  it('evicts the oldest when over capacity', () => {
    const c = new TTLCache<number>(1000, 2, () => 0)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3) // evicts 'a'
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })
})

describe('withCache', () => {
  it('runs fn once, then serves from cache', async () => {
    const c = new TTLCache<number>(1000, 10, () => 0)
    let calls = 0
    const fn = async () => {
      calls++
      return 7
    }
    expect(await withCache(c, 'k', fn)).toBe(7)
    expect(await withCache(c, 'k', fn)).toBe(7)
    expect(calls).toBe(1)
  })

  it('does not cache a throwing fn', async () => {
    const c = new TTLCache<number>(1000, 10, () => 0)
    await expect(withCache(c, 'k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    let calls = 0
    expect(await withCache(c, 'k', async () => { calls++; return 5 })).toBe(5)
    expect(calls).toBe(1)
  })
})
