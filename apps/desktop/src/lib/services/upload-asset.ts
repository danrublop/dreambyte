/**
 * User-uploaded project asset service.
 * Called by the dreambyte:projects.uploadAsset IPC handler. Accepts an
 * ArrayBuffer + mimeType + filename (no FormData over the IPC bridge),
 * writes the file under `<userData>/uploads/projects/<projectId>/`,
 * extracts metadata + thumbnails, and inserts a project_assets row
 * with `source: 'upload'`.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { v4 as uuidv4 } from 'uuid'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projectAssets } from '@/lib/db/schema'
import { getUploadsDir, uploadsUrlFor } from '@/lib/uploads/paths'
import { extractColorsFromImage, extractColorsFromSvg } from '@/lib/brand/extract-colors'
import { sanitizeSvg } from './sanitize-svg'
import { createLogger } from '@/lib/logger'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'

const log = createLogger('asset-upload')
const execFileAsync = promisify(execFile)

/**
 * N1 — resolve the user's installed ffmpeg/ffprobe (packages/render-server/ffmpeg-path.js)
 * instead of relying on the process PATH alone: a macOS app launched from Finder
 * doesn't see Homebrew's bin dir. Falls back to the bare name, so a machine
 * without FFmpeg degrades to no thumbnail / default duration (both non-fatal).
 */
const ffBinary = (name: 'ffmpeg' | 'ffprobe') => findFfmpeg(name) ?? name

/** Streaming sha256 — large media never fully materializes in memory. */
async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}
const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}
const ALLOWED_AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}
// Reference documents the agent can digest (pdf/text). No decoder touches
// these — they're stored + handed to the model as reference material — so the
// allowlist is about routing, not parser safety.
const ALLOWED_DOC_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
}
/** Browsers often hand us application/octet-stream (or nothing) for media
 *  files — infer the MIME from the extension so mp3/mov drops still work. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
}
const MAX_IMAGE_SIZE = 50 * 1024 * 1024
// Docs + any non-media reference file. Generous cap since these are stored, not
// decoded; ArrayBuffer IPC transport is the real ceiling for chat-dropped files.
const MAX_DOC_SIZE = 100 * 1024 * 1024
const MAX_AUDIO_SIZE = 300 * 1024 * 1024
// Path-based uploads stream from disk in the main process (no IPC payload),
// so the video cap is real-footage sized. ArrayBuffer transport (web
// fallback) hits Electron structured-clone limits long before this.
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * H1 — magic-byte sniff to verify the declared MIME matches actual file
 * content. Defeats the rename-`.exe`-to-`.mp4` attack and reduces the
 * blast radius of any future ffprobe/ffmpeg parser CVE: malformed content
 * is rejected at the door instead of being handed to a decoder.
 *
 * Each entry returns true iff the leading bytes are consistent with the
 * declared MIME. Permissive on SVG (text-based; relies on the regex
 * sanitizer downstream) and on container formats where the magic sits
 * past the start.
 */
function verifyMagicBytes(mime: string, buf: Buffer): boolean {
  const head = buf.subarray(0, 64)
  switch (mime) {
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    case 'image/png':
      return (
        head[0] === 0x89 &&
        head[1] === 0x50 &&
        head[2] === 0x4e &&
        head[3] === 0x47 &&
        head[4] === 0x0d &&
        head[5] === 0x0a &&
        head[6] === 0x1a &&
        head[7] === 0x0a
      )
    case 'image/gif':
      // "GIF87a" or "GIF89a"
      return head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38
    case 'image/webp':
      // "RIFF" .... "WEBP"
      return (
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50
      )
    case 'image/svg+xml': {
      // Text-based. Allow BOM (U+FEFF, written here as \uFEFF to satisfy
      // no-irregular-whitespace) + whitespace + (<?xml decl)? + <svg | <?xml | <!DOCTYPE.
      const text = head
        .toString('utf-8')
        .replace(/^\uFEFF/, '')
        .trimStart()
      return text.startsWith('<')
    }
    case 'video/mp4':
    case 'video/quicktime':
      // ISO BMFF: bytes 4-7 == "ftyp" for both mp4 and mov.
      return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    case 'video/webm':
      // EBML header
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
    case 'audio/mpeg':
    case 'audio/mp3':
      // ID3 tag or bare MPEG frame sync (0xFFEx)
      return (
        (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
      )
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      // "RIFF" .... "WAVE"
      return (
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x41 &&
        head[10] === 0x56 &&
        head[11] === 0x45
      )
    case 'audio/mp4':
    case 'audio/x-m4a':
      // ISO BMFF, same as mp4/mov
      return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    case 'audio/aac':
      // ADTS sync (0xFFFx) or ID3-prefixed
      return (
        (head[0] === 0xff && (head[1] & 0xf0) === 0xf0) || (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)
      )
    case 'audio/ogg':
      // "OggS"
      return head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53
    case 'audio/flac':
    case 'audio/x-flac':
      // "fLaC"
      return head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43
    case 'application/pdf':
      // "%PDF"
      return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
    case 'application/json':
      // Text formats have no reliable magic bytes; content is never fed to a
      // decoder, only stored + handed to the model. Accept as-is.
      return true
    default:
      return false
  }
}

/** @internal test helper — exposes the magic-byte verifier for direct testing. */
export const __testVerifyMagicBytes = verifyMagicBytes

function classifyType(mime: string): 'image' | 'video' | 'svg' | 'audio' | 'doc' {
  if (mime === 'image/svg+xml') return 'svg'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime in ALLOWED_DOC_TYPES) return 'doc'
  return 'image'
}

export class UploadAssetValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'UploadAssetValidationError'
  }
}

export interface UploadAssetInput {
  projectId: string
  /** File bytes (web fallback / small files). Exactly one of data | filePath. */
  data?: ArrayBuffer
  /** Absolute path to the source file (Electron drag-drop via
   *  webUtils.getPathForFile) — the main process streams from disk, so large
   *  footage never rides the IPC channel. */
  filePath?: string
  mimeType: string
  originalName: string
  /** Comma-separated tag list (mirrors the legacy formData field). */
  tags?: string[]
  /** Optional display name override. */
  name?: string | null
}

export interface UploadAssetResult {
  asset: typeof projectAssets.$inferSelect
}

export async function uploadAsset(input: UploadAssetInput): Promise<UploadAssetResult> {
  if (!UUID_RE.test(input.projectId)) {
    throw new UploadAssetValidationError('projectId (uuid) is required')
  }
  const hasData = input.data instanceof ArrayBuffer
  const hasPath = typeof input.filePath === 'string' && input.filePath.length > 0
  if (hasData === hasPath) {
    throw new UploadAssetValidationError('Provide exactly one of data (ArrayBuffer) or filePath')
  }

  // Resolve the effective MIME: browsers hand octet-stream (or nothing) for
  // plenty of perfectly good media files — fall back to the extension.
  let mimeType = typeof input.mimeType === 'string' ? input.mimeType : ''
  const nameExt = (input.originalName ?? '').split('.').pop()?.toLowerCase() ?? ''
  const allAllowed = { ...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES, ...ALLOWED_AUDIO_TYPES, ...ALLOWED_DOC_TYPES }
  if (!(mimeType in allAllowed)) {
    const inferred = EXT_TO_MIME[nameExt]
    if (inferred) mimeType = inferred
  }

  // Any file type is accepted. Known media/svg/doc types keep their canonical
  // extension + kind (and known media is magic-byte-verified below, since we
  // hand it to a decoder). Anything else lands as a generic 'doc' reference —
  // stored + handed to the agent, never decoded — so no allowlist gate.
  const knownExt = allAllowed[mimeType]
  const kind = knownExt ? classifyType(mimeType) : 'doc'
  const ext = knownExt ?? (nameExt || 'bin')
  const maxSize =
    kind === 'video'
      ? MAX_VIDEO_SIZE
      : kind === 'audio'
        ? MAX_AUDIO_SIZE
        : kind === 'doc'
          ? MAX_DOC_SIZE
          : MAX_IMAGE_SIZE
  const maxLabel = kind === 'video' ? '2GB' : kind === 'audio' ? '300MB' : kind === 'doc' ? '100MB' : '50MB'

  let sizeBytes: number
  let headBuffer: Buffer
  if (hasPath) {
    let stat
    try {
      stat = await fs.stat(input.filePath!)
    } catch {
      throw new UploadAssetValidationError(`Cannot read file: ${input.filePath}`)
    }
    if (!stat.isFile()) throw new UploadAssetValidationError('filePath must point to a regular file')
    sizeBytes = stat.size
    const fh = await fs.open(input.filePath!, 'r')
    try {
      const head = Buffer.alloc(Math.min(64, sizeBytes))
      await fh.read(head, 0, head.length, 0)
      headBuffer = head
    } finally {
      await fh.close()
    }
  } else {
    sizeBytes = input.data!.byteLength
    headBuffer = Buffer.from(input.data!, 0, Math.min(input.data!.byteLength, 64))
  }

  if (sizeBytes > maxSize) {
    throw new UploadAssetValidationError(`File too large. Max ${maxLabel} for ${kind}`)
  }

  // H1 — verify magic bytes BEFORE writing to disk so a misdeclared MIME
  // (rename `evil.exe` to `evil.mp4`) is rejected before ffprobe / ffmpeg
  // ever touch the bytes. Only decodable media is gated; generic 'doc' files
  // are never handed to a decoder, so there's nothing to spoof into.
  if (kind !== 'doc' && !verifyMagicBytes(mimeType, headBuffer)) {
    throw new UploadAssetValidationError(`File contents do not match declared type ${mimeType}. Refusing upload.`)
  }

  const assetId = uuidv4()
  const safeOriginal = (input.originalName || `upload.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  const storedFilename = `${assetId}_${safeOriginal}`

  const uploadsRoot = getUploadsDir()
  const projectDir = path.join(uploadsRoot, 'projects', input.projectId)
  await fs.mkdir(projectDir, { recursive: true })

  const storagePath = path.resolve(path.join(projectDir, storedFilename))
  if (!storagePath.startsWith(path.resolve(projectDir) + path.sep)) {
    throw new UploadAssetValidationError('Invalid upload path (escape)')
  }
  // Path uploads stream via copyFile (no large buffers in memory). The
  // in-memory `buffer` is only materialized for kinds that need the bytes
  // (sharp metadata / SVG sanitize / color extraction) — those are capped
  // at image sizes anyway.
  if (hasPath) {
    await fs.copyFile(input.filePath!, storagePath)
  } else {
    await fs.writeFile(storagePath, Buffer.from(input.data!))
  }
  const needsBytes = kind === 'image' || kind === 'svg'
  const buffer: Buffer = needsBytes
    ? hasPath
      ? await fs.readFile(storagePath)
      : Buffer.from(input.data!)
    : Buffer.alloc(0)

  const publicUrl = uploadsUrlFor(`projects/${input.projectId}/${storedFilename}`)
  const assetType = kind
  const displayName =
    input.name?.trim() || input.originalName.replace(/\.[^.]+$/, '') || `upload-${assetId.slice(0, 6)}`

  let width: number | null = null
  let height: number | null = null
  let durationSeconds: number | null = null
  let thumbnailUrl: string | null = null
  let extractedColors: string[] = []
  let audioPresenceTag: string | null = null

  if (assetType === 'image') {
    try {
      const meta = await sharp(buffer).metadata()
      width = meta.width ?? null
      height = meta.height ?? null
      const thumbFilename = `${assetId}_thumb.jpg`
      const thumbPath = path.join(projectDir, thumbFilename)
      await sharp(buffer, { animated: false })
        .resize(300, null, { withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbPath)
      thumbnailUrl = uploadsUrlFor(`projects/${input.projectId}/${thumbFilename}`)
    } catch (e) {
      log.warn('image meta/thumbnail failed', { error: e })
    }
    try {
      extractedColors = await extractColorsFromImage(buffer)
    } catch (e) {
      log.warn('color extraction failed', { error: e })
    }
  } else if (assetType === 'svg') {
    const rawSvg = buffer.toString('utf-8')
    const cleanSvg = sanitizeSvg(rawSvg)
    if (cleanSvg !== rawSvg) {
      await fs.writeFile(storagePath, cleanSvg, 'utf-8')
    }
    thumbnailUrl = publicUrl
    const vbMatch = cleanSvg.match(/viewBox=["']\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*["']/)
    if (vbMatch) {
      width = Math.round(parseFloat(vbMatch[3]))
      height = Math.round(parseFloat(vbMatch[4]))
    } else {
      const wMatch = cleanSvg.match(/width=["']([\d.]+)/)
      const hMatch = cleanSvg.match(/height=["']([\d.]+)/)
      if (wMatch) width = Math.round(parseFloat(wMatch[1]))
      if (hMatch) height = Math.round(parseFloat(hMatch[1]))
    }
    try {
      extractedColors = extractColorsFromSvg(cleanSvg)
    } catch (e) {
      log.warn('SVG color extraction failed', { error: e })
    }
  } else if (assetType === 'video' || assetType === 'audio') {
    // video / audio — ffprobe for duration (and dimensions when video)
    try {
      const { stdout } = await execFileAsync(
        ffBinary('ffprobe'),
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', storagePath],
        { timeout: 15_000 },
      )
      const info = JSON.parse(stdout)
      const videoStream = info.streams?.find((s: { codec_type?: string }) => s.codec_type === 'video') as
        | { width?: number; height?: number }
        | undefined
      if (videoStream) {
        width = videoStream.width ?? null
        height = videoStream.height ?? null
      }
      durationSeconds = info.format?.duration ? parseFloat(info.format.duration) : null
      // Tag audio presence so timeline drops know whether to create the
      // linked audio clip (NLE-style A/V pair). Tags, not a schema column.
      if (assetType === 'video') {
        const hasAudioStream = !!info.streams?.some((s: { codec_type?: string }) => s.codec_type === 'audio')
        audioPresenceTag = hasAudioStream ? 'has-audio' : 'no-audio'
      }
    } catch (e) {
      log.warn('ffprobe failed', { error: e })
    }
    if (assetType === 'video') {
      try {
        const thumbFilename = `${assetId}_thumb.jpg`
        const thumbPath = path.join(projectDir, thumbFilename)
        await execFileAsync(
          ffBinary('ffmpeg'),
          ['-i', storagePath, '-vframes', '1', '-vf', 'scale=300:-1', '-y', thumbPath],
          {
            timeout: 30_000,
          },
        )
        thumbnailUrl = uploadsUrlFor(`projects/${input.projectId}/${thumbFilename}`)
      } catch (e) {
        log.warn('ffmpeg thumbnail failed', { error: e })
      }
    }
  }

  // sha256 of the bytes — the cache key for media-analysis (Phase 2.5).
  // Altered file → re-upload → new hash → analysis cache miss → re-analyze.
  // Streamed from disk for video/audio so large footage never fully
  // materializes in memory.
  const contentHash = needsBytes ? createHash('sha256').update(buffer).digest('hex') : await hashFileSha256(storagePath)

  // Dedup reference docs: the same file dropped in chat repeatedly should reuse
  // its existing row, not pile up copies. Scoped to 'doc' so media keeps its
  // current "each upload is its own asset" behavior.
  if (kind === 'doc') {
    const [dup] = await db
      .select()
      .from(projectAssets)
      .where(and(eq(projectAssets.projectId, input.projectId), eq(projectAssets.contentHash, contentHash)))
      .limit(1)
    if (dup) {
      await fs.rm(storagePath, { force: true })
      return { asset: dup }
    }
  }

  const [asset] = await db
    .insert(projectAssets)
    .values({
      id: assetId,
      projectId: input.projectId,
      filename: input.originalName.slice(0, 255),
      storagePath,
      publicUrl,
      type: assetType,
      mimeType,
      sizeBytes,
      width,
      height,
      durationSeconds,
      name: displayName,
      tags: [...(input.tags ?? []), ...(audioPresenceTag ? [audioPresenceTag] : [])],
      thumbnailUrl,
      extractedColors,
      source: 'upload',
      contentHash,
    })
    .returning()

  return { asset }
}
