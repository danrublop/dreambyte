import crypto from 'crypto'

/** Maximum text length for TTS requests (roughly ~15 minutes of speech) */
export const MAX_TTS_TEXT_LENGTH = 10_000

/** Maximum query length for SFX/music search */
export const MAX_SEARCH_QUERY_LENGTH = 500

/**
 * Validate and cap TTS text input length.
 * Throws if text exceeds the limit.
 */
export function validateTextLength(text: string): void {
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    throw new Error(`Text too long: ${text.length} characters (max ${MAX_TTS_TEXT_LENGTH})`)
  }
}

/**
 * Validate search query length.
 */
export function validateQueryLength(query: string): void {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Query too long: ${query.length} characters (max ${MAX_SEARCH_QUERY_LENGTH})`)
  }
}

/**
 * Sanitize a sceneId for safe use in filenames.
 * Strips path traversal characters and anything not alphanumeric/hyphen.
 */
export function sanitizeSceneId(sceneId: string): string {
  return sceneId.replace(/[^a-zA-Z0-9\-]/g, '')
}

/**
 * Generate a safe, unique audio filename.
 * Includes random suffix to prevent collisions from concurrent requests.
 */
export function safeAudioFilename(prefix: string, sceneId: string, ext: string = 'mp3'): string {
  const safe = sanitizeSceneId(sceneId)
  const rand = crypto.randomBytes(4).toString('hex')
  return `${prefix}-${safe}-${Date.now()}-${rand}.${ext}`
}

/**
 * Sanitize provider error messages before returning to clients.
 * Strips potential API key fragments and internal details.
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Audio operation failed'

  const msg = err.message

  // Strip anything that looks like an API key (long alphanumeric strings)
  let sanitized = msg.replace(/[a-zA-Z0-9_\-]{20,}/g, '[REDACTED]')

  // Strip URLs that may contain keys in query params
  sanitized = sanitized.replace(/https?:\/\/\S+/g, '[URL]')

  return sanitized
}
