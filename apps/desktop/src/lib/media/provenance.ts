/**
 * Asset provenance — persist every AI-generated result as a ProjectAsset so the
 * Media Library Gallery can show it, the agent can `query_media_library` /
 * `reuse_asset` it, and `regenerate_asset` can seed a retry.
 *
 * Why server-only: writes to disk (thumbnail) and the DB. Never import from
 * client code.
 */

import 'server-only'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import sharp from 'sharp'
import { db } from '@/lib/db'
import { createLogger } from '@/lib/logger'
import { getUploadsDir, uploadsUrlFor } from '@/lib/uploads/paths'
import { getGeneratedDir, resolvePublicMediaPath } from '@/lib/media-paths'

const log = createLogger('media.provenance')
import { projectAssets } from '@/lib/db/schema'
import type { AssetGenerationMetadata, AssetSource, AssetType } from '@/lib/types'

export interface PersistGeneratedAssetInput {
  projectId: string
  /** Public URL returned by the provider (may be a third-party CDN). */
  sourceUrl: string
  /** Intent-appropriate asset type. */
  type: AssetType
  /** Display name; falls back to a short prompt slug. */
  name?: string
  tags?: string[]
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  mimeType?: string
  /** Full provenance block — copied verbatim into the row. */
  metadata: AssetGenerationMetadata
  /** 'generated' by default; some flows (e.g. background-removal of an upload) pass 'upload'. */
  source?: AssetSource
}

export interface PersistedAsset {
  id: string
  projectId: string
  publicUrl: string
  thumbnailUrl: string | null
  type: AssetType
}

/**
 * Download the remote media into /public/uploads/projects/:projectId, generate
 * a thumbnail if it's an image, and insert a projectAssets row with full
 * provenance. Returns the new asset id + stable public URL.
 */
export async function persistGeneratedAsset(input: PersistGeneratedAssetInput): Promise<PersistedAsset> {
  // projectId lands in filesystem + public URL paths — pin it to the same
  // safe-id shape as getProjectDataDir so a traversal-containing id can't escape
  // the uploads/projects dir or poison publicUrl/thumbnailUrl. Real ids are UUIDs.
  if (!/^[a-zA-Z0-9_-]+$/.test(input.projectId)) {
    throw new Error(`Invalid projectId: ${input.projectId}`)
  }
  const assetId = uuidv4()
  const ext = guessExt(input.type, input.mimeType, input.sourceUrl)
  // Use the canonical uploads dir/URL resolvers (DREAMBYTE_UPLOADS_DIR-aware) rather
  // than hardcoding cwd/public/uploads. In Electron, main.ts sets
  // DREAMBYTE_UPLOADS_DIR=<userData>/uploads + DREAMBYTE_UPLOADS_URL_BASE=dreambyte://uploads/,
  // and the dreambyte:// protocol handler (+ MP4 export window) serve from there.
  // Hardcoding public/uploads wrote generated/sandbox assets where nothing serves
  // them, so they 404'd in the editor scene-frame and the export (broken images).
  // Web dev (no env) still falls back to cwd/public/uploads, which Next serves.
  const uploadsDir = path.join(getUploadsDir(), 'projects', input.projectId)
  await fs.mkdir(uploadsDir, { recursive: true })

  const storedFilename = `${assetId}.${ext}`
  const storagePath = path.join(uploadsDir, storedFilename)
  const publicUrl = uploadsUrlFor(`projects/${input.projectId}/${storedFilename}`)

  const buffer = await fetchAsBuffer(input.sourceUrl)
  await fs.writeFile(storagePath, buffer)

  let width = input.width ?? null
  let height = input.height ?? null
  let thumbnailUrl: string | null = null

  if (input.type === 'image') {
    try {
      if (width == null || height == null) {
        const meta = await sharp(buffer).metadata()
        width = meta.width ?? width
        height = meta.height ?? height
      }
      const thumbFilename = `${assetId}_thumb.jpg`
      const thumbPath = path.join(uploadsDir, thumbFilename)
      await sharp(buffer, { animated: false })
        .resize(300, null, { withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbPath)
      thumbnailUrl = `/uploads/projects/${input.projectId}/${thumbFilename}`
    } catch (e) {
      log.warn('image meta/thumbnail failed', { error: e })
    }
  }

  const displayName = input.name?.trim() || deriveName(input.metadata.prompt) || `generated-${assetId.slice(0, 6)}`

  const [row] = await db
    .insert(projectAssets)
    .values({
      id: assetId,
      projectId: input.projectId,
      filename: storedFilename,
      storagePath,
      publicUrl,
      type: input.type,
      mimeType: input.mimeType ?? inferMime(input.type, ext),
      sizeBytes: buffer.byteLength,
      width,
      height,
      durationSeconds: input.durationSeconds ?? null,
      name: displayName,
      tags: input.tags ?? [],
      thumbnailUrl,
      extractedColors: [],
      source: input.source ?? 'generated',
      prompt: input.metadata.prompt,
      provider: input.metadata.provider,
      model: input.metadata.model,
      costCents: input.metadata.costCents,
      parentAssetId: input.metadata.parentAssetId,
      referenceAssetIds: input.metadata.referenceAssetIds,
      enhanceTags: input.metadata.enhanceTags,
    })
    .returning()

  // Sandbox placeholders are written to /generated/sandbox/ as single-use
  // sources, then copied here into uploads/. Delete the orphan source so that
  // directory doesn't grow unbounded across Sandbox runs. Scoped to that path
  // only — real cached generations (/generated/images/) are reused, never deleted.
  if (input.sourceUrl.startsWith('/generated/sandbox/')) {
    // Containment: resolve the target and confirm it stays under the sandbox
    // dir before rm. The prefix check alone permits `/generated/sandbox/../..`
    // traversal — callers only pass server-generated UUID paths today, but this
    // keeps the delete primitive from becoming an arbitrary-unlink if that changes.
    // Env-aware mount: the sandbox dir lives under getGeneratedDir(),
    // matching asset-gateway's write site.
    const sandboxRoot = path.join(getGeneratedDir(), 'sandbox')
    const target = resolvePublicMediaPath(input.sourceUrl)
    if (target && (target === sandboxRoot || target.startsWith(sandboxRoot + path.sep))) {
      fs.rm(target, { force: true }).catch(() => {})
    }
  }

  return {
    id: row.id,
    projectId: row.projectId,
    publicUrl: row.publicUrl,
    thumbnailUrl: row.thumbnailUrl,
    type: row.type as AssetType,
  }
}

async function fetchAsBuffer(url: string): Promise<Buffer> {
  // Local public-path URLs can be read from disk directly to avoid a needless HTTP roundtrip.
  if (url.startsWith('/')) {
    // Known media mounts resolve env-aware:
    // in packaged builds /generated/ etc. live under userData, not
    // cwd()/public; the resolver also containment-guards each mount.
    const mounted = resolvePublicMediaPath(url)
    if (mounted) return await fs.readFile(mounted)
    // Anything else (e.g. bundled /sfx-library/ files) stays a contained read
    // under public/ — `path.join(cwd, 'public', '/a/../../x')` would otherwise
    // escape via `..` and copy an arbitrary local file into the public uploads
    // dir (Codex review). Callers pass server-generated paths today; this
    // stops it becoming an arbitrary-read if a sourceUrl ever isn't.
    const publicDir = path.join(process.cwd(), 'public')
    const p = path.resolve(publicDir, `.${url}`)
    if (p !== publicDir && !p.startsWith(publicDir + path.sep)) {
      throw new Error(`Refusing to read path outside public/: ${url}`)
    }
    return await fs.readFile(p)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`)
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

function guessExt(type: AssetType, mime: string | undefined, url: string): string {
  // Avatar clips are videos on disk; treat them like 'video'.
  if (type === 'video' || type === 'avatar') {
    if (mime?.includes('webm')) return 'webm'
    if (mime?.includes('quicktime')) return 'mov'
    return 'mp4'
  }
  if (type === 'audio') {
    if (mime?.includes('wav')) return 'wav'
    if (mime?.includes('ogg')) return 'ogg'
    const urlExtA = url.split('?')[0].split('.').pop()?.toLowerCase()
    if (urlExtA && ['mp3', 'wav', 'ogg', 'm4a'].includes(urlExtA)) return urlExtA
    return 'mp3'
  }
  if (type === 'svg') return 'svg'
  if (mime?.includes('png')) return 'png'
  if (mime?.includes('webp')) return 'webp'
  const urlExt = url.split('?')[0].split('.').pop()?.toLowerCase()
  if (urlExt && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(urlExt)) {
    return urlExt === 'jpeg' ? 'jpg' : urlExt
  }
  return 'png'
}

function inferMime(type: AssetType, ext: string): string {
  if (type === 'video' || type === 'avatar')
    return ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4'
  if (type === 'audio')
    return ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg'
  if (type === 'svg' || ext === 'svg') return 'image/svg+xml'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

function deriveName(prompt: string | null): string | null {
  if (!prompt) return null
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
}
