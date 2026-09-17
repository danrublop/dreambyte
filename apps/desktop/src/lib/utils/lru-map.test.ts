import { describe, it, expect } from 'vitest'
import { LruMap } from './lru-map'

describe('LruMap', () => {
  it('evicts the least-recently used entry when over capacity', () => {
    const m = new LruMap<string, number>(3)
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    m.set('d', 4) // evicts 'a' (oldest)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
    expect(m.has('d')).toBe(true)
  })

  it('touches an entry on get so it stops being the LRU', () => {
    const m = new LruMap<string, number>(3)
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    m.get('a') // 'a' is now most-recently-used
    m.set('d', 4) // evicts 'b', not 'a'
    expect(m.has('a')).toBe(true)
    expect(m.has('b')).toBe(false)
  })

  it('updating an existing key bumps its recency without growing the map', () => {
    const m = new LruMap<string, number>(2)
    m.set('a', 1)
    m.set('b', 2)
    m.set('a', 11) // touches 'a' and stays at size=2
    m.set('c', 3) // evicts 'b', not 'a'
    expect(m.size).toBe(2)
    expect(m.get('a')).toBe(11)
    expect(m.has('b')).toBe(false)
    expect(m.has('c')).toBe(true)
  })

  it('delete removes an entry', () => {
    const m = new LruMap<string, number>(3)
    m.set('a', 1)
    expect(m.delete('a')).toBe(true)
    expect(m.has('a')).toBe(false)
    expect(m.delete('a')).toBe(false)
  })

  it('rejects non-positive capacity', () => {
    expect(() => new LruMap(0)).toThrow()
    expect(() => new LruMap(-1)).toThrow()
  })
})
