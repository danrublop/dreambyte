import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { getCachedMedia, setCachedMedia } from '@/lib/db'
import { getGeneratedDir, resolvePublicMediaPath } from '@/lib/media-paths'
import { computeCacheHash } from './cache-hash'

/**
 * Resolve a cached row's stored URL (`/generated/...`) to disk, env-aware
 * (packaged Electron keeps the generated mount under userData, not
 * `cwd()/public`). null (non-local / poisoned row)
 * reads as a cache miss.
 */
async function cachedFileExists(filePath: string): Promise<boolean> {
  const abs = resolvePublicMediaPath(filePath)
  if (!abs) return false
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

export interface CacheMetadata {
  width?: number
  height?: number
  [key: string]: unknown
}

// computeCacheHash now lives in cache-hash.ts (db-free, canonical deep hashing). Re-exported
// for the existing callers that import it from here.
export { computeCacheHash }

export async function checkCache(
  api: string,
  params: Record<string, unknown>,
): Promise<{ filePath: string; metadata: CacheMetadata } | null> {
  const hash = computeCacheHash(params)
  const cached = await getCachedMedia(hash)
  if (!cached) return null

  if (!(await cachedFileExists(cached.filePath))) return null

  let metadata: CacheMetadata = {}
  if (cached.config) {
    try {
      metadata = JSON.parse(cached.config)?._metadata ?? {}
    } catch {
      /* ok */
    }
  }

  return { filePath: cached.filePath, metadata }
}

export async function saveToCache(
  api: string,
  params: Record<string, unknown>,
  buffer: Buffer,
  ext: string,
  metadata?: CacheMetadata,
): Promise<string> {
  const hash = computeCacheHash(params)
  const subdir =
    api === 'heygen' ? 'avatars' : api === 'veo3' ? 'videos' : api === 'backgroundRemoval' ? 'stickers' : 'images'

  const dir = path.join(getGeneratedDir(), subdir)
  await fs.mkdir(dir, { recursive: true })

  const filename = `${hash}.${ext}`
  const filePath = path.join(dir, filename)
  await fs.writeFile(filePath, buffer)

  const publicPath = `/generated/${subdir}/${filename}`
  const configObj = { ...params, _metadata: metadata ?? {} }
  await setCachedMedia(
    hash,
    api,
    publicPath,
    (params.prompt as string) ?? '',
    (params.model as string) ?? '',
    JSON.stringify(configObj),
  )
  return publicPath
}

// Large binary download (generated image/video bytes). Cap it so a stalled provider CDN
// can't hang the agent turn — 120s for the bigger payloads.
const DOWNLOAD_TIMEOUT_MS = 120_000

export async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/** SHA256 of file bytes, sliced to 16 hex chars. Used to dedupe identical files regardless of source URL. */
export function computeContentHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

/**
 * Check if a buffer's content hash already exists in media_cache.
 * Returns the existing publicPath if found (and the underlying file still exists on disk).
 * Use this to dedupe research downloads — e.g. two search queries return the same Pexels
 * MP4, we only want to store it once.
 */
export async function checkContentCache(buffer: Buffer): Promise<{ filePath: string; contentHash: string } | null> {
  const contentHash = computeContentHash(buffer)
  const cached = await getCachedMedia(contentHash)
  if (!cached) return null
  if (!(await cachedFileExists(cached.filePath))) return null
  return { filePath: cached.filePath, contentHash }
}
