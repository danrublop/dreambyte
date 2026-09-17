/**
 * In-memory TTL + LRU cache for research reads. The desktop app stays open across
 * runs, so this survives across runs in a session and trims the spend that repeats
 * EVERY run: a multi-hop loop re-issuing overlapping queries, and edit-and-re-run
 * cycles re-paying Tavily credits + model tokens for identical fetches (outside-voice
 * #8). Restart-surviving (DB-backed) caching is the noted upgrade path, not built here.
 *
 * `nowFn` is injectable so tests control expiry without real time.
 */

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TTLCache<V> {
  private map = new Map<string, Entry<V>>()
  constructor(
    private ttlMs: number,
    private max = 200,
    private nowFn: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (this.nowFn() >= e.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    // LRU touch: re-insert so it becomes most-recent.
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V): void {
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, expiresAt: this.nowFn() + this.ttlMs })
  }

  clear(): void {
    this.map.clear()
  }
}

/** Stable cache key fragment: lowercase, trim, drop trailing slashes. */
export function normalizeKey(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\/+$/, '')
}

/** Return the cached value or run `fn`, cache it, and return it. A throwing `fn`
 *  propagates and caches nothing. Pass `shouldCache` to skip caching a value (e.g. a
 *  transient empty search result that would otherwise starve fallbacks for the full TTL). */
export async function withCache<V>(
  cache: TTLCache<V>,
  key: string,
  fn: () => Promise<V>,
  shouldCache?: (v: V) => boolean,
): Promise<V> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = await fn()
  if (!shouldCache || shouldCache(value)) cache.set(key, value)
  return value
}

/** Don't negatively-cache an empty `{results:[]}` (soft-fail); anything else caches. */
export function hasResults(v: { results?: unknown[] } | unknown): boolean {
  const r = (v as { results?: unknown[] })?.results
  return !Array.isArray(r) || r.length > 0
}
