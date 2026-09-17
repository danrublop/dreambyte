/**
 * Ingest services — URL ingest (yt-dlp probe + download) and direct-URL
 * fetch + transcode.
 *
 * Callers: agent tool handlers and Electron IPC.
 *
 * Storage convention:
 *   getUploadsDir()/projects/<projectId>/ingested/<assetId>.<ext>
 *
 * Which resolves to:
 *   dev:      <cwd>/public/uploads/projects/<projectId>/ingested/...
 *             (served by Next at /uploads/projects/<projectId>/ingested/...)
 *   packaged: <userData>/uploads/projects/<projectId>/ingested/...
 *             (served by dreambyte://uploads/projects/<projectId>/ingested/...)
 *
 * Ownership enforcement stays with the IPC handler and the tool-handler
 * caller (world.projectId binding). The service
 * trusts the projectId it is given.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '@/lib/logger'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'
import { sanitizeSvg } from './sanitize-svg'

const log = createLogger('ingest')
import sharp from 'sharp'
import { db } from '@/lib/db'
import { projectAssets } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { probe, download, YtDlpNotInstalledError } from '@/lib/ingest/yt-dlp'
import { computeContentHash } from '@/lib/apis/media-cache'
import { getUploadsDir, uploadsUrlFor } from '@/lib/uploads/paths'
import { assertPublicHttpUrl, UrlGuardError } from '@/lib/security/url-guard'
import { normalizeWikimediaThumbUrl } from './wikimedia-url'

const execFileAsync = promisify(execFile)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_DURATION_SEC = 600 // 10 min hard cap
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024
const INGESTED_SUBDIR = 'ingested'

// ── Service errors ─────────────────────────────────────────────────────────

export class IngestValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'IngestValidationError'
  }
}

/**
 * Upstream dependency missing (yt-dlp binary). Route maps to 503;
 * IPC maps to a regular Error so the renderer can show "install yt-dlp".
 */
export class YtDlpMissingError extends Error {
  readonly code = 'YT_DLP_MISSING' as const
  constructor(message: string) {
    super(message)
    this.name = 'YtDlpMissingError'
  }
}

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
    throw new IngestValidationError('projectId (uuid) is required')
  }
}

function ingestedDir(projectId: string): string {
  return path.join(getUploadsDir(), 'projects', projectId, INGESTED_SUBDIR)
}

function ingestedUrl(projectId: string, filename: string): string {
  return uploadsUrlFor(`projects/${projectId}/${INGESTED_SUBDIR}/${filename}`)
}

// ── yt-dlp: probe + download ───────────────────────────────────────────────

export interface IngestUrlInput {
  url: string
  projectId: string
  /** If omitted, returns probe data only. If set, downloads that format. */
  formatId?: string
}

export type IngestUrlResult =
  | {
      mode: 'probe'
      title: string
      durationSec: number
      thumbnail: string | null | undefined
      uploader: string | null | undefined
      extractor: string | null | undefined
      webpageUrl: string | null | undefined
      recommendedFormatId: string | null | undefined
      formats: unknown[]
      ytDlpTooLong: string | null
    }
  | {
      mode: 'download'
      asset: typeof projectAssets.$inferSelect
      contentHash: string
      sourceUrl: string
      deduped: boolean
    }

export async function ingestUrl(input: IngestUrlInput): Promise<IngestUrlResult> {
  if (!input.url || typeof input.url !== 'string') {
    throw new IngestValidationError('url is required')
  }
  // SSRF guard — same as `ingestDirect`. yt-dlp won't meaningfully probe
  // `file://` or localhost for public-video metadata anyway, so the loss
  // of flexibility is zero.
  try {
    assertPublicHttpUrl(input.url)
  } catch (e) {
    if (e instanceof UrlGuardError) throw new IngestValidationError(e.message)
    throw e
  }
  assertProjectId(input.projectId)

  // Probe-only (no formatId) — returns metadata without downloading.
  if (!input.formatId) {
    try {
      const info = await probe(input.url)
      return {
        mode: 'probe',
        title: info.title,
        durationSec: info.durationSec,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        extractor: info.extractor,
        webpageUrl: info.webpageUrl,
        recommendedFormatId: info.recommendedFormatId,
        formats: info.formats.slice(0, 12),
        ytDlpTooLong:
          info.durationSec > MAX_DURATION_SEC
            ? `Video is ${Math.round(info.durationSec)}s; hard cap is ${MAX_DURATION_SEC}s. Refuse or try a shorter clip.`
            : null,
      }
    } catch (e) {
      if (e instanceof YtDlpNotInstalledError) throw new YtDlpMissingError(e.message)
      throw new Error(`yt-dlp probe failed: ${(e as Error).message}`, { cause: e })
    }
  }

  // Download with explicit format.
  const assetId = uuidv4()
  const uploadsDir = ingestedDir(input.projectId)
  await fs.mkdir(uploadsDir, { recursive: true })
  const storagePath = path.join(uploadsDir, `${assetId}.mp4`)

  let result
  let downloadSucceeded = false
  try {
    try {
      result = await download({
        url: input.url,
        destPath: storagePath,
        formatId: input.formatId,
        maxDurationSec: MAX_DURATION_SEC,
      })
      downloadSucceeded = true
    } catch (e) {
      if (e instanceof YtDlpNotInstalledError) throw new YtDlpMissingError(e.message)
      throw new Error(`yt-dlp download failed: ${(e as Error).message}`, { cause: e })
    }
  } finally {
    // yt-dlp may leave a partial file on disk if it errors mid-download
    // (e.g. network drop, source-side rate limit, SIGTERM). Without this
    // cleanup the uploads dir accumulates orphan `<assetId>.mp4` files
    // that never get a DB row and never get served.
    if (!downloadSucceeded) {
      await fs.unlink(storagePath).catch(() => {})
    }
  }

  const stat = await fs.stat(storagePath)
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    await fs.unlink(storagePath).catch(() => {})
    throw new IngestValidationError(
      `Downloaded file is ${Math.round(stat.size / 1024 / 1024)} MB, exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB cap.`,
    )
  }
  const fileBuffer = await fs.readFile(storagePath)
  const contentHash = computeContentHash(fileBuffer)

  // Dedup: same contentHash in this project → return existing, discard copy.
  const existing = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.projectId, input.projectId), eq(projectAssets.contentHash, contentHash)))
    .limit(1)
  if (existing.length > 0) {
    await fs.unlink(storagePath).catch(() => {})
    return {
      mode: 'download',
      asset: existing[0],
      contentHash,
      sourceUrl: result.sourceUrl,
      deduped: true,
    }
  }

  // Thumbnail (best-effort)
  let thumbnailUrl: string | null = null
  try {
    const thumbFilename = `${assetId}_thumb.jpg`
    const thumbPath = path.join(uploadsDir, thumbFilename)
    await execFileAsync('ffmpeg', ['-i', storagePath, '-vframes', '1', '-vf', 'scale=300:-1', '-y', thumbPath], {
      timeout: 30_000,
    })
    thumbnailUrl = ingestedUrl(input.projectId, thumbFilename)
  } catch {
    /* non-fatal */
  }

  const filename = `${assetId}.mp4`
  const publicUrl = ingestedUrl(input.projectId, filename)

  const [asset] = await db
    .insert(projectAssets)
    .values({
      id: assetId,
      projectId: input.projectId,
      filename: `${result.title.slice(0, 200).replace(/[^\w -]/g, '_')}.mp4`,
      storagePath,
      publicUrl,
      type: 'video',
      mimeType: 'video/mp4',
      sizeBytes: stat.size,
      width: result.width ?? null,
      height: result.height ?? null,
      durationSeconds: result.durationSec,
      name: result.title.slice(0, 200),
      tags: [],
      thumbnailUrl,
      extractedColors: [],
      source: 'yt-dlp',
      contentHash,
      sourceUrl: result.sourceUrl,
    })
    .returning()

  return {
    mode: 'download',
    asset,
    contentHash,
    sourceUrl: result.sourceUrl,
    deduped: false,
  }
}

// ── Direct URL fetch + transcode ───────────────────────────────────────────

const MIME_TO_TYPE: Record<string, { type: 'image' | 'video' | 'svg'; ext: string }> = {
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/png': { type: 'image', ext: 'png' },
  'image/webp': { type: 'image', ext: 'webp' },
  'image/gif': { type: 'image', ext: 'gif' },
  'image/svg+xml': { type: 'svg', ext: 'svg' },
  'video/mp4': { type: 'video', ext: 'mp4' },
  'video/webm': { type: 'video', ext: 'webm' },
  'video/quicktime': { type: 'video', ext: 'mov' },
  'video/ogg': { type: 'video', ext: 'ogv' },
  'application/ogg': { type: 'video', ext: 'ogv' },
}

function extFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const ext = path.extname(u.pathname).toLowerCase().slice(1)
    return ext || null
  } catch {
    return null
  }
}

function typeFromExt(ext: string): { type: 'image' | 'video' | 'svg'; ext: string } | null {
  const e = ext.toLowerCase()
  if (['jpg', 'jpeg'].includes(e)) return { type: 'image', ext: 'jpg' }
  if (['png', 'webp', 'gif'].includes(e)) return { type: 'image', ext: e }
  if (e === 'svg') return { type: 'svg', ext: 'svg' }
  if (['mp4', 'webm', 'mov', 'ogv', 'm4v'].includes(e)) return { type: 'video', ext: e === 'm4v' ? 'mp4' : e }
  return null
}

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const name = path
      .basename(u.pathname)
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
    return name || u.hostname
  } catch {
    return 'Imported media'
  }
}

export interface IngestDirectInput {
  url: string
  projectId: string
  name?: string
  tags?: string[]
}

export interface IngestDirectResult {
  asset: typeof projectAssets.$inferSelect
  contentHash: string
  sourceUrl: string
  deduped: boolean
}

export async function ingestDirect(input: IngestDirectInput): Promise<IngestDirectResult> {
  if (!input.url || typeof input.url !== 'string') {
    throw new IngestValidationError('url is required')
  }
  // SSRF guard: reject non-http(s) schemes and private/loopback hosts
  // before any fetch. Does not protect against DNS rebinding —
  // `public.attacker.com` resolving to 169.254.169.254 between HEAD
  // and GET would still slip through. That would need IP pinning at
  // the fetch layer; out of scope for this guard.
  try {
    assertPublicHttpUrl(input.url)
  } catch (e) {
    if (e instanceof UrlGuardError) throw new IngestValidationError(e.message)
    throw e
  }
  assertProjectId(input.projectId)

  // A descriptive User-Agent is good hygiene — Wikimedia's UA policy asks for one and some
  // hosts require it — so we always send it (+ an image/video Accept). NOTE: the UA is NOT
  // what unblocks Wikimedia (a header-less fetch of a full Wikimedia file already 200s); the
  // real fix is the thumb→Special:FilePath rewrite below. See normalizeWikimediaThumbUrl.
  const DOWNLOAD_HEADERS: Record<string, string> = {
    'User-Agent': 'Dreambyte/1.0 (+https://dreambyte.app; media ingest)',
    Accept: 'image/*,video/*,application/octet-stream,*/*;q=0.8',
  }

  // Wikimedia `upload.wikimedia.org/.../thumb/.../Npx-<File>` URLs 400 from some networks
  // (Varnish edge) even with a valid UA — that was the real trophy-download failure. Rewrite
  // them to the canonical, rename-proof `Special:FilePath/<File>?width=N`, which returns 200.
  // No-op for every other URL.
  const fetchUrl = normalizeWikimediaThumbUrl(input.url)
  if (fetchUrl !== input.url) {
    try {
      assertPublicHttpUrl(fetchUrl)
    } catch (e) {
      if (e instanceof UrlGuardError) throw new IngestValidationError(e.message)
      throw e
    }
  }

  const head = await fetch(fetchUrl, { method: 'HEAD', headers: DOWNLOAD_HEADERS }).catch(() => null)
  const contentType = head?.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const contentLength = head?.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_FILE_SIZE_BYTES) {
    throw new IngestValidationError(
      `File is ${Math.round(Number(contentLength) / 1024 / 1024)} MB, exceeds 200 MB cap.`,
    )
  }

  const response = await fetch(fetchUrl, { headers: DOWNLOAD_HEADERS })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  // Re-validate the post-redirect host before reading the body — assertPublicHttpUrl
  // only checked the input URL, and the default redirect:'follow' could land on an
  // internal host (SSRF): a public URL redirecting to 169.254.169.254 would
  // otherwise be ingested.
  if (response.url && response.url !== input.url) {
    try {
      assertPublicHttpUrl(response.url)
    } catch (e) {
      if (e instanceof UrlGuardError) throw new IngestValidationError(`Redirect to disallowed host: ${e.message}`)
      throw e
    }
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_FILE_SIZE_BYTES) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.length
  }
  if (total >= MAX_FILE_SIZE_BYTES) {
    throw new IngestValidationError('File too large (over 200 MB)')
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))

  let typeInfo = contentType ? MIME_TO_TYPE[contentType] : undefined
  if (!typeInfo) {
    const urlExt = extFromUrl(input.url)
    if (urlExt) typeInfo = typeFromExt(urlExt) ?? undefined
  }
  if (!typeInfo) {
    throw new IngestValidationError(
      `Cannot determine media type from URL or content-type (${contentType ?? 'unknown'}).`,
    )
  }

  const contentHash = computeContentHash(buffer)

  const existing = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.projectId, input.projectId), eq(projectAssets.contentHash, contentHash)))
    .limit(1)
  if (existing.length > 0) {
    return { asset: existing[0], contentHash, sourceUrl: input.url, deduped: true }
  }

  const assetId = uuidv4()
  const uploadsDir = ingestedDir(input.projectId)
  await fs.mkdir(uploadsDir, { recursive: true })

  let effectiveExt = typeInfo.ext
  const needsTranscode = typeInfo.type === 'video' && (typeInfo.ext === 'ogv' || typeInfo.ext === 'mov')
  const rawFilename = `${assetId}.${typeInfo.ext}`
  const rawPath = path.join(uploadsDir, rawFilename)
  // Sanitize remotely-fetched SVG before persisting — it's served same-origin
  // and would otherwise execute embedded <script>/on*/javascript: (stored XSS).
  // Matches the upload path's defense.
  if (typeInfo.type === 'svg') {
    await fs.writeFile(rawPath, sanitizeSvg(buffer.toString('utf-8')), 'utf-8')
  } else {
    await fs.writeFile(rawPath, buffer)
  }

  let storedFilename = rawFilename
  let storagePath = rawPath
  if (needsTranscode) {
    const mp4Filename = `${assetId}.mp4`
    const mp4Path = path.join(uploadsDir, mp4Filename)
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          rawPath,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          '-y',
          mp4Path,
        ],
        { timeout: 180_000 },
      )
      await fs.unlink(rawPath).catch(() => {})
      storedFilename = mp4Filename
      storagePath = mp4Path
      effectiveExt = 'mp4'
    } catch (e) {
      log.warn('transcode failed, keeping original', { extra: { message: (e as Error).message } })
    }
  }

  const publicUrl = ingestedUrl(input.projectId, storedFilename)
  let width: number | null = null
  let height: number | null = null
  let durationSeconds: number | null = null
  let thumbnailUrl: string | null = null

  if (typeInfo.type === 'image') {
    try {
      const meta = await sharp(buffer).metadata()
      width = meta.width ?? null
      height = meta.height ?? null
      const thumbFilename = `${assetId}_thumb.jpg`
      const thumbPath = path.join(uploadsDir, thumbFilename)
      await sharp(buffer, { animated: false })
        .resize(300, null, { withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbPath)
      thumbnailUrl = ingestedUrl(input.projectId, thumbFilename)
    } catch {
      /* non-fatal */
    }
  } else if (typeInfo.type === 'video') {
    try {
      const { stdout } = await execFileAsync(
        findFfmpeg('ffprobe') ?? 'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', storagePath],
        { timeout: 15_000 },
      )
      const info = JSON.parse(stdout)
      const v = info.streams?.find((s: { codec_type?: string }) => s.codec_type === 'video')
      if (v) {
        width = v.width ?? null
        height = v.height ?? null
      }
      durationSeconds = info.format?.duration ? parseFloat(info.format.duration) : null
    } catch {
      /* non-fatal */
    }
    try {
      const thumbFilename = `${assetId}_thumb.jpg`
      const thumbPath = path.join(uploadsDir, thumbFilename)
      await execFileAsync('ffmpeg', ['-i', storagePath, '-vframes', '1', '-vf', 'scale=300:-1', '-y', thumbPath], {
        timeout: 30_000,
      })
      thumbnailUrl = ingestedUrl(input.projectId, thumbFilename)
    } catch {
      /* non-fatal */
    }
  } else if (typeInfo.type === 'svg') {
    thumbnailUrl = publicUrl
  }

  const displayName = input.name || deriveNameFromUrl(input.url)
  const storedMime =
    typeInfo.type === 'video'
      ? `video/${effectiveExt === 'ogv' ? 'ogg' : effectiveExt}`
      : typeInfo.type === 'svg'
        ? 'image/svg+xml'
        : `image/${effectiveExt === 'jpg' ? 'jpeg' : effectiveExt}`

  const [asset] = await db
    .insert(projectAssets)
    .values({
      id: assetId,
      projectId: input.projectId,
      filename: storedFilename,
      storagePath,
      publicUrl,
      type: typeInfo.type,
      mimeType: storedMime,
      sizeBytes: (await fs.stat(storagePath)).size,
      width,
      height,
      durationSeconds,
      name: displayName,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 30) : [],
      thumbnailUrl,
      extractedColors: [],
      source: 'research',
      contentHash,
      sourceUrl: input.url,
    })
    .returning()

  return { asset, contentHash, sourceUrl: input.url, deduped: false }
}
