/**
 * Tiny LRU map. Backed by a native Map (which preserves insertion order) —
 * `get()` re-inserts to mark a hit as most-recently used, and `set()` evicts
 * the oldest entry when over capacity.
 *
 * Use for caching things that are unbounded over the life of the app
 * (waveform peaks, video thumbnails) so long editing sessions don't grow
 * memory without bound.
 */
export class LruMap<K, V> {
  private m = new Map<K, V>()
  constructor(private readonly max: number) {
    if (max <= 0) throw new RangeError(`LruMap max must be positive (got ${max})`)
  }

  get(key: K): V | undefined {
    const v = this.m.get(key)
    if (v === undefined) return undefined
    // Touch: delete + re-set bumps the key to the end of insertion order.
    this.m.delete(key)
    this.m.set(key, v)
    return v
  }

  has(key: K): boolean {
    return this.m.has(key)
  }

  set(key: K, value: V): void {
    if (this.m.has(key)) this.m.delete(key)
    this.m.set(key, value)
    if (this.m.size > this.max) {
      // Evict oldest (first inserted).
      const oldest = this.m.keys().next().value as K | undefined
      if (oldest !== undefined) this.m.delete(oldest)
    }
  }

  delete(key: K): boolean {
    return this.m.delete(key)
  }

  get size(): number {
    return this.m.size
  }

  clear(): void {
    this.m.clear()
  }
}
