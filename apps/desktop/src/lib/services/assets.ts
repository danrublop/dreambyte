/**
 * Project-asset service functions: patch, delete, regenerate.
 * Callers: Electron IPC and agent tool handlers. Ownership enforcement
 * stays at the IPC / tool-handler boundary.
 */

import fs from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { createLogger } from '@/lib/logger'
import { resolvePublicMediaPath } from '@/lib/media-paths'

const log = createLogger('asset')
import { projectAssets } from '@/lib/db/schema'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class AssetValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'AssetValidationError'
  }
}

export class AssetNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const
  constructor(message: string) {
    super(message)
    this.name = 'AssetNotFoundError'
  }
}

function assertProjectId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new AssetValidationError('projectId (uuid) is required')
  }
}

// ── PATCH ──────────────────────────────────────────────────────────────────

export interface PatchAssetInput {
  projectId: string
  assetId: string
  name?: string
  tags?: string[]
}

export async function patchAsset(input: PatchAssetInput): Promise<{ asset: typeof projectAssets.$inferSelect }> {
  assertProjectId(input.projectId)
  if (!input.assetId) throw new AssetValidationError('assetId is required')

  const updates: Partial<typeof projectAssets.$inferInsert> = {}
  if (typeof input.name === 'string' && input.name.trim()) {
    updates.name = input.name.trim()
  }
  if (Array.isArray(input.tags)) {
    updates.tags = input.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
  }
  if (Object.keys(updates).length === 0) {
    throw new AssetValidationError('No valid fields to update')
  }

  const [updated] = await db
    .update(projectAssets)
    .set(updates)
    .where(and(eq(projectAssets.id, input.assetId), eq(projectAssets.projectId, input.projectId)))
    .returning()

  if (!updated) throw new AssetNotFoundError('Asset not found')
  return { asset: updated }
}

// ── DELETE ─────────────────────────────────────────────────────────────────

export interface DeleteAssetInput {
  projectId: string
  assetId: string
}

export async function deleteAsset(input: DeleteAssetInput): Promise<{ success: true }> {
  assertProjectId(input.projectId)
  if (!input.assetId) throw new AssetValidationError('assetId is required')

  const [asset] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, input.assetId), eq(projectAssets.projectId, input.projectId)))
  if (!asset) throw new AssetNotFoundError('Asset not found')

  // Remove files from disk first so a failed DB delete doesn't orphan the
  // bytes. If the file delete fails (already gone), swallow ENOENT; warn
  // on anything else.
  try {
    await fs.unlink(asset.storagePath)
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err?.code !== 'ENOENT') log.warn('failed to delete file', { error: err })
  }

  if (asset.thumbnailUrl && asset.thumbnailUrl !== asset.publicUrl) {
    // Env-aware mount resolution: packaged Electron's media mounts
    // live under userData, not cwd()/public. null (non-local URL) → nothing
    // on our disk to delete.
    const thumbPath = resolvePublicMediaPath(asset.thumbnailUrl)
    if (thumbPath) {
      try {
        await fs.unlink(thumbPath)
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err?.code !== 'ENOENT') log.warn('failed to delete thumbnail', { error: err })
      }
    }
  }

  await db
    .delete(projectAssets)
    .where(and(eq(projectAssets.id, input.assetId), eq(projectAssets.projectId, input.projectId)))
  return { success: true }
}

// ── Regenerate (image assets only) ─────────────────────────────────────────

export interface RegenerateAssetInput {
  projectId: string
  assetId: string
  promptOverride?: string
  model?: string
  aspectRatio?: string
  enhanceTags?: string[]
}

export interface RegenerateAssetResult {
  asset: typeof projectAssets.$inferSelect
  cost: number
  finalPrompt: string
}

function deriveAspect(w: number | null, h: number | null): string | null {
  if (!w || !h) return null
  const r = w / h
  if (r > 1.5) return '16:9'
  if (r < 0.7) return '9:16'
  if (r > 1.1) return '4:3'
  if (r < 0.9) return '3:4'
  return '1:1'
}

export async function regenerateAsset(input: RegenerateAssetInput): Promise<RegenerateAssetResult> {
  assertProjectId(input.projectId)
  if (!input.assetId) throw new AssetValidationError('assetId is required')

  const { generateImage } = await import('@/lib/apis/image-gen')
  const { logSpend } = await import('@/lib/db')
  const { persistGeneratedAsset } = await import('@/lib/media/provenance')
  const { enrichPrompt } = await import('@/lib/media/prompt-enhancer')

  const [parent] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, input.assetId), eq(projectAssets.projectId, input.projectId)))
    .limit(1)
  if (!parent) throw new AssetNotFoundError('Asset not found')
  if (parent.type !== 'image') {
    throw new AssetValidationError('Only image assets are regenerable')
  }

  const basePrompt = (input.promptOverride?.trim() || parent.prompt || parent.name || '').toString()
  if (!basePrompt) {
    throw new AssetValidationError('Parent has no prompt; pass promptOverride')
  }
  const model = (input.model ?? parent.model ?? 'flux-schnell') as Parameters<typeof generateImage>[0]['model']
  const aspectRatio = (input.aspectRatio ?? deriveAspect(parent.width, parent.height) ?? '1:1') as Parameters<
    typeof generateImage
  >[0]['aspectRatio']
  const enhanceTags = Array.isArray(input.enhanceTags) ? input.enhanceTags : (parent.enhanceTags ?? [])

  const finalPrompt = enrichPrompt(basePrompt, enhanceTags, model as Parameters<typeof enrichPrompt>[2])

  const result = await generateImage({
    prompt: finalPrompt,
    model,
    aspectRatio,
    style: null,
    skipCache: true,
  })
  if (result.cost > 0) {
    await logSpend(
      input.projectId,
      'imageGen',
      result.cost,
      `regen ${input.assetId.slice(0, 6)}: ${basePrompt.slice(0, 80)}`,
    )
  }
  const persisted = await persistGeneratedAsset({
    projectId: input.projectId,
    sourceUrl: result.imageUrl,
    type: 'image',
    name: `${parent.name} — retry`,
    width: result.width,
    height: result.height,
    metadata: {
      prompt: finalPrompt,
      provider: 'imageGen',
      model: model as string,
      costCents: Math.round((result.cost ?? 0) * 100),
      parentAssetId: parent.id,
      referenceAssetIds: parent.referenceAssetIds ?? null,
      enhanceTags: enhanceTags.length ? enhanceTags : null,
    },
  })
  const [row] = await db.select().from(projectAssets).where(eq(projectAssets.id, persisted.id)).limit(1)
  return { asset: row, cost: result.cost, finalPrompt }
}
