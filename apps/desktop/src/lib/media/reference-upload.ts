/**
 * Reference-image upload for true image-to-image.
 *
 * The problem (flagged by the Codex outside-voice pass): our assets are stored as local
 * app paths — `publicUrl` is `/uploads/projects/:id/:file`, `storagePath` is an absolute
 * path on the user's machine. External providers (fal, OpenAI) cannot fetch either. True
 * i2i therefore needs the reference turned into an internet-fetchable URL FIRST.
 *
 * This module resolves any reference form to a fetchable URL:
 *   - already http(s)            → passed through unchanged (no upload)
 *   - absolute disk path         → read + uploaded to fal storage
 *   - relative /uploads app path → resolved under public/ then uploaded
 *
 * Uploads are deduped by content hash for the process lifetime, so re-running i2i against
 * the same reference (the common case — multiple variations of one image) uploads once.
 *
 * Dependencies (fs read, fal upload, fal configure) are injected so the resolver is unit-
 * testable without disk or network — the contract-test strategy from the plan.
 */

import path from 'node:path'
import { promises as fs, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getUploadsDir } from '@/lib/uploads/paths'
import { getAudioDir } from '@/lib/audio/paths'
import { getGeneratedDir } from '@/lib/media-paths'

export interface ReferenceUploadDeps {
  readFile: (absPath: string) => Promise<Buffer>
  /** Upload bytes to a fetchable URL (fal storage in prod). */
  upload: (bytes: Buffer, contentType: string) => Promise<string>
  /** Resolve a relative/absolute app reference to an absolute disk path. */
  toDiskPath: (ref: string) => string
  /** Byte size of a disk file WITHOUT reading it into memory (fs.stat). Optional so existing test
   *  deps keep working; when present, the local-file path rejects an over-cap clip BEFORE buffering
   *  it (a 200MB video cap must gate the read, not follow it — else a huge file OOMs first). */
  statSize?: (absPath: string) => Promise<number>
}

const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s)

// SSRF guard: an http reference is handed to fal, which fetches it server-side. Block hosts
// that could reach internal infra / cloud metadata. Only callers passing trusted asset URLs
// should use http refs at all; this is defense-in-depth for the exported primitive.
function assertSafeHttpUrl(ref: string): void {
  let u: URL
  try {
    u = new URL(ref)
  } catch {
    throw new Error(`i2i reference is not a valid URL: ${ref}`)
  }
  const host = u.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || // link-local / cloud metadata (169.254.169.254)
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (blocked) throw new Error(`i2i reference host is not allowed (SSRF guard): ${host}`)
}

// Local refs must resolve INSIDE an allowed root — never read an arbitrary absolute path off
// the host (that would let a reference exfiltrate /etc/passwd, ~/.dreambyte/studio.db, .env to
// fal). Allowed roots: public/ (web dev) AND the runtime uploads dir (packaged Electron stores
// generated/uploaded assets at <userData>/uploads, served via dreambyte://uploads/ — outside
// public/, so it must be explicitly permitted or every i2i off a generated asset 404s).
function assertWithinPublic(diskPath: string): void {
  const resolved = path.resolve(diskPath)
  // audio dir is allowed too: lipsync uploads TTS-generated audio files to fal (they live in the
  // runtime audio dir, outside public/, in packaged Electron).
  const roots = [path.resolve(process.cwd(), 'public'), path.resolve(getUploadsDir()), path.resolve(getAudioDir())]
  const contained = (p: string, rootList: string[]) =>
    rootList.some((root) => p === root || p.startsWith(root + path.sep))
  if (!contained(resolved, roots)) {
    throw new Error(`reference escapes allowed roots (public/, uploads, audio): ${resolved}`)
  }
  // Symlink hardening: path.resolve is lexical and does NOT follow symlinks, so a symlink planted
  // inside an allowed root could point outside it and still pass the prefix check. Resolve symlinks
  // and re-check against the REAL roots. A missing target (not yet created) skips this — the read
  // will fail on its own.
  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return
  }
  const realRoots = roots.map((r) => {
    try {
      return realpathSync(r)
    } catch {
      return r
    }
  })
  if (!contained(real, realRoots)) {
    throw new Error(`reference resolves via symlink outside allowed roots: ${real}`)
  }
}

// Bounded so a long-lived Electron/render-server process can't grow the dedup map forever.
const UPLOAD_CACHE_CAP = 200

// Web-root paths that are SERVED from public/ but look filesystem-absolute (leading slash).
// publicUrl is `/uploads/...`; these must resolve under public/, not be mistaken for a real
// absolute disk path (path.isAbsolute('/uploads/x') is true on POSIX — the trap).
const PUBLIC_WEB_PREFIXES = ['/uploads/', '/generated/', '/scenes/']

/**
 * Map a stored reference to an absolute disk path.
 *  - `/uploads/...` (and other public web prefixes) → under public/
 *  - a real absolute fs path (e.g. storagePath) → used as-is
 *  - bare relative path → under public/
 */
export function defaultToDiskPath(ref: string): string {
  // Packaged Electron: generated/uploaded assets are stored at <uploadsDir> and addressed as
  // `dreambyte://uploads/<rel>`. Map back to the real uploads dir (NOT public/, where nothing
  // serves them). Without this, i2i off any generated asset resolves to public/dreambyte:/...
  // and fails — breaking character reuse and generate_image_from_reference in the desktop app.
  if (ref.startsWith('dreambyte://uploads/')) {
    return path.join(getUploadsDir(), ref.slice('dreambyte://uploads/'.length))
  }
  // Audio assets (TTS output for lipsync) live in the runtime audio dir, addressed as
  // `dreambyte://audio/<name>` (packaged) or `/audio/<name>` (dev). Map both back to getAudioDir().
  if (ref.startsWith('dreambyte://audio/')) {
    return path.join(getAudioDir(), ref.slice('dreambyte://audio/'.length))
  }
  if (ref.startsWith('/audio/')) {
    return path.join(getAudioDir(), ref.slice('/audio/'.length))
  }
  // `/uploads/...` is served from the uploads dir (defaults to public/uploads in web dev, but
  // is <userData>/uploads when DREAMBYTE_UPLOADS_DIR is set). Resolve via the same resolver so
  // both environments agree.
  if (ref.startsWith('/uploads/')) {
    return path.join(getUploadsDir(), ref.slice('/uploads/'.length))
  }
  // `/generated/...` (cached AI media) likewise lives under an env-aware mount —
  // <userData>/generated when packaged, not cwd()/public.
  if (ref.startsWith('/generated/')) {
    return path.join(getGeneratedDir(), ref.slice('/generated/'.length))
  }
  if (ref.startsWith('dreambyte://generated/')) {
    return path.join(getGeneratedDir(), ref.slice('dreambyte://generated/'.length))
  }
  if (PUBLIC_WEB_PREFIXES.some((p) => ref.startsWith(p))) {
    return path.join(process.cwd(), 'public', ref.replace(/^\/+/, ''))
  }
  if (path.isAbsolute(ref)) return ref
  return path.join(process.cwd(), 'public', ref.replace(/^\/+/, ''))
}

/** Media kind a reference is resolved AS — gates the mime allowlist + size cap. 'video' (Tier 2 #5
 *  extend) accepts a video source; 'audio' (Tier 3 Cast voice clone) accepts a voice sample and is
 *  what the biometric clone path passes so an audio data:/local ref isn't rejected as a non-image. */
export type ReferenceKind = 'image' | 'video' | 'audio'

const contentTypeFor = (ref: string, kind: ReferenceKind = 'image'): string => {
  const ext = path.extname(ref).toLowerCase()
  if (kind === 'video') {
    // Extend / video→video source clip. .mp4 here is VIDEO (note: as an image/audio ref .mp4 maps
    // to audio/mp4 below — the kind disambiguates the same extension).
    if (ext === '.webm') return 'video/webm'
    if (ext === '.mov') return 'video/quicktime'
    if (ext === '.m4v') return 'video/x-m4v'
    return 'video/mp4'
  }
  if (kind === 'audio') {
    // Voice-clone sample / narration audio. .mp4/.webm here are AUDIO containers (the kind
    // disambiguates the same extension from the video branch above).
    if (ext === '.wav') return 'audio/wav'
    if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
    if (ext === '.ogg' || ext === '.webm') return 'audio/ogg'
    if (ext === '.flac') return 'audio/flac'
    return 'audio/mpeg'
  }
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.svg') return 'image/svg+xml'
  // Audio (lipsync TTS output uploaded to fal as audio_url).
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.webm') return 'audio/ogg'
  return 'image/jpeg'
}

// Cap on a single reference's decoded byte size. Bounds main-process memory against an oversized
// data: URL (captured 4K frame / pasted upload) or a huge http body — generous for a real image,
// small enough to refuse a memory-exhaustion payload. ~25MB.
const MAX_REF_BYTES = 25 * 1024 * 1024
// Video source clips (extend / video→video) are far larger than a still — a 10s clip can run tens
// of MB. Cap generously enough for a real clip, small enough to refuse a memory-exhaustion payload.
const MAX_VIDEO_REF_BYTES = 200 * 1024 * 1024
// Voice-clone samples are short (seconds), but allow a generous margin for a longer/lossless
// sample while still refusing a memory-exhaustion payload. ~50MB.
const MAX_AUDIO_REF_BYTES = 50 * 1024 * 1024
const REF_FETCH_TIMEOUT_MS = 15000

const capFor = (kind: ReferenceKind): number =>
  kind === 'video' ? MAX_VIDEO_REF_BYTES : kind === 'audio' ? MAX_AUDIO_REF_BYTES : MAX_REF_BYTES

// Parse a data: URL → bytes + mime. Detects `;base64` ANYWHERE in the mediatype params (not just
// immediately after the type, e.g. `data:image/png;charset=utf-8;base64,…`), rejects mime types
// outside the requested KIND (a `data:text/html;base64,…` must not flow to an image provider, nor
// an image to the video-extend path), and caps the size by kind.
function parseDataUrl(ref: string, kind: ReferenceKind = 'image'): { bytes: Buffer; mimeType: string } {
  const comma = ref.indexOf(',')
  if (comma === -1) throw new Error('Invalid data: URL reference')
  const header = ref.slice('data:'.length, comma)
  const payload = ref.slice(comma + 1)
  const isBase64 = /;base64/i.test(header)
  const fallback = kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png'
  const mimeType = (header.split(';')[0] || fallback).trim() || fallback
  if (!mimeType.startsWith(`${kind}/`)) throw new Error(`Unsupported ${kind} reference type: ${mimeType}`)
  const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  if (bytes.length === 0) throw new Error('Empty data: URL reference')
  if (bytes.length > capFor(kind)) throw new Error(`Reference ${kind} too large`)
  return { bytes, mimeType }
}

// Fetch an http(s) reference to bytes with SSRF + DoS guards: the host blocklist is re-enforced by
// REFUSING redirects (`redirect:'manual'` → a 3xx becomes a non-ok opaque response; the initial
// host check can't see a 302 to internal infra / cloud metadata), plus a timeout and a size cap.
async function fetchHttpRefBytes(
  ref: string,
  kind: ReferenceKind = 'image',
): Promise<{ bytes: Buffer; mimeType: string }> {
  assertSafeHttpUrl(ref)
  const cap = capFor(kind)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REF_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(ref, { redirect: 'manual', signal: controller.signal })
    // res.ok is true only for a 2xx direct response; a redirect (opaqueredirect, status 0) or an
    // error both fail here — so a 302 to an internal host is rejected, not silently followed.
    if (!res.ok) throw new Error(`Reference fetch failed or redirected: ${res.status}`)
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > cap) throw new Error(`Reference ${kind} too large`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > cap) throw new Error(`Reference ${kind} too large`)
    const declaredType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || ''
    // Kind guard (parity with parseDataUrl): if the server declares a CONCRETE media content-type that
    // doesn't match the requested kind, reject — an http URL returning text/html or an image must not
    // be accepted as an 'audio' voice sample and forwarded to a provider. Generic/unknown binary types
    // (octet-stream, empty) are allowed and fall back to extension-based typing, since many legitimate
    // media hosts serve octet-stream.
    const isGenericBinary =
      declaredType === '' || declaredType === 'application/octet-stream' || declaredType === 'binary/octet-stream'
    if (!isGenericBinary && !declaredType.startsWith(`${kind}/`)) {
      throw new Error(`Unsupported ${kind} reference type: ${declaredType}`)
    }
    const mimeType = declaredType && !isGenericBinary ? declaredType : contentTypeFor(ref, kind)
    return { bytes, mimeType }
  } finally {
    clearTimeout(timer)
  }
}

// Content-hash → fetchable URL, for the process lifetime. Re-uploading the same reference
// (variation runs) is wasteful and slow; this collapses it to one upload. The key folds in the
// KIND because identical bytes can be uploaded with a different content-type (a .mp4 resolved as
// audio/mp4 vs video/mp4) — keying on bytes alone would return the first upload's wrong mime.
const uploadCache = new Map<string, string>()
const cacheKeyFor = (hash: string, kind: ReferenceKind): string => (kind === 'image' ? hash : `${kind}:${hash}`)

/** Test-only: clear the dedup cache so cases don't leak into each other. */
export function __clearReferenceUploadCache(): void {
  uploadCache.clear()
}

let realDepsPromise: Promise<ReferenceUploadDeps> | null = null

// Built lazily so importing this module never pulls in the fal SDK / configures credentials
// until an actual upload is needed (keeps the hot path and tests light).
async function getRealDeps(): Promise<ReferenceUploadDeps> {
  if (!realDepsPromise) {
    realDepsPromise = (async () => {
      const fal = await import('@fal-ai/serverless-client')
      const key = process.env.FAL_KEY
      if (key) fal.config({ credentials: key })
      return {
        readFile: (p) => fs.readFile(p),
        upload: async (bytes, contentType) => {
          // Wrap in Uint8Array — Node Buffer isn't typed as a BlobPart in the TS lib.
          const blob = new Blob([new Uint8Array(bytes)], { type: contentType })
          return (await fal.storage.upload(blob)) as string
        },
        toDiskPath: defaultToDiskPath,
        statSize: async (p) => (await fs.stat(p)).size,
      }
    })()
  }
  return realDepsPromise
}

/**
 * Turn any reference (http URL, absolute path, or relative /uploads path) into a URL that
 * an external provider can fetch. Http(s) inputs pass through untouched; local files are
 * read and uploaded to fal storage (deduped by content hash).
 *
 * Throws if a local file can't be read — callers must surface that as a clear i2i error,
 * NOT silently fall back to text-only generation (the silent-degrade failure mode).
 */
export async function resolveReferenceToFetchableUrl(
  ref: string,
  deps?: ReferenceUploadDeps,
  opts?: { kind?: ReferenceKind },
): Promise<string> {
  const kind = opts?.kind ?? 'image'
  if (isHttpUrl(ref)) {
    assertSafeHttpUrl(ref)
    return ref
  }

  // data: URL (a captured scene frame or an uploaded image/clip, base64-encoded by the renderer).
  // Decode → upload to fal storage (deduped by content hash), same as a local file reference.
  if (ref.startsWith('data:')) {
    const { bytes, mimeType: contentType } = parseDataUrl(ref, kind)
    const dataKey = cacheKeyFor(createHash('sha256').update(bytes).digest('hex'), kind)
    const cachedData = uploadCache.get(dataKey)
    if (cachedData) return cachedData
    const dd = deps ?? (await getRealDeps())
    const dataUrl = await dd.upload(bytes, contentType)
    if (uploadCache.size >= UPLOAD_CACHE_CAP) {
      const oldest = uploadCache.keys().next().value
      if (oldest !== undefined) uploadCache.delete(oldest)
    }
    uploadCache.set(dataKey, dataUrl)
    return dataUrl
  }

  const d = deps ?? (await getRealDeps())
  const diskPath = d.toDiskPath(ref)
  assertWithinPublic(diskPath)

  // Reject an over-cap file BEFORE reading it into the main process (a 200MB video cap must gate the
  // read, not follow it — else a huge clip OOMs first). stat is optional on the deps; without it we
  // fall back to the post-read length check below.
  if (d.statSize) {
    let size: number
    try {
      size = await d.statSize(diskPath)
    } catch (e) {
      throw new Error(`${kind} reference not readable at ${diskPath}: ${(e as Error).message}`, { cause: e })
    }
    if (size > capFor(kind)) throw new Error(`Reference ${kind} too large`)
  }

  let bytes: Buffer
  try {
    bytes = await d.readFile(diskPath)
  } catch (e) {
    throw new Error(`${kind} reference not readable at ${diskPath}: ${(e as Error).message}`, { cause: e })
  }
  // Backstop the stat check (and the only check when statSize is absent): a clip that grew between
  // stat and read, or a dep without stat, is still bounded.
  if (bytes.length > capFor(kind)) throw new Error(`Reference ${kind} too large`)

  // Full digest (not a 16-char truncation) to avoid birthday collisions in a long-lived
  // process serving an unbounded number of distinct references.
  const key = cacheKeyFor(createHash('sha256').update(bytes).digest('hex'), kind)
  const cached = uploadCache.get(key)
  if (cached) return cached

  const url = await d.upload(bytes, contentTypeFor(ref, kind))
  // Bounded LRU-ish: evict the oldest entry when at cap (Map preserves insertion order).
  if (uploadCache.size >= UPLOAD_CACHE_CAP) {
    const oldest = uploadCache.keys().next().value
    if (oldest !== undefined) uploadCache.delete(oldest)
  }
  uploadCache.set(key, url)
  return url
}

/**
 * Resolve any reference (data: URL, http(s) URL, or local /uploads path) to raw bytes + mime type.
 * Used by providers that need inline image BYTES (e.g. Veo image-to-video) rather than a fetchable
 * URL. Throws on unreadable references — never silently degrade to text-only.
 */
export async function resolveReferenceToBytes(
  ref: string,
  deps?: ReferenceUploadDeps,
  opts?: { kind?: ReferenceKind },
): Promise<{ bytes: Buffer; mimeType: string }> {
  const kind = opts?.kind ?? 'image'
  if (ref.startsWith('data:')) return parseDataUrl(ref, kind)
  if (isHttpUrl(ref)) return fetchHttpRefBytes(ref, kind)
  const d = deps ?? (await getRealDeps())
  const diskPath = d.toDiskPath(ref)
  assertWithinPublic(diskPath)
  let bytes: Buffer
  try {
    bytes = await d.readFile(diskPath)
  } catch (e) {
    throw new Error(`reference not readable at ${diskPath}: ${(e as Error).message}`, { cause: e })
  }
  if (bytes.length > capFor(kind)) throw new Error(`Reference ${kind} too large`)
  return { bytes, mimeType: contentTypeFor(ref, kind) }
}
