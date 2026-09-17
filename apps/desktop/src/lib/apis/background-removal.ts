import * as fal from '@fal-ai/serverless-client'
import fs from 'fs/promises'
import { resolvePublicMediaPath } from '@/lib/media-paths'
import { checkCache, saveToCache, downloadToBuffer } from './media-cache'

const FAL_KEY = () => process.env.FAL_KEY

function configureFal() {
  const key = FAL_KEY()
  if (key) {
    fal.config({ credentials: key })
  }
}

export const BG_REMOVAL_COST = 0.01

export async function removeImageBackground(
  imageUrl: string,
  skipCache = false,
): Promise<{ resultUrl: string; cost: number }> {
  // Check cache
  const cacheParams = { imageUrl, operation: 'rmbg' }
  if (!skipCache) {
    const cached = await checkCache('backgroundRemoval', cacheParams)
    if (cached) {
      return { resultUrl: cached.filePath, cost: 0 }
    }
  }

  configureFal()

  let input: Record<string, unknown>

  if (imageUrl.startsWith('/')) {
    // Local file — read and send as data URI so FAL doesn't need to reach
    // our server (which may be localhost / unreachable in production).
    // Env-aware mount resolution: in packaged Electron the uploads/
    // generated mounts live under userData, not cwd()/public.
    const absPath = resolvePublicMediaPath(imageUrl)
    if (!absPath) throw new Error(`Not a local media URL: ${imageUrl}`)
    const fileBuffer = await fs.readFile(absPath)
    if (fileBuffer.length > 10 * 1024 * 1024) {
      throw new Error('Image too large for background removal (max 10MB)')
    }
    const base64 = fileBuffer.toString('base64')
    const mime = imageUrl.endsWith('.png')
      ? 'image/png'
      : imageUrl.endsWith('.webp')
        ? 'image/webp'
        : imageUrl.endsWith('.gif')
          ? 'image/gif'
          : 'image/jpeg'
    input = { image_url: `data:${mime};base64,${base64}` }
  } else {
    input = { image_url: imageUrl }
  }

  const result = (await fal.subscribe('fal-ai/bria-rmbg', { input })) as any

  const resultUrl = result.image?.url
  if (!resultUrl) throw new Error('No result from background removal')

  const buffer = await downloadToBuffer(resultUrl)
  const publicPath = await saveToCache('backgroundRemoval', cacheParams, buffer, 'png')

  return { resultUrl: publicPath, cost: BG_REMOVAL_COST }
}
