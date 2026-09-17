export function mulberry32(seed: number): () => number {
  let s = seed | 0
  return function next() {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rng: () => number, values: T[]): T {
  if (values.length === 0) throw new Error('pick() requires non-empty values')
  const idx = Math.floor(rng() * values.length)
  return values[Math.min(values.length - 1, Math.max(0, idx))]
}

export function range(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng()
}
