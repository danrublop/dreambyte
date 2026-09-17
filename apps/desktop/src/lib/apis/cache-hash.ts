import crypto from 'crypto'

/**
 * Canonical cache-key hashing for media generation.
 *
 * The old hash was `JSON.stringify(params, Object.keys(params).sort())`. That second arg is
 * a JSON.stringify REPLACER ARRAY, not a sort — it lists only TOP-LEVEL keys and, as a
 * property filter, applies at EVERY nesting depth. So any nested object (a camera spec, a
 * character bundle) had its fields dropped from the serialization: two requests differing
 * only in a deep field hashed identically → a false cache hit returned the WRONG asset.
 *
 * This serializes deterministically by recursively sorting object keys at all depths while
 * preserving array order, and hashes the full SHA-256 (no 64-bit truncation → no birthday
 * collisions across a long-lived cache). Changing the algorithm invalidates existing cache
 * entries — that's a one-time, harmless regenerate (orphaned files, no breakage).
 */
// Cache params are app-internal flat-ish objects, but guard depth so a malformed/circular
// params object can't recurse forever and take down generation before any provider call.
const MAX_CANONICAL_DEPTH = 12

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error('cache key params nested too deep (possible cycle)')
  }
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, depth + 1)) // order significant
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key], depth + 1)
    return out
  }
  return value // primitives (string, number, boolean, null)
}

/** Stable deep canonical JSON for a params object — key order independent, depth-correct. */
export function canonicalJson(params: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(params))
}

export function computeCacheHash(params: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(params)).digest('hex')
}
