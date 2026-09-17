/**
 * Media-source resolver seam.
 *
 * Intake engines live in `src/lib/` but reference media is addressed by `dreambyte://`
 * URIs that only the Electron layer can resolve to a disk path. Same single-slot
 * pattern as `caption-transcriber` / `frame-detector`: `src/lib/` declares the seam,
 * Electron sets the implementation at boot (`setMediaResolver`), tests inject a
 * fake. The default handles `file://` + absolute paths so MCP / test runs work
 * without Electron.
 */

import path from 'node:path'

export interface ResolvedMedia {
  bytes: Uint8Array
  localPath: string
  mimeType: string
}

export type MediaResolver = (uri: string, mimeHint?: string) => Promise<ResolvedMedia>

let active: MediaResolver | null = null

export function setMediaResolver(resolver: MediaResolver | null): void {
  active = resolver
}

// Optional containment roots for the no-resolver fallback (security review
// F28). In production the Electron resolver is set and confines reads to the
// project mount; the fallback below only runs headless/MCP, where it would
// otherwise read ANY absolute/file:// path (e.g. /etc/passwd) into a vision
// model. Headless entrypoints can call this to bound the fallback to their
// project root(s). Unset → current behavior (test/dev convenience).
let fallbackRoots: string[] | null = null

export function setMediaFallbackRoots(roots: string[] | null): void {
  fallbackRoots = roots && roots.length > 0 ? roots.map((r) => path.resolve(r)) : null
}

/** Best-effort mime guess from a filename extension. */
export function guessMimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.flac':
      return 'audio/flac'
    case '.ogg':
      return 'audio/ogg'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.pdf':
      return 'application/pdf'
    case '.txt':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Pre-filter for reference-media URIs: rejects `http(s)://` (ffmpeg/Gemini
 * SSRF) and `..` traversal before any engine touches the URI.
 *
 * NOTE: this is a pre-filter, NOT full containment. It deliberately allows any
 * absolute / `file://` path with no `..` (the desktop app legitimately
 * references the user's own files). Actual containment to a project mount is
 * the Electron-supplied resolver's job (set via setMediaResolver); the
 * no-resolver fallback in resolveMedia additionally honors
 * setMediaFallbackRoots. Do not treat this function as a path boundary on its
 * own.
 */
export function isSafeMediaUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length === 0) return false
  if (/^https?:\/\//i.test(uri)) return false // SSRF via ffmpeg -i / remote fetch
  // Decode once so encoded "%2e%2e" traversal can't slip past the check.
  let decoded = uri
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    return false
  }
  if (decoded.includes('..')) return false
  return true
}

/**
 * Resolve a media URI to bytes + a local path + mime. Uses the Electron-supplied
 * resolver when set; otherwise reads `file://` / absolute paths directly.
 */
export async function resolveMedia(uri: string, mimeHint?: string): Promise<ResolvedMedia> {
  if (!isSafeMediaUri(uri)) throw new Error(`media-source: refusing unsafe media URI (${uri})`)
  if (active) return active(uri, mimeHint)

  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    throw new Error(`media-source: no resolver set for remote URI (${uri})`)
  }
  if (uri.startsWith('dreambyte://')) {
    throw new Error(
      `media-source: dreambyte:// URI needs the Electron resolver — call setMediaResolver at boot (${uri})`,
    )
  }
  const localPath = uri.replace(/^file:\/\//, '')
  // When fallback roots are configured, confine the read to them — the lib
  // pre-filter (isSafeMediaUri) only blocks `..`, so without this a headless
  // run could read an arbitrary absolute path into a vision model.
  if (fallbackRoots) {
    const resolved = path.resolve(localPath)
    const contained = fallbackRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (!contained) {
      throw new Error(`media-source: path outside allowed roots (${uri})`)
    }
  }
  const { promises: fs } = await import('node:fs')
  const buf = await fs.readFile(localPath)
  return { bytes: new Uint8Array(buf), localPath, mimeType: mimeHint ?? guessMimeFromPath(localPath) }
}
