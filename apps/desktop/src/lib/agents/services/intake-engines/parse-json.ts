/**
 * Shared fenced-JSON parser for intake engines.
 *
 * Every vision/audio engine asks the model for a JSON object and gets back
 * possibly-fenced, possibly-prose-wrapped text. This was duplicated in
 * image-engine, audio-engine, and frames-vision; centralize it here.
 */

/** Strip ``` fences, then parse the first {...} object. Returns null on failure. */
export function parseFencedJson<T = unknown>(raw: string): T | null {
  if (!raw) return null
  const fenced = raw.replace(/```(?:json)?/gi, '').trim()
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
