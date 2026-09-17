/**
 * Decode + validate a scene-clip data URI at the IPC trust boundary.
 *
 * The renderer posts the exported MP4 back as a base64 `data:` URI. This decodes
 * it to bytes, enforcing the size + mime limits HERE (the renderer's caps are
 * advisory — a compromised/replayed renderer message must not amplify into
 * main-process memory or spoof the mime that flows into Gemini's inlineData).
 *
 * Pure (no Electron deps) so it's unit-testable; the IPC handler wraps any throw
 * in an IpcValidationError.
 */

/** ~Gemini inline request ceiling; anything larger is invalid regardless of intent. */
export const CLIP_DATAURI_MAX_CHARS = 20 * 1024 * 1024
const ALLOWED_CLIP_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime'])

export interface DecodedClip {
  bytes: Uint8Array
  mimeType: string
}

/**
 * Decode a `data:<mime>;base64,<payload>` clip URI to bytes + an allowlisted mime.
 * Throws on: oversize, missing/malformed URI, or a payload that decodes to zero
 * bytes (Buffer.from silently truncates invalid base64, so zero length is the
 * real signal the payload was corrupt). Mime is clamped to the allowlist —
 * anything else falls back to `video/mp4` rather than trusting the prefix.
 */
export function decodeClipDataUri(dataUri: string | undefined): DecodedClip {
  if ((dataUri?.length ?? 0) > CLIP_DATAURI_MAX_CHARS) {
    throw new Error('Clip dataUri exceeds the inline size limit')
  }
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri ?? '')
  if (!m) {
    throw new Error('Missing or invalid clip dataUri')
  }
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'))
  if (bytes.length === 0) {
    throw new Error('Clip dataUri decoded to zero bytes')
  }
  // Sniff the container magic bytes — don't trust the declared mime alone. A
  // mismatch means the renderer posted non-video bytes (bug or tampering); reject
  // before it reaches the video model.
  if (!looksLikeVideoContainer(bytes)) {
    throw new Error('Clip bytes are not a recognized video container (mp4/mov/webm)')
  }
  const mimeType = ALLOWED_CLIP_MIME.has(m[1]) ? m[1] : 'video/mp4'
  return { bytes, mimeType }
}

/** True if the bytes start with an ISO-BMFF (mp4/mov: `ftyp` box at offset 4) or
 *  Matroska/WebM (EBML header `1A 45 DF A3`) signature. Cheap header sniff, not a
 *  full parse — enough to reject non-video payloads at the trust boundary. */
function looksLikeVideoContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  // WebM/Matroska: EBML magic at offset 0.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true
  // ISO-BMFF (mp4/mov): a box-type at offset 4 of ftyp/moov/mdat/free/skip/wide.
  const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  return ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(boxType)
}
