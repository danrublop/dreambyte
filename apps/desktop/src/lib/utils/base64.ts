/**
 * Browser-safe binary → base64.
 *
 * Extracted from the agent clip round-trip so the chunk-boundary correctness can
 * be unit-tested (a multi-MB clip is exactly where naive encoding breaks).
 */

/**
 * Encode binary bytes as base64. Chunked at 32KB so a multi-MB buffer doesn't
 * blow the argument limit of `String.fromCharCode(...spread)`. Round-trips
 * byte-for-byte with `Buffer.from(result, 'base64')` / `atob` regardless of size.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
