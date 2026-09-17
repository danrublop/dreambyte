/**
 * Client-side image utilities for agent chat image input.
 * Handles resize, validation, and base64 extraction.
 */

export const MAX_IMAGE_DIMENSION = 1568
export const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB pre-resize
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type AllowedImageMime = (typeof ALLOWED_IMAGE_TYPES)[number]

export function validateImage(file: File): { valid: boolean; error?: string } {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageMime)) {
    return { valid: false, error: `Unsupported image type: ${file.type}. Use PNG, JPEG, GIF, or WebP.` }
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` }
  }
  return { valid: true }
}

export async function resizeImage(
  file: File | Blob,
  maxDim = MAX_IMAGE_DIMENSION,
): Promise<{ dataUri: string; mimeType: AllowedImageMime; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)

      // Use PNG for transparency-capable formats, JPEG otherwise
      const isPng = file.type === 'image/png' || file.type === 'image/gif'
      const outputMime = isPng ? 'image/png' : 'image/jpeg'
      const quality = isPng ? undefined : 0.85
      const dataUri = canvas.toDataURL(outputMime, quality)

      resolve({
        dataUri,
        mimeType: outputMime as AllowedImageMime,
        width,
        height,
      })
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/** Split a data URI into its mime type and raw base64 data */
export function extractBase64(dataUri: string): { mimeType: string; data: string } {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid data URI')
  return { mimeType: match[1], data: match[2] }
}
