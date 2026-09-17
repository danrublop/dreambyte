/**
 * Shared URL guard against trivial SSRF vectors.
 *
 * Blocks obvious bad cases at URL-parse time:
 *   - non-http(s) schemes (`file://`, `data:`, `javascript:`, …)
 *   - loopback hosts (`localhost`, `127.0.0.1`, `::1`)
 *   - RFC1918 private ranges (`10.*`, `192.168.*`, `172.16-31.*`)
 *   - link-local / cloud metadata (`169.254.*`)
 *   - `.local` mDNS, `0.0.0.0`
 *   - IPv6 ULA (`fc00::/7`) + link-local (`fe80::/10`)
 *
 * Does NOT protect against DNS rebinding (a `public.attacker.com` that
 * resolves to `169.254.169.254` between the HEAD and GET calls). That
 * needs IP pinning at fetch time and is out of scope for this guard.
 *
 * Callers convert `UrlGuardError` to whatever their validation-error
 * subclass is (e.g. `IngestValidationError`).
 */

export class UrlGuardError extends Error {
  readonly code = 'URL_GUARD' as const
  constructor(message: string) {
    super(message)
    this.name = 'UrlGuardError'
  }
}

/**
 * Parse an IPv4 literal in any `inet_aton`-accepted form to its 32-bit value,
 * or null if `host` isn't an IPv4 literal. Handles dotted decimal/hex/octal
 * AND the 1-, 2-, 3-part shorthand where the final field absorbs the remaining
 * bytes — i.e. the encodings (`2130706433`, `0x7f000001`, `0177.0.0.1`) that a
 * dotted-decimal-only check misses, letting an attacker reach 127.0.0.1 /
 * 169.254.169.254.
 */
export function looseIpv4ToLong(host: string): number | null {
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    let n: number
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16)
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8)
    else if (/^(0|[1-9]\d*)$/.test(p)) n = parseInt(p, 10)
    else return null
    if (!Number.isInteger(n) || n < 0) return null
    nums.push(n)
  }
  const k = nums.length
  for (let i = 0; i < k - 1; i++) if (nums[i] > 255) return null
  if (nums[k - 1] > Math.pow(256, 4 - (k - 1)) - 1) return null
  let value = nums[k - 1]
  for (let i = 0; i < k - 1; i++) value += nums[i] * Math.pow(256, 3 - i)
  return value >>> 0
}

export function isInternalIpv4(value: number): boolean {
  const inCidr = (base: number, bits: number) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
  }
  const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  return (
    inCidr(ip(0, 0, 0, 0), 8) || // 0.0.0.0/8
    inCidr(ip(10, 0, 0, 0), 8) || // RFC1918
    inCidr(ip(100, 64, 0, 0), 10) || // CGNAT
    inCidr(ip(127, 0, 0, 0), 8) || // loopback
    inCidr(ip(169, 254, 0, 0), 16) || // link-local + cloud metadata
    inCidr(ip(172, 16, 0, 0), 12) || // RFC1918
    inCidr(ip(192, 168, 0, 0), 16) // RFC1918
  )
}

function isLoopbackOrPrivateV4(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.endsWith('.local')) return true
  if (hostname.endsWith('.internal')) return true
  if (hostname === '::1') return true
  // Any IPv4 literal — dotted-decimal OR numeric (decimal/hex/octal) — is
  // normalized to its 32-bit value and CIDR-checked, so alternate encodings
  // can't slip past prefix matching.
  const long = looseIpv4ToLong(hostname)
  if (long !== null) return isInternalIpv4(long)
  return false
}

function isPrivateV6(hostname: string): boolean {
  // Node keeps brackets on `url.hostname` for IPv6 literals — strip so the
  // regexes can anchor on the address bytes themselves.
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (bare === '::' || bare === '::1') return true
  // ULA: fc00::/7 → first byte 0xfc or 0xfd
  if (/^(fc|fd)[0-9a-f]{0,2}:/.test(bare)) return true
  // Link-local: fe80::/10 → fe80..febf (first hextet only — second nibble 8..b)
  if (/^fe[89ab][0-9a-f]?:/.test(bare)) return true
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or the normalized `::ffff:xxxx:xxxx`).
  // These shouldn't appear in any legitimate public URL — they're an
  // internal representation format. Reject the whole class rather than
  // decoding the last 32 bits and re-running the private-v4 check.
  if (/^::ffff:/.test(bare)) return true
  return false
}

export interface AssertPublicHttpUrlOptions {
  /** Default: `['http:', 'https:']`. Pass `['https:']` to force TLS. */
  allowedSchemes?: string[]
}

/**
 * Validates `urlString` and returns the parsed `URL`. Throws
 * `UrlGuardError` on disallowed schemes or non-public hosts.
 */
export function assertPublicHttpUrl(urlString: string, opts: AssertPublicHttpUrlOptions = {}): URL {
  const allowedSchemes = opts.allowedSchemes ?? ['http:', 'https:']

  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new UrlGuardError('Invalid URL')
  }

  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new UrlGuardError(`Disallowed URL scheme: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!hostname) {
    throw new UrlGuardError('URL has no hostname')
  }

  if (isLoopbackOrPrivateV4(hostname) || isPrivateV6(hostname)) {
    throw new UrlGuardError(`Internal address not allowed: ${hostname}`)
  }

  return parsed
}
